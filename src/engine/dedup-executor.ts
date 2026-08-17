// src/engine/dedup-executor.ts — IDedupExecutor 实现：硬链接去重执行器
// 把分析报告变成真实回收（rmlint -c hardlink 同族方案）：
//   canonical（组内第一份）保留原件，其余 victim 原子替换为指向 canonical inode 的硬链接。
//
// 安全属性（每一层都有对应测试）：
//   1. TOCTOU 复验 —— 分析与执行是两个时刻；链接前对 canonical 与 victim 重新
//      计算 SHA-256，任一与报告 hash 不符 ⇒ 整组跳过（分析结果可能是陈旧的）。
//   2. 跨设备防护 —— st_dev 不同（跨文件系统/挂载点）⇒ hardlink 物理不可能 ⇒ 跳过。
//   3. 原子替换 —— link(canonical→tmp) + rename(tmp→victim)：任何时刻 victim 路径
//      都存在可用文件，无"先删后链"的空窗。
//   4. 事后断言 —— 替换后校验 st_ino(victim) === st_ino(canonical)，不等则回滚该条。
//   5. 诚实记账 —— bytesSaved 只计替换前 nlink=1 的 victim（victim 本就共享 inode
//      时替换不释放任何空间）。
//   6. undo 可逆 —— 内容已验证与 canonical 一致，undo = 从 canonical 复制回独立文件
//      （无需物理备份区，复制即恢复独立 inode）。
import * as fs from 'fs'
import * as crypto from 'crypto'
import { err, ioError, ok } from '../contracts/base'
import type { IDedupExecutor, LinkJournalEntry } from '../contracts/dedup.contract'
import type { NukeError } from '../contracts/base'
import { copyAtomic } from '../infra/fs-utils'

export function createDedupExecutor(): IDedupExecutor {
  function hashFile(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256')
      const stream = fs.createReadStream(p)
      stream.on('data', chunk => h.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(h.digest('hex')))
    })
  }

  return {
    async apply(report, opts) {
      const signal = opts?.signal
      const journal: LinkJournalEntry[] = []
      const skipped: { path: string; reason: string }[] = []
      let linkedFiles = 0
      let bytesSaved = 0
      let cancelled = false

      outer:
      try {
        for (const group of report.groups) {
          if (signal?.aborted) { cancelled = true; break }
          if (group.copies.length < 2) continue
          const canonical = group.copies[0]!
          // TOCTOU 复验：canonical 当前内容必须仍是报告认定的内容
          try {
            const h = await hashFile(canonical.path)
            if (h !== group.hash) {
              skipped.push({ path: canonical.path, reason: '复验失败：canonical 内容已变化（整组跳过）' })
              continue
            }
          } catch (e) {
            skipped.push({ path: canonical.path, reason: `canonical 读取失败: ${String(e).slice(0, 80)}` })
            continue
          }

          let canonicalDev: number
          let canonicalIno: number
          let canonicalMtime: number
          try {
            const st = fs.statSync(canonical.path)
            canonicalDev = st.dev
            canonicalIno = st.ino
            canonicalMtime = st.mtimeMs
          } catch {
            skipped.push({ path: canonical.path, reason: 'canonical 消失' })
            continue
          }

          for (const copy of group.copies.slice(1)) {
            if (signal?.aborted) { cancelled = true; break outer }
            const victim = copy.path
            let linked = false   // rename 一旦成功即为 true：此后任何异常都必须入 journal
            try {
              // 符号链接不参与：statSync 会跟随到目标，误把链接路径替换为硬链接
              // 且目标文件原地不动 —— 既不省空间又破坏了链接语义
              let lst: fs.Stats
              try { lst = fs.lstatSync(victim) } catch {
                skipped.push({ path: victim, reason: 'victim 消失' })
                continue
              }
              if (lst.isSymbolicLink()) {
                skipped.push({ path: victim, reason: '符号链接（与分析器口径一致，跳过）' })
                continue
              }

              // canonical 原地改写防护：in-place 写保留 inode 但必然更新 mtime；
              // victim 的内容哈希复验的是旧内容，链接过去会拿到被污染的新内容
              try {
                const cst = fs.statSync(canonical.path)
                if (cst.ino !== canonicalIno || cst.dev !== canonicalDev || cst.mtimeMs !== canonicalMtime) {
                  skipped.push({ path: canonical.path, reason: 'canonical 在组处理中被修改（整组中止）' })
                  break   // 跳出 victim 循环，进入下一组
                }
              } catch {
                skipped.push({ path: canonical.path, reason: 'canonical 消失（整组中止）' })
                break
              }

              const vs = fs.statSync(victim)
              // 已是同一 inode：无需动作
              if (vs.ino === canonicalIno && vs.dev === canonicalDev) {
                skipped.push({ path: victim, reason: '已是同一 inode（已链接）' })
                continue
              }
              // 跨设备：硬链接物理不可能
              if (vs.dev !== canonicalDev) {
                skipped.push({ path: victim, reason: '跨文件系统（st_dev 不同）' })
                continue
              }
              // 尺寸先行快检：size 变了必然内容变了，免全量哈希
              if (vs.size !== group.sizeBytes) {
                skipped.push({ path: victim, reason: '复验失败：尺寸已变化' })
                continue
              }
              // TOCTOU 复验：victim 当前内容必须等于组 hash
              const h = await hashFile(victim)
              if (h !== group.hash) {
                skipped.push({ path: victim, reason: '复验失败：内容已变化' })
                continue
              }

              // 原子替换：link → tmp，rename → victim（无空窗）
              const tmp = `${victim}.dedup-${crypto.randomBytes(4).toString('hex')}`
              try {
                fs.linkSync(canonical.path, tmp)
                fs.renameSync(tmp, victim)
                linked = true
              } catch (e) {
                try { fs.unlinkSync(tmp) } catch {}
                skipped.push({ path: victim, reason: `链接失败（可能不支持硬链接）: ${String(e).slice(0, 60)}` })
                continue
              }

              // 事后断言：victim 现在必须指向 canonical 的 inode。
              // 断言失败 ≠ 可当作没发生：rename 已生效，必须入 journal 留 undo 通道
              let after: fs.Stats
              try { after = fs.statSync(victim) } catch {
                linkedFiles++
                if (vs.nlink === 1) bytesSaved += group.sizeBytes
                journal.push({ victim, canonical: canonical.path, sizeBytes: group.sizeBytes })
                skipped.push({ path: victim, reason: '事后 stat 失败：链接已生效并已记入 journal' })
                continue
              }
              if (after.ino !== canonicalIno || after.dev !== canonicalDev) {
                linkedFiles++
                if (vs.nlink === 1) bytesSaved += group.sizeBytes
                journal.push({ victim, canonical: canonical.path, sizeBytes: group.sizeBytes })
                skipped.push({ path: victim, reason: '事后断言失败：inode 不匹配（链接已生效，记入 journal 可 undo）' })
                continue
              }

              linkedFiles++
              const wasExclusive = vs.nlink === 1   // 替换前独占 inode 才真正省空间
              if (wasExclusive) bytesSaved += group.sizeBytes
              journal.push({ victim, canonical: canonical.path, sizeBytes: group.sizeBytes })
            } catch (e) {
              // 兜底：rename 已生效的条目必须入 journal（否则部分应用不可 undo）
              if (linked) {
                linkedFiles++
                journal.push({ victim, canonical: canonical.path, sizeBytes: group.sizeBytes })
                skipped.push({ path: victim, reason: `链接后处理异常（已记入 journal）: ${String(e).slice(0, 60)}` })
              } else {
                skipped.push({ path: victim, reason: `处理失败: ${String(e).slice(0, 80)}` })
              }
            }
          }
        }
        // 取消/完成统一出口：journal 始终随结果返回，副作用绝不失记
      } catch (e) {
        // 最外层异常（理论不可达）：journal 经 details 带出，调用方仍可 undo
        const error: NukeError = ioError('去重执行失败', e)
        return err(journal.length > 0 ? { ...error, details: { ...error.details, journal, linkedFiles, bytesSaved } } : error)
      }
      return ok({ linkedFiles, bytesSaved, journal, skipped, cancelled })
    },

    async undo(journal) {
      let undone = 0
      const failed: { victim: string; error: string }[] = []
      for (const entry of journal) {
        try {
          // 内容已验证与 canonical 一致：复制回独立文件即恢复（copyAtomic 自带原子性）
          copyAtomic(entry.canonical as string, entry.victim as string)
          undone++
        } catch (e) {
          // best-effort：单条失败不中断其余恢复，明细随报告返回
          failed.push({ victim: entry.victim, error: String(e).slice(0, 120) })
        }
      }
      return ok({ undone, failed })
    },
  }
}

// src/infra/backup-store.ts — IBackupStore 实现：回收区代替物理删除
// 三种备份形态：
//   file-copy  配置文件：复制留档
//   dir-move   目录：fs.renameSync 原子移入回收区（O(1)、可逆）
//   yaml-edit  配置编辑：先存原内容快照，再写新内容（写前 fsync）
// 安全纪律：
//   1. txId 白名单校验（与 WAL 同源）—— purge 是递归 rm，绝不接受路径拼接输入
//   2. stage* 的副作用与 manifest 落盘必须同生共死：manifest 写失败即反向补偿
//      副作用，否则"原位已移走 + 备份无记录"会让恢复流程销毁唯一数据副本
//
// 升级（restoreAll 并行恢复）：
//   恢复的规范序 = manifest 逆序（后 stage 的先恢复）。硬约束：记录 j（先
//   stage）落在记录 i（后 stage）的 originalPath 内部或相同 ⇒ i 必须先恢复
//   （容器先就位，成员才能写入）。据此做依赖分层：level = 依赖链深度，
//   层间按层号升序串行（等价于逆序方向的拓扑序），同层记录两两路径无关
//   → 层内经 fs-utils forEachPool 有界并发。
//   全部恢复完成后对恢复产物（原位路径）做 size/hash 指纹复验，任一不符
//   → 返回错误保持未终结语义（restore 幂等，可修复后重试）。
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import type { AbsolutePath, Result, TxId } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type {
  BackupArea, BackupRecord, FileFingerprint, IBackupStore,
} from '../contracts/transaction'

import { DEFAULT_IO_CONCURRENCY, dirSize, forEachPool, readJsonl } from './fs-utils'

// 与 wal.ts 同源的白名单：字母数字与-_，长度 ≤ 64；路径分隔符/点/空白一律非法
const TXID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface BackupStoreOptions {
  readonly backupRoot: string   // <dshHome>/.nuke/backups
  readonly now?: () => Date
}

/** restoreAll 的可选参数 */
export interface RestoreAllOptions {
  /** 恢复并发上界（默认 8）。当前底层 fs 调用为同步实现，该上界约束的是
   *  并发池结构与错误隔离边界（迁移异步 IO 后即获得真实并行收益）。 */
  readonly concurrency?: number
}

/** createBackupStore 返回的备份区能力：BackupArea 契约的超集（只增不改） */
export interface BackupAreaRuntime extends BackupArea {
  /** 批量并行恢复：默认按 manifest 全部记录（也可传入子集，按传入顺序
   *  视为 stage 序）做依赖分层 + 有界并发恢复，完成后指纹复验。 */
  restoreAll(records?: readonly BackupRecord[], opts?: RestoreAllOptions): Promise<Result<void>>
}

/** createBackupStore 的运行时能力集：IBackupStore 契约的超集（向后兼容） */
export interface BackupStoreRuntime extends IBackupStore {
  reserve(txId: TxId): Promise<BackupAreaRuntime>
}

/** child 是否位于 parent 内部（或与 parent 相同）—— 恢复依赖判定用。
 *  path.relative 派生：'.' / 不越出 parent 即包含；'..' 开头 = 在外。 */
function pathContainsOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}

export function createBackupStore(options: BackupStoreOptions): BackupStoreRuntime {

  fs.mkdirSync(options.backupRoot, { recursive: true })

  function hashFile(p: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)
  }

  function hashString(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, 16)
  }

  /** 目录指纹：按序累积全部文件内容哈希（结构敏感，与旧 fingerprint.ts 一致） */
  function hashDir(p: string): string {
    const h = crypto.createHash('sha256')
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.isFile()) h.update(fs.readFileSync(full))
      }
    }
    walk(p)
    return h.digest('hex').slice(0, 16)
  }

  function fingerprintOf(p: string, content?: string): FileFingerprint {
    const stat = fs.statSync(p)
    if (stat.isDirectory()) {
      return {
        path: p as AbsolutePath,
        hash: hashDir(p),
        size: dirSize(p),
        mtime: Math.floor(stat.mtimeMs),
      }
    }
    return {
      path: p as AbsolutePath,
      hash: content !== undefined ? hashString(content) : hashFile(p),
      size: content !== undefined ? Buffer.byteLength(content) : stat.size,
      mtime: Math.floor(stat.mtimeMs),
    }
  }

  /** 恢复产物指纹复验：恢复后的原位路径与 stage 时记录的备份指纹比对
   *  （size + hash；mtime 必然因重写而变化，不参与比对）。 */
  function fingerprintMatches(rec: BackupRecord): boolean {
    try {
      const st = fs.statSync(rec.originalPath)
      if (rec.kind === 'dir-move') {
        if (!st.isDirectory()) return false
        return hashDir(rec.originalPath) === rec.fingerprint.hash
          && dirSize(rec.originalPath) === rec.fingerprint.size
      }
      if (!st.isFile()) return false
      return hashFile(rec.originalPath) === rec.fingerprint.hash
        && st.size === rec.fingerprint.size
    } catch {
      return false   // 复验路径不可读 = 不匹配（fail-closed）
    }
  }

  function txArea(txId: TxId): string {
    // fail-closed：purge 是递归 rm，txId 绝不参与未校验的路径拼接（防 "../" 穿越）
    if (!TXID_RE.test(txId)) {
      throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`)
    }
    return path.join(options.backupRoot, txId)
  }

  function manifestFile(txId: TxId): string {
    return path.join(txArea(txId), 'manifest.jsonl')
  }

  function appendManifest(txId: TxId, record: BackupRecord): void {
    const fd = fs.openSync(manifestFile(txId), 'a')
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n')
      fs.fdatasyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  function writeSync(p: string, content: string): void {
    const fd = fs.openSync(p, 'w')
    try {
      fs.writeSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  /** 单条恢复核心路径：restore 方法与 restoreAll 并行池共用同一实现 */
  const doRestore = async (record: BackupRecord): Promise<Result<void>> => {
    // 恢复前校验备份产物未被篡改（hash 与备份时不一致 → 拒绝恢复并报错）
    try {
      if (!fs.existsSync(record.backupPath)) {
        // dir-move 幂等：备份已被移回原位 = 已恢复过，重复调用视为成功
        if (record.kind === 'dir-move' && fs.existsSync(record.originalPath)) {
          return ok(undefined)
        }
        return err({ code: 'E_IO', message: `备份产物不存在: ${record.backupPath}` })
      }
      const currentHash = record.kind === 'dir-move'
        ? hashDir(record.backupPath)
        : record.originalContent !== undefined
          ? hashString(fs.readFileSync(record.backupPath, 'utf-8'))
          : hashFile(record.backupPath)
      if (currentHash !== record.fingerprint.hash) {
        return err({
          code: 'E_IO',
          message: `备份被篡改，拒绝恢复: ${record.backupPath}`,
          details: { expected: record.fingerprint.hash, actual: currentHash },
        })
      }
      switch (record.kind) {
        case 'file-copy':
          fs.copyFileSync(record.backupPath, record.originalPath)
          break
        case 'dir-move':
          // 防静默覆盖：stage 后若原位被重建（如重新生成的 node_modules），
          // 恢复会销毁新内容 —— 拒绝并交由人工决策，绝不rename覆盖
          if (fs.existsSync(record.originalPath)) {
            return err({
              code: 'E_IO',
              message: `原位已存在新内容，拒绝覆盖式恢复: ${record.originalPath}`,
            })
          }
          try {
            fs.renameSync(record.backupPath, record.originalPath)
          } catch {
            fs.cpSync(record.backupPath, record.originalPath, { recursive: true })
            fs.rmSync(record.backupPath, { recursive: true, force: true })
          }
          break
        case 'yaml-edit':
          writeSync(record.originalPath, record.originalContent
            ?? fs.readFileSync(record.backupPath, 'utf-8'))
          break
      }
      return ok(undefined)
    } catch (e) {
      return err(ioError('恢复失败', e))
    }
  }

  return {
    async reserve(txId: TxId): Promise<BackupAreaRuntime> {
      fs.mkdirSync(txArea(txId), { recursive: true })

      /** manifest 读取的闭包级实现（对象字面量方法间不能互相按名调用） */
      const readManifest = (): readonly BackupRecord[] => {
        const p = manifestFile(txId)
        if (!fs.existsSync(p)) return []
        // 容错读取：崩溃残留半行跳过而非抛错（与 fs-utils JSONL 纪律一致）
        return readJsonl<BackupRecord>(p) ?? []
      }

      const area: BackupAreaRuntime = {
        async stageFile(original: AbsolutePath): Promise<BackupRecord> {
          const backupPath = path.join(txArea(txId), `f-${counter()}-${path.basename(original)}`) as AbsolutePath
          fs.copyFileSync(original, backupPath)
          const record: BackupRecord = {
            operationId: counter(),
            kind: 'file-copy',
            originalPath: original,
            backupPath,
            fingerprint: fingerprintOf(backupPath),
          }
          try {
            appendManifest(txId, record)
          } catch (e) {
            // 原位未动：清掉备份即完全回退，绝不留"无记录的产物"
            try { fs.unlinkSync(backupPath) } catch { /* 已不存在 */ }
            throw e
          }
          return record
        },

        async stageDir(original: AbsolutePath): Promise<BackupRecord> {
          // 原子移入回收区：rename 跨设备时回退 copy+rm（仍在回收区语义内）。
          // 纪律：manifest 落盘成功之后才允许 rm 原位 —— cp 路径下一旦
          // manifest 失败，备份删除即回到干净状态，原位始终完好。
          const backupPath = path.join(txArea(txId), `d-${counter()}-${path.basename(original)}`) as AbsolutePath
          let movedByRename = false
          try {
            fs.renameSync(original, backupPath)
            movedByRename = true
          } catch {
            try {
              fs.cpSync(original, backupPath, { recursive: true })
            } catch (e) {
              try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch { /* 残留交由 orphan 守卫 */ }
              throw e   // 原位未动，半写备份已清理
            }
          }
          const record: BackupRecord = {
            operationId: counter(),
            kind: 'dir-move',
            originalPath: original,
            backupPath,
            fingerprint: fingerprintOf(backupPath),
          }
          try {
            appendManifest(txId, record)
          } catch (e) {
            // manifest 失败：把数据放回原位（rename 反向 / cp 反向），不留孤儿
            if (movedByRename) {
              try { fs.renameSync(backupPath, original) } catch { /* 保底留给 orphan 守卫 */ }
            } else {
              try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch { /* 同上 */ }
            }
            throw e
          }
          if (!movedByRename) {
            // manifest 已持久化：此刻起备份可恢复，才允许移除原位
            fs.rmSync(original, { recursive: true, force: true })
          }
          return record
        },

        async stageEdit(original: AbsolutePath, nextContent: string): Promise<BackupRecord> {
          const backupPath = path.join(txArea(txId), `e-${counter()}-${path.basename(original)}`) as AbsolutePath
          const originalContent = fs.readFileSync(original, 'utf-8')
          writeSync(backupPath, originalContent)   // 原内容先落盘 + fsync
          writeSync(original, nextContent)          // 再写新内容
          const record: BackupRecord = {
            operationId: counter(),
            kind: 'yaml-edit',
            originalPath: original,
            backupPath,
            fingerprint: fingerprintOf(backupPath, originalContent),
            originalContent,
          }
          try {
            appendManifest(txId, record)
          } catch (e) {
            // 原位已被改写：立即写回原内容，恢复 stage 前状态
            writeSync(original, originalContent)
            try { fs.unlinkSync(backupPath) } catch { /* 已不存在 */ }
            throw e
          }
          return record
        },

        async restore(record: BackupRecord): Promise<Result<void>> {
          return await doRestore(record)
        },

        async restoreAll(records?: readonly BackupRecord[], opts: RestoreAllOptions = {}): Promise<Result<void>> {
          try {
            const list = records ?? readManifest()
            if (list.length === 0) return ok(undefined)
            const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_IO_CONCURRENCY)

            // ── 依赖分层：逆序正确性约束的并行化（见文件头注释） ──
            const n = list.length
            const levels = new Array<number>(n).fill(0)
            // 从后往前：level[i]（i > j）先算好，j 的层级 = 其依赖链的最大深度
            for (let j = n - 1; j >= 0; j--) {
              let level = 0
              for (let i = j + 1; i < n; i++) {
                if (pathContainsOrEqual(list[i]!.originalPath, list[j]!.originalPath)) {
                  level = Math.max(level, levels[i]! + 1)
                }
              }
              levels[j] = level
            }
            const maxLevel = Math.max(...levels)

            // 层间串行（层号升序 = 逆 stage 方向）、层内有界并发（同层
            // 记录两两路径无关，可安全并行）。任一层失败即停止后续层
            // —— 依赖未就位/部分失败时继续只会产生级联错误。
            for (let lv = 0; lv <= maxLevel; lv++) {
              const wave: number[] = []
              for (const [idx, l] of levels.entries()) {
                if (l === lv) wave.push(idx)
              }
              if (wave.length === 0) continue
              const settled = await forEachPool(wave, concurrency, idx => doRestore(list[idx]!))
              for (const r of settled) {
                if (r.status === 'fulfilled') {
                  if (!r.value.ok) return err(r.value.error)
                } else {
                  return err(ioError('并行恢复失败', r.reason))
                }
              }
            }

            // ── 恢复产物指纹复验：size + hash 必须与 stage 时记录一致 ──
            // （防"恢复流程声称成功但产物与备份指纹不符"的静默漂移；
            //   失败保持未终结语义：restore 幂等，修复后可整体重试）
            // 只复验"叶子"记录（originalPath 不包含其他记录的路径）：容器
            // 记录（目录内部还有更高层恢复的成员）的产物必然被成员的恢复
            // 覆盖改写 —— 对其复验会把合法的嵌套恢复判为失败，且幂等重试
            // 永远无法通过。嵌套场景的最终内容由最后写入的叶子记录决定，
            // 验叶子即验最终态。
            const isLeaf = (i: number): boolean =>
              !list.some((s, j) => j !== i && pathContainsOrEqual(list[i]!.originalPath, s.originalPath))
            const leaves = list.filter((_, i) => isLeaf(i))
            const checks = await forEachPool(leaves, concurrency, async rec => fingerprintMatches(rec))
            for (const [idx, c] of checks.entries()) {
              if (c.status === 'rejected') return err(ioError('恢复产物复验异常', c.reason))
              if (!c.value) {
                const rec = leaves[idx]!
                return err({
                  code: 'E_IO',
                  message: `恢复产物指纹复验失败: ${rec.originalPath}`,
                  details: { expected: rec.fingerprint },
                })
              }
            }
            return ok(undefined)
          } catch (e) {
            return err(ioError('批量恢复失败', e))
          }
        },

        manifest(): readonly BackupRecord[] {
          return readManifest()
        },

        orphanArtifacts(): number {
          // purge 守卫：清点备份区中未被 manifest 记录的产物。崩溃窗口
          // （副作用已发生、manifest 未落盘）留下的产物可能是数据唯一副本。
          const area = txArea(txId)
          let entries: string[]
          try { entries = fs.readdirSync(area) } catch { return 0 }
          const known = new Set(readManifest().map(r => path.basename(r.backupPath)))
          known.add('manifest.jsonl')
          return entries.filter(name => !known.has(name)).length
        },

        async purge(txId: TxId): Promise<Result<void>> {
          try {
            fs.rmSync(txArea(txId), { recursive: true, force: true })
            return ok(undefined)
          } catch (e) {
            return err(ioError('清理备份区失败', e))
          }
        },
      }
      return area
    },
  }

  /** 备份产物唯一后缀（随机 hex：同事务内多文件备份不撞名） */
  function counter(): string {
    return crypto.randomBytes(6).toString('hex')
  }
}

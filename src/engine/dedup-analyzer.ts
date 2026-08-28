// src/engine/dedup-analyzer.ts — IDedupAnalyzer 实现：内容寻址去重分析
// 三级瀑布算法（rmlint/rmlints 同族的世界级方案，性能关键）：
//   阶段一  size 分桶 —— 同尺寸才可能同内容；尺寸唯一的文件零哈希成本淘汰
//   阶段二  头+中+尾三段采样指纹（各 4KB）—— 采样不同即淘汰，不做全量读。
//           三段覆盖三类现实"同质段"盲区：头（magic number/shebang/JSON 前缀
//           相同的 bundle）、尾（padding/trailer/签名后缀相同）、中（头尾都对
//           但中部不同 —— 打包器时间戳/构建号差异的典型形态）。双段采样对
//           第三类无能为力，只能漏到阶段三全量哈希兜底（正确但贵）。
//   阶段三  仅对采样碰撞组计算全量 SHA-256 —— 零误报的最终裁决
// 并行哈希：有界并发池（默认 8 路），SSD 上接近线性加速。
// 安全属性：跳过符号链接（防哈希到逃逸目标）；流式读取（大文件不占内存）；
// AbortSignal 在目录遍历、采样、全量哈希三个层面响应取消。
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import type { AbsolutePath, ProfileName } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { DedupGroup, DedupReport, IDedupAnalyzer } from '../contracts/dedup.contract'
import { DEFAULT_IO_CONCURRENCY, forEachPool } from '../infra/fs-utils'

export interface DedupAnalyzerOptions {
  readonly dshHome: string
  readonly now?: () => number
  /** 报告保留的最大分组数（默认 100），超出部分仅计入总量 */
  readonly maxGroups?: number
}

const PROFILE_RE = /(?:^|[/\\])profiles[/\\]([^/\\]+)[/\\]/

export function createDedupAnalyzer(options: DedupAnalyzerOptions): IDedupAnalyzer {
  const now = options.now ?? (() => Date.now())
  const maxGroups = options.maxGroups ?? 100

  function defaultRoots(): string[] {
    const out: string[] = []
    const profilesDir = path.join(options.dshHome, 'profiles')
    try {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(path.join(profilesDir, e.name, 'node_modules'))
      }
    } catch { /* profiles 不存在 → 无默认根 */ }
    return out
  }

  function profileOf(p: string): ProfileName | null {
    const m = PROFILE_RE.exec(p)
    return m === null ? null : (m[1] as ProfileName)
  }

  /** 收集参与分析的文件：跳过符号链接、过滤小文件 */
  function collect(
    roots: readonly string[],
    minSize: number,
    signal: AbortSignal | undefined,
  ): { bySize: Map<number, string[]>; filesScanned: number; bytesScanned: number } | null {
    const bySize = new Map<number, string[]>()
    let filesScanned = 0
    let bytesScanned = 0

    const walk = (dir: string): boolean => {
      if (signal?.aborted) return false
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return true }
      for (const e of entries) {
        if (signal?.aborted) return false
        const full = path.join(dir, e.name)
        if (e.isSymbolicLink()) continue          // 防符号链接逃逸/重复计数
        if (e.isDirectory()) { if (!walk(full)) return false }
        else if (e.isFile()) {
          let size: number
          try { size = fs.statSync(full).size } catch { continue }
          if (size < minSize) continue             // 小文件：哈希成本 > 回收价值
          filesScanned++
          bytesScanned += size
          const bucket = bySize.get(size)
          if (bucket) bucket.push(full)
          else bySize.set(size, [full])
        }
      }
      return true
    }

    for (const root of roots) {
      if (!walk(root)) return null                 // 被取消
    }
    return { bySize, filesScanned, bytesScanned }
  }

  async function hashFile(p: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256')
      const stream = fs.createReadStream(p)
      stream.on('data', chunk => h.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => { resolve(h.digest('hex')); })
    })
  }

  const SAMPLE_BYTES = 4096

  /** 头+中+尾三段采样指纹：一次 open + 至多三次定位 read（≤12KB IO），
   *  绝不读全量。退化规则：size ≤ S 仅头；S < size ≤ 2S 头+尾（中段与
   *  头/尾重叠无增益）；size > 2S 头+中+尾（2S~3S 区间中段与头尾部分
   *  重叠 —— 重复字节无害，指纹只需确定性不需采样不重叠）。
   *  中段起点 = (size-S)/2 向下取整（中点对齐，两侧对称）。
   *  fh.read 的 position 精确定位由 FileHandle API 保证；采样窗口全部
   *  落在 [0, size) 内，不存在短读歧义。 */
  async function sampleFingerprint(p: string, size: number): Promise<string> {
    const fh = await fs.promises.open(p, 'r')
    try {
      const h = crypto.createHash('sha256')
      const readAt = async (len: number, position: number): Promise<void> => {
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, position)
        h.update(buf)
      }
      const headLen = Math.min(SAMPLE_BYTES, size)
      await readAt(headLen, 0)
      if (size > SAMPLE_BYTES) {
        await readAt(SAMPLE_BYTES, size - SAMPLE_BYTES)
      }
      if (size > 2 * SAMPLE_BYTES) {
        await readAt(SAMPLE_BYTES, Math.floor((size - SAMPLE_BYTES) / 2))
      }
      return `s:${h.digest('hex')}`
    } finally {
      await fh.close()
    }
  }

  return {
    async analyze(analyzeOptions) {
      const started = now()
      const signal = analyzeOptions?.signal
      const minSize = analyzeOptions?.minSizeBytes ?? 4096
      const roots = (analyzeOptions?.roots ?? defaultRoots()) as string[]

      if (roots.length === 0) {
        return ok({
          groups: [], totalReclaimableBytes: 0, filesScanned: 0, bytesScanned: 0, durationMs: 0,
        })
      }

      try {
        // ── 阶段一：size 分桶（尺寸唯一即淘汰，零哈希成本）
        const collected = collect(roots, minSize, signal)
        if (!collected) return err({ code: 'E_CANCELLED', message: '去重分析被取消' })
        const { bySize, filesScanned, bytesScanned } = collected
        let sizeEliminated = 0
        const candidates: { size: number; paths: string[] }[] = []
        for (const [size, paths] of bySize) {
          if (paths.length < 2) { sizeEliminated += paths.length; continue }
          candidates.push({ size, paths })
        }

        // ── 阶段二：头尾采样指纹（并发池），采样不同即淘汰
        let sampleEliminated = 0
        let bytesSaved = 0   // 被采样淘汰的文件本应全量读的字节
        const sampleCollisions: { size: number; paths: string[] }[] = []
        for (const { size, paths } of candidates) {
          if (signal?.aborted) return err({ code: 'E_CANCELLED', message: '去重分析被取消' })
          const bySample = new Map<string, string[]>()
          const settled = await forEachPool(paths, DEFAULT_IO_CONCURRENCY, async p =>
            ({ p, fp: await sampleFingerprint(p, size) }))
          for (const r of settled) {
            if (r.status !== 'fulfilled') continue   // 读失败的文件不参与
            const { p, fp } = r.value
            const bucket = bySample.get(fp)
            if (bucket) bucket.push(p)
            else bySample.set(fp, [p])
          }
          for (const bucket of bySample.values()) {
            if (bucket.length < 2) {
              sampleEliminated += bucket.length
              bytesSaved += bucket.length * size
            } else {
              sampleCollisions.push({ size, paths: bucket })
            }
          }
        }

        // ── 阶段三：仅采样碰撞组做全量 SHA-256（零误报最终裁决，并发池）
        const groups: DedupGroup[] = []
        let fullHashed = 0
        for (const { size, paths } of sampleCollisions) {
          if (signal?.aborted) return err({ code: 'E_CANCELLED', message: '去重分析被取消' })
          const byHash = new Map<string, string[]>()
          const settled = await forEachPool(paths, DEFAULT_IO_CONCURRENCY, async p =>
            ({ p, hash: await hashFile(p) }))
          for (const r of settled) {
            if (r.status !== 'fulfilled') continue
            const { p, hash } = r.value
            fullHashed++
            const bucket = byHash.get(hash)
            if (bucket) bucket.push(p)
            else byHash.set(hash, [p])
          }
          for (const [hash, copies] of byHash) {
            if (copies.length < 2) continue
            groups.push({
              hash, sizeBytes: size,
              copies: copies.map(p => ({ path: p as AbsolutePath, profile: profileOf(p) })),
              reclaimableBytes: (copies.length - 1) * size,
            })
          }
        }

        groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes)
        const totalReclaimableBytes = groups.reduce((s, g) => s + g.reclaimableBytes, 0)

        const report: DedupReport = {
          groups: groups.slice(0, maxGroups),
          totalReclaimableBytes,
          filesScanned,
          bytesScanned,
          durationMs: now() - started,
          stages: { sizeEliminated, sampleEliminated, fullHashed, bytesSavedBySampling: bytesSaved },
        }
        return ok(report)
      } catch (e) {
        return err(ioError('去重分析失败', e))
      }
    },
  }
}

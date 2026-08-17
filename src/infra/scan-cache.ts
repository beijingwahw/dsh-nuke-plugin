// src/infra/scan-cache.ts — 增量扫描缓存：mtime+size 指纹校验的结果复用
// 突破点：二次扫描近瞬时。扫描最贵的两类操作是
//   1. contains 检查（readFileSync 整个 yaml/json）
//   2. dirSize（目录全量递归）
// 本缓存以 path 为键存 {mtimeMs, size, containsHit, dirBytes}，读取方用
// 它已经做的那一次 stat 校验指纹 —— 命中则零 IO 复用，未命中才真正计算。
//
// 正确性论证（诚实版）：
//   - 文件条目（containsHit）严格正确：内容变化 ⇒ mtime 或 size 变化
//   - 目录条目（dirBytes）：直接子项增删 ⇒ 目录 mtime 变化 ⇒ 立即失效；
//     但嵌套文件的【原地改写】（尺寸不变、无增删）不改变任何祖先目录的 mtime
//     ⇒ 此类变化检测不到，由 maxAgeMs（默认 24h）兜底 bounding 过期时间。
//     dirBytes 仅用于回收空间【估算】（真实回收量由清理步骤实测），此语义可接受。
//   - atime 不缓存：读取本身会更新 atime，缓存它必然自我污染
//   - 指纹校验失败 ⇒ 当 miss 处理并回写新值 —— 保守方向是"多算"而非"错算"
//
// 持久化：单 JSON 文件 + 版本号；损坏/缺版本 ⇒ 视为空缓存（磁盘数据不可信纪律）。
// 驱逐：LRU 上限（默认 4096 条），溢出逐最旧。

import * as fs from 'fs'
import * as path from 'path'
import { writeJsonAtomic } from './fs-utils'

export interface ScanCacheEntry {
  readonly mtimeMs: number
  readonly size: number
  /** isFile 检查点的 contains 命中结果（false = 不含目标，跳过产出证据） */
  readonly containsHit?: boolean
  /** 目录检查点的递归体积（字节，估算值：见头部正确性论证） */
  readonly dirBytes?: number
}

export interface ScanCacheOptions {
  readonly filePath: string
  /** 条目上限（LRU），默认 4096 */
  readonly maxEntries?: number
  /** 条目最大年龄（ms），默认 24h：目录嵌套原地改写检测不到，TTL 兜底 */
  readonly maxAgeMs?: number
}

interface PersistedEntry extends ScanCacheEntry {
  readonly cachedAt: number
}

interface PersistedShape {
  readonly version: 1
  readonly entries: Record<string, PersistedEntry>
}

const MAX_DEFAULT = 4096
const MAX_AGE_MS_DEFAULT = 24 * 3600 * 1000

export interface IScanCache {
  /** 指纹匹配则返回缓存条目，否则 null（miss）。命中会刷新 LRU 热度。 */
  get(filePath: string, mtimeMs: number, size: number): ScanCacheEntry | null
  /** 写入/更新条目（内存态；flush 前不落盘） */
  set(filePath: string, entry: ScanCacheEntry): void
  /** 原子落盘；无变更则零 IO */
  flush(): void
  /** 调试/报告用：当前条目数与命中统计 */
  stats(): { entries: number; hits: number; misses: number }
}

export function createScanCache(options: ScanCacheOptions): IScanCache {
  const maxEntries = options.maxEntries ?? MAX_DEFAULT
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS_DEFAULT
  // Map 迭代序 = 插入序：LRU 由"读/写前先 delete 再 set"实现
  const cache = new Map<string, PersistedEntry>()
  let dirty = false
  let hits = 0
  let misses = 0

  // 磁盘数据不可信：缺版本/损坏/结构异常 ⇒ 空缓存起步
  try {
    if (fs.existsSync(options.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(options.filePath, 'utf-8')) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const shape = parsed as Partial<PersistedShape>
        if (shape.version === 1 && typeof shape.entries === 'object' && shape.entries !== null) {
          for (const [k, v] of Object.entries(shape.entries)) {
            if (typeof v === 'object' && v !== null &&
                typeof (v as PersistedEntry).mtimeMs === 'number' &&
                typeof (v as PersistedEntry).size === 'number' &&
                typeof (v as PersistedEntry).cachedAt === 'number') {
              cache.set(k, v as PersistedEntry)
            }
          }
        }
      }
    }
  } catch { /* 损坏缓存 ⇒ 空缓存 */ }

  function evictIfNeeded(): void {
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  return {
    get(filePath, mtimeMs, size) {
      const hit = cache.get(filePath)
      if (hit === undefined) { misses++; return null }
      // 指纹校验：mtime 或 size 任一变化 ⇒ 内容已变 ⇒ miss
      if (hit.mtimeMs !== mtimeMs || hit.size !== size) { misses++; return null }
      // TTL 校验：目录嵌套原地改写检测不到，年龄兜底（见头部论证）。
      // maxAgeMs=0 语义 = 禁用缓存（age >= 0 恒真）
      if (Date.now() - hit.cachedAt >= maxAgeMs) { misses++; return null }
      hits++
      // LRU 热度刷新
      cache.delete(filePath)
      cache.set(filePath, hit)
      return hit
    },

    set(filePath, entry) {
      cache.delete(filePath)
      cache.set(filePath, { ...entry, cachedAt: Date.now() })
      evictIfNeeded()
      dirty = true
    },

    flush() {
      if (!dirty) return
      const shape: PersistedShape = { version: 1, entries: Object.fromEntries(cache) }
      try {
        fs.mkdirSync(path.dirname(options.filePath), { recursive: true })
        writeJsonAtomic(options.filePath, shape)
        dirty = false
      } catch { /* 落盘失败不致命：缓存本来就是加速器 */ }
    },

    stats() { return { entries: cache.size, hits, misses } },
  }
}

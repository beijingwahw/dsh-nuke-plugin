// src/infra/ledger.ts — ILedger 实现：空间台账（append-only JSONL）
// 存储与 trend.jsonl 同款：尾部半行容错、原子追加。
// 聚合升级：query 单次遍历产出全维度结果（totals 与 byAction/byProfile/byDay
// 三维索引在同一循环累计），不再逐维度反复扫数组；配合 stat 指纹解析缓存，
// 重复 query（仪表盘轮询/多维过滤）不重复磁盘 IO 与 JSON.parse。
import * as fs from 'fs'
import * as path from 'path'
import { err, ioError, ok } from '../contracts/base'
import { appendJsonl, readJsonl } from './fs-utils'
import type {
  ILedger, LedgerBreakdown, LedgerEntry, LedgerQuery, LedgerSummary,
} from '../contracts/ledger.contract'

export interface LedgerOptions {
  readonly historyDir: string
}

/** 聚合桶（内部可变累计器；输出前转换为只读 LedgerBreakdown） */
interface Bucket { bytes: number; count: number }

export function createLedger(options: LedgerOptions): ILedger {
  const file = path.join(options.historyDir, 'ledger.jsonl')

  // ─── 解析缓存：stat 指纹（size:mtimeMs）判定失效 ──────────────
  // 台账 append-only：指纹不变 ⇒ 内容未变。record 追加、外部直写、
  // 半行补全都必然改变 size 或 mtime，触发全量重读 —— 缓存对手工编辑/
  // 跨进程写入保持诚实；文件不存在（stat 失败）缓存空起步，语义与
  // "读取失败按空台账"一致。
  let cachedStamp: string | null = null
  let cachedEntries: LedgerEntry[] = []

  function statStamp(): string | null {
    try {
      const st = fs.statSync(file)
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return null
    }
  }

  function readAll(): LedgerEntry[] {
    const stamp = statStamp()
    if (stamp === cachedStamp) return cachedEntries
    const parsed = readJsonl<LedgerEntry>(file)
    // 可读性失败（权限等瞬态）不落缓存：下次调用仍会重试读盘
    if (parsed !== null) {
      cachedEntries = parsed
      cachedStamp = stamp
    }
    return parsed ?? []
  }

  function matches(e: LedgerEntry, filter: LedgerQuery | undefined): boolean {
    return (filter?.kind === undefined || e.kind === filter.kind)
      && (filter?.profile === undefined || e.profile === filter.profile)
      && (filter?.since === undefined || e.at >= filter.since)
  }

  function bump(m: Map<string, Bucket>, key: string, bytes: number): void {
    const cur = m.get(key)
    if (cur === undefined) m.set(key, { bytes, count: 1 })
    else { cur.bytes += bytes; cur.count++ }
  }

  function breakdownOf(m: Map<string, Bucket>): LedgerBreakdown[] {
    return [...m.entries()].map(([key, b]) => ({ key, bytes: b.bytes, count: b.count }))
  }

  /** 单次遍历产出全维度聚合：过滤谓词内联，totals 与三维索引同循环累计 */
  function summarize(filter: LedgerQuery | undefined): LedgerSummary {
    let totalFreed = 0
    let totalPending = 0
    let entryCount = 0
    const byAction = new Map<string, Bucket>()
    const byProfile = new Map<string, Bucket>()
    const byDay = new Map<string, Bucket>()
    for (const e of readAll()) {
      if (!matches(e, filter)) continue
      entryCount++
      if (e.kind === 'freed') totalFreed += e.bytes
      else totalPending += e.bytes
      bump(byAction, e.action, e.bytes)
      bump(byProfile, e.profile, e.bytes)
      bump(byDay, e.at.slice(0, 10), e.bytes)   // 按日索引：ISO 时间戳前 10 位
    }
    return {
      totalFreed,
      totalPending,
      entryCount,
      byAction: breakdownOf(byAction).sort((a, b) => b.bytes - a.bytes),
      byProfile: breakdownOf(byProfile).sort((a, b) => b.bytes - a.bytes),
      byDay: breakdownOf(byDay).sort((a, b) => a.key.localeCompare(b.key)),
    }
  }

  return {
    async record(entry) {
      try {
        appendJsonl(file, entry)
        return ok(undefined)
      } catch (e) {
        return err(ioError('台账写入失败', e))
      }
    },

    async query(filter) {
      try {
        return ok(summarize(filter))
      } catch (e) {
        return err(ioError('台账查询失败', e))
      }
    },

    entries(filter, limit = 50) {
      return readAll()
        .filter(e => matches(e, filter))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
    },
  }
}

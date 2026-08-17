// src/infra/ledger.ts — ILedger 实现：空间台账（append-only JSONL）
// 存储与 trend.jsonl 同款：尾部半行容错、原子追加。
// 聚合在读取时完成（数据量级：每次 clean 一条，无需预聚合）。
import * as path from 'path'
import { err, ioError, ok } from '../contracts/base'
import { appendJsonl, readJsonl } from './fs-utils'
import type {
  ILedger, LedgerBreakdown, LedgerEntry, LedgerQuery, LedgerSummary,
} from '../contracts/ledger.contract'

export interface LedgerOptions {
  readonly historyDir: string
}

export function createLedger(options: LedgerOptions): ILedger {
  const file = path.join(options.historyDir, 'ledger.jsonl')
  const readAll = (): LedgerEntry[] => readJsonl<LedgerEntry>(file) ?? []

  function filterOf(filter: LedgerQuery | undefined) {
    return (e: LedgerEntry): boolean =>
      (filter?.kind === undefined || e.kind === filter.kind)
      && (filter?.profile === undefined || e.profile === filter.profile)
      && (filter?.since === undefined || e.at >= filter.since)
  }

  function breakdown(entries: readonly LedgerEntry[], keyOf: (e: LedgerEntry) => string): LedgerBreakdown[] {
    const map = new Map<string, { bytes: number; count: number }>()
    for (const e of entries) {
      const key = keyOf(e)
      const cur = map.get(key) ?? { bytes: 0, count: 0 }
      cur.bytes += e.bytes
      cur.count++
      map.set(key, cur)
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.bytes - a.bytes)
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
        const all = readAll().filter(filterOf(filter))
        const freed = all.filter(e => e.kind === 'freed')
        const pending = all.filter(e => e.kind === 'pending')
        const summary: LedgerSummary = {
          totalFreed: freed.reduce((s, e) => s + e.bytes, 0),
          totalPending: pending.reduce((s, e) => s + e.bytes, 0),
          entryCount: all.length,
          byAction: breakdown(all, e => e.action),
          byProfile: breakdown(all, e => e.profile),
          byDay: [...breakdown(all, e => e.at.slice(0, 10))]
            .sort((a, b) => a.key.localeCompare(b.key)),
        }
        return ok(summary)
      } catch (e) {
        return err(ioError('台账查询失败', e))
      }
    },

    entries(filter, limit = 50) {
      return readAll()
        .filter(filterOf(filter))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
    },
  }
}

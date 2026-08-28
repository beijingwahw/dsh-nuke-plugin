// contracts/ledger.contract.ts — 空间台账（双式记账）
// 每个回收的字节都要有出处：事务提交 → 记账（txId 可溯源审计链）；
// 去重潜力/孤儿发现 → 记为"应收"（pending，未真正回收）。
// 支持按 动作 / profile / 日 三维聚合，回答"清理到底省了多少、省在哪"。

import type { Brand, CleanAction, ProfileName, Result, TxId } from './base'

export type LedgerKind = 'freed' | 'pending'

/** 全局哨兵品牌：'*' 只能经 LEDGER_GLOBAL 构造，杜绝裸字符串混入 */
export type GlobalLedgerProfile = Brand<'*', 'GlobalLedgerProfile'>

/** 台账条目的 profile 域：具体 profile 名，或全局（跨 profile 动作如 dedup） */
export type LedgerProfile = ProfileName | GlobalLedgerProfile

/** 全局条目的 profile 值：dedup / 孤儿回收等不属于任何单一 profile 的动作 */
export const LEDGER_GLOBAL: GlobalLedgerProfile = '*' as GlobalLedgerProfile

/** freed = 实际回收（事务 commit）；pending = 发现但未回收（扫描/去重潜力） */
export interface LedgerEntry {
  readonly at: string
  readonly kind: LedgerKind
  readonly txId: TxId | null
  readonly profile: LedgerProfile
  readonly plugin: string | null
  readonly action: CleanAction | 'dedup-potential' | 'dedup-hardlink'
  readonly bytes: number
  /** 记账动机（人类可读） */
  readonly note: string
}

export interface LedgerBreakdown {
  readonly key: string
  readonly bytes: number
  readonly count: number
}

export interface LedgerQuery {
  readonly kind?: LedgerKind
  readonly profile?: LedgerProfile
  /** 只统计该日期之后（含）；ISO 日期 */
  readonly since?: string
}

export interface LedgerSummary {
  readonly totalFreed: number
  readonly totalPending: number
  readonly entryCount: number
  /** 按动作聚合（bytes 降序） */
  readonly byAction: readonly LedgerBreakdown[]
  /** 按 profile 聚合 */
  readonly byProfile: readonly LedgerBreakdown[]
  /** 按日聚合（升序，趋势图原料） */
  readonly byDay: readonly LedgerBreakdown[]
}

export interface ILedger {
  record(entry: LedgerEntry): Promise<Result<void>>
  query(filter?: LedgerQuery): Promise<Result<LedgerSummary>>
  /** 原始条目（at 降序，分页） */
  entries(filter?: LedgerQuery, limit?: number): readonly LedgerEntry[]
}

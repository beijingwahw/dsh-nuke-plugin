// contracts/trend.contract.ts — 历史趋势追踪器
// 数据驱动决策：每次 scan/clean/doctor 后记录快照（append-only JSONL），
// 线性回归拟合"可回收空间"随时间的变化率，预测 30 天走势，
// 并检测异常突增（可能是某插件失控写盘的早期信号）。

import type { ProfileName, Result } from './base'

export type TrendTrigger = 'scan' | 'clean' | 'doctor'

export interface TrendSnapshot {
  /** ISO 时间戳 */
  readonly at: string
  readonly trigger: TrendTrigger
  readonly profile: ProfileName
  /** 当时扫描出的可回收空间 */
  readonly bytesReclaimable: number
  /** 当时事务实际回收的空间（scan/doctor 为 0） */
  readonly bytesFreed: number
  readonly residualCount: number
  readonly healthScore: number
}

export interface TrendAnomaly {
  readonly detected: boolean
  readonly detail: string | null
}

export interface TrendReport {
  readonly snapshotCount: number
  readonly firstAt: string | null
  readonly lastAt: string | null
  /** bytesReclaimable 对时间的线性回归斜率（字节/天）；样本 <2 → 0 */
  readonly bytesPerDay: number
  /** 线性外推 30 天后的可回收空间；样本 <2 → null */
  readonly projected30dBytes: number | null
  readonly anomaly: TrendAnomaly
  readonly latest: TrendSnapshot | null
}

export interface ITrendTracker {
  /** 追加快照（append-only，尾部半行容错与 WAL 一致） */
  record(snapshot: TrendSnapshot): Promise<Result<void>>
  /** 聚合分析；profile 省略 = 全部 */
  analyze(profile?: ProfileName): Promise<Result<TrendReport>>
}

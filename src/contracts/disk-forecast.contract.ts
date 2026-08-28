// contracts/disk-forecast.contract.ts — 磁盘写满预测器
// 主动运维核心问题："磁盘还有几天满？"
// 数据源：趋势追踪器的回归斜率（残留增长 ≈ 磁盘占用增长）+ statfs 实时余量。
// 输出：daysUntilFull（写满倒计时）+ 分级告警 + 可执行建议。

import type { Result } from './base'
import type { TrendReport } from './trend.contract'

export type ForecastSeverity = 'ok' | 'watch' | 'warning' | 'critical'

export interface DiskForecast {
  readonly sampledAt: string
  readonly totalBytes: number | null
  readonly freeBytes: number | null
  readonly usedPct: number | null
  /** 残留增长速率（字节/天，来自趋势回归；无足够样本 = null） */
  readonly growthBytesPerDay: number | null
  /** 写满倒计时（天）；余量未降或数据不足 = null */
  readonly daysUntilFull: number | null
  /** 线性外推的写满时刻（ISO） */
  readonly projectedFullAt: string | null
  readonly severity: ForecastSeverity
  readonly recommendation: string
  /** 预测所依据的趋势数据摘要（可解释性） */
  readonly trendBasis: Pick<TrendReport, 'snapshotCount' | 'bytesPerDay' | 'anomaly'> | null
}

export interface IDiskForecaster {
  /** 采样一次：statfs 当前余量 × 趋势斜率 → 倒计时与建议 */
  forecast(): Promise<Result<DiskForecast>>
}

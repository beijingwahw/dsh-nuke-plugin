// contracts/guardian.contract.ts — 守卫者巡检
// 一键主动运维入口：并行采集 磁盘预测 / 趋势异常 / 全科体检 / 未终结事务，
// 聚合为分级告警清单，每条告警附带"下一步该调哪个 nuke_* 工具"的行动建议。
// 这是 dsh-nuke 从"被动清理工具"进化为"自治运维代理"的关键组件。

import type { ProfileName, Result } from './base'
import type { DiskForecast } from './disk-forecast.contract'
import type { DoctorReport } from './doctor.contract'
import type { TrendReport } from './trend.contract'

export type AlertKind =
  | 'DISK_CRITICAL'      // 磁盘即将写满
  | 'DISK_WARNING'
  | 'TREND_ANOMALY'      // 残留突增（失控写盘信号）
  | 'HEALTH_BLOCKING'    // 健康检查存在 critical 失败
  | 'HEALTH_DROP'        // 健康度低于阈值
  | 'UNFINISHED_TX'      // 存在崩溃残留事务
  | 'RECLAIM_BACKLOG'    // 可回收空间积压超阈值

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface GuardianAlert {
  readonly kind: AlertKind
  readonly severity: AlertSeverity
  readonly message: string
  /** 行动建议：下一步调用的 nuke_* 工具 */
  readonly suggestedTool: string
}

export interface GuardianThresholds {
  /** daysUntilFull 低于该值 → DISK_CRITICAL */
  readonly criticalDaysUntilFull: number
  /** daysUntilFull 低于该值 → DISK_WARNING */
  readonly warningDaysUntilFull: number
  /** 可回收空间高于该值 → RECLAIM_BACKLOG */
  readonly backlogBytes: number
  /** 健康度低于该值 → HEALTH_DROP */
  readonly minHealthScore: number
}

export interface GuardianReport {
  readonly patrolledAt: string
  readonly profile: ProfileName
  /** severity 降序（critical 在前） */
  readonly alerts: readonly GuardianAlert[]
  readonly disk: DiskForecast | null
  readonly trend: TrendReport | null
  readonly doctor: DoctorReport | null
  /** 巡检失败的部分（不阻断其余采集） */
  readonly partialFailures: readonly string[]
}

export interface IGuardian {
  patrol(options?: {
    readonly profile?: ProfileName
    readonly thresholds?: Partial<GuardianThresholds>
  }): Promise<Result<GuardianReport>>
}

export const DEFAULT_GUARDIAN_THRESHOLDS: GuardianThresholds = {
  criticalDaysUntilFull: 3,
  warningDaysUntilFull: 14,
  backlogBytes: 2 * 1024 ** 3,      // 2GB
  minHealthScore: 60,
}

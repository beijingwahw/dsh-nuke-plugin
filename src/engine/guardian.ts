// src/engine/guardian.ts — IGuardian 实现：守卫者巡检
// 采集容错原则：任一采集器失败记入 partialFailures，绝不阻断其余采集
// （巡检的价值在于覆盖面，单点失败降级不失效）。
// 告警排序：critical > warning > info；同级按 kind 字典序稳定输出。
//
// 本轮升级（告警去重键 + 抑制窗口）：
//   周期巡检的天然病：同一个问题每小时重复报告一遍，告警风暴把真问题
//   淹没在噪音里（Alertmanager 的 group_interval 痛点的迷你版）。治理：
//     · 去重键 = kind + 语义要素（UNFINISHED_TX 附事务集合）—— 键相同
//       即"同一个问题在重复发生"
//     · 抑制窗口（默认 6h）：窗口内同键告警不重发，只计入
//       suppressedAlertKeys（可观测：重复≠消失）
//     · 告警解除（本轮巡检未再出现）→ 清除该键记忆，复发视为新告警
//       重新计时（resolved → firing 重置语义）
//     · severity 升级走新键（DISK_WARNING → DISK_CRITICAL 是不同 kind），
//       恶化升级永远立即上报，绝不被窗口捂住
//   suppressionWindowMs = 0 关闭抑制（旧的逐次全报行为）。
import type { Clock, ProfileName, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { IDiskForecaster } from '../contracts/disk-forecast.contract'
import type { IDoctor, DoctorReport } from '../contracts/doctor.contract'
import type {
  GuardianAlert, GuardianReport, GuardianThresholds, IGuardian,
} from '../contracts/guardian.contract'
import { DEFAULT_GUARDIAN_THRESHOLDS } from '../contracts/guardian.contract'
import type { ITrendTracker, TrendReport } from '../contracts/trend.contract'

// ─── 引擎层扩展类型（contracts 只读；新输出经协变子类型暴露） ──

/** 告警详情：新增去重键（抑制窗口判定与可观测性的联合口径） */
export interface GuardianAlertDetail extends GuardianAlert {
  /** 去重键：kind [+ 语义要素（UNFINISHED_TX 附排序后事务集合）] */
  readonly dedupKey: string
}

/** 巡检报告详情：alerts 携带去重键 + 被抑制键清单（契约字段语义不变） */
export interface GuardianReportDetail extends GuardianReport {
  readonly alerts: readonly GuardianAlertDetail[]
  /** 本轮被抑制窗口吞掉的告警键（窗口内同键不重发；重复 ≠ 消失） */
  readonly suppressedAlertKeys: readonly string[]
}

/** IGuardian 的引擎层扩展：patrol 返回详情（协变返回类型） */
export interface IGuardianDetail extends IGuardian {
  patrol(options?: {
    readonly profile?: ProfileName
    readonly thresholds?: Partial<GuardianThresholds>
  }): Promise<Result<GuardianReportDetail>>
}

export interface GuardianDeps {
  readonly forecaster: IDiskForecaster
  readonly trend: ITrendTracker
  readonly doctor: IDoctor
  /** 未终结事务 id 列表（来自 WAL） */
  readonly unfinishedTxIds: () => readonly string[]
  readonly clock: Clock
  /** 告警抑制窗口（ms）：窗口内同键告警不重发，默认 6 小时；0 = 关闭 */
  readonly suppressionWindowMs?: number
}

/** 默认抑制窗口：6 小时（周期巡检下同一问题的最长重复上报间隔） */
const DEFAULT_SUPPRESSION_WINDOW_MS = 6 * 3600_000

const SEV_ORDER: Record<GuardianAlert['severity'], number> = { critical: 0, warning: 1, info: 2 }

export function createGuardian(deps: GuardianDeps): IGuardianDetail {
  // 抑制窗口状态：去重键 → 上次发出时刻（epoch ms）。
  // guardian 生命周期内跨 patrol 持续；抑制的告警不刷新时刻（窗口自首次发出起算）
  const lastEmittedAt = new Map<string, number>()

  return {
    async patrol(patrolOptions) {
      try {
        const profile = patrolOptions?.profile ?? ('web' as ProfileName)
        const th: GuardianThresholds = {
          ...DEFAULT_GUARDIAN_THRESHOLDS,
          ...patrolOptions?.thresholds,
        }
        const drafts: { key: string; alert: GuardianAlert }[] = []
        const partialFailures: string[] = []
        const push = (key: string, alert: GuardianAlert) => drafts.push({ key, alert })

        // 1) 磁盘预测
        let disk = null
        const diskR = await deps.forecaster.forecast()
        if (diskR.ok) {
          disk = diskR.value
          if (disk.daysUntilFull !== null) {
            if (disk.daysUntilFull <= th.criticalDaysUntilFull) {
              push('DISK_CRITICAL', {
                kind: 'DISK_CRITICAL', severity: 'critical',
                message: `磁盘约 ${disk.daysUntilFull.toFixed(1)} 天后写满（余量 ${disk.freeBytes} 字节，日增 ${Math.round(disk.growthBytesPerDay ?? 0)}）`,
                suggestedTool: 'nuke_doctor',
              })
            } else if (disk.daysUntilFull <= th.warningDaysUntilFull) {
              push('DISK_WARNING', {
                kind: 'DISK_WARNING', severity: 'warning',
                message: `磁盘 ${disk.daysUntilFull.toFixed(1)} 天后写满，开始规划清理`,
                suggestedTool: 'nuke_orphans',
              })
            }
          }
        } else {
          partialFailures.push(`disk: ${diskR.error.message}`)
        }

        // 2) 趋势异常
        let trend: TrendReport | null = null
        const trendR = await deps.trend.analyze()
        if (trendR.ok) {
          trend = trendR.value
          if (trend.anomaly.detected) {
            push('TREND_ANOMALY', {
              kind: 'TREND_ANOMALY', severity: 'warning',
              message: trend.anomaly.detail ?? '残留量异常突变',
              suggestedTool: 'nuke_doctor',
            })
          }
        } else {
          partialFailures.push(`trend: ${trendR.error.message}`)
        }

        // 3) 全科体检
        let doctor: DoctorReport | null = null
        const doctorR = await deps.doctor.diagnose(profile)
        if (doctorR.ok) {
          doctor = doctorR.value
          if (doctor.blocking) {
            push('HEALTH_BLOCKING', {
              kind: 'HEALTH_BLOCKING', severity: 'critical',
              message: `健康检查存在阻断项（评分 ${doctor.healthScore}/100），清理事务将被拒绝`,
              suggestedTool: 'nuke_health',
            })
          } else if (doctor.healthScore < th.minHealthScore) {
            push('HEALTH_DROP', {
              kind: 'HEALTH_DROP', severity: 'warning',
              message: `健康度 ${doctor.healthScore}/100 低于阈值 ${th.minHealthScore}`,
              suggestedTool: 'nuke_health',
            })
          }
          if (doctor.totalReclaimableBytes >= th.backlogBytes) {
            push('RECLAIM_BACKLOG', {
              kind: 'RECLAIM_BACKLOG', severity: 'warning',
              message: `可回收空间积压超阈值（${doctor.totalReclaimableBytes} ≥ ${th.backlogBytes}）`,
              suggestedTool: 'nuke_clean',
            })
          }
        } else {
          partialFailures.push(`doctor: ${doctorR.error.message}`)
        }

        // 4) 未终结事务（崩溃残留）—— 键附事务集合：集合变化 = 新问题
        const unfinished = deps.unfinishedTxIds()
        if (unfinished.length > 0) {
          const txKey = [...unfinished].sort().join(',')
          push(`UNFINISHED_TX:${txKey}`, {
            kind: 'UNFINISHED_TX', severity: 'critical',
            message: `检测到 ${unfinished.length} 个未终结事务（崩溃残留）: ${unfinished.join(', ')}`,
            suggestedTool: 'nuke_recover',
          })
        }

        // ── 告警治理：去重键 + 抑制窗口 ──────────────────────────
        const windowMs = deps.suppressionWindowMs ?? DEFAULT_SUPPRESSION_WINDOW_MS
        const nowMs = deps.clock.now().getTime()

        // 告警解除：本轮未再出现的键清除记忆（复发视为新告警重新计时）
        const activeKeys = new Set(drafts.map(d => d.key))
        for (const key of [...lastEmittedAt.keys()]) {
          if (!activeKeys.has(key)) lastEmittedAt.delete(key)
        }

        const alerts: GuardianAlertDetail[] = []
        const suppressedAlertKeys: string[] = []
        for (const d of drafts) {
          const last = lastEmittedAt.get(d.key)
          if (windowMs > 0 && last !== undefined && nowMs - last < windowMs) {
            suppressedAlertKeys.push(d.key)   // 窗口内重复：抑制（不刷新时刻）
            continue
          }
          lastEmittedAt.set(d.key, nowMs)
          alerts.push({ ...d.alert, dedupKey: d.key })
        }

        alerts.sort((a, b) =>
          SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.kind.localeCompare(b.kind))

        const report: GuardianReportDetail = {
          patrolledAt: deps.clock.now().toISOString(),
          profile,
          alerts,
          disk,
          trend,
          doctor,
          partialFailures,
          suppressedAlertKeys,
        }
        return ok(report)
      } catch (e) {
        return err(ioError('守卫者巡检失败', e))
      }
    },
  }
}

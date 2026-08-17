// src/engine/guardian.ts — IGuardian 实现：守卫者巡检
// 采集容错原则：任一采集器失败记入 partialFailures，绝不阻断其余采集
// （巡检的价值在于覆盖面，单点失败降级不失效）。
// 告警排序：critical > warning > info；同级按 kind 字典序稳定输出。
import type { Clock } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { ProfileName } from '../contracts/base'
import type { IDiskForecaster } from '../contracts/disk-forecast.contract'
import type { ITrendTracker, TrendReport } from '../contracts/trend.contract'
import type { IDoctor, DoctorReport } from '../contracts/doctor.contract'
import type {
  GuardianAlert, GuardianReport, GuardianThresholds, IGuardian,
} from '../contracts/guardian.contract'
import { DEFAULT_GUARDIAN_THRESHOLDS } from '../contracts/guardian.contract'

export interface GuardianDeps {
  readonly forecaster: IDiskForecaster
  readonly trend: ITrendTracker
  readonly doctor: IDoctor
  /** 未终结事务 id 列表（来自 WAL） */
  readonly unfinishedTxIds: () => readonly string[]
  readonly clock: Clock
}

const SEV_ORDER: Record<GuardianAlert['severity'], number> = { critical: 0, warning: 1, info: 2 }

export function createGuardian(deps: GuardianDeps): IGuardian {
  return {
    async patrol(patrolOptions) {
      try {
        const profile = patrolOptions?.profile ?? ('web' as ProfileName)
        const th: GuardianThresholds = {
          ...DEFAULT_GUARDIAN_THRESHOLDS,
          ...patrolOptions?.thresholds,
        }
        const alerts: GuardianAlert[] = []
        const partialFailures: string[] = []

        // 1) 磁盘预测
        let disk = null
        const diskR = await deps.forecaster.forecast()
        if (diskR.ok) {
          disk = diskR.value
          if (disk.daysUntilFull !== null) {
            if (disk.daysUntilFull <= th.criticalDaysUntilFull) {
              alerts.push({
                kind: 'DISK_CRITICAL', severity: 'critical',
                message: `磁盘约 ${disk.daysUntilFull.toFixed(1)} 天后写满（余量 ${disk.freeBytes} 字节，日增 ${Math.round(disk.growthBytesPerDay ?? 0)}）`,
                suggestedTool: 'nuke_doctor',
              })
            } else if (disk.daysUntilFull <= th.warningDaysUntilFull) {
              alerts.push({
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
            alerts.push({
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
            alerts.push({
              kind: 'HEALTH_BLOCKING', severity: 'critical',
              message: `健康检查存在阻断项（评分 ${doctor.healthScore}/100），清理事务将被拒绝`,
              suggestedTool: 'nuke_health',
            })
          } else if (doctor.healthScore < th.minHealthScore) {
            alerts.push({
              kind: 'HEALTH_DROP', severity: 'warning',
              message: `健康度 ${doctor.healthScore}/100 低于阈值 ${th.minHealthScore}`,
              suggestedTool: 'nuke_health',
            })
          }
          if (doctor.totalReclaimableBytes >= th.backlogBytes) {
            alerts.push({
              kind: 'RECLAIM_BACKLOG', severity: 'warning',
              message: `可回收空间积压超阈值（${doctor.totalReclaimableBytes} ≥ ${th.backlogBytes}）`,
              suggestedTool: 'nuke_clean',
            })
          }
        } else {
          partialFailures.push(`doctor: ${doctorR.error.message}`)
        }

        // 4) 未终结事务（崩溃残留）
        const unfinished = deps.unfinishedTxIds()
        if (unfinished.length > 0) {
          alerts.push({
            kind: 'UNFINISHED_TX', severity: 'critical',
            message: `检测到 ${unfinished.length} 个未终结事务（崩溃残留）: ${unfinished.join(', ')}`,
            suggestedTool: 'nuke_recover',
          })
        }

        alerts.sort((a, b) =>
          SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.kind.localeCompare(b.kind))

        const report: GuardianReport = {
          patrolledAt: deps.clock.now().toISOString(),
          profile,
          alerts,
          disk,
          trend,
          doctor,
          partialFailures,
        }
        return ok(report)
      } catch (e) {
        return err(ioError('守卫者巡检失败', e))
      }
    },
  }
}

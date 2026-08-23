// src/engine/disk-forecaster.ts — IDiskForecaster 实现：磁盘写满预测
// 模型：daysUntilFull = freeBytes / 残留增长速率（趋势回归斜率）。
//   斜率 ≤0（在净回收）或样本 <2 → 倒计时不可预测（null）
//   statfs 不可用（如沙箱无权限）→ 仅输出趋势侧结论
// 保守原则：趋势异常时下调一档严重度（数据被污染时不给乐观结论）。
import type { Clock } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import { statfsBytes } from '../infra/fs-utils'
import type { ITrendTracker } from '../contracts/trend.contract'
import type { DiskForecast, ForecastSeverity, IDiskForecaster } from '../contracts/disk-forecast.contract'

export interface DiskForecasterOptions {
  readonly diskRoot: string
  readonly trend: ITrendTracker
  readonly clock: Clock
  /** 可注入的磁盘采样（测试用）：返回 [free, total] 或 null */
  readonly sampleDisk?: (root: string) => { free: number; total: number } | null
}

const DAY_MS = 86_400_000

export function createDiskForecaster(options: DiskForecasterOptions): IDiskForecaster {
  function sample(): { free: number; total: number } | null {
    if (options.sampleDisk) return options.sampleDisk(options.diskRoot)
    return statfsBytes(options.diskRoot)
  }

  return {
    async forecast() {
      try {
        const now = options.clock.now()
        const trendR = await options.trend.analyze()
        if (!trendR.ok) return trendR
        const trend = trendR.value

        const disk = sample()
        const growth = trend.snapshotCount >= 2 && trend.bytesPerDay > 0
          ? trend.bytesPerDay
          : null

        let daysUntilFull: number | null = null
        let projectedFullAt: string | null = null
        if (disk !== null && growth !== null && growth > 0 && disk.free > 0) {
          daysUntilFull = disk.free / growth
          projectedFullAt = new Date(now.getTime() + daysUntilFull * DAY_MS).toISOString()
        }

        // 严重度判定（趋势异常 → 保守下调）
        let severity: ForecastSeverity = 'ok'
        if (disk !== null && disk.total > 0) {
          const usedPct = ((disk.total - disk.free) / disk.total) * 100
          if (usedPct >= 95) severity = 'critical'
          else if (usedPct >= 85) severity = 'warning'
          else if (usedPct >= 70) severity = 'watch'
        }
        if (daysUntilFull !== null) {
          if (daysUntilFull <= 3) severity = 'critical'
          else if (daysUntilFull <= 14 && severity !== 'critical') severity = 'warning'
          else if (daysUntilFull <= 30 && severity === 'ok') severity = 'watch'
        }
        if (trend.anomaly.detected && severity === 'ok') severity = 'watch'

        // 建议：随严重度升级给出更激进的动作链
        let recommendation: string
        switch (severity) {
          case 'critical':
            recommendation = '磁盘即将写满：立即 nuke_doctor 体检 → 按处方 nuke_clean（balanced），必要时 nuke_dedup 核查跨 profile 冗余'
            break
          case 'warning':
            recommendation = '磁盘余量承压：建议 nuke_orphans 扫一遍孤儿 → dry-run 评估回收量后执行'
            break
          case 'watch':
            recommendation = '保持观察：残留仍在增长，建议运行 nuke_doctor 获取处方'
            break
          default:
            recommendation = trend.snapshotCount < 2
              ? '趋势数据不足：多跑几次 nuke_scan 后即可获得预测能力'
              : '磁盘健康，按需清理即可'
        }

        const forecast: DiskForecast = {
          sampledAt: now.toISOString(),
          totalBytes: disk?.total ?? null,
          freeBytes: disk?.free ?? null,
          usedPct: disk && disk.total > 0
            ? Math.round(((disk.total - disk.free) / disk.total) * 1000) / 10
            : null,
          growthBytesPerDay: growth,
          daysUntilFull,
          projectedFullAt,
          severity,
          recommendation,
          trendBasis: {
            snapshotCount: trend.snapshotCount,
            bytesPerDay: trend.bytesPerDay,
            anomaly: trend.anomaly,
          },
        }
        return ok(forecast)
      } catch (e) {
        return err(ioError('磁盘预测失败', e))
      }
    },
  }
}

// src/engine/disk-forecaster.ts — IDiskForecaster 实现：磁盘写满预测
// 模型：daysUntilFull = freeBytes / 残留增长速率（趋势回归斜率）。
//   斜率 ≤0（在净回收）或样本 <2 → 倒计时不可预测（null）
//   statfs 不可用（如沙箱无权限）→ 仅输出趋势侧结论
// 保守原则：趋势异常时下调一档严重度（数据被污染时不给乐观结论）。
//
// 本轮升级（倒计时置信区间 + 悲观值分级，零依赖纯计算；契约字段语义不变，
// 新输出经 DiskForecastDetail 以协变子类型暴露 —— 旧消费者无感知）：
//
//   1. 倒计时置信区间：趋势追踪器已输出斜率 95% CI（Theil-Sen 成对斜率
//      分布的分位）。倒计时 = free/slope 是斜率的倒数函数 —— 单调反转，
//      故 CI 端点反演：daysUntilFullLow = free/slopeHigh（增长最快 →
//      最早写满，悲观界）、daysUntilFullHigh = free/slopeLow（增长最慢 →
//      最晚写满，乐观界）。slopeLow ≤ 0 时 CI 含"永不写满"→ 乐观侧
//      不可界（null）—— 诚实标注，而不是硬造一个无意义的巨数时刻。
//      契约型 ITrendTracker 桩（无 CI 字段）经 isTrendReportDetail 判别后
//      优雅降级为纯点估计 —— 与"statfs 不可用仅输出趋势侧"同哲学。
//
//   2. 悲观值分级：severity 阈值判定改用 daysUntilFullLow（CI 缺失时回退
//      点估计）。由分位数单调性 slopeHigh ≥ slope → 悲观界 ≤ 点估计 →
//      分级只会持平或上调、永不下调 —— 不确定性越大报警越早（宁虚警
//      不可漏警的运维立场）。完美线性数据 CI 退化为零宽 → 悲观界 =
//      点估计 → 行为与旧版逐位一致（向后兼容的锚点）。
//      severityBasis 记录判定依据（哪个值、哪条阈值）—— 分级不是黑盒。
import type { Clock, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { DiskForecast, ForecastSeverity, IDiskForecaster } from '../contracts/disk-forecast.contract'
import type { ITrendTracker } from '../contracts/trend.contract'
import { statfsBytes } from '../infra/fs-utils'

import { isTrendReportDetail } from './trend-tracker'

// ─── 引擎层扩展类型（contracts 只读；新输出字段在此定义并导出） ──

/** 磁盘预测详情：契约字段语义不变，新增倒计时置信区间与分级依据 */
export interface DiskForecastDetail extends DiskForecast {
  /** 写满倒计时 95% 置信下界（天，悲观：最早写满）= free / 斜率上界。
   *  趋势无 CI（契约桩 / 样本不足）或斜率上界 ≤0 → null */
  readonly daysUntilFullLow: number | null
  /** 写满倒计时 95% 置信上界（天，乐观：最晚写满）= free / 斜率下界。
   *  斜率下界 ≤0（CI 含"永不写满"）→ null：乐观侧不可界 */
  readonly daysUntilFullHigh: number | null
  /** 悲观写满时刻（ISO，对应 daysUntilFullLow）；不可估或越界 → null */
  readonly projectedFullAtLow: string | null
  /** 乐观写满时刻（ISO，对应 daysUntilFullHigh）；不可界或越界 → null */
  readonly projectedFullAtHigh: string | null
  /** severity 的判定依据（可解释性：哪个值、哪条阈值驱动了当前分级） */
  readonly severityBasis: string
}

/** IDiskForecaster 的引擎层扩展：forecast 返回详情报告（协变返回类型） */
export interface IDiskForecasterDetail extends IDiskForecaster {
  forecast(): Promise<Result<DiskForecastDetail>>
}

export interface DiskForecasterOptions {
  readonly diskRoot: string
  readonly trend: ITrendTracker
  readonly clock: Clock
  /** 可注入的磁盘采样（测试用）：返回 [free, total] 或 null */
  readonly sampleDisk?: (root: string) => { free: number; total: number } | null
}

const DAY_MS = 86_400_000

/** 安全 ISO 序列化：时间戳超出 JS Date 值域（±8.64e15 ms ≈ ±27 万年）时
 *  Date#toISOString 会抛 RangeError —— 极慢增长下的乐观写满时刻很容易
 *  越界（如 1 字节/天 × GB 级余量 ≈ 10^9 天）。返回 null 而非让整个预测
 *  失败：倒计时数值本身仍然有效，只是无法表达为日历时刻。 */
function safeIso(ms: number): string | null {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
    ? new Date(ms).toISOString()
    : null
}

export function createDiskForecaster(options: DiskForecasterOptions): IDiskForecasterDetail {
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

        // ── 倒计时置信区间：斜率 CI 端点经倒数反演（单调反转）──────
        // 契约型趋势桩无 CI 字段 → isTrendReportDetail 判别后降级为点估计
        const detail = isTrendReportDetail(trend) ? trend : null
        const growthHigh = detail !== null && detail.bytesPerDayHigh !== null
          && detail.bytesPerDayHigh > 0
          ? detail.bytesPerDayHigh
          : null
        const growthLow = detail !== null && detail.bytesPerDayLow !== null
          && detail.bytesPerDayLow > 0
          ? detail.bytesPerDayLow
          : null
        const countdown = (rate: number): number | null =>
          disk !== null && disk.free > 0 && rate > 0 ? disk.free / rate : null

        let daysUntilFull: number | null = null
        let projectedFullAt: string | null = null
        if (growth !== null) {
          daysUntilFull = countdown(growth)
          projectedFullAt = daysUntilFull !== null
            ? safeIso(now.getTime() + daysUntilFull * DAY_MS)
            : null
        }
        const daysUntilFullLow = growthHigh !== null ? countdown(growthHigh) : null
        const daysUntilFullHigh = growthLow !== null ? countdown(growthLow) : null
        const projectedFullAtLow = daysUntilFullLow !== null
          ? safeIso(now.getTime() + daysUntilFullLow * DAY_MS)
          : null
        const projectedFullAtHigh = daysUntilFullHigh !== null
          ? safeIso(now.getTime() + daysUntilFullHigh * DAY_MS)
          : null

        // ── 严重度判定（悲观值分级 + 可解释依据）─────────────────
        // 悲观倒计时 = CI 下界 ?? 点估计：分位数单调性保证 ≤ 点估计，
        // 故分级只会持平或上调（保守方向），完美线性数据下与旧版逐位一致。
        const pessimisticDays = daysUntilFullLow ?? daysUntilFull
        const cdLabel = daysUntilFullLow !== null ? '倒计时 95% 置信下界' : '倒计时点估计'
        const reasons: string[] = []
        let severity: ForecastSeverity = 'ok'
        if (disk !== null && disk.total > 0) {
          const usedPct = ((disk.total - disk.free) / disk.total) * 100
          if (usedPct >= 95) {
            severity = 'critical'
            reasons.push(`使用率 ${usedPct.toFixed(1)}% ≥ 95%`)
          } else if (usedPct >= 85) {
            severity = 'warning'
            reasons.push(`使用率 ${usedPct.toFixed(1)}% ≥ 85%`)
          } else if (usedPct >= 70) {
            severity = 'watch'
            reasons.push(`使用率 ${usedPct.toFixed(1)}% ≥ 70%`)
          }
        }
        if (pessimisticDays !== null) {
          if (pessimisticDays <= 3) {
            severity = 'critical'
            reasons.push(`${cdLabel} ${pessimisticDays.toFixed(1)} 天 ≤ 3 天`)
          } else if (pessimisticDays <= 14 && severity !== 'critical') {
            severity = 'warning'
            reasons.push(`${cdLabel} ${pessimisticDays.toFixed(1)} 天 ≤ 14 天`)
          } else if (pessimisticDays <= 30 && severity === 'ok') {
            severity = 'watch'
            reasons.push(`${cdLabel} ${pessimisticDays.toFixed(1)} 天 ≤ 30 天`)
          }
        }
        if (trend.anomaly.detected && severity === 'ok') {
          severity = 'watch'
          reasons.push('趋势异常保守下调')
        }

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
          case 'ok':
            recommendation = trend.snapshotCount < 2
              ? '趋势数据不足：多跑几次 nuke_scan 后即可获得预测能力'
              : '磁盘健康，按需清理即可'
            break
        }

        const forecast: DiskForecastDetail = {
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
          daysUntilFullLow,
          daysUntilFullHigh,
          projectedFullAtLow,
          projectedFullAtHigh,
          severityBasis: reasons.length > 0 ? reasons.join('；') : '无风险信号',
        }
        return ok(forecast)
      } catch (e) {
        return err(ioError('磁盘预测失败', e))
      }
    },
  }
}

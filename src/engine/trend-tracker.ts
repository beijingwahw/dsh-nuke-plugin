// src/engine/trend-tracker.ts — ITrendTracker 实现：历史趋势追踪
// 存储：append-only JSONL（<dshHome>/.nuke/history/trend.jsonl），尾部半行容错。
// 分析：Theil-Sen 稳健回归拟合 bytesReclaimable(t)，斜率=字节/天；
//       异常检测：末值偏离稳健预测 >3σ̂（σ̂ = MAD×1.4826，样本≥3 时启用）。
//
// 为什么放弃最小二乘（世界级升级）：
//   LS 的 breakdown point 是 0% —— 单个离群点（一次异常写盘/一次统计口径变化）
//   就能把斜率拉偏数倍，进而污染 daysUntilFull 预测与告警。
//   Theil-Sen（成对斜率取中位数）breakdown point 29.3%：
//   近三分之一的数据被污染时斜率估计仍然正确。
//   配套 MAD（绝对中位差×1.4826 ≈ 稳健 σ）使异常阈值本身也抗污染。
import * as path from 'path'
import { err, ioError, ok } from '../contracts/base'
import { appendJsonl, readJsonl } from '../infra/fs-utils'
import type {
  ITrendTracker, TrendReport, TrendSnapshot,
} from '../contracts/trend.contract'

export interface TrendTrackerOptions {
  /** history 目录（通常 <dshHome>/.nuke/history） */
  readonly historyDir: string
  readonly now?: () => Date
}

const MS_PER_DAY = 86_400_000

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

/** 快照净化：JSONL 历史可能含损坏/陈旧格式条目（缺字段、非法日期、非有限数）。
 *  NaN 是传染性的 —— 一个坏点会让 slope/σ̂/预测全部变 NaN，进而污染
 *  daysUntilFull 与异常告警。在入口整条剔除，宁缺毋滥。 */
function sanitizeSnapshots(snaps: readonly TrendSnapshot[]): TrendSnapshot[] {
  return snaps.filter(s =>
    typeof s.at === 'string'
    && Number.isFinite(Date.parse(s.at))
    && typeof s.bytesReclaimable === 'number'
    && Number.isFinite(s.bytesReclaimable),
  )
}

export function createTrendTracker(options: TrendTrackerOptions): ITrendTracker {
  const file = path.join(options.historyDir, 'trend.jsonl')
  const readAll = (): TrendSnapshot[] => readJsonl<TrendSnapshot>(file) ?? []

  /** Theil-Sen 稳健回归：斜率 = 全部成对斜率的中位数；截距 = median(y - slope·x)。
   *  O(n²) 对 —— 快照量级（数百）下毫秒级；完美线性数据下与 LS 完全一致。 */
  function regress(points: readonly { x: number; y: number }[]): { slope: number; intercept: number } {
    const n = points.length
    if (n < 2) return { slope: 0, intercept: n === 1 ? points[0]!.y : 0 }
    const slopes: number[] = []
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = points[j]!.x - points[i]!.x
        if (dx !== 0) {
          const s = (points[j]!.y - points[i]!.y) / dx
          // 极小 dx 会把成对斜率炸成 ±Infinity：非有限斜率不入样本
          if (Number.isFinite(s)) slopes.push(s)
        }
      }
    }
    if (slopes.length === 0) return { slope: 0, intercept: median(points.map(p => p.y)) }
    const slope = median(slopes)
    const intercept = median(points.map(p => p.y - slope * p.x))
    // 终极保险：拟合结果非有限（理论上已被上游净化排除）时退化为无趋势
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
      return { slope: 0, intercept: median(points.map(p => p.y)) }
    }
    return { slope, intercept }
  }

  /** MAD×1.4826：对正态数据等价于标准差，但对离群点稳健（阈值不被污染） */
  function robustSigma(residuals: readonly number[]): number {
    const med = median(residuals)
    return 1.4826 * median(residuals.map(r => Math.abs(r - med)))
  }

  return {
    async record(snapshot) {
      try {
        appendJsonl(file, snapshot)
        return ok(undefined)
      } catch (e) {
        return err(ioError('趋势快照写入失败', e))
      }
    },

    async analyze(profile) {
      try {
        const all = sanitizeSnapshots(readAll()
          .filter(s => profile === undefined || s.profile === profile))
          .sort((a, b) => a.at.localeCompare(b.at))

        const n = all.length
        const points = all.map(s => ({ x: Date.parse(s.at), y: s.bytesReclaimable }))

        let bytesPerDay = 0
        let projected30dBytes: number | null = null
        let anomalyDetail: string | null = null

        if (n >= 2) {
          const { slope, intercept } = regress(points)
          bytesPerDay = (slope * MS_PER_DAY)
          const lastX = points[n - 1]!.x
          projected30dBytes = Math.max(0, intercept + slope * (lastX + 30 * MS_PER_DAY))

          // 3σ̂ 异常检测（out-of-sample）：用历史点拟合，检验末点是否离群。
          // 不能把末点放进拟合集 —— 离群点会抬高 σ 稀释自身（自我掩盖）。
          // σ̂ = MAD×1.4826：阈值本身抗污染（LS 的 σ 会被历史离群点撑大）。
          if (n >= 3) {
            const train = points.slice(0, -1)
            const fit = regress(train)
            const trainRes = train.map(p => p.y - (fit.intercept + fit.slope * p.x))
            const sd = robustSigma(trainRes)
            const predicted = fit.intercept + fit.slope * points[n - 1]!.x
            const lastResidual = points[n - 1]!.y - predicted
            const isAnomaly = sd > 0
              ? Math.abs(lastResidual) > 3 * sd
              : lastResidual !== 0   // 完美线性历史 + 任何突变 = 异常
            if (isAnomaly) {
              const sign = lastResidual > 0 ? '激增' : '骤降'
              anomalyDetail = `最新快照显著偏离趋势（3σ̂ ${sign}）—— 可能存在插件失控写盘或清理异常`
            }
          }
        }

        const report: TrendReport = {
          snapshotCount: n,
          firstAt: n > 0 ? all[0]!.at : null,
          lastAt: n > 0 ? all[n - 1]!.at : null,
          // 出口终检：非有限值绝不下发（Infinity 进 JSON 序列化会变 null，
          // NaN 会毒化下游 daysUntilFull/告警文案）
          bytesPerDay: Number.isFinite(bytesPerDay) ? bytesPerDay : 0,
          projected30dBytes:
            projected30dBytes !== null && Number.isFinite(projected30dBytes)
              ? projected30dBytes
              : null,
          anomaly: { detected: anomalyDetail !== null, detail: anomalyDetail },
          latest: n > 0 ? all[n - 1]! : null,
        }
        return ok(report)
      } catch (e) {
        return err(ioError('趋势分析失败', e))
      }
    },
  }
}

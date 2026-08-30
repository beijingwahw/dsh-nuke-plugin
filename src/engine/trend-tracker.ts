// src/engine/trend-tracker.ts — ITrendTracker 实现：历史趋势追踪
// 存储：append-only JSONL（<dshHome>/.nuke/history/trend.jsonl），尾部半行容错。
// 分析：时间加权 Theil-Sen 稳健回归拟合 bytesReclaimable(t)，斜率=字节/天；
//       异常检测：末值偏离稳健预测 >3σ̂（σ̂ = MAD×1.4826，样本≥3 时启用）。
//
// 为什么放弃最小二乘（世界级升级）：
//   LS 的 breakdown point 是 0% —— 单个离群点（一次异常写盘/一次统计口径变化）
//   就能把斜率拉偏数倍，进而污染 daysUntilFull 预测与告警。
//   Theil-Sen（成对斜率取中位数）breakdown point 29.3%：
//   近三分之一的数据被污染时斜率估计仍然正确。
//   配套 MAD（绝对中位差×1.4826 ≈ 稳健 σ）使异常阈值本身也抗污染。
//
// 本轮升级（三项新能力，全部零依赖纯计算；契约字段语义不变，新输出经
// TrendReportDetail 以协变子类型暴露 —— 旧消费者无感知）：
//
//   1. 时间加权 Theil-Sen：近期样本对斜率贡献权重更高（指数衰减，半衰期可配）。
//      成对斜率 (i,j) 的权重 = w_i × w_j（两端点衰减权重之积）—— 若只看较新端点，
//      横跨新旧 regime 的长基线对子会被误当新鲜信息（其值是被旧数据稀释过的
//      平均速率）；唯有两端都新鲜的对子才代表"当下增长率"。
//      半衰期默认 30 天；Infinity = 全 1 权重（严格退化为经典 Theil-Sen）。
//      权重年龄以数据集中最新快照为基准 —— 无墙钟依赖，同数据必得同结果。
//
//   2. CUSUM 变点检测：对相邻快照的局部增长率序列做序贯检测，输出 changepoints
//      （时间 + 方向 + 前后 regime 速率），回答"增长率什么时候突变、朝哪边突变"。
//      基准 μ/σ̂ 取自热身窗（默认 3 个局部率）的中位数与 MAD×1.4826；
//      上行 C⁺ = max(0, C⁺+(r−μ−K))、下行 C⁻ = min(0, C⁻+(r−μ+K))，
//      K = σ̂/2（容差）、H = 4σ̂（阈值，倍数可配）。报警需累积 ≥2 个局部率
//      —— 区分"增长率突变"与"单点尖峰"（后者归 3σ̂ 异常检测管）；报警后
//      还要用前后 regime 中位数做方向一致性后验（自证不是噪声）。每次报警后
//      从变点处重建基准，支持多 regime 逐段识别。
//
//   3. 预测区间：斜率不确定性（成对斜率分布的加权 2.5%/97.5% 分位 —— Sen 秩
//      区间的时间加权推广，小样本自然退化为极值区间即保守区间）传播到 30 天
//      外推：区间锚定在中心拟合线的末点取值上，宽度纯由斜率不确定性驱动，
//      点估计恒居区间内。完美线性数据 → 零宽度区间（诚实的零不确定性）。
import * as path from 'path'

import { err, ioError, ok } from '../contracts/base'
import type { ProfileName, Result } from '../contracts/base'
import type {
  ITrendTracker, TrendReport, TrendSnapshot,
} from '../contracts/trend.contract'
import { appendJsonl, readJsonl } from '../infra/fs-utils'

// ─── 引擎层扩展类型（contracts 只读；新输出字段在此定义并导出） ──

/** 增长率变点：局部增长率发生持续性突变的时刻（CUSUM 检出） */
export interface TrendChangepoint {
  /** 新 regime 首个快照的 ISO 时间（突变首次"显现"的时刻） */
  readonly at: string
  /** up = 增长率上升（堆积加速）；down = 增长率下降（放缓/清理生效） */
  readonly direction: 'up' | 'down'
  /** 突变前 regime 的局部增长率中位数（字节/天） */
  readonly bytesPerDayBefore: number
  /** 突变后 regime 的局部增长率中位数（字节/天） */
  readonly bytesPerDayAfter: number
}

/** 趋势报告详情：契约字段语义不变，新增变点列表与预测区间 */
export interface TrendReportDetail extends TrendReport {
  /** 增长率变点列表（按时间升序；无突变或样本不足 → 空数组） */
  readonly changepoints: readonly TrendChangepoint[]
  /** 回归斜率 95% 置信下界（字节/天）；样本 <2 或无有效成对斜率 → null */
  readonly bytesPerDayLow: number | null
  /** 回归斜率 95% 置信上界（字节/天） */
  readonly bytesPerDayHigh: number | null
  /** 30 天外推的 95% 区间下界（斜率不确定性传播；projected30dBytes 为 null 时亦为 null） */
  readonly projected30dBytesLow: number | null
  /** 30 天外推的 95% 区间上界 */
  readonly projected30dBytesHigh: number | null
}

/** ITrendTracker 的引擎层扩展：analyze 返回详情报告（协变返回类型） */
export interface ITrendTrackerDetail extends ITrendTracker {
  analyze(profile?: ProfileName): Promise<Result<TrendReportDetail>>
}

/** 运行时判别：报告是否为引擎层详情（携带变点与斜率 CI）。
 *  契约型 ITrendTracker 实现（如测试桩）返回纯 TrendReport 时，
 *  消费者据此优雅降级为点估计 —— 与磁盘预测器"statfs 不可用仅输出趋势侧"同哲学。 */
export function isTrendReportDetail(report: TrendReport): report is TrendReportDetail {
  return 'changepoints' in report
    && 'bytesPerDayLow' in report
    && 'bytesPerDayHigh' in report
}

export interface TrendTrackerOptions {
  /** history 目录（通常 <dshHome>/.nuke/history） */
  readonly historyDir: string
  readonly now?: () => Date
  /** 时间加权半衰期（天，默认 30）：端点权重 = 0.5^(年龄/半衰期)。
   *  Infinity = 不做时间衰减（全 1 权重，严格退化为经典 Theil-Sen）。 */
  readonly halfLifeDays?: number
  /** CUSUM 基准热身所需的局部增长率个数（默认 3，最小 2） */
  readonly cusumWarmup?: number
  /** CUSUM 报警阈值 = 该倍数 × 热身窗稳健 σ̂（默认 4） */
  readonly cusumThresholdSigmas?: number
}

const MS_PER_DAY = 86_400_000
const DEFAULT_HALF_LIFE_DAYS = 30
const DEFAULT_CUSUM_WARMUP = 3
const DEFAULT_CUSUM_THRESHOLD_SIGMAS = 4
/** 预测区间的置信水平 95% → 成对斜率分布的分位取 2.5% / 97.5% */
const SLOPE_CI_Q = 0.025

/** 未加权分位数（线性插值）：pos=(n-1)·q，与经典定义一致 */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 0) return 0
  return quantile(s, 0.5)
}

interface WeightedSample {
  readonly value: number
  readonly weight: number
}

/** 加权分位数（线性插值，与 infra/reliability 同构）：样本 i 的代表位置 =
 *  其权重区间的起点（前缀权和 C_{i-1}），插值目标 t = q·(W-1) —— 全 1 权重时
 *  逐位等价于未加权公式 pos=(n-1)·q（兼容既有语义）。 */
function weightedQuantile(sorted: readonly WeightedSample[], q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const anchors: number[] = []
  let cum = 0
  for (const s of sorted) {
    anchors.push(cum)
    cum += s.weight
  }
  if (cum <= 0) {
    // 权重全部衰减为 0（理论边界）：退化为未加权分位数
    return quantile(sorted.map(s => s.value), q)
  }
  const t = q * (cum - 1)
  if (t <= anchors[0]!) return sorted[0]!.value
  if (t >= anchors[n - 1]!) return sorted[n - 1]!.value
  for (let i = 0; i < n - 1; i++) {
    const a = anchors[i]!
    const b = anchors[i + 1]!
    if (t >= a && t < b) {
      if (b <= a) return sorted[i]!.value   // 零权重样本无跨度
      return sorted[i]!.value
        + (sorted[i + 1]!.value - sorted[i]!.value) * ((t - a) / (b - a))
    }
  }
  return sorted[n - 1]!.value
}

/** 指数衰减权重：0.5^(年龄/半衰期)。半衰期 Infinity → 恒 1（不衰减）；
 *  ≤0 → 只有最新样本（年龄 0）有权重。 */
function decayWeight(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1
  if (!(halfLifeMs > 0)) return 0
  return 0.5 ** (ageMs / halfLifeMs)
}

/** MAD×1.4826：对正态数据等价于标准差，但对离群点稳健（阈值不被污染） */
function robustSigma(values: readonly number[]): number {
  const med = median(values)
  return 1.4826 * median(values.map(v => Math.abs(v - med)))
}

/** 快照形状守卫：JSON.parse 只拦语法错误，"null"/"42" 等合法 JSON 直投
 *  TrendSnapshot 后，下游 s.profile 过滤/s.at.localeCompare 会抛 TypeError
 *  使整个 analyze 失败 —— 单条坏行不该有一票否决权。 */
function isTrendSnapshot(v: unknown): v is TrendSnapshot {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.at === 'string'
    && typeof s.bytesReclaimable === 'number'
    && typeof s.profile === 'string'
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

interface TrendFit {
  /** 斜率（字节/ms） */
  readonly slope: number
  readonly intercept: number
  /** 斜率 95% 置信区间（字节/ms）；无有效成对斜率 → null（不可估计） */
  readonly slopeLow: number | null
  readonly slopeHigh: number | null
}

/** 时间加权 Theil-Sen：斜率 = 全部成对斜率（按两端点权重之积加权）的中位数；
 *  截距 = median(y − slope·x)（按端点权重加权）。O(n²) 对 —— 快照量级（数百）
 *  下毫秒级；完美线性数据下与 LS 完全一致（权重不影响相同值的次序）。 */
function regress(
  points: readonly { x: number; y: number }[],
  halfLifeMs: number,
): TrendFit {
  const n = points.length
  if (n < 2) {
    return { slope: 0, intercept: n === 1 ? points[0]!.y : 0, slopeLow: null, slopeHigh: null }
  }
  const xRef = Math.max(...points.map(p => p.x))
  const w = points.map(p => decayWeight(xRef - p.x, halfLifeMs))
  const slopes: WeightedSample[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[j]!.x - points[i]!.x
      if (dx > 0) {
        const s = (points[j]!.y - points[i]!.y) / dx
        // 极小 dx 会把成对斜率炸成 ±Infinity：非有限斜率不入样本
        if (Number.isFinite(s)) slopes.push({ value: s, weight: w[i]! * w[j]! })
      }
    }
  }
  if (slopes.length === 0) {
    return { slope: 0, intercept: median(points.map(p => p.y)), slopeLow: null, slopeHigh: null }
  }
  slopes.sort((a, b) => a.value - b.value)
  const slope = weightedQuantile(slopes, 0.5)
  const interceptSamples = points
    .map((p, i) => ({ value: p.y - slope * p.x, weight: w[i]! }))
    .sort((a, b) => a.value - b.value)
  const intercept = weightedQuantile(interceptSamples, 0.5)
  // 终极保险：拟合结果非有限（理论上已被上游净化排除）时退化为无趋势
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return { slope: 0, intercept: median(points.map(p => p.y)), slopeLow: null, slopeHigh: null }
  }
  return {
    slope,
    intercept,
    slopeLow: weightedQuantile(slopes, SLOPE_CI_Q),
    slopeHigh: weightedQuantile(slopes, 1 - SLOPE_CI_Q),
  }
}

// ─── CUSUM 变点检测 ────────────────────────────────────────────

/** 局部增长率：相邻快照对的 bytesReclaimable 变化率（字节/天），
 *  挂靠右端快照（新 regime 的首个快照） */
interface LocalRate {
  readonly atEnd: string
  readonly bytesPerDay: number
}

function buildLocalRates(all: readonly TrendSnapshot[]): LocalRate[] {
  const rates: LocalRate[] = []
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1]!
    const cur = all[i]!
    const dx = Date.parse(cur.at) - Date.parse(prev.at)
    // 重复时间戳（dx=0）不产生速率；只跳过该对，不影响后续配对
    if (dx > 0) {
      const r = ((cur.bytesReclaimable - prev.bytesReclaimable) / dx) * MS_PER_DAY
      if (Number.isFinite(r)) rates.push({ atEnd: cur.at, bytesPerDay: r })
    }
  }
  return rates
}

interface ChangepointCandidate {
  /** 变点所在的局部率下标（新 regime 的首个速率区间） */
  readonly idx: number
  readonly dir: 'up' | 'down'
}

/** CUSUM 序贯检测（pass 1）：从热身窗建立基准 μ/σ̂，逐率累积上/下行偏移，
 *  超阈值且累积 ≥2 个率 → 记候选变点，并从变点处重建基准继续（多 regime）。
 *  pass 2：方向一致性后验 —— 候选方向必须与前后 regime 中位数差值同号，
 *  否则丢弃（单点尖峰会让 CUSUM 报警，但前后中位数几乎不变 → 不是变点）。 */
function detectChangepoints(
  rates: readonly LocalRate[],
  warmup: number,
  thresholdSigmas: number,
): TrendChangepoint[] {
  const W = Math.max(2, Math.floor(warmup))
  const candidates: ChangepointCandidate[] = []
  const segMedian = (from: number, to: number): number =>
    median(rates.slice(from, to).map(r => r.bytesPerDay))

  // ── pass 1：序贯 CUSUM，产出候选变点 ──
  let pos = 0
  while (pos + W < rates.length) {
    const mu = segMedian(pos, pos + W)
    const sigma = robustSigma(rates.slice(pos, pos + W).map(r => r.bytesPerDay))
    const k = 0.5 * sigma            // 容差：吸收 ±σ̂/2 内的抖动
    const h = thresholdSigmas * sigma // 报警阈值
    let up = 0
    let down = 0
    let runUp = pos + W               // 当前上行累积的起始率下标
    let runDown = pos + W
    let detected = false
    for (let i = pos + W; i < rates.length; i++) {
      const dev = rates[i]!.bytesPerDay - mu
      up = Math.max(0, up + dev - k)
      down = Math.min(0, down + dev + k)
      if (up === 0) runUp = i + 1
      if (down === 0) runDown = i + 1
      // 单率偏移（i === run*）不算变点：那是尖峰，归 3σ̂ 异常检测管
      const upAlarm = up > h && i > runUp
      const downAlarm = -down > h && i > runDown
      if (upAlarm || downAlarm) {
        candidates.push(downAlarm && -down > up
          ? { idx: runDown, dir: 'down' }
          : { idx: runUp, dir: 'up' })
        detected = true
        break
      }
    }
    if (!detected) break
    pos = candidates[candidates.length - 1]!.idx   // 从变点处重建基准
  }
  if (candidates.length === 0) return []

  // ── pass 2：方向一致性后验（用初步分段的前后中位数自证）──
  const bounds = [0, ...candidates.map(c => c.idx), rates.length]
  const kept: ChangepointCandidate[] = []
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const before = segMedian(bounds[i]!, c.idx)
    const after = segMedian(c.idx, bounds[i + 2]!)
    const tol = 1e-9 * Math.max(1, Math.abs(before), Math.abs(after))
    if (c.dir === 'up' ? after - before > tol : before - after > tol) kept.push(c)
  }
  if (kept.length === 0) return []

  // 幸存分段重算前后中位数（被丢弃的候选不切分 regime）
  const finalBounds = [0, ...kept.map(c => c.idx), rates.length]
  return kept.map((c, i) => ({
    at: rates[c.idx]!.atEnd,
    direction: c.dir,
    bytesPerDayBefore: segMedian(finalBounds[i]!, c.idx),
    bytesPerDayAfter: segMedian(c.idx, finalBounds[i + 2]!),
  }))
}

export function createTrendTracker(options: TrendTrackerOptions): ITrendTrackerDetail {
  const file = path.join(options.historyDir, 'trend.jsonl')
  const readAll = (): TrendSnapshot[] => readJsonl<TrendSnapshot>(file, isTrendSnapshot) ?? []
  const halfLifeMs = (options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * MS_PER_DAY
  const cusumWarmup = options.cusumWarmup ?? DEFAULT_CUSUM_WARMUP
  const cusumThresholdSigmas = options.cusumThresholdSigmas ?? DEFAULT_CUSUM_THRESHOLD_SIGMAS

  /** 出口终检：非有限值绝不下发（Infinity 进 JSON 序列化会变 null，
   *  NaN 会毒化下游 daysUntilFull/告警文案） */
  const finiteOrNull = (v: number | null): number | null =>
    v !== null && Number.isFinite(v) ? v : null

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
        let bytesPerDayLow: number | null = null
        let bytesPerDayHigh: number | null = null
        let projected30dBytesLow: number | null = null
        let projected30dBytesHigh: number | null = null
        let anomalyDetail: string | null = null

        if (n >= 2) {
          const fit = regress(points, halfLifeMs)
          bytesPerDay = (fit.slope * MS_PER_DAY)
          const lastX = points[n - 1]!.x
          projected30dBytes = Math.max(0, fit.intercept + fit.slope * (lastX + 30 * MS_PER_DAY))

          // 预测区间：锚定在中心拟合线的末点取值，宽度纯由斜率不确定性驱动
          // —— 点估计（intercept + slope·(lastX+30d)）恒居区间内。
          if (fit.slopeLow !== null && fit.slopeHigh !== null) {
            bytesPerDayLow = fit.slopeLow * MS_PER_DAY
            bytesPerDayHigh = fit.slopeHigh * MS_PER_DAY
            const fittedLast = fit.intercept + fit.slope * lastX
            projected30dBytesLow = Math.max(0, fittedLast + fit.slopeLow * 30 * MS_PER_DAY)
            projected30dBytesHigh = Math.max(0, fittedLast + fit.slopeHigh * 30 * MS_PER_DAY)
          }

          // 3σ̂ 异常检测（out-of-sample）：用历史点拟合，检验末点是否离群。
          // 不能把末点放进拟合集 —— 离群点会抬高 σ 稀释自身（自我掩盖）。
          // σ̂ = MAD×1.4826：阈值本身抗污染（LS 的 σ 会被历史离群点撑大）。
          // 注：噪声尺度是测量过程的物理属性，不随时间衰减 —— σ̂ 不做时间加权。
          if (n >= 3) {
            const train = points.slice(0, -1)
            const fitTrain = regress(train, halfLifeMs)
            const trainRes = train.map(p => p.y - (fitTrain.intercept + fitTrain.slope * p.x))
            const sd = robustSigma(trainRes)
            const predicted = fitTrain.intercept + fitTrain.slope * points[n - 1]!.x
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

        const report: TrendReportDetail = {
          snapshotCount: n,
          firstAt: n > 0 ? all[0]!.at : null,
          lastAt: n > 0 ? all[n - 1]!.at : null,
          bytesPerDay: Number.isFinite(bytesPerDay) ? bytesPerDay : 0,
          projected30dBytes:
            projected30dBytes !== null && Number.isFinite(projected30dBytes)
              ? projected30dBytes
              : null,
          anomaly: { detected: anomalyDetail !== null, detail: anomalyDetail },
          latest: n > 0 ? all[n - 1]! : null,
          changepoints: detectChangepoints(
            buildLocalRates(all), cusumWarmup, cusumThresholdSigmas),
          bytesPerDayLow: finiteOrNull(bytesPerDayLow),
          bytesPerDayHigh: finiteOrNull(bytesPerDayHigh),
          projected30dBytesLow: finiteOrNull(projected30dBytesLow),
          projected30dBytesHigh: finiteOrNull(projected30dBytesHigh),
        }
        return ok(report)
      } catch (e) {
        return err(ioError('趋势分析失败', e))
      }
    },
  }
}

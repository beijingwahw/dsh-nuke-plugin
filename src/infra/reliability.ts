// src/infra/reliability.ts — IReliabilityModel 实现
// 数据源是审计链而非独立状态文件：单一事实源，永不与实际历史漂移；
// 审计 hash chain 的完整性同时就是可靠性数据的信任根。
//
// 统计方法（经验贝叶斯分层收缩）：
//   全局层  μ = (S + K·μ₀)/(S+F+K)   —— pooled 成功率向设计先验 μ₀ 收缩
//   动作层  α = μκ + s_a,  β = (1-μ)κ + f_a
//   p̂_a   = α/(α+β)                  —— 向全局均值收缩的后验均值
//   CI95   = Wilson score interval    —— 以 (p̂_a, α+β) 为输入的 Wilson 区间
//   selfWeight = (s_a+f_a)/(s_a+f_a+κ) —— 收缩系数（可解释）
// κ 是动作层先验强度：动作观测数 << κ 时几乎完全借力全局，>> κ 时自信。
//
// 设计先验（V5.1.1 冷启动修复）：
//   旧全局层用 Laplace +1/+2 → 零历史时 μ=0.5（硬币先验）。硬币先验对
//   "无信息"是中立的，但对本域是错的：事务引擎 validate 前置（失败在
//   commit 前被拦截）、编辑前快照备份、目录改名进回收区、Saga 回滚 ——
//   步骤失败是设计上的例外而非常态。更致命的是先知按 Saga 连乘
//   P = ∏p_i：0.5⁴=6%、0.5¹⁴=0.006%，把"零信息"误渲染为"高故障"，
//   用户看到的是吓人的低成功率而非诚实的"尚无数据"。
//   修复：全局层向设计先验 μ₀=0.95 收缩（强度 K=20 —— 约 20 次全局
//   观测后历史数据权重过半，先验随数据自动稀释）；零历史时 μ=μ₀，
//   0.95⁴=81%、0.95¹⁴=49%，与"设计上会成功"的直觉一致，且置信度
//   仍诚实标注 low、CI 仍宽（Wilson 不假装知道）。
//
// CI 升级说明（正态近似 → Wilson）：
//   Beta 正态近似在小区间（n 小 / p̂ 近 0 或 1）会给出越界 [0,1] 的区间，
//   只能靠 clamp 掩盖 —— 形同虚设。Wilson score interval 以
//   p̂ + z²/2n 为中心、以 (1+z²/n)⁻¹ 收缩幅度，天然有界、小样本偏斜
//   正确，是计数型比例区间的小样本标准解。此处 p̂ 取收缩后验均值、
//   n 取后验有效样本量 α+β —— 区间与点估计同源（都来自同一 Beta 后验）。
//
// 校准分布升级（等权分位数 → 时间加权分位数）：
//   估算精度会漂移（工具链/磁盘形态变化），老样本的可信度自然衰减。
//   每个 ratio 样本按其时间戳获得指数衰减权重（半衰期可配，默认 30 天），
//   分位数在"权重代表位置"上做线性插值 —— 全 1 权重时严格退化为
//   旧公式 pos=(n-1)·q（兼容既有语义），近期样本权重更高则区间整体
//   向近期观测偏移。
import type { IAuditLog } from '../contracts/logging'
import { OP_AUDIT_PREFIX } from '../contracts/logging'
import type {
  ActionReliability, CalibrationSummary, IReliabilityModel, SizeBucket,
} from '../contracts/reliability.contract'

// ─── V5.2：大小桶边界（操作级协变量调制） ─────────────────────
// 大目录删除的失败模式（EBUSY/长路径/超时/句柄耗尽）与 5MB 级完全不同，
// "remove-node-modules 的成功率"应按体量分层。桶先验强度 κ_b=5：
// 桶内样本天然稀疏（动作层样本被 3 个桶摊薄），更快向动作层让位。
const SIZE_BUCKETS: ReadonlyArray<{ readonly bucket: SizeBucket; readonly min: number; readonly max: number | null }> = [
  { bucket: 'small', min: 0, max: 1024 * 1024 },                    // < 1MB
  { bucket: 'medium', min: 1024 * 1024, max: 100 * 1024 * 1024 },   // 1MB ~ 100MB
  { bucket: 'large', min: 100 * 1024 * 1024, max: null },           // ≥ 100MB
]

function bucketOf(sizeBytes: number): (typeof SIZE_BUCKETS)[number] | null {
  for (const b of SIZE_BUCKETS) {
    if (sizeBytes >= b.min && (b.max === null || sizeBytes < b.max)) return b
  }
  return null
}

/** 桶层先验强度：小于动作层 κ=10 —— 桶样本被三桶摊薄，更快向动作层让位 */
const BUCKET_KAPPA = 5

export interface ReliabilityModelOptions {
  readonly audit: IAuditLog
  /** 经验贝叶斯先验强度 κ（默认 10：约 10 次观测后自身数据过半） */
  readonly shrinkage?: number
  /**
   * 设计先验成功率 μ₀（默认 0.95）：零历史时全局层的收缩锚点。
   * 取值依据：validate 前置 + 快照备份 + 回收区改名 + Saga 回滚的事务
   * 引擎，步骤失败是设计上的例外。可配置（如观察到真实环境更脆弱可调低）。
   */
  readonly priorSuccessProbability?: number
  /** 设计先验强度 K（默认 20：约 20 次全局观测后历史数据权重过半） */
  readonly priorStrength?: number
  /** 校准分布所需最少样本数（默认 3，不足则诚实返回 null） */
  readonly minCalibrationSamples?: number
  /** 校准样本权重半衰期（ms，默认 30 天）：权重 = 0.5^(年龄/半衰期)。
   *  年龄以该动作样本中最新的时间戳为基准 —— 无墙钟依赖，结果确定。
   *  Infinity = 不做时间衰减（全 1 权重，等价于未加权分位数）。 */
  readonly calibrationHalfLifeMs?: number
  /** 只统计该时间之后的观测（ISO；默认全部） */
  readonly since?: string
}

interface CalibrationSample {
  readonly ratio: number
  readonly atMs: number   // Date.parse(timestamp)；NaN = 时间不可知
}

interface ActionStats {
  successes: number
  failures: number
  samples: CalibrationSample[]
  /** V5.2：大小桶统计（estimated 可归桶的成败样本；双向归桶保证无偏） */
  buckets: Map<SizeBucket, { successes: number; failures: number }>
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/** Wilson score interval：输入比例点估计与有效样本量，返回 95% 区间。
 *  n ≤ 0（零有效样本）→ [0,1]：诚实承认一无所知。 */
function wilsonInterval(pHat: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1]
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (pHat + z2 / (2 * n)) / denom
  const spread = (z / denom) * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))
  return [clamp01(center - spread), clamp01(center + spread)]
}

interface WeightedSample {
  readonly value: number
  readonly weight: number
}

/** 加权分位数（线性插值）：样本 i 的代表位置 = 其权重区间的起点
 *  （前缀权和 C_{i-1}），插值目标 t = q·(W-1) —— 与未加权公式
 *  pos=(n-1)·q 完全同构（全 1 权重时逐位等价）。 */
function weightedQuantile(sorted: readonly WeightedSample[], q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const anchors: number[] = []
  let cum = 0
  for (const s of sorted) {
    anchors.push(cum)
    cum += s.weight
  }
  const W = cum
  if (W <= 0) {
    // 权重全部衰减为 0（理论边界）：退化为未加权分位数
    return quantile(sorted.map(s => s.value), q)
  }
  const t = q * (W - 1)
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

export async function createReliabilityModel(
  options: ReliabilityModelOptions,
): Promise<IReliabilityModel> {
  const kappa = options.shrinkage ?? 10
  const mu0 = options.priorSuccessProbability ?? 0.95
  const priorK = options.priorStrength ?? 20
  const minCal = options.minCalibrationSamples ?? 3
  const halfLifeMs = options.calibrationHalfLifeMs ?? 30 * 24 * 3600 * 1000

  // ── 采集：一次性读审计链，按动作聚合 ───────────────────────
  const entries = await options.audit.query(options.since !== undefined ? { since: options.since } : {})
  const stats = new Map<string, ActionStats>()
  let pooledS = 0
  let pooledF = 0
  for (const e of entries) {
    if (!e.action.startsWith(OP_AUDIT_PREFIX)) continue
    if (e.outcome === 'skipped') continue   // 策略性跳过不是可靠性证据
    const action = e.action.slice(OP_AUDIT_PREFIX.length)
    const s = stats.get(action)
      ?? { successes: 0, failures: 0, samples: [] as CalibrationSample[], buckets: new Map<SizeBucket, { successes: number; failures: number }>() }
    const est = (e.detail as { estimated?: unknown }).estimated
    const act = (e.detail as { actual?: unknown }).actual
    if (e.outcome === 'success') {
      s.successes++
      pooledS++
      // 校准样本：detail { estimated, actual }（estimated>0 时才有意义）
      if (typeof est === 'number' && typeof act === 'number' && est > 0) {
        s.samples.push({ ratio: act / est, atMs: Date.parse(e.timestamp) })
      }
    } else {
      s.failures++
      pooledF++
    }
    // V5.2 大小桶：成败双向归桶（estimated>0 即可归桶；失败样本同样
    // 带 estimated —— 事务引擎失败审计已记录预估量，负证据不丢失）
    if (typeof est === 'number' && est > 0) {
      const b = bucketOf(est)
      if (b) {
        const bs = s.buckets.get(b.bucket) ?? { successes: 0, failures: 0 }
        if (e.outcome === 'success') bs.successes++
        else bs.failures++
        s.buckets.set(b.bucket, bs)
      }
    }
    stats.set(action, s)
  }

  // 全局层：pooled 成功率向设计先验 μ₀ 收缩（强度 K）。
  // 零历史 → μ = μ₀（0.95）；数据累积 → 先验权重 1/(n+K) 自动稀释。
  const mu = (pooledS + priorK * mu0) / (pooledS + pooledF + priorK)
  const sampleCount = pooledS + pooledF

  /** 校准样本 → 时间加权样本集（按值升序，权重随年龄指数衰减） */
  function weightedSamples(samples: readonly CalibrationSample[]): WeightedSample[] {
    const finite = samples.map(x => x.atMs).filter(v => Number.isFinite(v))
    const tRef = finite.length > 0 ? Math.max(...finite) : null
    return samples.map(x => ({
      value: x.ratio,
      weight: tRef !== null && Number.isFinite(x.atMs)
        ? 0.5 ** (Math.max(0, tRef - x.atMs) / halfLifeMs)
        : 1,   // 时间不可知的样本不降权（保守计入，宁可多信不可盲弃）
    })).sort((a, b) => a.value - b.value)
  }

  function build(
    action: string,
    s: ActionStats | undefined,
    sizeBytes?: number,
  ): ActionReliability {
    const succ = s?.successes ?? 0
    const fail = s?.failures ?? 0
    const alpha = mu * kappa + succ
    const beta = (1 - mu) * kappa + fail
    let mean = alpha / (alpha + beta)
    let ci: readonly [number, number]
    let selfWeight = (succ + fail) / (succ + fail + kappa)
    let sizeBucket: ActionReliability['sizeBucket']

    // V5.2 桶层调制：α_b = p_action·κ_b + s_b, β_b = (1-p_action)·κ_b + f_b
    //（三层收缩：桶 → 动作 → 全局 → 设计先验；κ_b=5）
    // 注意：selfWeight 保持动作层口径（"该动作有多少自身历史"），
    // 桶层权重单独由 sizeBucket.selfWeight 表达 —— 两个语义不混用。
    if (typeof sizeBytes === 'number' && sizeBytes >= 0) {
      const b = bucketOf(sizeBytes)
      if (b) {
        const bs = s?.buckets.get(b.bucket) ?? { successes: 0, failures: 0 }
        const nB = bs.successes + bs.failures
        const alphaB = mean * BUCKET_KAPPA + bs.successes
        const betaB = (1 - mean) * BUCKET_KAPPA + bs.failures
        mean = alphaB / (alphaB + betaB)
        ci = wilsonInterval(mean, alphaB + betaB)
        sizeBucket = {
          bucket: b.bucket,
          rangeBytes: [b.min, b.max],
          samples: nB,
          selfWeight: nB / (nB + BUCKET_KAPPA),
        }
      } else {
        ci = wilsonInterval(mean, alpha + beta)
      }
    } else {
      ci = wilsonInterval(mean, alpha + beta)
    }

    // Wilson score interval：点估计与区间同源于 Beta(α,β) 后验
    const [lo, hi] = ci
    const samples = weightedSamples(s?.samples ?? [])
    const calibration: CalibrationSummary | null = samples.length >= minCal
      ? {
        samples: samples.length,
        p10: weightedQuantile(samples, 0.10),
        p50: weightedQuantile(samples, 0.50),
        p90: weightedQuantile(samples, 0.90),
      }
      : null
    return {
      action,
      successes: succ,
      failures: fail,
      successProbability: mean,
      ci95: [lo, hi],
      selfWeight,
      calibration,
      ...(sizeBucket !== undefined ? { sizeBucket } : {}),
    }
  }

  const snapshot = new Map<string, ActionReliability>()
  for (const [action, s] of stats) snapshot.set(action, build(action, s))

  return {
    sampleCount,
    globalSuccessProbability: mu,
    byAction: () => snapshot,
    reliabilityOf: (action, opts) => {
      const base = stats.get(action)
      return build(action, base, opts?.sizeBytes)
    },
  }
}

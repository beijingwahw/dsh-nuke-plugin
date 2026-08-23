// src/infra/reliability.ts — IReliabilityModel 实现
// 数据源是审计链而非独立状态文件：单一事实源，永不与实际历史漂移；
// 审计 hash chain 的完整性同时就是可靠性数据的信任根。
//
// 统计方法（经验贝叶斯分层收缩）：
//   全局层  μ = (S+1)/(S+F+2)         —— pooled 成功率（Laplace 平滑）
//   动作层  α = μκ + s_a,  β = (1-μ)κ + f_a
//   p̂_a   = α/(α+β)                  —— 向全局均值收缩的后验均值
//   CI95   = p̂ ± 1.96·sd              —— Beta 正态近似
//   selfWeight = (s_a+f_a)/(s_a+f_a+κ) —— 收缩系数（可解释）
// κ 是先验强度：动作观测数 << κ 时几乎完全借力全局，>> κ 时自信。
import type { IAuditLog } from '../contracts/logging'
import type {
  ActionReliability, CalibrationSummary, IReliabilityModel,
} from '../contracts/reliability.contract'

/** 步骤级审计条目的 action 前缀（引擎写入） */
export const OP_AUDIT_PREFIX = 'op:'

export interface ReliabilityModelOptions {
  readonly audit: IAuditLog
  /** 经验贝叶斯先验强度 κ（默认 10：约 10 次观测后自身数据过半） */
  readonly shrinkage?: number
  /** 校准分布所需最少样本数（默认 3，不足则诚实返回 null） */
  readonly minCalibrationSamples?: number
  /** 只统计该时间之后的观测（ISO；默认全部） */
  readonly since?: string
}

interface ActionStats {
  successes: number
  failures: number
  ratios: number[]
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

export async function createReliabilityModel(
  options: ReliabilityModelOptions,
): Promise<IReliabilityModel> {
  const kappa = options.shrinkage ?? 10
  const minCal = options.minCalibrationSamples ?? 3

  // ── 采集：一次性读审计链，按动作聚合 ───────────────────────
  const entries = await options.audit.query(options.since !== undefined ? { since: options.since } : {})
  const stats = new Map<string, ActionStats>()
  let pooledS = 0
  let pooledF = 0
  for (const e of entries) {
    if (!e.action.startsWith(OP_AUDIT_PREFIX)) continue
    if (e.outcome === 'skipped') continue   // 策略性跳过不是可靠性证据
    const action = e.action.slice(OP_AUDIT_PREFIX.length)
    const s = stats.get(action) ?? { successes: 0, failures: 0, ratios: [] }
    if (e.outcome === 'success') {
      s.successes++
      pooledS++
      // 校准样本：detail { estimated, actual }（estimated>0 时才有意义）
      const est = (e.detail as { estimated?: unknown }).estimated
      const act = (e.detail as { actual?: unknown }).actual
      if (typeof est === 'number' && typeof act === 'number' && est > 0) {
        s.ratios.push(act / est)
      }
    } else {
      s.failures++
      pooledF++
    }
    stats.set(action, s)
  }

  const mu = (pooledS + 1) / (pooledS + pooledF + 2)   // 冷启动 = 0.5
  const sampleCount = pooledS + pooledF

  function build(action: string, s: ActionStats | undefined): ActionReliability {
    const succ = s?.successes ?? 0
    const fail = s?.failures ?? 0
    const alpha = mu * kappa + succ
    const beta = (1 - mu) * kappa + fail
    const mean = alpha / (alpha + beta)
    // Beta 分布方差 → 正态近似 95% CI
    const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)))
    const ratios = [...(s?.ratios ?? [])].sort((a, b) => a - b)
    const calibration: CalibrationSummary | null = ratios.length >= minCal
      ? { samples: ratios.length, p10: quantile(ratios, 0.10), p50: quantile(ratios, 0.50), p90: quantile(ratios, 0.90) }
      : null
    return {
      action,
      successes: succ,
      failures: fail,
      successProbability: mean,
      ci95: [clamp01(mean - 1.96 * sd), clamp01(mean + 1.96 * sd)],
      selfWeight: (succ + fail) / (succ + fail + kappa),
      calibration,
    }
  }

  const snapshot = new Map<string, ActionReliability>()
  for (const [action, s] of stats) snapshot.set(action, build(action, s))

  return {
    sampleCount,
    globalSuccessProbability: mu,
    byAction: () => snapshot,
    reliabilityOf: (action) => snapshot.get(action) ?? build(action, undefined),
  }
}

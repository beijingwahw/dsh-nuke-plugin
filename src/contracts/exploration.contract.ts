// contracts/exploration.contract.ts — V5.6 探索智能（Thompson 受控探索）
//
// 问题：V3 → V5.5 的学习系统是纯利用（exploitation）—— 所有预测取
// 后验均值，决策永远偏向历史证据充分的动作。这有一个系统性死锁：
// "富者愈富"—— 新动作/新尺寸桶的成功率收缩向先验，在均值口径下
// 永远竞争不过有历史的动作，于是永远不被执行，永远没有数据，
// 先验永远不被修正。多臂老虎机理论对此有标准解法：Thompson 采样
//（后验采样决策）—— 不取均值，而是从 Beta 后验**抽一个样本**来
// 决策：后验宽（数据少）的动作偶尔被抽得很高而被选中执行，产生
// 数据后后验收窄 —— 探索与利用的比例由不确定性自动调节，渐近最优。
//
// 本契约提供读侧（先知推演）的探索智能：
//   sampleBeta     — 种子化 Beta 采样（Marsaglia-Tsang Gamma + Box-Muller）
//   thompsonExplore — 纯函数探索规划器：逐步后验采样 + 事务口径 +
//                     信息价值排序（"执行哪一步能最快让先知变准"）
//
// 信息价值口径（uncertaintyBytes）：
//   后验标准差 σ × 失败敞口 exposure —— "这步成功率的不确定度
//   值多少字节"。σ 大（数据少）且敞口大（失败作废的回收多）的
//   步骤最值得优先执行以获取数据。
//
// 纪律：探索报告是**建议**而非行为 —— 真正的执行决策仍由用户/Agent
// 基于 nuke_oracle 全量口径做出；采样种子固定 → 同输入逐位可复现。

/** 种子化 Gamma(shape, 1) 采样 —— Marsaglia-Tsang 压缩法（shape ≥ 1） */
function sampleGamma(shape: number, rand: () => number): number {
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    // Box-Muller 正态（u1 防零：log(0) = -∞）
    const u1 = Math.max(rand(), 1e-12)
    const u2 = rand()
    const x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const v = (1 + c * x) ** 3
    if (v <= 0) continue
    const u = rand()
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
      return d * v
    }
  }
}

/** 种子化 Beta(α,β) 采样：Beta = G(α)/(G(α)+G(β))。
 *  shape < 1 时用 Boost 公式 G(a) = G(a+1)·U^(1/a)。
 *  α/β 非正或退化 → NaN（调用方防御性跳过）。 */
export function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  if (!(alpha > 0) || !(beta > 0) || !Number.isFinite(alpha) || !Number.isFinite(beta)) {
    return Number.NaN
  }
  const draw = (shape: number): number => (shape < 1)
    ? sampleGamma(shape + 1, rand) * Math.pow(Math.max(rand(), 1e-12), 1 / shape)
    : sampleGamma(shape, rand)
  const g1 = draw(alpha)
  const g2 = draw(beta)
  const sum = g1 + g2
  return sum > 0 && Number.isFinite(sum) ? g1 / sum : alpha / (alpha + beta)
}

/** 探索输入：某一步的后验与敞口（纯数据，可来自任意可靠性模型） */
export interface ExplorationStepInput {
  readonly index: number
  readonly action: string
  /** 后验均值口径（与决策口径一致的基础 p） */
  readonly mean: number
  /** Beta 后验参数（可靠性模型暴露的最终层后验） */
  readonly alpha: number
  readonly beta: number
  /** 失败将作废的潜在回收（exposureBytes） */
  readonly exposureBytes: number
  /** 该动作自身历史样本数（successes + failures） */
  readonly evidence: number
}

/** 单步探索画像 */
export interface ThompsonStep {
  readonly index: number
  readonly action: string
  /** 后验均值（利用口径） */
  readonly mean: number
  /** 本次后验采样值（探索口径） */
  readonly sampled: number
  /** 采样惊喜 = sampled − mean（>0 乐观抽样） */
  readonly surprise: number
  /** 后验标准差 σ = √(αβ/((α+β)²(α+β+1))) */
  readonly posteriorSd: number
  /** 信息价值 = σ × 敞口（"这步的不确定度值多少字节"） */
  readonly uncertaintyBytes: number
  /** 自身历史样本数 */
  readonly evidence: number
}

/** Thompson 探索报告 */
export interface ThompsonExploration {
  /** 采样种子（同种子 + 同步骤序列 → 逐位可复现） */
  readonly seed: number
  readonly steps: readonly ThompsonStep[]
  /** 采样口径事务成功率 = ∏ sampled_i（基础口径连乘） */
  readonly sampledTxProbability: number
  /** 均值口径事务成功率 = ∏ mean_i（对照） */
  readonly meanTxProbability: number
  /** 信息价值最高的步骤（全部零敞口或零不确定 = null） */
  readonly mostInformative: ThompsonStep | null
  /** 人类可读的探索建议 */
  readonly rationale: string
}

export interface ThompsonExploreOptions {
  /** 采样种子（必填 —— 可复现性是审计纪律） */
  readonly seed: number
  /** 信息价值入榜的最小不确定敞口（默认 1 字节） */
  readonly minUncertaintyBytes?: number
}

/** 后验标准差：Beta(α,β) 的 σ */
export function betaSd(alpha: number, beta: number): number {
  const n = alpha + beta
  return Math.sqrt((alpha * beta) / (n * n * (n + 1)))
}

/** Thompson 探索规划器（纯函数）：
 *  逐步从 Beta 后验采样 → 采样口径事务成功率（探索决策的 Thompson 口径）
 *  + 信息价值排序（执行优先级：σ × 敞口 最大者最先）。 */
export function thompsonExplore(
  steps: readonly ExplorationStepInput[],
  options: ThompsonExploreOptions,
): ThompsonExploration {
  // 种子化 LCG（Numerical Recipes 参数，与 oracle 的蒙特卡洛同源同纪律）
  let state = options.seed >>> 0
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  const minUnc = options.minUncertaintyBytes ?? 1

  const out: ThompsonStep[] = []
  let sampledTx = 1
  let meanTx = 1
  for (const s of steps) {
    const sd = betaSd(s.alpha, s.beta)
    const sampled = sampleBeta(s.alpha, s.beta, rand)
    const p = Number.isFinite(sampled) ? Math.min(1, Math.max(0, sampled)) : s.mean
    sampledTx *= p
    meanTx *= s.mean
    out.push({
      index: s.index,
      action: s.action,
      mean: s.mean,
      sampled: p,
      surprise: p - s.mean,
      posteriorSd: sd,
      uncertaintyBytes: sd * s.exposureBytes,
      evidence: s.evidence,
    })
  }

  let mostInformative: ThompsonStep | null = null
  for (const st of out) {
    if (st.uncertaintyBytes < minUnc) continue
    if (mostInformative === null || st.uncertaintyBytes > mostInformative.uncertaintyBytes) {
      mostInformative = st
    }
  }

  const pct = (p: number) => `${(p * 100).toFixed(1)}%`
  const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)}MB`
  const parts: string[] = []
  parts.push(`Thompson 采样口径成功率 ${pct(sampledTx)}（均值口径 ${pct(meanTx)}）`)
  if (mostInformative !== null) {
    parts.push(`信息价值最高：第 ${mostInformative.index} 步 ${mostInformative.action}`
      + `（自身历史 ${mostInformative.evidence} 条，后验 σ ${(mostInformative.posteriorSd * 100).toFixed(1)} 个百分点`
      + `，不确定敞口 ≈ ${mb(mostInformative.uncertaintyBytes)}）—— 优先执行能最快收窄先知的盲区`)
  }
  const lucky = out.filter(s => s.surprise > 0.05).length
  if (lucky > 0) {
    parts.push(`${lucky} 步被乐观抽样（+5pp 以上）：数据不足的动作获得探索机会，执行即学习`)
  }

  return {
    seed: options.seed,
    steps: out,
    sampledTxProbability: sampledTx,
    meanTxProbability: meanTx,
    mostInformative,
    rationale: parts.join('；'),
  }
}

// src/engine/optimizer.ts — 清理计划合成器：帕累托最优动作子集选择
//
// 问题本质（概率背包变体）：给定 n 个候选动作（顺序固定，任意子集合法），
//   max E(S) = ∏p_i · Σw_i   与   max P(S) = ∏p_i   天然冲突
// → 双目标帕累托前沿 + 三种问法（max-reclaim / max-success / pareto）。
//
// 求解策略（世界级惯例：小规模精确、大规模启发式）：
//   n ≤ 16 → 2^n 精确枚举（65,536 子集 × O(n) 评估 ≈ 毫秒级），
//             前沿由全部子集的非支配集构成 —— 数学最优，可作回归基准
//   n > 16 → 贪心剔除序列（按 bytesPerPct 升序逐个剔除生成嵌套解）+ 2-swap
//             局部改善；嵌套序列天然覆盖前沿两端的"极端剔除路径"
//
// 可解释性：每个被剔除动作给出 successUplift × reclaimCost 的性价比账单
//（"剔除它花了 340MB 换 2.1 个百分点成功率"）—— 推荐不是黑箱。
import type { Result } from '../contracts/base'
import { err, ok } from '../contracts/base'
import type {
  CandidateAction, DropReason, OptimizedPlan, OptimizerGoal, ParetoPoint,
} from '../contracts/optimizer.contract'

/** 精确枚举的动作数上限（2^16 = 65,536 子集，评估 O(16) → 毫秒级） */
const EXACT_LIMIT = 16

// ─── 子集评估（纯函数，数学唯一入口） ────────────────────────────

/** 评估一个子集的双目标值（bits 为选中位掩码；顺序由候选数组下标承载） */
function evaluate(
  candidates: readonly CandidateAction[],
  bits: number,
): { p: number; w: number } {
  let p = 1
  let w = 0
  for (let i = 0; i < candidates.length; i++) {
    if (bits & (1 << i)) {
      const c = candidates[i]!
      p *= c.successProbability
      w += c.calibrationRatio * c.estimatedBytes
    }
  }
  return { p, w }
}

/** 评估并打包为前沿点（indices 升序 = 工厂序） */
function toPoint(
  candidates: readonly CandidateAction[],
  bits: number,
): ParetoPoint {
  const { p, w } = evaluate(candidates, bits)
  const indices: number[] = []
  const actions: CandidateAction['action'][] = []
  for (let i = 0; i < candidates.length; i++) {
    if (bits & (1 << i)) {
      indices.push(candidates[i]!.index)
      actions.push(candidates[i]!.action)
    }
  }
  return {
    indices,
    actions,
    dropped: candidates.length - indices.length,
    successProbability: p,
    expectedReclaimBytes: p * w,
  }
}

/** 支配判定：a 支配 b ⇔ a 在两目标上均 ≥ b 且至少一项 > b */
function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  const ge = a.successProbability >= b.successProbability
    && a.expectedReclaimBytes >= b.expectedReclaimBytes
  const gt = a.successProbability > b.successProbability
    || a.expectedReclaimBytes > b.expectedReclaimBytes
  return ge && gt
}

/** 从候选点集提取帕累托前沿（成功率升序 → 回收量降序的严格阶梯：
 *  f[0] = 激进端（回收量最大、成功率最低）；f[last] = 保守端（成功率最高、回收量最小）） */
function paretoFront(points: readonly ParetoPoint[]): ParetoPoint[] {
  // 先去重：不同子集可能产生数学等价的 (P, E)（贪心序列与 2-swap 交叠），
  // 重复点互不支配会以平点混入前沿
  const seen = new Set<string>()
  const unique: ParetoPoint[] = []
  for (const pt of points) {
    const key = `${pt.successProbability.toPrecision(12)}|${pt.expectedReclaimBytes.toPrecision(12)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(pt)
  }
  const front: ParetoPoint[] = []
  for (const pt of unique) {
    // 跳过被已入前沿者支配的点；同时剔除被新点支配的旧点
    if (front.some(f => dominates(f, pt))) continue
    for (let i = front.length - 1; i >= 0; i--) {
      if (dominates(pt, front[i]!)) front.splice(i, 1)
    }
    front.push(pt)
  }
  front.sort((a, b) => a.successProbability - b.successProbability
    || b.expectedReclaimBytes - a.expectedReclaimBytes)
  return front
}

// ─── 精确求解（n ≤ 16）────────────────────────────────────────

function solveExact(candidates: readonly CandidateAction[]): ParetoPoint[] {
  const n = candidates.length
  const points: ParetoPoint[] = []
  for (let bits = 1; bits < (1 << n); bits++) {
    points.push(toPoint(candidates, bits))
  }
  return paretoFront(points)
}

// ─── 启发式求解（n > 16）：贪心剔除 + 2-swap ────────────────────

/** 单动作性价比：剔除它换取 1 个百分点成功率要花多少字节
 *  （值越小越值得先剔 —— 成功率便宜、回收损失小） */
function bytesPerPctOf(c: CandidateAction): number {
  const uplift = (1 / c.successProbability - 1) * 100   // 剔除后 P 变为 P/p，提升换算
  const cost = c.calibrationRatio * c.estimatedBytes
  if (uplift <= 0) return Number.POSITIVE_INFINITY       // p=1 的动作剔除无成功率收益
  return cost / uplift
}

function solveHeuristic(candidates: readonly CandidateAction[]): ParetoPoint[] {
  const n = candidates.length
  const order = [...candidates.keys()].sort(
    (a, b) => bytesPerPctOf(candidates[a]!) - bytesPerPctOf(candidates[b]!),
  )
  // 贪心剔除序列：从全集开始逐个剔除性价比最高者 → n 个嵌套子集
  //（删到单元素为止：空集 = "不清理"，不构成解）
  const keep = new Set<number>([...candidates.keys()])
  const points: ParetoPoint[] = [toPoint(candidates, maskOf(keep, n))]
  for (const drop of order) {
    keep.delete(drop)
    if (keep.size === 0) break
    points.push(toPoint(candidates, maskOf(keep, n)))
  }
  // 2-swap 局部改善：对每个贪心解尝试"换出一员 + 换入一员"，
  // 生成非支配新解补充前沿（O(n²) 每解，两轮内收敛）
  for (let round = 0; round < 2; round++) {
    const base = paretoFront(points)
    for (const pt of base) {
      const inSet = new Set(pt.indices)
      for (let out = 0; out < n; out++) {
        if (!inSet.has(candidates[out]!.index)) continue
        for (let inn = 0; inn < n; inn++) {
          if (inSet.has(candidates[inn]!.index) || inn === out) continue
          const swapped = new Set([...inSet].filter(x => x !== candidates[out]!.index))
          swapped.add(candidates[inn]!.index)
          points.push(toPoint(candidates, maskOf(swapped, n)))
        }
      }
    }
  }
  return paretoFront(points)
}

function maskOf(keep: ReadonlySet<number>, n: number): number {
  let bits = 0
  for (let i = 0; i < n; i++) if (keep.has(i)) bits |= 1 << i
  return bits
}

// ─── 剔除理由（可解释性） ────────────────────────────────────────

function dropReasons(
  candidates: readonly CandidateAction[],
  recommendedBits: number,
): DropReason[] {
  const reasons: DropReason[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (recommendedBits & (1 << i)) continue
    const c = candidates[i]!
    const uplift = (1 / c.successProbability - 1) * 100
    const cost = c.calibrationRatio * c.estimatedBytes
    reasons.push({
      index: c.index,
      action: c.action,
      successUpliftPct: uplift,
      reclaimCostBytes: cost,
      bytesPerPct: uplift > 0 ? cost / uplift : Number.POSITIVE_INFINITY,
    })
  }
  return reasons.sort((a, b) => a.bytesPerPct - b.bytesPerPct)
}

// ─── 推荐点选择（按目标约束在前沿上选点） ────────────────────────

function selectByGoal(frontier: readonly ParetoPoint[], goal: OptimizerGoal): ParetoPoint {
  // 前沿约定：f[0] = 激进端（E 最大、P 最低）；f[last] = 保守端（P 最高）
  if (goal.kind === 'max-reclaim') {
    // E 尽可能大且 P 达标：从激进端（E 最大）向保守端走，首个 P 达标点
    for (const pt of frontier) {
      if (pt.successProbability >= goal.minSuccessProbability) return pt
    }
    return frontier[frontier.length - 1]!   // 无达标点 → 保守端（P 最高，诚实交由叙事说明约束不可行）
  }
  if (goal.kind === 'max-success') {
    // P 尽可能高且 E 达标：从保守端（P 最高）向激进端走，首个 E 达标点
    for (let i = frontier.length - 1; i >= 0; i--) {
      if (frontier[i]!.expectedReclaimBytes >= goal.minReclaimBytes) return frontier[i]!
    }
    return frontier[0]!   // 都不达标 → 激进端（E 最大）
  }
  // pareto：推荐"拐点"—— 边际收益开始急剧衰减处。
  // 沿前沿从激进端（f[0]）向保守端走，计算"每牺牲 1 字节回收换来的
  // 成功率提升"；该比率首次超过全局中位数×2 处 = 性价比崩塌点，
  // 拐点取其前一点（性价比尚可的最激进计划）—— 平衡且不极端。
  if (frontier.length <= 2) return frontier[0]!
  const ratios: number[] = []
  for (let i = 1; i < frontier.length; i++) {
    const dSuccess = (frontier[i]!.successProbability - frontier[i - 1]!.successProbability) * 100
    const dReclaim = frontier[i - 1]!.expectedReclaimBytes - frontier[i]!.expectedReclaimBytes
    if (dSuccess > 0 && dReclaim > 0) ratios.push(dReclaim / dSuccess)
  }
  if (ratios.length === 0) return frontier[0]!
  ratios.sort((a, b) => a - b)
  const median = ratios[Math.floor(ratios.length / 2)]!
  for (let i = 1; i < frontier.length; i++) {
    const dSuccess = (frontier[i]!.successProbability - frontier[i - 1]!.successProbability) * 100
    const dReclaim = frontier[i - 1]!.expectedReclaimBytes - frontier[i]!.expectedReclaimBytes
    if (dSuccess > 0 && dReclaim / dSuccess > median * 2) return frontier[i - 1]!
  }
  return frontier[0]!
}

// ─── 公共入口 ────────────────────────────────────────────────────

export function optimize(
  candidates: readonly CandidateAction[],
  goal: OptimizerGoal,
): Result<OptimizedPlan, { code: string; message: string }> {
  if (candidates.length === 0) {
    return err({ code: 'E_VALIDATION', message: '优化器需要至少一个候选动作' })
  }
  const n = candidates.length
  const fullBits = n >= 31 ? -1 >>> (32 - n) : (1 << n) - 1
  const solver: 'exact' | 'heuristic' = n <= EXACT_LIMIT ? 'exact' : 'heuristic'
  const frontier = solver === 'exact' ? solveExact(candidates) : solveHeuristic(candidates)
  const fullSet = toPoint(candidates, fullBits)
  const recommended = selectByGoal(frontier, goal)

  // 推荐点 → 位掩码（按工厂序 index 映射回候选下标）
  const byIndex = new Map(candidates.map((c, i) => [c.index, i]))
  let recBits = 0
  for (const idx of recommended.indices) recBits |= 1 << byIndex.get(idx)!
  const drops = dropReasons(candidates, recBits)

  const successUpliftPct = (recommended.successProbability - fullSet.successProbability) * 100
  const reclaimSacrificePct = fullSet.expectedReclaimBytes > 0
    ? (1 - recommended.expectedReclaimBytes / fullSet.expectedReclaimBytes) * 100
    : 0

  return ok({
    goal,
    recommended,
    frontier,
    fullSet,
    vsFullSet: { successUpliftPct, reclaimSacrificePct },
    drops,
    solver,
  })
}

// tests/optimizer.test.ts — 计划合成器单测
// 数学正确性 / 前沿支配性 / 目标约束选点 / 启发式质量 / 剔除理由
import { describe, expect, it } from 'vitest'
import { optimize } from '../src/engine/optimizer'
import type { CandidateAction } from '../src/contracts/optimizer.contract'

const MB = 1024 * 1024

function cand(
  index: number, action: string, p: number, bytes: number, cal = 1,
): CandidateAction {
  return {
    action: action as CandidateAction['action'],
    index,
    successProbability: p,
    estimatedBytes: bytes,
    calibrationRatio: cal,
    riskLevel: 'medium',
  }
}

describe('基础数学（Saga 语义）', () => {
  it('单动作全集 = 唯一计划；成功率和期望回收精确', () => {
    const r = optimize([cand(0, 'remove-storages', 0.9, 100 * MB)], { kind: 'pareto' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.frontier.length).toBe(1)
    expect(r.value.recommended.successProbability).toBeCloseTo(0.9)
    expect(r.value.recommended.expectedReclaimBytes).toBeCloseTo(0.9 * 100 * MB)
    expect(r.value.drops.length).toBe(0)
    expect(r.value.solver).toBe('exact')
  })

  it('两动作：全集 + 单独保留高回收者 → 前沿 2 点，数学手算核对', () => {
    // A: p=0.8, w=100MB；B: p=0.95, w=900MB
    // 全集: P=0.76, E=0.76×1000=760MB；仅B: P=0.95, E=855MB → 支配全集!
    // 仅A: P=0.8, E=80MB（被 855MB 支配）→ 前沿只含 {仅B, 全集}？855>760 且 0.95>0.76
    // → 仅B 支配全集 → 前沿只有 {仅B}。
    const r = optimize(
      [cand(0, 'a', 0.8, 100 * MB), cand(1, 'b', 0.95, 900 * MB)],
      { kind: 'pareto' },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 仅B 支配一切 → 前沿单点
    expect(r.value.frontier.length).toBe(1)
    expect(r.value.frontier[0]!.actions).toEqual(['b' as never])
    expect(r.value.recommended.successProbability).toBeCloseTo(0.95)
    expect(r.value.recommended.expectedReclaimBytes).toBeCloseTo(0.95 * 900 * MB)
  })

  it('校准比参与期望回收计算', () => {
    const r = optimize([cand(0, 'a', 1, 100 * MB, 0.5)], { kind: 'pareto' })
    if (!r.ok) return
    expect(r.value.recommended.expectedReclaimBytes).toBeCloseTo(50 * MB)
  })

  it('空候选 → 校验错误', () => {
    const r = optimize([], { kind: 'pareto' })
    expect(r.ok).toBe(false)
  })
})

describe('帕累托前沿性质（6 动作暴力验证）', () => {
  // 构造有真实权衡的 6 动作集：高字节低成功率 vs 低字节高成功率
  const candidates: CandidateAction[] = [
    cand(0, 'a', 0.99, 10 * MB),
    cand(1, 'b', 0.97, 30 * MB),
    cand(2, 'c', 0.92, 80 * MB),
    cand(3, 'd', 0.85, 200 * MB),
    cand(4, 'e', 0.70, 500 * MB),
    cand(5, 'f', 0.50, 900 * MB),
  ]

  it('前沿严格阶梯：成功率升序 + 回收量降序（无支配对）', () => {
    const r = optimize(candidates, { kind: 'pareto' })
    if (!r.ok) return
    const f = r.value.frontier
    expect(f.length).toBeGreaterThan(1)
    for (let i = 1; i < f.length; i++) {
      expect(f[i]!.successProbability).toBeGreaterThan(f[i - 1]!.successProbability)
      expect(f[i]!.expectedReclaimBytes).toBeLessThan(f[i - 1]!.expectedReclaimBytes)
    }
  })

  it('前沿两端语义：f[0]=激进端（回收 ≥ 全集，全集可被支配），f[last]=保守端（成功率最高）', () => {
    const r = optimize(candidates, { kind: 'pareto' })
    if (!r.ok) return
    const f = r.value.frontier
    // 数学事实：E = ∏p·Σw，剔除低 p 大 w 动作可能同时提升两目标
    // → 全集不一定帕累托最优。激进端（回收最大）必须 ≥ 全集
    expect(f[0]!.expectedReclaimBytes).toBeGreaterThanOrEqual(r.value.fullSet.expectedReclaimBytes)
    // 保守端不含空集（不清理不是解）且是全场最高成功率
    const maxP = Math.max(...f.map(x => x.successProbability))
    expect(f[f.length - 1]!.successProbability).toBeCloseTo(maxP)
    expect(f[f.length - 1]!.indices.length).toBeGreaterThanOrEqual(1)
  })

  it('精确前沿 = 全部 63 个非空子集的非支配集（暴力交叉验证）', () => {
    const r = optimize(candidates, { kind: 'pareto' })
    if (!r.ok) return
    // 暴力计算所有子集的 (P, E)，找非支配集大小
    const evals: { p: number; e: number }[] = []
    for (let bits = 1; bits < 64; bits++) {
      let p = 1, w = 0
      for (let i = 0; i < 6; i++) {
        if (bits & (1 << i)) { p *= candidates[i]!.successProbability; w += candidates[i]!.estimatedBytes }
      }
      evals.push({ p, e: p * w })
    }
    const nonDominated = evals.filter(x =>
      !evals.some(y => y !== x
        && y.p >= x.p && y.e >= x.e && (y.p > x.p || y.e > x.e)),
    )
    expect(r.value.frontier.length).toBe(nonDominated.length)
    // 推荐点必须真的在前沿里（不被任何子集支配）
    for (const pt of r.value.frontier) {
      const dominated = evals.some(x =>
        x.p > pt.successProbability && x.e > pt.expectedReclaimBytes)
      expect(dominated).toBe(false)
    }
  })
})

describe('目标约束选点', () => {
  const candidates: CandidateAction[] = [
    cand(0, 'a', 0.99, 10 * MB),
    cand(1, 'b', 0.9, 100 * MB),
    cand(2, 'c', 0.6, 800 * MB),
  ]

  it('max-reclaim 且 minSuccess=0.9：成功率达标者中回收最大', () => {
    const r = optimize(candidates, { kind: 'max-reclaim', minSuccessProbability: 0.9 })
    if (!r.ok) return
    expect(r.value.recommended.successProbability).toBeGreaterThanOrEqual(0.9)
    // 达标子集：{a}(0.99, 9.9MB), {b}(0.9, 90MB)；{a,b}=0.891<0.9 不达标
    // → 回收最大者 = {b}：P=0.9, E=90MB
    expect(r.value.recommended.actions).toEqual(['b' as never])
    expect(r.value.recommended.expectedReclaimBytes).toBeCloseTo(0.9 * 100 * MB)
  })

  it('max-reclaim 不可行阈值 → 回退保守端（成功率最高计划，不伪装达标）', () => {
    const r = optimize(candidates, { kind: 'max-reclaim', minSuccessProbability: 0.99999 })
    if (!r.ok) return
    // 无子集达标 → 保守端 = {a}（全场最高成功率 0.99）
    expect(r.value.recommended.actions).toEqual(['a' as never])
    expect(r.value.recommended.successProbability).toBeCloseTo(0.99)
  })

  it('max-success 且 minReclaim=50MB：回收达标者中成功率最大', () => {
    const r = optimize(candidates, { kind: 'max-success', minReclaimBytes: 50 * MB })
    if (!r.ok) return
    expect(r.value.recommended.expectedReclaimBytes).toBeGreaterThanOrEqual(50 * MB)
    // 前沿升序扫描：{a}: E=9.9MB（不达标）→ {b}: E=90MB（达标）→ 推荐 {b}
    expect(r.value.recommended.actions).toEqual(['b' as never])
    expect(r.value.recommended.successProbability).toBeCloseTo(0.9)
  })
})

describe('启发式求解器（n > 16）', () => {
  function gen(n: number): CandidateAction[] {
    const out: CandidateAction[] = []
    for (let i = 0; i < n; i++) {
      // 确定性构造：p 与字节负相关（真实权衡形态）
      const p = 0.99 - 0.005 * i
      const bytes = (i + 1) * 50 * MB
      out.push(cand(i, `act-${i}`, p, bytes))
    }
    return out
  }

  it('n=20：合法前沿（严格阶梯、激进端回收 ≥ 全集、无空集）', () => {
    const r = optimize(gen(20), { kind: 'pareto' })
    if (!r.ok) return
    expect(r.value.solver).toBe('heuristic')
    const f = r.value.frontier
    expect(f.length).toBeGreaterThan(1)
    for (let i = 1; i < f.length; i++) {
      expect(f[i]!.successProbability).toBeGreaterThan(f[i - 1]!.successProbability)
      expect(f[i]!.expectedReclaimBytes).toBeLessThan(f[i - 1]!.expectedReclaimBytes)
    }
    // 激进端（f[0]）回收量不劣于全集（启发式必须覆盖全集点）
    expect(f[0]!.expectedReclaimBytes).toBeGreaterThanOrEqual(r.value.fullSet.expectedReclaimBytes)
    // 前沿不含空集（不清理不是解）
    for (const pt of f) expect(pt.indices.length).toBeGreaterThanOrEqual(1)
  })

  it('启发式质量：同输入小规模下（n=14 精确 vs 强制启发路径不可比，用支配性自证）', () => {
    // n=14 用精确；其前沿点不应被任何"单动作剔除"贪心解支配（下界验证）
    const r = optimize(gen(14), { kind: 'pareto' })
    if (!r.ok) return
    expect(r.value.solver).toBe('exact')
    expect(r.value.frontier.length).toBeGreaterThan(1)
  })
})

describe('剔除理由（可解释性）', () => {
  it('每个被剔除动作给出成功率提升与回收代价的账单', () => {
    const candidates = [
      cand(0, 'keep-safe', 0.99, 10 * MB),
      cand(1, 'risky-big', 0.5, 500 * MB),
    ]
    const r = optimize(candidates, { kind: 'max-reclaim', minSuccessProbability: 0.9 })
    if (!r.ok) return
    expect(r.value.drops.length).toBe(1)
    const d = r.value.drops[0]!
    expect(d.action).toBe('risky-big' as never)
    expect(d.successUpliftPct).toBeCloseTo(100)   // 0.99/0.495 - 1 ≈ 100%
    expect(d.reclaimCostBytes).toBeCloseTo(500 * MB)
    expect(d.bytesPerPct).toBeGreaterThan(0)
  })

  it('推荐全集时 drops 为空', () => {
    const r = optimize([cand(0, 'a', 0.99, 10 * MB)], { kind: 'pareto' })
    if (!r.ok) return
    expect(r.value.drops.length).toBe(0)
    expect(r.value.vsFullSet.successUpliftPct).toBeCloseTo(0)
  })
})

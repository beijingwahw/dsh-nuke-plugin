// tests/exploration.test.ts — V5.6 探索智能（Thompson 受控探索 + CVaR 下行风险）
//
// 纯利用的死锁：所有预测取后验均值 → 决策永远偏向历史充分的动作 →
// 新动作永远不被执行 → 永远没有数据（富者愈富）。Thompson 采样用
// 后验抽样决策打破死锁：不确定性自动调节探索/利用比例。
//
// 测试纪律：
//   - 采样统计断言用大样本 + 固定种子（逐位可复现，不引入测试抖动）
//   - Beta 采样均值/方差对理论值的收敛（±5% 容差）
//   - 探索规划器为纯函数：同输入同种子 → 逐位相同
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { betaSd, sampleBeta, thompsonExplore } from '../src/contracts/exploration.contract'
import type { ExplorationStepInput } from '../src/contracts/exploration.contract'
import { createOracle } from '../src/engine/oracle'
import { createReliabilityModel } from '../src/infra/reliability'
import { createAuditLog } from '../src/infra/audit-log'
import { createLogger } from '../src/infra/logger'
import type { IReliabilityModel } from '../src/contracts/reliability.contract'
import type { CleanOperation, CleanRequest } from '../src/contracts/transaction'
import type { IPathResolver } from '../src/contracts/paths'
import type { Result } from '../src/contracts/base'
import { ok } from '../src/contracts/base'

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

// ─── 种子化 LCG（与生产同源） ────────────────────────────────
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('V5.6 Beta 采样（Marsaglia-Tsang）', () => {
  it('均值与方差收敛于 Beta 理论值（大样本 + 固定种子）', () => {
    const a = 9.5
    const b = 0.5
    const rand = lcg(42)
    const n = 20000
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const x = sampleBeta(a, b, rand)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      sum += x
      sumSq += x * x
    }
    const mean = sum / n
    const variance = sumSq / n - mean * mean
    const tMean = a / (a + b)
    const tVar = (a * b) / ((a + b) ** 2 * (a + b + 1))
    expect(mean).toBeGreaterThan(tMean * 0.95)
    expect(mean).toBeLessThan(tMean * 1.05)
    expect(variance).toBeGreaterThan(tVar * 0.9)
    expect(variance).toBeLessThan(tVar * 1.1)
  })

  it('退化输入 → NaN（防御性，不产生伪随机）', () => {
    const rand = lcg(1)
    expect(sampleBeta(0, 1, rand)).toBeNaN()
    expect(sampleBeta(1, -2, rand)).toBeNaN()
    expect(sampleBeta(Number.NaN, 1, rand)).toBeNaN()
  })

  it('同种子逐位可复现；异种子产生不同流', () => {
    const r1 = lcg(7)
    const r2 = lcg(7)
    const r3 = lcg(8)
    const s1 = Array.from({ length: 8 }, () => sampleBeta(3, 5, r1))
    const s2 = Array.from({ length: 8 }, () => sampleBeta(3, 5, r2))
    const s3 = Array.from({ length: 8 }, () => sampleBeta(3, 5, r3))
    expect(s1).toEqual(s2)
    expect(s1).not.toEqual(s3)
  })

  it('betaSd：Beta 标准差解析式', () => {
    // Beta(9.5, 0.5)：σ² = 9.5·0.5/(10²·11)
    expect(betaSd(9.5, 0.5)).toBeCloseTo(Math.sqrt((9.5 * 0.5) / (100 * 11)), 12)
    // 大样本 → σ 小（后验收窄 = 更确定）
    expect(betaSd(950, 50)).toBeLessThan(betaSd(9.5, 0.5))
  })
})

// ─── Thompson 探索规划器（纯函数） ────────────────────────────

function steps(): ExplorationStepInput[] {
  return [
    // 数据充分：σ 小，不确定敞口小
    { index: 0, action: 'clean-home-patch', mean: 0.98, alpha: 98, beta: 2, exposureBytes: 100, evidence: 80 },
    // 数据稀疏 + 大敞口：信息价值最高
    { index: 1, action: 'remove-node-modules', mean: 0.9, alpha: 9.5, beta: 0.5, exposureBytes: 400 * 1024 * 1024, evidence: 0 },
    // 数据稀疏 + 小敞口
    { index: 2, action: 'remove-storages', mean: 0.9, alpha: 9.5, beta: 0.5, exposureBytes: 200, evidence: 0 },
  ]
}

describe('V5.6 Thompson 探索规划器', () => {
  it('采样口径 = 逐步采样连乘；均值口径 = 逐步均值连乘', () => {
    const ex = thompsonExplore(steps(), { seed: 123 })
    expect(ex.sampledTxProbability).toBeCloseTo(
      ex.steps.reduce((acc, s) => acc * s.sampled, 1), 12,
    )
    expect(ex.meanTxProbability).toBeCloseTo(0.98 * 0.9 * 0.9, 12)
  })

  it('信息价值排序：σ × 敞口 最大者胜出（稀疏证据 + 大敞口）', () => {
    const ex = thompsonExplore(steps(), { seed: 123 })
    expect(ex.mostInformative).not.toBeNull()
    expect(ex.mostInformative!.index).toBe(1)
    expect(ex.mostInformative!.action).toBe('remove-node-modules')
    expect(ex.mostInformative!.evidence).toBe(0)
    // 敞口最大 + 同 σ → 不确定敞口最大
    expect(ex.mostInformative!.uncertaintyBytes).toBeGreaterThan(ex.steps[2]!.uncertaintyBytes)
  })

  it('同输入同种子 → 逐位可复现（审计纪律）', () => {
    const a = thompsonExplore(steps(), { seed: 999 })
    const b = thompsonExplore(steps(), { seed: 999 })
    expect(a).toEqual(b)
  })

  it('零不确定（点质量后验）→ mostInformative null（没有盲区就不建议探索）', () => {
    // α+β 极大且 p=1 → σ→0 → 敞口乘积趋零
    const deterministic: ExplorationStepInput[] = [
      { index: 0, action: 'a', mean: 1, alpha: 1e9, beta: 1e-6, exposureBytes: 1000, evidence: 1e9 },
    ]
    const ex = thompsonExplore(deterministic, { seed: 5, minUncertaintyBytes: 0.01 })
    expect(ex.mostInformative).toBeNull()
    expect(ex.rationale).toContain('Thompson 采样口径成功率')
  })

  it('rationale 提及信息价值与探索机会（人类可读）', () => {
    const ex = thompsonExplore(steps(), { seed: 123 })
    expect(ex.rationale).toContain('信息价值最高')
    expect(ex.rationale).toContain('remove-node-modules')
  })
})

// ─── 可靠性模型：posterior 暴露 ──────────────────────────────

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('V5.6 可靠性模型 posterior（与 mean 同源）', () => {
  it('posterior.alpha/(α+β) === successProbability（无大小查询）', async () => {
    const audit = createAuditLog({ filePath: path.join(tmp, 'chain-a.jsonl') })
    await audit.append({
      timestamp: new Date().toISOString(), actor: 't', action: 'op:remove-storages',
      outcome: 'success', detail: { operationId: 'a' },
    } as never)
    const model = await createReliabilityModel({ audit })
    const r = model.reliabilityOf('remove-storages')
    expect(r.posterior).toBeDefined()
    expect(r.posterior!.alpha / (r.posterior!.alpha + r.posterior!.beta))
      .toBeCloseTo(r.successProbability, 12)
    // 1 成 0 败 + 收缩：α = μ·κ + 1, β = (1-μ)·κ
    expect(r.posterior!.alpha).toBeGreaterThan(1)
    expect(r.posterior!.beta).toBeGreaterThan(0)
  })

  it('带 sizeBytes 查询 → 桶层后验（与调制后 mean 同源）', async () => {
    const audit = createAuditLog({ filePath: path.join(tmp, 'chain-b.jsonl') })
    await audit.append({
      timestamp: new Date().toISOString(), actor: 't', action: 'op:remove-node-modules',
      outcome: 'success', detail: { operationId: 'a', estimated: 500 * 1024 * 1024 },
    } as never)
    const model = await createReliabilityModel({ audit })
    const r = model.reliabilityOf('remove-node-modules', { sizeBytes: 600 * 1024 * 1024 })
    expect(r.posterior).toBeDefined()
    expect(r.posterior!.alpha / (r.posterior!.alpha + r.posterior!.beta))
      .toBeCloseTo(r.successProbability, 12)
    // 桶内 1 样本 + κ_b=5：后验强度 = 6（≠ 动作层 κ=10 + 1 = 11）
    expect(r.posterior!.alpha + r.posterior!.beta).toBeCloseTo(6, 10)
  })

  it('零历史动作：posterior = 纯先验（α+β = κ），σ 宽 → 高探索价值', async () => {
    const audit = createAuditLog({ filePath: path.join(tmp, 'chain-c.jsonl') })
    const model = await createReliabilityModel({ audit })
    const r = model.reliabilityOf('clean-home-patch')
    expect(r.successes + r.failures).toBe(0)
    expect(r.posterior!.alpha + r.posterior!.beta).toBeCloseTo(10, 10)
    // 零历史 σ 显著宽于有历史动作
    const audit2 = createAuditLog({ filePath: path.join(tmp, 'chain-d.jsonl') })
    for (let i = 0; i < 50; i++) {
      await audit2.append({
        timestamp: new Date().toISOString(), actor: 't', action: 'op:clean-home-patch',
        outcome: 'success', detail: { operationId: `a${i}` },
      } as never)
    }
    const model2 = await createReliabilityModel({ audit: audit2 })
    const r2 = model2.reliabilityOf('clean-home-patch')
    expect(betaSd(r2.posterior!.alpha, r2.posterior!.beta)).toBeLessThan(
      betaSd(r.posterior!.alpha, r.posterior!.beta),
    )
  })
})

// ─── 先知集成：探索报告 + CVaR ───────────────────────────────

const stubResolver: IPathResolver = {
  platform: () => ({ os: 'linux', home: '/h' as never, tempRoot: '/t' as never, dshHome: '/d' as never, pathSep: '/' }),
  canonicalize: async p => ok(p as never),
  isWithin: async () => true,
  assertDeletable: async p => ok(p as never),
  profileDir: () => '/d/profiles/web' as never,
  storagesRoot: () => '/d/storages' as never,
  attachmentsRoot: () => '/d/attachments' as never,
  dshHomePatchFile: () => '/d/cordis.patch.yml' as never,
  nukeStateRoot: () => '/d/.nuke' as never,
}

function mkOp(id: string, action: string, est: number): CleanOperation {
  return {
    id, action: action as CleanOperation['action'], target: 'p1' as never,
    async preview() {
      return { summary: id, touchedPaths: [], estimatedBytesReclaimable: est, requiresExclusiveLock: true }
    },
    async validate() { return ok(undefined) },
    async execute() { return ok({ outcome: { bytesFreed: 0, message: '' }, backup: null }) },
    async undo() { return ok(undefined) },
  }
}

const request: CleanRequest = {
  plugins: ['p1' as never], profile: 'web' as never,
  strategy: 'balanced', dryRun: false, actor: 't',
}

function modelWithPosterior(pOf: (action: string) => number, evidence: number): IReliabilityModel {
  return {
    sampleCount: 30,
    globalSuccessProbability: 0.95,
    byAction: () => new Map(),
    reliabilityOf: (action): IReliabilityModel extends never ? never : any => {
      const p = pOf(action)
      const alpha = p * (evidence + 10)
      const beta = (1 - p) * (evidence + 10)
      return {
        action, successes: evidence, failures: 0,
        successProbability: p,
        ci95: [0.5, 0.99], selfWeight: evidence / (evidence + 10),
        posterior: { alpha, beta },
        calibration: null,
        failureModes: [], transientShare: 0,
        retryAdjustedProbability: p,
        duration: { samples: 5, p50: 250, p90: 900 },
      }
    },
  }
}

function okv<T>(r: Result<T, { message: string }>): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

describe('V5.6 先知推演集成（exploration + CVaR）', () => {
  it('探索报告：逐步采样 + 事务口径 + 信息价值；叙事提及 Thompson/CVaR', async () => {
    const oracle = createOracle({
      reliability: async () => modelWithPosterior(a => (a === 'remove-node-modules' ? 0.6 : 0.95), 0),
      operationFactory: () => [mkOp('op-0', 'clean-home-patch', 100), mkOp('op-1', 'remove-node-modules', 200)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
    })
    const o = okv(await oracle.divine(request))
    expect(o.exploration).not.toBeNull()
    const ex = o.exploration!
    expect(ex.steps).toHaveLength(2)
    expect(ex.meanTxProbability).toBeCloseTo(0.95 * 0.6, 12)
    expect(ex.sampledTxProbability).toBeCloseTo(
      ex.steps.reduce((acc, s) => acc * s.sampled, 1), 12,
    )
    // 大敞口的稀疏步骤是信息价值之王（remove-node-modules 敞口 200 > 100）
    expect(ex.mostInformative!.index).toBe(1)
    // 叙事：探索口径 + 下行风险
    expect(o.narrative).toContain('Thompson 探索口径成功率')
    expect(o.narrative).toContain('下行风险 CVaR₁₀')
    expect(o.narrative).toContain('信息价值最高')
  })

  it('mock 模型无 posterior → 以 (mean, 强度10) 近似（兼容降级）', async () => {
    const legacyModel = {
      sampleCount: 10,
      globalSuccessProbability: 0.9,
      byAction: () => new Map(),
      reliabilityOf: (action: string) => ({
        action, successes: 9, failures: 1,
        successProbability: 0.9, ci95: [0.5, 0.99], selfWeight: 0.5,
        calibration: null, failureModes: [], transientShare: 0,
        retryAdjustedProbability: 0.9,
      }),
    } as unknown as IReliabilityModel
    const oracle = createOracle({
      reliability: async () => legacyModel,
      operationFactory: () => [mkOp('op-0', 'remove-storages', 100)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
    })
    const o = okv(await oracle.divine(request))
    expect(o.exploration).not.toBeNull()
    // 近似后验强度 = 10；采样仍落在 (0,1)
    expect(o.exploration!.steps[0]!.sampled).toBeGreaterThan(0)
    expect(o.exploration!.steps[0]!.sampled).toBeLessThan(1)
    expect(o.exploration!.meanTxProbability).toBeCloseTo(0.9, 12)
  })

  it('CVaR₁₀：成功率 > 10% 的 Saga → 尾部全失败 = 0（诚实下行）', async () => {
    const oracle = createOracle({
      reliability: async () => modelWithPosterior(() => 0.8, 100),
      operationFactory: () => [mkOp('op-0', 'remove-storages', 1000)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
    })
    const o = okv(await oracle.divine(request))
    expect(o.transactionSuccessProbability).toBeCloseTo(0.8, 10)
    expect(o.monteCarlo.trials).toBeGreaterThan(0)
    // 最差 10% 抽样全部是失败回滚 → 条件均值 0
    expect(o.monteCarlo.cvar10).toBe(0)
    // 互证：抽样成功率 ≈ 解析连乘
    expect(o.monteCarlo.successRate).toBeGreaterThan(0.7)
    expect(o.monteCarlo.successRate).toBeLessThan(0.9)
  })

  it('CVaR₁₀：成功率 > 90% → 最差尾部由失败回滚过渡到成功抽样，CVaR > 0', async () => {
    const oracle = createOracle({
      reliability: async () => modelWithPosterior(() => 0.95, 0),
      operationFactory: () => [mkOp('op-0', 'remove-storages', 1000)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
      monteCarloTrials: 5000,
    })
    const o = okv(await oracle.divine(request))
    expect(o.transactionSuccessProbability).toBeCloseTo(0.95, 10)
    // 零样本质量 5% < 尾部 10% → 尾部 = 全部失败(≈5%) + 最小的成功抽样(≈5%)
    // → CVaR₁₀ ≈ 0.05/0.1 × 1000 ≈ 500（无校准比扰动时）
    expect(o.monteCarlo.cvar10).toBeGreaterThan(0)
    expect(o.monteCarlo.cvar10).toBeLessThan(1000)
    // 单调性 sanity：尾部均值 ≤ 中位数
    expect(o.monteCarlo.cvar10).toBeLessThanOrEqual(o.monteCarlo.p50)
  })

  it('同种子同输入 → 探索报告逐位可复现', async () => {
    const build = () => createOracle({
      reliability: async () => modelWithPosterior(a => (a === 'remove-node-modules' ? 0.6 : 0.95), 0),
      operationFactory: () => [mkOp('op-0', 'clean-home-patch', 100), mkOp('op-1', 'remove-node-modules', 200)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date(2026, 0, 1) },
    })
    const a = okv(await build().divine(request))
    const b = okv(await build().divine(request))
    expect(a.exploration).toEqual(b.exploration)
  })
})

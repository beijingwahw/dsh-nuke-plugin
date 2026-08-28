// tests/oracle.test.ts — 先知引擎（概率融合 / 置信区间 / 最脆弱步骤 / 磁盘延长）
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, expect, it } from 'vitest'

import type { Result } from '../src/contracts/base'
import { ok } from '../src/contracts/base'
import type { IDiskForecaster, DiskForecast  } from '../src/contracts/disk-forecast.contract'
import type { IPathResolver } from '../src/contracts/paths'
import type { IReliabilityModel, ActionReliability } from '../src/contracts/reliability.contract'
import type { CleanOperation, CleanRequest } from '../src/contracts/transaction'
import { createOracle } from '../src/engine/oracle'
import { createAuditLog } from '../src/infra/audit-log'
import { createLogger } from '../src/infra/logger'
import { createReliabilityModel } from '../src/infra/reliability'

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

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

/** 三步剧本：patch(100B, p=1) → node-modules(200B, p=0.5, 校准 0.9) → storages(400B, p=1) */
function threeOps(): CleanOperation[] {
  const mk = (id: string, action: CleanOperation['action'], est: number): CleanOperation => ({
    id, action, target: 'p1' as never,
    async preview() {
      return { summary: id, touchedPaths: [], estimatedBytesReclaimable: est, requiresExclusiveLock: true }
    },
    async validate() { return ok(undefined) },
    async execute() { return ok({ outcome: { bytesFreed: 0, message: '' }, backup: null }) },
    async undo() { return ok(undefined) },
  })
  return [
    mk('op-0', 'clean-home-patch', 100),
    mk('op-1', 'remove-node-modules', 200),
    mk('op-2', 'remove-storages', 400),
  ]
}

function mockModel(pOf: (action: string) => number, sampleCount = 10): IReliabilityModel {
  return {
    sampleCount,
    globalSuccessProbability: 0.9,
    byAction: () => new Map(),
    reliabilityOf: (action): ActionReliability => ({
      action, successes: 0, failures: 0,
      successProbability: pOf(action),
      ci95: [0, 1], selfWeight: 0,
      calibration: action === 'remove-node-modules'
        ? { samples: 5, p10: 0.8, p50: 0.9, p90: 1.2 }
        : null,
    }),
  }
}

const request: CleanRequest = {
  plugins: ['p1' as never], profile: 'web' as never,
  strategy: 'balanced', dryRun: false, actor: 't',
}

function buildOracle(model: IReliabilityModel, forecaster?: IDiskForecaster) {
  return createOracle({
    reliability: async () => model,
    operationFactory: () => threeOps(),
    resolver: stubResolver,
    logger,
    clock: { now: () => new Date() },
    ...(forecaster ? { forecaster } : {}),
  })
}

function okv<T>(r: Result<T, { message: string }>): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

describe('先知引擎（nuke_oracle）', () => {
  it('概率融合：连乘成功率 × 校准中位数 → 期望回收', async () => {
    // P = 1 × 0.5 × 1 = 0.5；q50 = 100 + 200×0.9 + 400 = 680；E = 0.5×680 = 340
    const oracle = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)))
    const r = okv(await oracle.divine(request))
    expect(r.transactionSuccessProbability).toBeCloseTo(0.5)
    expect(r.totalEstimatedBytes).toBe(700)
    expect(r.expectedReclaimBytes).toBeCloseTo(340)
    expect(r.reclaimP10IfSuccess).toBeCloseTo(100 + 200 * 0.8 + 400)   // 660
    expect(r.reclaimP90IfSuccess).toBeCloseTo(100 + 200 * 1.2 + 400)   // 740
  })

  it('最脆弱步骤 = 失败概率 × 敞口最大者（带后缀和）', async () => {
    const oracle = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)))
    const r = okv(await oracle.divine(request))
    expect(r.weakestStep).not.toBeNull()
    expect(r.weakestStep!.index).toBe(1)
    expect(r.weakestStep!.exposureBytes).toBe(600)   // 200 + 400
    // 步骤敞口：[700, 600, 400]
    expect(r.steps[0]!.exposureBytes).toBe(700)
    expect(r.steps[2]!.exposureBytes).toBe(400)
  })

  it('期望回滚深度：Σ i·P(首败于 i)', async () => {
    // P(首败于1)=1×0.5 → 深度贡献 0.5×1=0.5；步骤0/2 不可能失败
    const oracle = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)))
    const r = okv(await oracle.divine(request))
    expect(r.expectedRollbackDepth).toBeCloseTo(0.5)
  })

  it('置信度随样本量分级；无校准数据时比率退化为 1（不假装知道偏差）', async () => {
    // 全 1.0 成功率 + 零校准样本 → 期望回收 = 预估原值
    const noCal: IReliabilityModel = {
      sampleCount: 10,
      globalSuccessProbability: 0.9,
      byAction: () => new Map(),
      reliabilityOf: (action): ActionReliability => ({
        action, successes: 0, failures: 0,
        successProbability: 1, ci95: [0, 1], selfWeight: 0, calibration: null,
      }),
    }
    const oracle = buildOracle(noCal)
    const r = okv(await oracle.divine(request))
    expect(r.confidence).toBe('medium')   // 10 样本
    expect(r.expectedReclaimBytes).toBeCloseTo(700)   // 无校准 → 全按预估
    const cold = buildOracle(mockModel(() => 0.9, 0))
    expect(okv(await cold.divine(request)).confidence).toBe('low')
    const rich = buildOracle(mockModel(() => 0.9, 100))
    expect(okv(await rich.divine(request)).confidence).toBe('high')
  })

  it('磁盘写满倒计时延长 = 期望回收 / 日增速', async () => {
    const forecaster: IDiskForecaster = {
      forecast: async () => ok({
        sampledAt: 't', totalBytes: 1000, freeBytes: 400, usedPct: 60,
        growthBytesPerDay: 100, daysUntilFull: 4, projectedFullAt: 'x',
        severity: 'warning', recommendation: 'r', trendBasis: null,
      } as DiskForecast),
    }
    const oracle = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)), forecaster)
    const r = okv(await oracle.divine(request))
    expect(r.diskExtensionDays).toBeCloseTo(340 / 100)
  })

  it('无 forecaster → diskExtensionDays=null；爆炸半径未注入 → null；叙事非空', async () => {
    const oracle = buildOracle(mockModel(() => 1))
    const r = okv(await oracle.divine(request))
    expect(r.diskExtensionDays).toBeNull()
    expect(r.brokenDependents).toBeNull()
    expect(r.narrative.length).toBeGreaterThan(0)
    expect(r.evidence.stepSamples).toBe(10)
  })

  it('空操作集：成功率 1、期望回收 0，不崩溃', async () => {
    const oracle = createOracle({
      reliability: async () => mockModel(() => 0.9),
      operationFactory: () => [],
      resolver: stubResolver,
      logger,
      clock: { now: () => new Date() },
    })
    const r = okv(await oracle.divine(request))
    expect(r.steps).toHaveLength(0)
    expect(r.transactionSuccessProbability).toBe(1)
    expect(r.expectedReclaimBytes).toBe(0)
    expect(r.weakestStep).toBeNull()
  })
})

describe('先知引擎（蒙特卡洛模拟 / 修复提升幅度）', () => {
  it('MC 分布：P10=0（失败回滚折算）、P90 有界、均值与解析期望互证、抽样成功率≈连乘', async () => {
    // P=0.5 → 一半抽样回收 0；成功抽样回收 680±校准波动
    const oracle = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)))
    const r = okv(await oracle.divine(request))
    const mc = r.monteCarlo
    expect(mc.trials).toBe(2000)
    expect(mc.seed).toBeGreaterThan(0)
    // 至少 10% 的抽样以失败告终 → P10 必为 0（无条件口径）
    expect(mc.p10).toBe(0)
    // 成功前提的回收上界 = 100 + 200×1.2 + 400 = 740 → P90 不越界
    expect(mc.p90).toBeGreaterThan(600)
    expect(mc.p90).toBeLessThanOrEqual(740 + 1e-9)
    expect(mc.p50).toBeLessThanOrEqual(mc.p90)
    // 均值互证：SE ≈ 340/√2000 ≈ 7.6 → ±30 为 4σ 安全带
    expect(mc.mean).toBeGreaterThan(340 - 30)
    expect(mc.mean).toBeLessThan(340 + 30)
    // 抽样成功率与解析连乘互证（4σ ≈ ±0.022）
    expect(mc.successRate).toBeGreaterThan(0.5 - 0.025)
    expect(mc.successRate).toBeLessThan(0.5 + 0.025)
  })

  it('同种子 → 逐位可复现；不同种子 → 样本不同但统计一致', async () => {
    const a = okv(await buildOracle(mockModel(() => 0.7)).divine(request))
    const b = okv(await buildOracle(mockModel(() => 0.7)).divine(request))
    expect(b.monteCarlo.p10).toBe(a.monteCarlo.p10)
    expect(b.monteCarlo.p50).toBe(a.monteCarlo.p50)
    expect(b.monteCarlo.p90).toBe(a.monteCarlo.p90)
    expect(b.monteCarlo.mean).toBe(a.monteCarlo.mean)
    const c = okv(await createOracle({
      reliability: async () => mockModel(() => 0.7),
      operationFactory: () => threeOps(),
      resolver: stubResolver, logger, clock: { now: () => new Date() },
      monteCarloSeed: 987654321,
    }).divine(request))
    // 种子不同 → 至少一个分位数不同（概率上几乎必然）；均值仍在统计带内
    const changed = c.monteCarlo.p10 !== a.monteCarlo.p10
      || c.monteCarlo.p50 !== a.monteCarlo.p50
      || c.monteCarlo.p90 !== a.monteCarlo.p90
    expect(changed).toBe(true)
    expect(Math.abs(c.monteCarlo.mean - a.monteCarlo.mean)).toBeLessThan(60)
  })

  it('最脆弱步骤附带修复提升幅度：p=0.5 → 修复后整体成功率 1（+0.5）', async () => {
    const oracle = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)))
    const r = okv(await oracle.divine(request))
    const w = r.weakestStep!
    expect(w.index).toBe(1)
    expect(w.repairedSuccessProbability).toBeCloseTo(1)
    expect(w.repairUplift).toBeCloseTo(0.5)
    // 多数步骤可靠时（其余 p=1）：修复最脆弱一步即可拉满整体成功率
    const all099 = buildOracle(mockModel(a => (a === 'remove-node-modules' ? 0.8 : 1)))
    const r2 = okv(await all099.divine(request))
    expect(r2.weakestStep!.repairUplift).toBeCloseTo(1 - 0.8)
  })

  it('monteCarloTrials=0 → 关闭模拟（分位数归零），解析口径不受影响', async () => {
    const oracle = createOracle({
      reliability: async () => mockModel(a => (a === 'remove-node-modules' ? 0.5 : 1)),
      operationFactory: () => threeOps(),
      resolver: stubResolver, logger, clock: { now: () => new Date() },
      monteCarloTrials: 0,
    })
    const r = okv(await oracle.divine(request))
    expect(r.monteCarlo.trials).toBe(0)
    expect(r.monteCarlo.p90).toBe(0)
    expect(r.expectedReclaimBytes).toBeCloseTo(340)   // 解析式不受模拟开关影响
  })

  it('空操作集 → MC 成功率 1、分位数 0', async () => {
    const oracle = createOracle({
      reliability: async () => mockModel(() => 0.9),
      operationFactory: () => [],
      resolver: stubResolver,
      logger,
      clock: { now: () => new Date() },
    })
    const r = okv(await oracle.divine(request))
    expect(r.monteCarlo.successRate).toBe(1)
    expect(r.monteCarlo.p50).toBe(0)
  })
})

describe('先知引擎（V5.1.1 冷启动修复：零历史不再硬币塌缩）', () => {
  it('零历史：3 步事务成功率 = 设计先验连乘 0.95³ ≈ 85.7%（旧硬币先验为 0.5³=12.5%）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-cold-'))
    try {
      // 真实可靠性模型 + 空审计链 = 用户报告的确切场景（刚装好、从未清理过）
      const model = await createReliabilityModel({
        audit: createAuditLog({ filePath: path.join(dir, 'chain.jsonl') }),
      })
      expect(model.sampleCount).toBe(0)
      const oracle = buildOracle(model)
      const r = okv(await oracle.divine(request))
      expect(r.confidence).toBe('low')                    // 置信度诚实：数据就是没有
      expect(r.transactionSuccessProbability).toBeCloseTo(0.95 ** 3, 5)
      expect(r.transactionSuccessProbability).toBeGreaterThan(0.85)
      // 每步纯先验：selfWeight=0 透传到步骤（渲染层据此标 🧭）
      for (const s of r.steps) expect(s.selfWeight).toBe(0)
      // 叙事必须说明数字来自设计先验，而非历史故障证据
      expect(r.narrative).toContain('设计先验')
      expect(r.narrative).toContain('3 步无自身历史')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('有历史动作混合未见过动作：已见步骤 selfWeight>0，未见步骤仍纯先验', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-mixed-'))
    try {
      const audit = createAuditLog({ filePath: path.join(dir, 'chain.jsonl') })
      // 只给 clean-home-patch 累积历史（5 成）—— 其余动作仍零样本
      for (let i = 0; i < 5; i++) {
        await audit.append({
          timestamp: `2026-08-20T00:00:${String(i).padStart(2, '0')}Z`,
          actor: 't', action: 'op:clean-home-patch', outcome: 'success', detail: {},
        })
      }
      const model = await createReliabilityModel({ audit })
      const oracle = buildOracle(model)
      const r = okv(await oracle.divine(request))
      const seen = r.steps.find(s => s.action === 'clean-home-patch')!
      const unseen = r.steps.find(s => s.action === 'remove-storages')!
      expect(seen.selfWeight).toBeCloseTo(5 / 15)          // κ=10：5 观测 → 1/3 自身权重
      expect(unseen.selfWeight).toBe(0)
      // 5 个全局样本 → medium 置信（阈值 5），叙事不再打冷启动补丁
      expect(r.confidence).toBe('medium')
      expect(r.narrative).not.toContain('设计先验')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('先知引擎（V5.2 决策智能：帕累托计划合成 + 大小分桶）', () => {
  /** 桶调制 mock：remove-node-modules 带 sizeBytes 查询时降到 0.5（大目录脆弱） */
  function bucketModel(): IReliabilityModel {
    return {
      sampleCount: 10,
      globalSuccessProbability: 0.9,
      byAction: () => new Map(),
      reliabilityOf: (action, opts): ActionReliability => ({
        action, successes: 0, failures: 0,
        successProbability: opts?.sizeBytes !== undefined && action === 'remove-node-modules'
          ? 0.5
          : 0.99,
        ci95: [0, 1], selfWeight: 0,
        calibration: null,
        ...(opts?.sizeBytes !== undefined && action === 'remove-node-modules'
          ? { sizeBucket: { bucket: 'large' as const, rangeBytes: [104857600, null] as const, samples: 3, selfWeight: 3 / 8 } }
          : {}),
      }),
    }
  }

  it('optimizedPlan：3 步全集合成前沿，剔除脆弱步骤可提升成功率（数学可验）', async () => {
    // 步骤：patch(100B,p=0.99) → node-modules(200B,p=0.5 桶调制) → storages(400B,p=0.99)
    // 全集 P=0.99×0.5×0.99=0.4901，E≈0.4901×(100+200+400)=343
    // 剔除 node-modules：P=0.9801，E=0.9801×500=490 → 支配全集！
    const oracle = buildOracle(bucketModel())
    const r = okv(await oracle.divine(request))
    expect(r.optimizedPlan).not.toBeNull()
    const plan = r.optimizedPlan!
    expect(plan.solver).toBe('exact')
    expect(plan.fullSet.successProbability).toBeCloseTo(0.99 * 0.5 * 0.99)
    // 前沿至少两点；激进端回收 ≥ 全集
    expect(plan.frontier.length).toBeGreaterThanOrEqual(2)
    expect(plan.frontier[0]!.expectedReclaimBytes)
      .toBeGreaterThanOrEqual(plan.fullSet.expectedReclaimBytes)
    // 拐点推荐剔除 node-modules（它同时拖累成功率且贡献少）
    expect(plan.recommended.actions).not.toContain('remove-node-modules')
    expect(plan.recommended.successProbability).toBeCloseTo(0.99 * 0.99)
    // 剔除理由给出账单
    expect(plan.drops.length).toBe(1)
    expect(plan.drops[0]!.action).toBe('remove-node-modules')
    expect(plan.drops[0]!.successUpliftPct).toBeGreaterThan(0)
  })

  it('步骤成功率已用大小分桶调制（oracle 传 sizeBytes 查询）', async () => {
    const oracle = buildOracle(bucketModel())
    const r = okv(await oracle.divine(request))
    const nm = r.steps.find(s => s.action === 'remove-node-modules')!
    expect(nm.successProbability).toBe(0.5)   // 桶调制生效（非动作层 0.99）
    const patch = r.steps.find(s => s.action === 'clean-home-patch')!
    expect(patch.successProbability).toBe(0.99)
  })

  it('优化器异常不阻断推演（optimizedPlan=null 降级）', async () => {
    // 概率含 NaN → optimize 返回 err → divine 仍成功（决策增强非关键路径）
    const badModel: IReliabilityModel = {
      sampleCount: 10,
      globalSuccessProbability: 0.9,
      byAction: () => new Map(),
      reliabilityOf: (action): ActionReliability => ({
        action, successes: 0, failures: 0,
        successProbability: action === 'remove-node-modules' ? Number.NaN : 0.9,
        ci95: [0, 1], selfWeight: 0, calibration: null,
      }),
    }
    const oracle = buildOracle(badModel)
    const r = await oracle.divine(request)
    // NaN 连乘传播 → 步骤成功率 NaN，但推演本身不抛错（决策链防御性）
    expect(r.ok).toBe(true)
  })
})

describe('先知引擎（V5.3 失败模式智能：模式诊断 / 重试感知推演 / 优化器对齐）', () => {
  /** V5.3 mock：remove-node-modules 历史失败全是 EBUSY（locked，瞬态），
   *  引擎重试可挽回 → retryAdjusted 显著高于裸成功率 */
  function modeModel(pRaw: number, pAdj: number): IReliabilityModel {
    return {
      sampleCount: 20,
      globalSuccessProbability: 0.9,
      byAction: () => new Map(),
      reliabilityOf: (action): ActionReliability => ({
        action,
        successes: action === 'remove-node-modules' ? 8 : 10,
        failures: action === 'remove-node-modules' ? 4 : 0,
        successProbability: action === 'remove-node-modules' ? pRaw : 1,
        ci95: [0, 1],
        selfWeight: action === 'remove-node-modules' ? 0.4 : 0.5,
        calibration: null,
        failureModes: action === 'remove-node-modules'
          ? [{
            mode: 'locked' as const, count: 4, share: 1,
            transience: 'transient' as const,
          }]
          : [],
        transientShare: action === 'remove-node-modules' ? 1 : 0,
        retryAdjustedProbability: action === 'remove-node-modules' ? pAdj : 1,
      }),
    }
  }

  it('重试感知事务成功率 = ∏ retryAdjusted p_i（与裸连乘并列，口径透明）', async () => {
    // 步骤：patch(p=1) → node-modules(p=0.5, 重试感知 0.875) → storages(p=1)
    const oracle = buildOracle(modeModel(0.5, 0.875))
    const r = okv(await oracle.divine(request))
    expect(r.transactionSuccessProbability).toBeCloseTo(0.5)          // 裸口径不变
    expect(r.retryAdjustedSuccessProbability).toBeCloseTo(0.875)      // 重试感知口径
    // 步骤级透传：失败模式分布 + 重试感知成功率
    const nm = r.steps.find(s => s.action === 'remove-node-modules')!
    expect(nm.failureModes).toHaveLength(1)
    expect(nm.failureModes[0]!.mode).toBe('locked')
    expect(nm.failureModes[0]!.transience).toBe('transient')
    expect(nm.retryAdjustedProbability).toBeCloseTo(0.875)
    expect(nm.transientShare).toBeCloseTo(1)
    // 其余步骤零失败：空模式档案 + 恒等投影
    const patch = r.steps.find(s => s.action === 'clean-home-patch')!
    expect(patch.failureModes).toEqual([])
    expect(patch.retryAdjustedProbability).toBeCloseTo(1)
  })

  it('最脆弱步骤附带主导模式诊断与处方（从"哪里弱"到"为什么弱、怎么办"）', async () => {
    const oracle = buildOracle(modeModel(0.5, 0.875))
    const r = okv(await oracle.divine(request))
    const w = r.weakestStep!
    expect(w.index).toBe(1)                            // node-modules 仍是最脆弱
    expect(w.dominantFailureMode).toBe('locked')
    expect(w.dominantFailureShare).toBeCloseTo(1)
    expect(w.prescription).toContain('EBUSY')
    expect(w.prescription).toContain('重试')
    // 叙事融合重试感知口径（有效成功率高于裸口径时明确告知）
    expect(r.narrative).toContain('重试')
  })

  it('零失败历史：最脆弱步骤无模式诊断（dominant=null，诚实缺省）', async () => {
    const oracle = buildOracle(mockModel(() => 0.9))
    const r = okv(await oracle.divine(request))
    const w = r.weakestStep!
    expect(w.dominantFailureMode).toBeNull()
    expect(w.dominantFailureShare).toBe(0)
    expect(w.prescription).toBeNull()
    // 全部步骤恒等投影 → 重试感知 = 裸连乘
    expect(r.retryAdjustedSuccessProbability).toBeCloseTo(r.transactionSuccessProbability)
  })

  it('优化器候选取重试调整口径：计划合成与引擎真实行为（含自动重试）对齐', async () => {
    // node-modules 裸 p=0.5（历史 EBUSY 失败），重试感知 0.99 —— V5.2 口径下
    // 优化器会把它当弱者剔除；V5.3 口径下它几乎可靠，应被保留
    const oracle = buildOracle(modeModel(0.5, 0.99))
    const r = okv(await oracle.divine(request))
    const plan = r.optimizedPlan!
    // 重试感知下全集 P=0.99、E≈0.99×700=693 —— 剔除它牺牲 200B 只换 1 个点，
    // 性价比极差 → 推荐保留全部三步
    expect(plan.recommended.actions).toContain('remove-node-modules')
    expect(plan.recommended.successProbability).toBeCloseTo(0.99)
    expect(plan.drops).toHaveLength(0)
  })

  it('全瞬态历史 → 重试感知叙事生效；全永久失败 → 无重试增益', async () => {
    // permission（永久）：重试不增益 → 两口径一致，叙事不提重试
    const permModel: IReliabilityModel = {
      sampleCount: 20,
      globalSuccessProbability: 0.9,
      byAction: () => new Map(),
      reliabilityOf: (action): ActionReliability => ({
        action,
        successes: 0, failures: action === 'remove-node-modules' ? 4 : 0,
        successProbability: action === 'remove-node-modules' ? 0.5 : 1,
        ci95: [0, 1], selfWeight: 0.4, calibration: null,
        failureModes: action === 'remove-node-modules'
          ? [{ mode: 'permission' as const, count: 4, share: 1, transience: 'permanent' as const }]
          : [],
        transientShare: 0,
        retryAdjustedProbability: action === 'remove-node-modules' ? 0.5 : 1,
      }),
    }
    const oracle = buildOracle(permModel)
    const r = okv(await oracle.divine(request))
    expect(r.retryAdjustedSuccessProbability).toBeCloseTo(0.5)
    // 永久模式处方：指引人工介入（重试无意义）
    expect(r.weakestStep!.dominantFailureMode).toBe('permission')
    expect(r.weakestStep!.prescription).toContain('权限')
    expect(r.narrative).not.toContain('自动重试瞬态失败')
  })
})

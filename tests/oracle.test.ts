// tests/oracle.test.ts — 先知引擎（概率融合 / 置信区间 / 最脆弱步骤 / 磁盘延长）
import { describe, expect, it } from 'vitest'
import { createOracle } from '../src/engine/oracle'
import { createLogger } from '../src/infra/logger'
import type { IReliabilityModel, ActionReliability } from '../src/contracts/reliability.contract'
import type { CleanOperation, CleanRequest } from '../src/contracts/transaction'
import type { IPathResolver } from '../src/contracts/paths'
import type { IDiskForecaster } from '../src/contracts/disk-forecast.contract'
import type { Result } from '../src/contracts/base'
import { ok } from '../src/contracts/base'
import type { DiskForecast } from '../src/contracts/disk-forecast.contract'

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

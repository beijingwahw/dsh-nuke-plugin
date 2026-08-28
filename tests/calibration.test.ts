// tests/calibration.test.ts — V5.5 自我校准（预测 → 存证 → 对账 → 再学习闭环）
// 对账不止打分，还驱动再学习：
//   过自信（存证均值 90% vs 实际 12.5%）→ logit 位移 δ<0 → 未来预测拉低
//   过保守（存证均值 30% vs 实际 87.5%）→ δ>0 → 拉高
//   证据 < 5 步 → 不修正（诚实：没有统计力就不动）
//   耗时中位比 3×（预测偏乐观）→ 修正因子向 3 收缩（按证据权重）
// 应用侧（引擎存证 / 先知推演）与学习侧同源 —— 残差→0 则 δ→0（收敛）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createAuditLog } from '../src/infra/audit-log'
import { createPredictionScorer } from '../src/infra/prediction-score'
import { createOracle } from '../src/engine/oracle'
import { createTransactionEngine } from '../src/engine/transaction-engine'
import { createLockManager } from '../src/infra/lock-manager'
import { createWal } from '../src/infra/wal'
import { createBackupStore } from '../src/infra/backup-store'
import { createLogger } from '../src/infra/logger'
import { createHookRegistry } from '../src/engine/hook-registry'
import { ok } from '../src/contracts/base'
import {
  applyCalibrationShift, applyDurationCorrection,
} from '../src/contracts/prediction.contract'
import type { CalibrationShift, PredictionScorecard } from '../src/contracts/prediction.contract'
import type { IReliabilityModel, ActionReliability } from '../src/contracts/reliability.contract'
import type { CleanOperation, CleanRequest, ITransactionEngine, TxContext } from '../src/contracts/transaction'
import type { AuditEntry } from '../src/contracts/logging'
import type { IPathResolver } from '../src/contracts/paths'

let tmp: string
let home: string
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-'))
  home = path.join(tmp, '.dsh')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

function auditAt(name: string) {
  return createAuditLog({ filePath: path.join(tmp, name, 'chain.jsonl') })
}

// ─── 纯函数 ────────────────────────────────────────────────

const SHIFT: CalibrationShift = {
  delta: -1.0, evidence: 20, meanPredicted: 0.9, actualRate: 0.6,
  selfWeight: 0.7, durationFactor: 2, durationSamples: 10,
}

describe('V5.5 校准纯函数（契约层）', () => {
  it('applyCalibrationShift：δ<0 拉低 / δ>0 拉高 / null 恒等', () => {
    expect(applyCalibrationShift(0.9, null)).toBe(0.9)
    expect(applyCalibrationShift(0.9, SHIFT)).toBeLessThan(0.9)
    expect(applyCalibrationShift(0.3, SHIFT)).toBeLessThan(0.3)
    expect(applyCalibrationShift(0.5, { ...SHIFT, delta: 1 })).toBeGreaterThan(0.5)
  })

  it('applyCalibrationShift：logit 线性语义 —— logit(p)+δ 的 sigmoid', () => {
    const z = Math.log(0.9 / 0.1) - 1
    expect(applyCalibrationShift(0.9, SHIFT)).toBeCloseTo(1 / (1 + Math.exp(-z)), 12)
  })

  it('applyCalibrationShift：钳制 [0.001, 0.999]；退化 p 恒等', () => {
    // logit(0.99)≈4.595；δ=−20 → sigmoid(−15.4)≈2e−7 → 钳到下界
    expect(applyCalibrationShift(0.99, { ...SHIFT, delta: -20 })).toBeCloseTo(0.001, 10)
    expect(applyCalibrationShift(0.01, { ...SHIFT, delta: 20 })).toBeCloseTo(0.999, 10)
    // 未越界时不钳制：δ=−10 → sigmoid(4.595−10)≈0.00447
    expect(applyCalibrationShift(0.99, { ...SHIFT, delta: -10 })).toBeCloseTo(0.00447, 5)
    expect(applyCalibrationShift(0, SHIFT)).toBe(0)
    expect(applyCalibrationShift(1, SHIFT)).toBe(1)
    expect(applyCalibrationShift(Number.NaN, SHIFT)).toBeNaN()
  })

  it('applyDurationCorrection：因子缩放；null shift / null 因子 / 非正 ms 恒等', () => {
    expect(applyDurationCorrection(100, SHIFT)).toBe(200)
    expect(applyDurationCorrection(100, null)).toBe(100)
    expect(applyDurationCorrection(100, { ...SHIFT, durationFactor: null })).toBe(100)
    expect(applyDurationCorrection(0, SHIFT)).toBe(0)
    expect(applyDurationCorrection(-5, SHIFT)).toBe(-5)
  })
})

// ─── 学习侧（计分器） ──────────────────────────────────────

let seq = 0
function entry(
  action: string,
  detail: Readonly<Record<string, unknown>>,
  opts: { readonly txId?: string; readonly outcome?: 'success' | 'failure' } = {},
): AuditEntry {
  seq++
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    actor: 't', action, outcome: opts.outcome ?? 'success', detail,
    ...(opts.txId !== undefined ? { txId: opts.txId as never } : {}),
  }
}

/** 一个事务的完整存证剧本：predict → 每步结局 → 终结 */
async function seedTx(
  audit: { append: (e: AuditEntry) => Promise<unknown> },
  txId: string,
  steps: readonly { readonly opId: string; readonly action: string; readonly p: number; readonly durPred?: number; readonly durActual?: number; readonly ok?: boolean }[],
  terminal: 'commit' | 'rollback',
  drill = false,
): Promise<void> {
  await audit.append(entry('tx-predict', {
    steps: steps.map((s, i) => ({
      index: i, operationId: s.opId, action: s.action, estimatedBytes: 100,
      predictedP: s.p,
      predictedDurationMs: s.durPred === undefined ? null : s.durPred,
    })),
    txSuccessProbability: steps.reduce((acc, s) => acc * s.p, 1),
    ...(drill ? { drill: true } : {}),
  }, { txId }))
  for (const s of steps) {
    await audit.append(entry(`op:${s.action}`, {
      operationId: s.opId,
      ...(s.durActual !== undefined ? { durationMs: s.durActual } : {}),
    }, { txId, outcome: s.ok === false ? 'failure' : 'success' }))
  }
  await audit.append(entry(terminal === 'commit' ? 'tx-commit' : 'tx-rollback', {}, { txId }))
}

describe('V5.5 自我校准（学习侧：从对账证据学 δ）', () => {
  it('过自信历史（存证均值 0.9 全回滚）→ δ<0，修正显著拉低', async () => {
    const audit = auditAt('overconfident')
    for (let i = 0; i < 6; i++) {
      await seedTx(audit, `t${i}`, [{ opId: 'a', action: 'remove-storages', p: 0.9, ok: false }], 'rollback')
    }
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    const cs = sc.calibration!
    expect(cs).not.toBeNull()
    expect(cs.evidence).toBe(6)
    expect(cs.meanPredicted).toBeCloseTo(0.9, 10)
    // Laplace: (0+1)/(6+2) = 0.125；δ_raw = logit(0.125)−logit(0.9)
    expect(cs.actualRate).toBeCloseTo(0.125, 10)
    const w = 6 / (6 + 8)
    expect(cs.selfWeight).toBeCloseTo(w, 10)
    const deltaRaw = Math.log(0.125 / 0.875) - Math.log(0.9 / 0.1)
    expect(cs.delta).toBeCloseTo(deltaRaw * w, 10)
    expect(cs.delta).toBeLessThan(0)
    // 修正后 0.9 → ≈0.604：预测被战绩实质性拉低
    expect(applyCalibrationShift(0.9, cs)).toBeLessThan(0.65)
  })

  it('过保守历史（存证均值 0.3 全成功）→ δ>0，修正拉高', async () => {
    const audit = auditAt('underconfident')
    for (let i = 0; i < 6; i++) {
      await seedTx(audit, `t${i}`, [{ opId: 'a', action: 'clean-home-patch', p: 0.3 }], 'commit')
    }
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    const cs = sc.calibration!
    // Laplace: (6+1)/8 = 0.875 > meanPredicted 0.3 → δ>0
    expect(cs.actualRate).toBeCloseTo(0.875, 10)
    expect(cs.delta).toBeGreaterThan(0)
    expect(applyCalibrationShift(0.3, cs)).toBeGreaterThan(0.5)
  })

  it('证据不足（< 5 步）→ calibration null（没有统计力就不修正）', async () => {
    const audit = auditAt('sparse')
    for (let i = 0; i < 4; i++) {
      await seedTx(audit, `t${i}`, [{ opId: 'a', action: 'remove-storages', p: 0.9 }], 'rollback')
    }
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredSteps).toBe(4)
    expect(sc.calibration).toBeNull()
  })

  it('演习事务不入证据（人为崩溃不是预测失误）', async () => {
    const audit = auditAt('drill-only')
    await seedTx(audit, 'd1', [
      { opId: 'a', action: 'remove-storages', p: 0.9 },
      { opId: 'b', action: 'remove-storages', p: 0.9 },
      { opId: 'c', action: 'remove-storages', p: 0.9 },
      { opId: 'd', action: 'remove-storages', p: 0.9 },
      { opId: 'e', action: 'remove-storages', p: 0.9 },
      { opId: 'f', action: 'remove-storages', p: 0.9 },
    ], 'rollback', true)
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredSteps).toBe(0)
    expect(sc.calibration).toBeNull()
  })

  it('耗时修正因子：中位比 3× → 因子向 3 收缩（按证据权重）', async () => {
    const audit = auditAt('slow')
    // 6 步：预测 100ms 实际 300ms → ratio 恒 3，p50 = 3
    for (let i = 0; i < 6; i++) {
      await seedTx(audit, `t${i}`, [{
        opId: 'a', action: 'remove-node-modules', p: 0.9, durPred: 100, durActual: 300,
      }], 'commit')
    }
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    const cs = sc.calibration!
    expect(cs.durationSamples).toBe(6)
    const w = 6 / 14
    expect(cs.durationFactor).toBeCloseTo(1 + (3 - 1) * w, 10)
    expect(applyDurationCorrection(100, cs)).toBeCloseTo(100 * (1 + 2 * w), 10)
  })

  it('大样本实际率≈存证率 → δ≈0（修正收敛：残差消失则位移消失）', async () => {
    const audit = auditAt('converge')
    // 50 步存证 p=0.6，实际 30 成 20 败（60% 成功）→
    // meanPred=0.6，actualRate=(30+1)/52≈0.596 → δ_raw≈−0.016 ≈ 0
    for (let i = 0; i < 50; i++) {
      const committed = i % 5 < 3   // 每 5 个成 3 个 → 30/50
      await seedTx(audit, `t${i}`, [{
        opId: 'a', action: 'remove-storages', p: 0.6, ok: committed,
      }], committed ? 'commit' : 'rollback')
    }
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    const cs = sc.calibration!
    expect(cs.evidence).toBe(50)
    expect(cs.actualRate).toBeCloseTo(31 / 52, 10)
    // 实际率 0.596 ≈ 存证率 0.6 → 位移趋零（迭代校准的收敛终点）
    expect(cs.delta).toBeCloseTo(0, 1)
    expect(Math.abs(applyCalibrationShift(0.6, cs) - 0.6)).toBeLessThan(0.01)
  })
})

// ─── 应用侧：引擎存证 + 先知推演 ──────────────────────────

function fixedModel(): IReliabilityModel {
  return {
    sampleCount: 10,
    globalSuccessProbability: 0.9,
    byAction: () => new Map(),
    reliabilityOf: action => ({
      action, successes: 9, failures: 1,
      successProbability: 0.9,
      ci95: [0.5, 0.99], selfWeight: 0.5,
      calibration: null,
      failureModes: [], transientShare: 0,
      retryAdjustedProbability: 0.9,
      duration: { samples: 5, p50: 250, p90: 900 },
    }),
  }
}

function goodOp(id: string, action: string, est: number): CleanOperation {
  return {
    id, action: action as CleanOperation['action'],
    target: 'victim-plugin' as never,
    async preview() {
      return { summary: id, touchedPaths: [], estimatedBytesReclaimable: est, requiresExclusiveLock: true }
    },
    async validate() { return ok(undefined) },
    async execute(_ctx: TxContext) {
      return ok({ outcome: { bytesFreed: est, message: 'ok' }, backup: null })
    },
    async undo() { return ok(undefined) },
  }
}

function request(): CleanRequest {
  return {
    plugins: ['victim-plugin' as never], profile: 'web' as never,
    strategy: 'safe', dryRun: false, actor: 'tester',
  }
}

function buildEngine(
  opts: {
    readonly predictor?: () => Promise<IReliabilityModel>
    readonly calibrator?: () => Promise<CalibrationShift | null>
  },
): { engine: ITransactionEngine; auditPath: string } {
  const auditPath = path.join(home, '.nuke', 'audit', `chain-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  const engine = createTransactionEngine(
    {
      lockManager: createLockManager({ lockRoot: path.join(home, '.nuke') }),
      wal: createWal({ walRoot: path.join(home, '.nuke', 'tx') }),
      backups: createBackupStore({ backupRoot: path.join(home, '.nuke', 'backups') }),
      audit: createAuditLog({ filePath: auditPath }),
      resolver: null as never,
      logger,
      hooks: createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') }),
      clock: { now: () => new Date() },
      verifyConfirmationToken: () => true,
      ...(opts.predictor !== undefined ? { predictor: opts.predictor } : {}),
      ...(opts.calibrator !== undefined ? { calibrator: opts.calibrator } : {}),
    },
    () => [goodOp('op-0', 'remove-storages', 100)],
  )
  return { engine, auditPath }
}

async function commitOk(engine: ITransactionEngine) {
  const s = await engine.begin(request())
  if (!s.ok) throw new Error(s.error.message)
  const plan = await engine.plan(s.value)
  if (!plan.ok) throw new Error(plan.error.message)
  const c = await engine.commit(plan.value)
  if (!c.ok) throw new Error(c.error.message)
}

function chainOf(auditPath: string) {
  return fs.readFileSync(auditPath, 'utf-8').trim().split('\n')
    .map(l => JSON.parse(l) as { readonly action: string; readonly detail: Readonly<Record<string, unknown>> })
}

describe('V5.5 自我校准（应用侧：引擎存证）', () => {
  it('注入校准器 → 存证 predictedP 为校准后口径 + detail 记录位移', async () => {
    const shift: CalibrationShift = {
      delta: -0.75, evidence: 12, meanPredicted: 0.9, actualRate: 0.55,
      selfWeight: 0.6, durationFactor: 1.5, durationSamples: 8,
    }
    const { engine, auditPath } = buildEngine({
      predictor: () => Promise.resolve(fixedModel()),
      calibrator: () => Promise.resolve(shift),
    })
    await commitOk(engine)
    const predict = chainOf(auditPath).find(e => e.action === 'tx-predict')!
    expect(predict).toBeDefined()
    // logit(0.9) − 0.75 = 1.447 → sigmoid ≈ 0.81
    expect(applyCalibrationShift(0.9, shift)).toBeCloseTo(0.81, 2)
    const steps = predict.detail.steps as { readonly predictedP: number; readonly predictedDurationMs: number }[]
    expect(steps[0]!.predictedP).toBeCloseTo(applyCalibrationShift(0.9, shift), 10)
    // 耗时 250ms × 1.5 = 375
    expect(steps[0]!.predictedDurationMs).toBeCloseTo(375, 10)
    expect(predict.detail.calibrationDelta).toBeCloseTo(-0.75, 10)
    expect(predict.detail.calibrationEvidence).toBe(12)
  })

  it('校准器抛错 → 恒等存证（学习失败绝不阻断真实清理）', async () => {
    const { engine, auditPath } = buildEngine({
      predictor: () => Promise.resolve(fixedModel()),
      calibrator: () => Promise.reject(new Error('审计链读取失败')),
    })
    await commitOk(engine)
    const predict = chainOf(auditPath).find(e => e.action === 'tx-predict')!
    const steps = predict.detail.steps as { readonly predictedP: number }[]
    expect(steps[0]!.predictedP).toBeCloseTo(0.9, 10)
    expect(predict.detail.calibrationDelta).toBeUndefined()
  })

  it('未注入校准器 → V5.4 语义完全兼容（恒等存证）', async () => {
    const { engine, auditPath } = buildEngine({
      predictor: () => Promise.resolve(fixedModel()),
    })
    await commitOk(engine)
    const predict = chainOf(auditPath).find(e => e.action === 'tx-predict')!
    const steps = predict.detail.steps as { readonly predictedP: number }[]
    expect(steps[0]!.predictedP).toBeCloseTo(0.9, 10)
  })
})

// ─── 应用侧：先知推演 ──────────────────────────────────────

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

function emptyScorecard(calibration: CalibrationShift | null): PredictionScorecard {
  return {
    scoredTx: 12, scoredSteps: 12,
    brierTx: 0.2, brierSteps: 0.18, brierBaseline: 0.24, skillScore: 0.17,
    durationRatio: null, calibration, recent: [],
  }
}

function calibratedModel(p: number, durationP50: number | null): IReliabilityModel {
  return {
    sampleCount: 30,
    globalSuccessProbability: 0.9,
    byAction: () => new Map(),
    reliabilityOf: (action): ActionReliability => ({
      action, successes: 27, failures: 3,
      successProbability: p,
      ci95: [0.6, 0.97], selfWeight: 0.75,
      calibration: null,
      failureModes: [], transientShare: 0,
      retryAdjustedProbability: p,
      ...(durationP50 !== null ? { duration: { samples: 6, p50: durationP50, p90: durationP50 * 3 } } : {}),
    }),
  }
}

describe('V5.5 自我校准（应用侧：先知推演）', () => {
  it('有战绩校准 → 逐步/事务校准口径 + 耗时修正 + 叙事提及', async () => {
    const shift: CalibrationShift = {
      delta: -0.75, evidence: 12, meanPredicted: 0.9, actualRate: 0.55,
      selfWeight: 0.6, durationFactor: 1.5, durationSamples: 8,
    }
    const oracle = createOracle({
      reliability: async () => calibratedModel(0.9, 250),
      operationFactory: () => [goodOp('op-0', 'remove-storages', 100)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
      scorecard: async () => emptyScorecard(shift),
    })
    const r = await oracle.divine({ plugins: ['p' as never], profile: 'web' as never, strategy: 'balanced' as never })
    if (!r.ok) throw new Error(r.error.message)
    const o = r.value
    expect(o.calibration).toBe(shift)
    expect(o.steps[0]!.calibratedProbability).toBeCloseTo(applyCalibrationShift(0.9, shift), 10)
    // 事务校准 = 逐步校准连乘（单步即其本身）
    expect(o.calibratedSuccessProbability).toBeCloseTo(applyCalibrationShift(0.9, shift), 10)
    // 耗时 250 × 1.5 = 375（预测偏乐观 → 放大）
    expect(o.steps[0]!.predictedDurationMs).toBeCloseTo(375, 10)
    expect(o.predictedDurationMs).toBeCloseTo(375, 10)
    expect(o.pessimisticDurationMs).toBeCloseTo(750 * 1.5, 10)
    expect(o.narrative).toContain('自我校准后成功率')
    expect(o.narrative).toContain('过自信')
  })

  it('无战绩（scorecard 未注入 / 校准 null）→ calibrated 字段 null（诚实缺省）', async () => {
    const oracle = createOracle({
      reliability: async () => calibratedModel(0.9, 250),
      operationFactory: () => [goodOp('op-0', 'remove-storages', 100)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
    })
    const r = await oracle.divine({ plugins: ['p' as never], profile: 'web' as never, strategy: 'balanced' as never })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.calibration).toBeNull()
    expect(r.value.calibratedSuccessProbability).toBeNull()
    expect(r.value.steps[0]!.calibratedProbability).toBeNull()
    // 耗时不修正（恒等）
    expect(r.value.steps[0]!.predictedDurationMs).toBeCloseTo(250, 10)
    // 零证据 scorecard（calibration=null）同样恒等
    const oracle2 = createOracle({
      reliability: async () => calibratedModel(0.9, 250),
      operationFactory: () => [goodOp('op-0', 'remove-storages', 100)],
      resolver: stubResolver, logger,
      clock: { now: () => new Date() },
      scorecard: async () => emptyScorecard(null),
    })
    const r2 = await oracle2.divine({ plugins: ['p' as never], profile: 'web' as never, strategy: 'balanced' as never })
    if (!r2.ok) throw new Error(r2.error.message)
    expect(r2.value.calibration).toBeNull()
    expect(r2.value.calibratedSuccessProbability).toBeNull()
  })
})

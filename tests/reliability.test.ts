// tests/reliability.test.ts — 贝叶斯可靠性模型（经验贝叶斯收缩 / 校准分布 / 数据飞轮）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createAuditLog } from '../src/infra/audit-log'
import { createReliabilityModel } from '../src/infra/reliability'
import { createTransactionEngine } from '../src/engine/transaction-engine'
import { createLockManager } from '../src/infra/lock-manager'
import { createWal } from '../src/infra/wal'
import { createBackupStore } from '../src/infra/backup-store'
import { createLogger } from '../src/infra/logger'
import { createHookRegistry } from '../src/engine/hook-registry'
import { ok } from '../src/contracts/base'
import type { CleanOperation, CleanRequest, TxContext } from '../src/contracts/transaction'

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

function auditAt(name: string) {
  return createAuditLog({ filePath: path.join(tmp, name, 'chain.jsonl') })
}

describe('贝叶斯可靠性模型', () => {
  it('冷启动：零历史 → 收缩到设计先验 0.95（非硬币 0.5），CI 仍诚实宽开', async () => {
    const model = await createReliabilityModel({ audit: auditAt('cold') })
    expect(model.sampleCount).toBe(0)
    expect(model.globalSuccessProbability).toBeCloseTo(0.95)
    const r = model.reliabilityOf('remove-node-modules')
    expect(r.successProbability).toBeCloseTo(0.95)
    expect(r.selfWeight).toBe(0)
    expect(r.calibration).toBeNull()
    // Wilson 不假装知道：点估计 0.95 的区间仍宽（零数据 → 不确定度大）
    expect(r.ci95[0]).toBeLessThan(0.95)
    expect(r.ci95[1]).toBeGreaterThan(0.95)
  })

  it('V5.2 大小分桶：同动作不同体量 → 三层收缩给出差异化成功率', async () => {
    const audit = auditAt('size-bucket')
    // remove-node-modules 历史：小目录(<1MB) 4 成 0 败；大目录(≥100MB) 1 成 4 败（EBUSY 风险）
    const MB = 1024 * 1024
    for (let i = 0; i < 4; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-node-modules', outcome: 'success',
        detail: { estimated: 0.5 * MB, actual: 0.5 * MB },
      })
    }
    await audit.append({
      timestamp: '2026-08-21T00:00:00Z',
      actor: 't', action: 'op:remove-node-modules', outcome: 'success',
      detail: { estimated: 2 * 1024 * MB, actual: 2 * 1024 * MB },
    })
    for (let i = 0; i < 4; i++) {
      await audit.append({
        timestamp: `2026-08-22T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-node-modules', outcome: 'failure',
        detail: { estimated: 2 * 1024 * MB, error: 'EBUSY' },
      })
    }
    const model = await createReliabilityModel({ audit })
    // 动作层（不分桶）：μ 全局 = (5+19)/(9+20) = 24/29 ≈ 0.8276
    // α = 0.8276×10+5 = 13.276, β = 0.1724×10+4 = 5.724 → p ≈ 0.6986
    const base = model.reliabilityOf('remove-node-modules')
    expect(base.successProbability).toBeCloseTo(13.276 / 19, 2)
    // 桶层（small）：κ_b=5，α_b = p_action×5+4 = 7.49，β_b = (1-p_action)×5+0 = 1.51
    // → p_small = 7.49/8.997 ≈ 0.8326（显著高于动作层 0.699：小目录历史全成）
    const small = model.reliabilityOf('remove-node-modules', { sizeBytes: 0.5 * MB })
    expect(small.sizeBucket).toBeDefined()
    expect(small.sizeBucket!.bucket).toBe('small')
    expect(small.sizeBucket!.samples).toBe(4)
    expect(small.successProbability).toBeCloseTo(7.49 / 8.997, 3)
    expect(small.successProbability).toBeGreaterThan(base.successProbability)
    // selfWeight 保持动作层口径（不被桶层覆盖）
    expect(small.selfWeight).toBeCloseTo(base.selfWeight)
    // 桶层（large）：1 成 4 败 → 显著低于动作层（大目录脆弱）
    const large = model.reliabilityOf('remove-node-modules', { sizeBytes: 2 * 1024 * MB })
    expect(large.sizeBucket!.bucket).toBe('large')
    expect(large.sizeBucket!.samples).toBe(5)
    expect(large.successProbability).toBeLessThan(base.successProbability)
    expect(large.successProbability).toBeLessThan(0.5)
    // 未知桶（medium 无样本）：调制不生效 → 诚实返回动作层估计
    const medium = model.reliabilityOf('remove-node-modules', { sizeBytes: 50 * MB })
    expect(medium.sizeBucket!.bucket).toBe('medium')
    expect(medium.sizeBucket!.samples).toBe(0)
    expect(medium.sizeBucket!.selfWeight).toBe(0)
    expect(medium.successProbability).toBeCloseTo(base.successProbability)
    // 不传 sizeBytes → 不附带桶证据（旧语义不变）
    expect(base.sizeBucket).toBeUndefined()
  })

  it('设计先验可配置：priorSuccessProbability 覆盖默认锚点', async () => {
    const model = await createReliabilityModel({
      audit: auditAt('prior-override'), priorSuccessProbability: 0.8,
    })
    expect(model.globalSuccessProbability).toBeCloseTo(0.8)
    expect(model.reliabilityOf('remove-node-modules').successProbability).toBeCloseTo(0.8)
  })

  it('经验贝叶斯收缩：有数据动作自信、无数据动作向全局均值收缩', async () => {
    const audit = auditAt('shrink')
    // remove-storages: 8 成 2 败（自身频率 0.8）
    // 全局 μ = (8 + 20×0.95)/(10+20) = 27/30 = 0.9（pooled 向设计先验收缩）
    for (let i = 0; i < 8; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-storages', outcome: 'success',
        detail: { estimated: 100, actual: 90 },
      })
    }
    for (let i = 0; i < 2; i++) {
      await audit.append({
        timestamp: `2026-08-21T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-storages', outcome: 'failure',
        detail: { error: 'x' },
      })
    }
    const model = await createReliabilityModel({ audit })
    expect(model.sampleCount).toBe(10)
    expect(model.globalSuccessProbability).toBeCloseTo(0.9)

    // 有数据：α=0.9×10+8=17, β=0.1×10+2=3 → 17/20 = 0.85（收缩向 0.9）
    const r = model.reliabilityOf('remove-storages')
    expect(r.successes).toBe(8)
    expect(r.failures).toBe(2)
    expect(r.successProbability).toBeCloseTo(0.85)
    expect(r.selfWeight).toBeCloseTo(10 / 20)
    expect(r.successProbability).toBeGreaterThan(0.8)   // 被拉向自身 0.8
    expect(r.successProbability).toBeLessThan(0.9)      // 但仍受全局 0.9 收缩

    // 无数据动作：完全借力全局 → 0.9
    const r2 = model.reliabilityOf('purge-temp')
    expect(r2.successProbability).toBeCloseTo(0.9)
    expect(r2.selfWeight).toBe(0)
  })

  it('设计先验随数据稀释：50 次观测后全局均值由数据主导，不被先验锚死', async () => {
    const audit = auditAt('dilute')
    // 40 成 10 败（真实 pooled 0.8）：μ = (40+19)/(50+20) = 59/70 ≈ 0.843
    // —— 数据权重 50/70 ≈ 71%，先验只拉高 ~4 个百分点（自动让位）
    for (let i = 0; i < 40; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-attachments', outcome: 'success',
        detail: {},
      })
    }
    for (let i = 0; i < 10; i++) {
      await audit.append({
        timestamp: `2026-08-21T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-attachments', outcome: 'failure',
        detail: {},
      })
    }
    const model = await createReliabilityModel({ audit })
    expect(model.sampleCount).toBe(50)
    expect(model.globalSuccessProbability).toBeCloseTo(59 / 70, 4)
    expect(model.globalSuccessProbability).toBeGreaterThan(0.8)   // 仍向先验微收
    expect(model.globalSuccessProbability).toBeLessThan(0.95)    // 但数据主导，未锚死先验
  })

  it('校准分布：ratio 样本插值分位数；样本不足诚实返回 null', async () => {
    const audit = auditAt('calib')
    // 三条 success 带 estimated/actual：ratios 0.5, 1.0, 1.5
    const ratios: [number, number][] = [[100, 50], [100, 100], [100, 150]]
    for (const [i, [est, act]] of ratios.entries()) {
      await audit.append({
        timestamp: `2026-08-22T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-attachments', outcome: 'success',
        detail: { estimated: est, actual: act },
      })
    }
    // 再来一条只有 2 个样本的动作 → 校准 null
    for (let i = 0; i < 2; i++) {
      await audit.append({
        timestamp: `2026-08-23T00:00:0${i}Z`,
        actor: 't', action: 'op:clean-home-patch', outcome: 'success',
        detail: { estimated: 10, actual: 10 },
      })
    }
    const model = await createReliabilityModel({ audit })
    const cal = model.reliabilityOf('remove-attachments').calibration
    expect(cal).not.toBeNull()
    expect(cal!.samples).toBe(3)
    expect(cal!.p50).toBeCloseTo(1.0)
    expect(cal!.p10).toBeCloseTo(0.6)    // pos=0.2 → 0.5+0.5×0.2
    expect(cal!.p90).toBeCloseTo(1.4)    // pos=1.8 → 1.0+0.5×0.8
    expect(model.reliabilityOf('clean-home-patch').calibration).toBeNull()
  })

  it('非 op: 条目与 skipped 结果不污染可靠性统计', async () => {
    const audit = auditAt('noise')
    await audit.append({ timestamp: '2026-08-24T00:00:00Z', actor: 't', action: 'tx-begin', outcome: 'success', detail: {} })
    await audit.append({ timestamp: '2026-08-24T00:00:01Z', actor: 't', action: 'op:purge-temp', outcome: 'skipped', detail: {} })
    await audit.append({ timestamp: '2026-08-24T00:00:02Z', actor: 't', action: 'tx-rollback', outcome: 'failure', detail: {} })
    const model = await createReliabilityModel({ audit })
    expect(model.sampleCount).toBe(0)
    expect(model.byAction().size).toBe(0)
  })

  it('数据飞轮：引擎 commit 的每一步自动成为下一次预测的训练样本', async () => {
    const home = path.join(tmp, 'flywheel')
    const audit = createAuditLog({ filePath: path.join(home, 'audit', 'chain.jsonl') })
    fs.mkdirSync(path.join(home, 'storages', 'p1'), { recursive: true })
    fs.writeFileSync(path.join(home, 'storages', 'p1', 'data.bin'), 'x'.repeat(1000))

    const op: CleanOperation = {
      id: 'op-1',
      action: 'remove-storages',
      target: 'p1' as never,
      async preview() {
        return { summary: 's', touchedPaths: [], estimatedBytesReclaimable: 1000, requiresExclusiveLock: true }
      },
      async validate() { return ok(undefined) },
      async execute(ctx: TxContext) {
        const backup = await ctx.backups.stageDir(path.join(home, 'storages', 'p1') as never)
        return ok({ outcome: { bytesFreed: 800, message: 'done' }, backup })
      },
      async undo() { return ok(undefined) },
    }
    const engine = createTransactionEngine(
      {
        lockManager: createLockManager({ lockRoot: path.join(home, 'locks') }),
        wal: createWal({ walRoot: path.join(home, 'tx') }),
        backups: createBackupStore({ backupRoot: path.join(home, 'backups') }),
        audit,
        resolver: null as never,
        logger,
        hooks: createHookRegistry({ dir: path.join(home, 'hooks') }),
        clock: { now: () => new Date() },
      },
      () => [op],
    )
    const request: CleanRequest = {
      plugins: ['p1' as never], profile: 'web' as never,
      strategy: 'safe', dryRun: false, actor: 't',
    }
    const session = await engine.begin(request)
    expect(session.ok).toBe(true)
    if (!session.ok) return
    const plan = await engine.plan(session.value)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const commit = await engine.commit(plan.value)
    expect(commit.ok).toBe(true)

    // 同一条审计链 → 可靠性模型读到 1 个 success 样本 + 1 个校准样本（800/1000）
    const model = await createReliabilityModel({ audit })
    expect(model.sampleCount).toBe(1)
    const r = model.reliabilityOf('remove-storages')
    expect(r.successes).toBe(1)
    expect(r.calibration).toBeNull()   // 默认 minCalibrationSamples=3，单样本诚实为 null
    // μ=(1+19)/21=20/21；α=μ·10+1=221/21，β=(1-μ)·10=10/21 → 221/231 ≈ 0.957
    //（飞轮方向：一次成功把该动作从纯先验 0.95 微微拉向自身 1.0）
    expect(r.successProbability).toBeCloseTo(221 / 231, 4)
  })
})

describe('可靠性统计升级（Wilson 区间 + 时间加权分位数）', () => {
  it('Wilson 小样本：区间天然有界（正态近似会越出 [0,1] 的场景），且包含点估计', async () => {
    const audit = auditAt('wilson')
    await audit.append({
      timestamp: '2026-08-25T00:00:00Z', actor: 't',
      action: 'op:tiny-action', outcome: 'success', detail: {},
    })
    // κ=1：后验有效样本量仅 2，p̂≈0.833 —— 正态近似上界 ≈ 0.833+1.96×0.26 > 1（越界）
    const model = await createReliabilityModel({ audit, shrinkage: 1 })
    const r = model.reliabilityOf('tiny-action')
    expect(r.ci95[0]).toBeGreaterThan(0)
    expect(r.ci95[1]).toBeLessThan(1)   // Wilson 收缩幅度，天然有界
    expect(r.ci95[0]).toBeLessThan(r.successProbability)
    expect(r.ci95[1]).toBeGreaterThan(r.successProbability)
  })

  it('时间加权分位数：老样本指数衰减、近因样本主导；全 1 权重退化回未加权公式', async () => {
    const audit = auditAt('weighted')
    // 近期 2 条 ratio 0.4 / 0.6 + 精确 30 天前 1 条 ratio 1.5
    await audit.append({
      timestamp: '2026-07-28T00:01:00Z', actor: 't', action: 'op:drifty',
      outcome: 'success', detail: { estimated: 100, actual: 150 },
    })
    await audit.append({
      timestamp: '2026-08-27T00:00:00Z', actor: 't', action: 'op:drifty',
      outcome: 'success', detail: { estimated: 100, actual: 40 },
    })
    await audit.append({
      timestamp: '2026-08-27T00:01:00Z', actor: 't', action: 'op:drifty',
      outcome: 'success', detail: { estimated: 100, actual: 60 },
    })

    // 半衰期 10 天：老样本权重 = 0.5^(30/10) = 0.125
    //   W = 2.125，t = 0.5×1.125 = 0.5625 → p50 = 0.4 + 0.2×0.5625 = 0.5125
    const weighted = await createReliabilityModel({ audit, calibrationHalfLifeMs: 10 * 24 * 3600 * 1000 })
    const cal = weighted.reliabilityOf('drifty').calibration
    expect(cal).not.toBeNull()
    expect(cal!.samples).toBe(3)
    expect(cal!.p50).toBeCloseTo(0.5125, 4)

    // 对照：半衰期无穷（Infinity）→ 权重恒为 1 → 与未加权公式逐位等价（p50 = 0.6）
    const unweighted = await createReliabilityModel({ audit, calibrationHalfLifeMs: Infinity })
    const cal2 = unweighted.reliabilityOf('drifty').calibration
    expect(cal2!.p50).toBeCloseTo(0.6, 4)
  })
})

describe('V5.3 失败模式智能（模式学习 / 瞬态份额 / 重试调整投影）', () => {
  it('失败模式归因：error 文本分类 + 显式 failureMode 优先 + 旧样本兼容', async () => {
    const audit = auditAt('modes')
    // remove-node-modules：3 次 EBUSY（locked）+ 1 次 EACCES（permission）失败
    for (let i = 0; i < 3; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-node-modules', outcome: 'failure',
        detail: { error: "EBUSY: resource busy or locked, rename 'a' -> 'b'" },
      })
    }
    // 旧式条目（无 failureMode）→ 现场分类 error 文本
    await audit.append({
      timestamp: '2026-08-20T00:00:10Z',
      actor: 't', action: 'op:remove-node-modules', outcome: 'failure',
      detail: { error: "EACCES: permission denied, unlink '/root/x'" },
    })
    // 新式条目（引擎 V5.3 显式 failureMode）→ 直接采用，无需文本
    await audit.append({
      timestamp: '2026-08-20T00:00:11Z',
      actor: 't', action: 'op:remove-node-modules', outcome: 'failure',
      detail: { error: 'Timeout after 30000ms', failureMode: 'timeout' },
    })
    const model = await createReliabilityModel({ audit })
    const r = model.reliabilityOf('remove-node-modules')
    expect(r.failures).toBe(5)
    expect(r.failureModes).toBeDefined()
    // 分布：locked 3/5, permission 1/5, timeout 1/5（count 降序）
    expect(r.failureModes!.map(m => [m.mode, m.count])).toEqual([
      ['locked', 3], ['permission', 1], ['timeout', 1],
    ])
    expect(r.failureModes![0]!.share).toBeCloseTo(0.6, 6)
    expect(r.failureModes![0]!.transience).toBe('transient')
    // 瞬态份额 = (locked 3 + timeout 1)/5 = 0.8
    expect(r.transientShare).toBeCloseTo(0.8, 6)
  })

  it('重试调整投影：p_adj = p + (1-p)·t·(1-(1-e)^R)，且不越界', async () => {
    const audit = auditAt('retry-adj')
    // remove-storages：2 成 2 败（全 EBUSY）→ t=1
    for (let i = 0; i < 2; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-storages', outcome: 'success',
        detail: { estimated: 100, actual: 100 },
      })
    }
    for (let i = 0; i < 2; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:01:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:remove-storages', outcome: 'failure',
        detail: { error: 'EBUSY: 被占用' },
      })
    }
    const model = await createReliabilityModel({ audit, retryAttempts: 2, retryEfficacy: 0.5 })
    const r = model.reliabilityOf('remove-storages')
    expect(r.transientShare).toBeCloseTo(1, 6)
    // p_adj = p + (1-p)×1×0.75 = 0.25 + 0.75×0.75（恒等展开验证）
    const expected = r.successProbability + (1 - r.successProbability) * 0.75
    expect(r.retryAdjustedProbability).toBeCloseTo(expected, 10)
    expect(r.retryAdjustedProbability).toBeGreaterThan(r.successProbability)
    expect(r.retryAdjustedProbability).toBeLessThanOrEqual(1)
  })

  it('零失败动作：failureModes 空、transientShare=0、retryAdjusted 恒等', async () => {
    const audit = auditAt('no-fail')
    for (let i = 0; i < 3; i++) {
      await audit.append({
        timestamp: `2026-08-20T00:00:${String(i).padStart(2, '0')}Z`,
        actor: 't', action: 'op:clean-home-patch', outcome: 'success',
        detail: { estimated: 10, actual: 9 },
      })
    }
    const model = await createReliabilityModel({ audit })
    const r = model.reliabilityOf('clean-home-patch')
    expect(r.failures).toBe(0)
    expect(r.failureModes).toEqual([])
    expect(r.transientShare).toBe(0)
    expect(r.retryAdjustedProbability).toBeCloseTo(r.successProbability, 12)
  })

  it('冷启动：零历史动作的模式字段诚实缺省（空分布 + 恒等投影）', async () => {
    const model = await createReliabilityModel({ audit: auditAt('cold-v53') })
    const r = model.reliabilityOf('remove-node-modules')
    expect(r.failureModes).toEqual([])
    expect(r.transientShare).toBe(0)
    expect(r.retryAdjustedProbability).toBeCloseTo(r.successProbability, 12)
  })
})

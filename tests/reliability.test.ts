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
  it('冷启动：零历史 → 全部动作收缩到 0.5 保守先验，诚实标注不确定', async () => {
    const model = await createReliabilityModel({ audit: auditAt('cold') })
    expect(model.sampleCount).toBe(0)
    expect(model.globalSuccessProbability).toBeCloseTo(0.5)
    const r = model.reliabilityOf('remove-node-modules')
    expect(r.successProbability).toBeCloseTo(0.5)
    expect(r.selfWeight).toBe(0)
    expect(r.calibration).toBeNull()
    expect(r.ci95[0]).toBeLessThan(0.5)
    expect(r.ci95[1]).toBeGreaterThan(0.5)
  })

  it('经验贝叶斯收缩：有数据动作自信、无数据动作向全局均值收缩', async () => {
    const audit = auditAt('shrink')
    // remove-storages: 8 成 2 败（自身频率 0.8）；pooled μ = (8+1)/(10+2) = 0.75
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
    expect(model.globalSuccessProbability).toBeCloseTo(0.75)

    // 有数据：α=0.75×10+8=15.5, β=0.25×10+2=4.5 → 15.5/20 = 0.775（收缩向 0.75）
    const r = model.reliabilityOf('remove-storages')
    expect(r.successes).toBe(8)
    expect(r.failures).toBe(2)
    expect(r.successProbability).toBeCloseTo(0.775)
    expect(r.selfWeight).toBeCloseTo(10 / 20)
    expect(r.successProbability).toBeGreaterThan(0.75)   // 被拉向自身 0.8
    expect(r.successProbability).toBeLessThan(0.8)       // 但仍受先验收缩

    // 无数据动作：完全借力全局 → 0.75
    const r2 = model.reliabilityOf('purge-temp')
    expect(r2.successProbability).toBeCloseTo(0.75)
    expect(r2.selfWeight).toBe(0)
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
    expect(r.successProbability).toBeGreaterThan(0.5)
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

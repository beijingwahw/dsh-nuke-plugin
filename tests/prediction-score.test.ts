// tests/prediction-score.test.ts — V5.4 预测评分级（先知问责制读侧）
// 对账口径：预测存证（tx-predict，commit 前写入）× 步骤结局（op:*）×
// 事务终结（tx-commit=1 / tx-rollback=0）三方按 txId 关联。
// Brier = (p−y)²；技能分 = 1 − Brier/基线，基线 = ȳ(1−ȳ)。
// 对账纪律：未终结跳过、演习跳过、畸形存证防御性跳过、回滚未执行
// 的步骤不计分（惩罚只落在已发生的事实上）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AuditEntry } from '../src/contracts/logging'
import { createAuditLog } from '../src/infra/audit-log'
import { createPredictionScorer } from '../src/infra/prediction-score'

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'predscore-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function auditAt(name: string) {
  return createAuditLog({ filePath: path.join(tmp, name, 'chain.jsonl') })
}

let seq = 0
/** 时间戳单调递增（对账 recent 排序依赖） */
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

function predictDetail(
  steps: readonly { readonly opId: string; readonly action: string; readonly p: number; readonly durationMs?: number | null }[],
  txP: number,
  drill = false,
): Readonly<Record<string, unknown>> {
  return {
    steps: steps.map((s, i) => ({
      index: i, operationId: s.opId, action: s.action, estimatedBytes: 100,
      predictedP: s.p,
      predictedDurationMs: s.durationMs === undefined ? null : s.durationMs,
    })),
    txSuccessProbability: txP,
    ...(drill ? { drill: true } : {}),
  }
}

describe('V5.4 预测评分级（先知问责制）', () => {
  it('零存证 → 全部 null / 0（战绩空白的诚实呈现）', async () => {
    const audit = auditAt('empty')
    await audit.append(entry('tx-begin', { plugins: ['p'] }, { txId: 't0' }))
    await audit.append(entry('tx-commit', {}, { txId: 't0' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredTx).toBe(0)
    expect(sc.scoredSteps).toBe(0)
    expect(sc.brierTx).toBeNull()
    expect(sc.brierSteps).toBeNull()
    expect(sc.brierBaseline).toBeNull()
    expect(sc.skillScore).toBeNull()
    expect(sc.durationRatio).toBeNull()
    expect(sc.recent).toEqual([])
  })

  it('事务级 Brier：完美预测全成 → 0；基线退化（全同结局）→ 技能分 null', async () => {
    const audit = auditAt('perfect')
    await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 1 }], 1), { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'a' }, { txId: 't1' }))
    await audit.append(entry('tx-commit', {}, { txId: 't1' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredTx).toBe(1)
    expect(sc.brierTx).toBeCloseTo(0, 10)
    // ȳ=1 → 基线 0（无技能已完美）→ 技能分无定义
    expect(sc.brierBaseline).toBeNull()
    expect(sc.skillScore).toBeNull()
  })

  it('惨败对账：预测 100% 却回滚 → Brier 1', async () => {
    const audit = auditAt('miss')
    await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 1 }], 1), { txId: 't1' }))
    await audit.append(entry('tx-rollback', { reason: '步骤失败' }, { txId: 't1', outcome: 'failure' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.brierTx).toBeCloseTo(1, 10)
    expect(sc.recent[0]!.actual).toBe(0)
  })

  it('技能分：混合结局 p=0.8 → Brier 0.34，基线 0.25，技能分 −0.36（劣于基线）', async () => {
    const audit = auditAt('skill')
    await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 0.8 }], 0.8), { txId: 't1' }))
    await audit.append(entry('tx-commit', {}, { txId: 't1' }))
    await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 0.8 }], 0.8), { txId: 't2' }))
    await audit.append(entry('tx-rollback', {}, { txId: 't2', outcome: 'failure' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    // (0.8−1)² + (0.8−0)² = 0.04 + 0.64 → /2 = 0.34
    expect(sc.brierTx).toBeCloseTo(0.34, 10)
    expect(sc.brierBaseline).toBeCloseTo(0.25, 10)
    expect(sc.skillScore).toBeCloseTo(1 - 0.34 / 0.25, 10)
    expect(sc.skillScore!).toBeLessThan(0)
  })

  it('步骤级计分：op 条目按 operationId 关联；回滚后未执行的步骤不计分', async () => {
    const audit = auditAt('steps')
    // 3 步预测；第 0 步失败 → 第 1/2 步被 Saga 回滚跳过（无结局条目）
    await audit.append(entry('tx-predict', predictDetail([
      { opId: 'a', action: 'clean-home-patch', p: 0.5 },
      { opId: 'b', action: 'remove-node-modules', p: 0.9 },
      { opId: 'c', action: 'remove-storages', p: 0.99 },
    ], 0.4455), { txId: 't1' }))
    await audit.append(entry('op:clean-home-patch', { operationId: 'a', error: 'boom' }, { txId: 't1', outcome: 'failure' }))
    await audit.append(entry('tx-rollback', {}, { txId: 't1', outcome: 'failure' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredSteps).toBe(1)                     // 只有 a 有结局
    expect(sc.brierSteps).toBeCloseTo((0.5 - 0) ** 2, 10)
    // 事务级照常计分（预测 0.4455，实际 0）
    expect(sc.brierTx).toBeCloseTo(0.4455 ** 2, 10)
  })

  it('步骤级 Brier 均值：两步全成 p=1/p=0.5 → (0 + 0.25)/2 = 0.125', async () => {
    const audit = auditAt('stepmean')
    await audit.append(entry('tx-predict', predictDetail([
      { opId: 'a', action: 'remove-storages', p: 1 },
      { opId: 'b', action: 'remove-node-modules', p: 0.5 },
    ], 0.5), { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'a' }, { txId: 't1' }))
    await audit.append(entry('op:remove-node-modules', { operationId: 'b' }, { txId: 't1' }))
    await audit.append(entry('tx-commit', {}, { txId: 't1' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredSteps).toBe(2)
    expect(sc.brierSteps).toBeCloseTo(0.125, 10)
  })

  it('对账纪律：演习事务跳过（人为崩溃 ≠ 预测失误）', async () => {
    const audit = auditAt('drill')
    await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 0.9 }], 0.9, true), { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'a' }, { txId: 't1' }))
    await audit.append(entry('tx-commit', {}, { txId: 't1' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredTx).toBe(0)
    expect(sc.recent).toEqual([])
  })

  it('对账纪律：未终结事务跳过（结局未定，计分即作弊）', async () => {
    const audit = auditAt('unfinished')
    await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 0.9 }], 0.9), { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'a' }, { txId: 't1' }))
    // 无 tx-commit / tx-rollback（崩溃未恢复）
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredTx).toBe(0)
  })

  it('耗时比分布：actual/predicted 的 p50/p90（≥3 样本才出分位）', async () => {
    const audit = auditAt('duration')
    await audit.append(entry('tx-predict', predictDetail([
      { opId: 'a', action: 'remove-storages', p: 1, durationMs: 100 },
      { opId: 'b', action: 'remove-storages', p: 1, durationMs: 100 },
      { opId: 'c', action: 'remove-storages', p: 1, durationMs: 100 },
    ], 1), { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'a', durationMs: 150 }, { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'b', durationMs: 200 }, { txId: 't1' }))
    await audit.append(entry('op:remove-storages', { operationId: 'c', durationMs: 100 }, { txId: 't1' }))
    await audit.append(entry('tx-commit', {}, { txId: 't1' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.durationRatio).not.toBeNull()
    expect(sc.durationRatio!.samples).toBe(3)
    // 比率排序 [1.0, 1.5, 2.0]：p50=1.5；p90 = pos 1.8 → 1.5+(2.0−1.5)×0.8 = 1.9
    expect(sc.durationRatio!.p50).toBeCloseTo(1.5, 10)
    expect(sc.durationRatio!.p90).toBeCloseTo(1.9, 10)
  })

  it('畸形存证条目防御性跳过（外部写入/旧形态不炸对账）', async () => {
    const audit = auditAt('malformed')
    await audit.append(entry('tx-predict', { steps: 'garbage', txSuccessProbability: 'high' }, { txId: 't1' }))
    await audit.append(entry('tx-predict', { steps: [{ operationId: 42, action: 'x', predictedP: 'low' }] }, { txId: 't2' }))
    await audit.append(entry('tx-commit', {}, { txId: 't1' }))
    await audit.append(entry('tx-commit', {}, { txId: 't2' }))
    const sc = await (await createPredictionScorer({ audit })).scorecard()
    expect(sc.scoredTx).toBe(0)
  })

  it('recent 明细：新 → 旧排序 + 条目上限', async () => {
    const audit = auditAt('recent')
    for (let i = 0; i < 4; i++) {
      const txId = `t${i}`
      await audit.append(entry('tx-predict', predictDetail([{ opId: 'a', action: 'remove-storages', p: 0.9 }], 0.9), { txId }))
      await audit.append(entry('op:remove-storages', { operationId: 'a' }, { txId }))
      await audit.append(entry('tx-commit', {}, { txId }))
    }
    const sc = await (await createPredictionScorer({ audit, recentLimit: 2 })).scorecard()
    expect(sc.scoredTx).toBe(4)
    expect(sc.recent).toHaveLength(2)
    // 时间戳递增构造 → recent[0] 是最后存证的 t3
    expect(sc.recent[0]!.brier).toBeCloseTo(0.01, 10)
    expect(sc.recent.map(r => r.actual)).toEqual([1, 1])
  })
})

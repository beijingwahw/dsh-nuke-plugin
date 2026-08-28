// tests/reporter-summary.test.ts — V5 报告汇总统计区单测
// 覆盖：Markdown 汇总段 / JSON 追加 summary 键（旧字段不动）/ dry-run 预估聚合 / 空报告零值
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TxId } from '../src/contracts/base'
import type { ReportPayload, ReportSummary } from '../src/contracts/logging'
import { createReporter } from '../src/infra/reporter'

let tmp: string
let reportsRoot: string
const FIXED_NOW = new Date('2026-08-20T08:00:00.000Z')

/** 4 步事务：2 done + 1 skipped + 1 failed → 成功率 3/4；总回收 12KB */
const txPayload: ReportPayload = {
  generatedAt: FIXED_NOW.toISOString(),
  chainValid: true,
  health: [],
  auditTrail: [],
  tx: {
    txId: 'sum1' as TxId,
    state: 'committed',
    steps: [
      { index: 0, operationId: 'op-1', action: 'remove-storages', status: 'done', bytesFreed: 4096, backup: null },
      { index: 1, operationId: 'op-2', action: 'remove-storages', status: 'skipped', bytesFreed: 0, backup: null },
      { index: 2, operationId: 'op-3', action: 'remove-attachments', status: 'failed', bytesFreed: 0, backup: null },
      { index: 3, operationId: 'op-4', action: 'purge-temp', status: 'done', bytesFreed: 8192, backup: null },
    ],
    bytesFreedTotal: 12288,
    startedAt: FIXED_NOW.toISOString(),
    finishedAt: FIXED_NOW.toISOString(),
  },
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-sum-'))
  reportsRoot = path.join(tmp, 'reports')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function make() {
  return createReporter({ reportsRoot, now: () => FIXED_NOW })
}

describe('V5 Markdown 汇总统计区', () => {
  it('事务报告：总回收/事务数/成功率/按动作分组表（降序）', async () => {
    const r = await make().export('markdown', txPayload)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = fs.readFileSync(r.value.path, 'utf-8')
    expect(md).toContain('## 汇总统计')
    expect(md).toContain('**总回收**: 12.0KB')
    expect(md).toContain('**事务数**: 1')
    expect(md).toContain('**步骤成功率**: 75%')   // done+skipped = 3/4
    expect(md).toContain('| purge-temp | 1 | 8.0KB |')
    expect(md).toContain('| remove-storages | 2 | 4.0KB |')
    expect(md).toContain('| remove-attachments | 1 | 0B |')
    // 按回收量降序：汇总表内 purge-temp 行在 remove-storages 行之前
    const summarySection = md.slice(md.indexOf('## 汇总统计'))
    expect(summarySection.indexOf('purge-temp')).toBeLessThan(summarySection.indexOf('remove-storages'))
  })

  it('纯健康检查报告（无 tx/dryRun）：零值汇总，成功率 —，不渲染动作表', async () => {
    const r = await make().export('markdown', {
      generatedAt: FIXED_NOW.toISOString(),
      chainValid: true,
      health: [],
      auditTrail: [],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = fs.readFileSync(r.value.path, 'utf-8')
    expect(md).toContain('**总回收**: 0B')
    expect(md).toContain('**事务数**: 0')
    expect(md).toContain('**步骤成功率**: —')
    expect(md).not.toContain('| 动作 | 步骤数 | 释放量 |')
  })

  it('dry-run 报告：汇总取预估量（actions 明细按动作聚合）', async () => {
    const r = await make().export('markdown', {
      generatedAt: FIXED_NOW.toISOString(),
      chainValid: true,
      health: [],
      auditTrail: [],
      dryRun: {
        txId: 'dry1' as TxId,
        plans: [],
        estimatedBytesReclaimable: 2048,
        warnings: [],
        actions: [
          { action: 'remove-node-modules', target: 'p1' as never, riskLevel: 'low', description: 'd', estimatedBytes: 1536 },
          { action: 'remove-node-modules', target: 'p2' as never, riskLevel: 'low', description: 'd', estimatedBytes: 512 },
        ],
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = fs.readFileSync(r.value.path, 'utf-8')
    expect(md).toContain('**总回收**: 2.0KB')
    expect(md).toContain('**事务数**: 0')
    expect(md).toContain('| remove-node-modules | 2 | 2.0KB |')
  })
})

describe('V5 JSON 汇总统计字段', () => {
  it('追加 summary 键，旧字段原样保留', async () => {
    const r = await make().export('json', txPayload)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = JSON.parse(fs.readFileSync(r.value.path, 'utf-8')) as ReportPayload & { summary: ReportSummary }
    // 旧字段不动
    expect(parsed.tx?.txId).toBe('sum1')
    expect(parsed.tx?.state).toBe('committed')
    expect(parsed.tx?.steps.length).toBe(4)
    expect(parsed.chainValid).toBe(true)
    expect(parsed.generatedAt).toBe(FIXED_NOW.toISOString())
    // 新增 summary 汇总
    expect(parsed.summary.totalBytesFreed).toBe(12288)
    expect(parsed.summary.txCount).toBe(1)
    expect(parsed.summary.successRate).toBe(0.75)
    expect(parsed.summary.byAction.map(a => a.action)).toEqual(
      ['purge-temp', 'remove-storages', 'remove-attachments'],
    )
  })
})

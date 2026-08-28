import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TxId } from '../src/contracts/base'
import type { ReportPayload } from '../src/contracts/logging'
import { createReporter } from '../src/infra/reporter'

let tmp: string
let reportsRoot: string

const FIXED_NOW = new Date('2026-08-16T12:00:00.000Z')

const payload: ReportPayload = {
  generatedAt: FIXED_NOW.toISOString(),
  chainValid: true,
  health: [
    { check: 'package.json 语法', passed: true, message: 'JSON 格式正确', severity: 'info', group: 'config' },
    { check: 'dsh CLI', passed: false, message: '命令不可用', severity: 'critical', group: 'runtime', fix: '安装 dsh' },
  ],
  auditTrail: [
    {
      seq: 1, prevHash: '0'.repeat(64), hash: 'a'.repeat(64),
      timestamp: FIXED_NOW.toISOString(), actor: 'tester',
      action: 'tx-begin', outcome: 'success', detail: {},
    },
  ],
  tx: {
    txId: 'abc123' as TxId,
    state: 'committed',
    steps: [
      { index: 0, operationId: 'op-1', action: 'remove-storages', status: 'done', bytesFreed: 4096, backup: null },
    ],
    bytesFreedTotal: 4096,
    startedAt: FIXED_NOW.toISOString(),
    finishedAt: FIXED_NOW.toISOString(),
  },
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-'))
  reportsRoot = path.join(tmp, 'reports')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function make() {
  return createReporter({ reportsRoot, now: () => FIXED_NOW })
}

describe('Reporter', () => {
  it('JSON 导出：合法 JSON、可回读全部字段、文件名含 txId', async () => {
    const r = await make().export('json', payload)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.path).toContain('nuke-abc123-')
    expect(r.value.path).toMatch(/\.json$/)
    const parsed = JSON.parse(fs.readFileSync(r.value.path, 'utf-8')) as ReportPayload
    expect(parsed.tx?.state).toBe('committed')
    expect(parsed.chainValid).toBe(true)
    expect(parsed.health.length).toBe(2)
    expect(r.value.bytes).toBeGreaterThan(0)
  })

  it('Markdown 导出：含事务摘要/健康检查表/审计链，健康检查转义管道符', async () => {
    const p2: ReportPayload = {
      ...payload,
      health: [{ check: 'x | y', passed: true, message: 'a|b', severity: 'info', group: 'config' }],
    }
    const r = await make().export('markdown', p2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = fs.readFileSync(r.value.path, 'utf-8')
    expect(md).toContain('# Nuke 清理报告')
    expect(md).toContain('## 事务摘要')
    expect(md).toContain('abc123')
    expect(md).toContain('remove-storages')
    expect(md).toContain('## 健康检查')
    expect(md).toContain('a\\|b')            // 管道符转义防表格断裂
    expect(md).toContain('## 审计链')
    expect(md).toContain('tx-begin')
    expect(md).toContain('✅ 完整')          // 链校验徽标
  })

  it('dryRun payload：渲染预演段落与阻断警告', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest 解构剔除 tx 字段是惯用法（同 src/infra/audit-log.ts），被剔除的兄弟变量是该模式的固有噪音
    const { tx: _tx, ...payloadWithoutTx } = payload
    const r = await make().export('markdown', {
      ...payloadWithoutTx,
      dryRun: {
        txId: 'abc123' as TxId,
        plans: [{
          operation: {
            summary: '删除 storages/foo',
            touchedPaths: ['/x/y' as any],
            estimatedBytesReclaimable: 1024,
            requiresExclusiveLock: true,
          },
          summary: '删除 storages/foo',
        }],
        estimatedBytesReclaimable: 1024,
        warnings: [{ code: 'W1', message: '引用仍存在', blocking: true }],
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = fs.readFileSync(r.value.path, 'utf-8')
    expect(md).toContain('## 预演（Dry-run）')
    expect(md).toContain('⛔ [阻断] 引用仍存在')
    expect(md).toContain('需要独占锁: 是')
  })

  it('重复导出幂等：目录自动创建，多次调用不冲突', async () => {
    const r1 = await make().export('json', payload)
    const r2 = await make().export('json', payload)
    expect(r1.ok && r2.ok).toBe(true)
    expect(fs.existsSync(reportsRoot)).toBe(true)
  })
})

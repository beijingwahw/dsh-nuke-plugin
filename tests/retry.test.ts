// tests/retry.test.ts — V5.3 步骤级模式感知重试
// 引擎重试决策完全由失败分类学的瞬态性驱动：
//   瞬态（EBUSY/超时…）→ 有界指数退避后重试，重试成功 = 事务成功
//   永久（校验拒绝/权限…）→ 一次失败立即回滚（重试纯浪费）
// 审计 detail 记录 retries 与 failureMode —— 可靠性模型的学习数据源。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ok } from '../src/contracts/base'
import type {
  CleanOperation, CleanRequest, ITransactionEngine, TxContext,
} from '../src/contracts/transaction'
import { createHookRegistry } from '../src/engine/hook-registry'
import { createTransactionEngine } from '../src/engine/transaction-engine'
import { createAuditLog } from '../src/infra/audit-log'
import { createBackupStore } from '../src/infra/backup-store'
import { createLockManager } from '../src/infra/lock-manager'
import { createLogger } from '../src/infra/logger'
import { createWal } from '../src/infra/wal'

let tmp: string
let home: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-test-'))
  home = path.join(tmp, '.dsh')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

/** 可编程操作：前 failTimes 次 execute 返回 err（message 由调用方指定），
 *  之后成功。记录每次 execute 调用（次数即重试证据）。 */
function flakyOp(opts: {
  action?: string
  failTimes: number
  message: string
  callsRef: { n: number }
}): CleanOperation {
  const { action = 'remove-storages', failTimes, message, callsRef } = opts
  return {
    id: `op-${action}`,
    action: action as CleanOperation['action'],
    target: 'victim-plugin' as never,
    async preview() {
      return { summary: '可编程失败步骤', touchedPaths: [], estimatedBytesReclaimable: 100, requiresExclusiveLock: true }
    },
    async validate() { return ok(undefined) },
    async execute() {
      callsRef.n++
      if (callsRef.n <= failTimes) {
        return { ok: false as const, error: { code: 'E_IO' as never, message } }
      }
      return ok({ outcome: { bytesFreed: 42, message: '第 N 次终于成功' }, backup: null })
    },
    async undo() { return ok(undefined) },
  }
}

function buildEngine(
  ops: (req: CleanRequest) => CleanOperation[],
  retryPolicy: { maxRetries: number; backoffMs: number } | undefined,
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
    },
    ops,
    // exactOptionalPropertyTypes：显式 undefined 不能赋给可选属性 —— 条件展开
    ...(retryPolicy !== undefined ? [{ retryPolicy }] : []),
  )
  return { engine, auditPath }
}

function request(): CleanRequest {
  return {
    plugins: ['victim-plugin' as never], profile: 'web' as never,
    strategy: 'safe', dryRun: false, actor: 'tester',
  }
}

/** 提交一个事务并解包（失败时抛错使测试失败）。commit 消费的是 plan */
type CommittedSummary = Extract<Awaited<ReturnType<ITransactionEngine['commit']>>, { ok: true }>['value']
async function commitOk(engine: ITransactionEngine): Promise<CommittedSummary> {
  const s = await engine.begin(request())
  if (!s.ok) throw new Error(`begin: ${s.error.message}`)
  const plan = await engine.plan(s.value)
  if (!plan.ok) throw new Error(`plan: ${plan.error.message}`)
  const committed = await engine.commit(plan.value)
  if (!committed.ok) throw new Error(`commit: ${committed.error.message}`)
  return committed.value
}

describe('V5.3 步骤级模式感知重试', () => {
  it('瞬态失败（EBUSY）→ 自动重试后成功：事务 committed，审计记录 retries', async () => {
    const calls = { n: 0 }
    const { engine, auditPath } = buildEngine(
      () => [flakyOp({ failTimes: 2, message: "EBUSY: resource busy or locked, rename 'a' -> 'b'", callsRef: calls })],
      { maxRetries: 3, backoffMs: 0 },
    )
    const summary = await commitOk(engine)
    expect(calls.n).toBe(3)            // 1 次首执行 + 2 次重试
    expect(summary.steps[0]!.status).toBe('done')
    expect(summary.steps[0]!.bytesFreed).toBe(42)
    // 审计 detail：retries=2（可靠性模型的 V5.3 学习数据源）
    const chain = fs.readFileSync(auditPath, 'utf-8').trim().split('\n')
      .map(l => JSON.parse(l) as { action: string; outcome: string; detail: Record<string, unknown> })
    const step = chain.find(e => e.action.startsWith('op:'))
    expect(step?.outcome).toBe('success')
    expect(step?.detail.retries).toBe(2)
  })

  it('超时失败（ETIMEDOUT）同样瞬态可重试', async () => {
    const calls = { n: 0 }
    const { engine } = buildEngine(
      () => [flakyOp({ failTimes: 1, message: 'ETIMEDOUT: 命令执行超时被终止', callsRef: calls })],
      { maxRetries: 2, backoffMs: 0 },
    )
    await commitOk(engine)
    expect(calls.n).toBe(2)
  })

  it('永久失败（E_VALIDATION）→ 不重试：一次失败立即回滚，retries=0 + failureMode 记档', async () => {
    const calls = { n: 0 }
    const { engine, auditPath } = buildEngine(
      () => [flakyOp({ failTimes: 5, message: '[E_VALIDATION] 路径越界: /etc', callsRef: calls })],
      { maxRetries: 3, backoffMs: 0 },
    )
    const s = await engine.begin(request())
    if (!s.ok) throw new Error(s.error.message)
    const plan = await engine.plan(s.value)
    if (!plan.ok) throw new Error(plan.error.message)
    const committed = await engine.commit(plan.value)
    expect(committed.ok).toBe(false)
    expect(calls.n).toBe(1)            // 永久失败：重试纯浪费，只执行一次
    // 失败审计：failureMode + retries=0
    const chain = fs.readFileSync(auditPath, 'utf-8').trim().split('\n')
      .map(l => JSON.parse(l) as { action: string; outcome: string; detail: Record<string, unknown> })
    const step = chain.find(e => e.action.startsWith('op:'))
    expect(step?.outcome).toBe('failure')
    expect(step?.detail.failureMode).toBe('validation')
    expect(step?.detail.retries).toBe(0)
  })

  it('重试次数上限：瞬态但耗尽重试 → 最终失败并回滚，failureMode=locked', async () => {
    const calls = { n: 0 }
    const { engine, auditPath } = buildEngine(
      () => [flakyOp({ failTimes: 99, message: 'EBUSY: 文件被占用', callsRef: calls })],
      { maxRetries: 2, backoffMs: 0 },
    )
    const s = await engine.begin(request())
    if (!s.ok) throw new Error(s.error.message)
    const plan = await engine.plan(s.value)
    if (!plan.ok) throw new Error(plan.error.message)
    const committed = await engine.commit(plan.value)
    expect(committed.ok).toBe(false)
    expect(calls.n).toBe(3)            // 1 首执行 + 2 重试（上限）
    const chain = fs.readFileSync(auditPath, 'utf-8').trim().split('\n')
      .map(l => JSON.parse(l) as { action: string; outcome: string; detail: Record<string, unknown> })
    const step = chain.find(e => e.action.startsWith('op:'))
    expect(step?.detail.failureMode).toBe('locked')
    expect(step?.detail.retries).toBe(2)
  })

  it('maxRetries=0 完全关闭重试（回到 V4 语义）：瞬态失败一次即回滚', async () => {
    const calls = { n: 0 }
    const { engine } = buildEngine(
      () => [flakyOp({ failTimes: 1, message: 'EBUSY: 文件被占用', callsRef: calls })],
      { maxRetries: 0, backoffMs: 0 },
    )
    const s = await engine.begin(request())
    if (!s.ok) throw new Error(s.error.message)
    const plan = await engine.plan(s.value)
    if (!plan.ok) throw new Error(plan.error.message)
    const committed = await engine.commit(plan.value)
    expect(committed.ok).toBe(false)
    expect(calls.n).toBe(1)
  })

  it('多步骤事务：第 1 步重试自愈，第 2 步正常执行（重试不破坏 Saga 顺序）', async () => {
    const callsA = { n: 0 }
    const executed: string[] = []
    const opA = flakyOp({ action: 'clean-home-patch', failTimes: 1, message: 'EAGAIN: resource temporarily unavailable', callsRef: callsA })
    const opB: CleanOperation = {
      id: 'op-second',
      action: 'remove-storages',
      target: 'victim-plugin' as never,
      async preview() { return { summary: '第二步', touchedPaths: [], estimatedBytesReclaimable: 10, requiresExclusiveLock: true } },
      async validate() { return ok(undefined) },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 测试桩不读执行上下文，参数仅对齐 CleanOperation.execute 契约签名
      async execute(_ctx: TxContext) {
        executed.push('B')
        return ok({ outcome: { bytesFreed: 10, message: 'ok' }, backup: null })
      },
      async undo() { return ok(undefined) },
    }
    const { engine } = buildEngine(() => [opA, opB], { maxRetries: 2, backoffMs: 0 })
    const summary = await commitOk(engine)
    expect(callsA.n).toBe(2)           // A 重试一次后成功
    expect(executed).toEqual(['B'])    // B 恰好执行一次
    expect(summary.steps.map(s => s.status)).toEqual(['done', 'done'])
  })
})

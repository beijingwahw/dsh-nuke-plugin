// tests/predict-notarize.test.ts — V5.4 预测存证（先知问责制写侧）
// commit 执行前，逐步预测（成功率/耗时）写入 hash chain：
//   - 存证条目（tx-predict）必须先于任何步骤条目（op:*）——
//     时间戳与链序双重证明"预测先于结局"，事后不可篡改
//   - 存证口径 = 重试感知成功率（与引擎实际执行语义对齐）
//   - 统计增强纪律：predictor 抛错绝不阻断真实清理
//   - 演习注入（crashAfterStep）时存证带 drill 标记（对账时跳过）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTransactionEngine } from '../src/engine/transaction-engine'
import { createLockManager } from '../src/infra/lock-manager'
import { createWal } from '../src/infra/wal'
import { createBackupStore } from '../src/infra/backup-store'
import { createAuditLog } from '../src/infra/audit-log'
import { createLogger } from '../src/infra/logger'
import { createHookRegistry } from '../src/engine/hook-registry'
import { ok } from '../src/contracts/base'
import type { IReliabilityModel } from '../src/contracts/reliability.contract'
import type {
  CleanOperation, CleanRequest, ITransactionEngine, TxContext,
} from '../src/contracts/transaction'

let tmp: string
let home: string
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-'))
  home = path.join(tmp, '.dsh')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

/** 固定可靠性模型：所有动作 p=0.9（重试感知）、耗时 p50=250ms / p90=900ms */
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

interface ChainEntry {
  readonly seq: number
  readonly action: string
  readonly txId?: string
  readonly detail: Readonly<Record<string, unknown>>
}

function buildEngine(
  ops: (req: CleanRequest) => CleanOperation[],
  opts: {
    readonly predictor?: () => Promise<IReliabilityModel>
    readonly crashAfterStep?: number
  } = {},
): { engine: ITransactionEngine; chain: () => ChainEntry[] } {
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
      ...(opts.crashAfterStep !== undefined ? { crashAfterStep: opts.crashAfterStep } : {}),
    },
    ops,
  )
  return {
    engine,
    chain: () => fs.readFileSync(auditPath, 'utf-8').trim().split('\n')
      .map(l => JSON.parse(l) as ChainEntry),
  }
}

function request(): CleanRequest {
  return {
    plugins: ['victim-plugin' as never], profile: 'web' as never,
    strategy: 'safe', dryRun: false, actor: 'tester',
  }
}

async function beginPlan(engine: ITransactionEngine) {
  const s = await engine.begin(request())
  if (!s.ok) throw new Error(s.error.message)
  const plan = await engine.plan(s.value)
  if (!plan.ok) throw new Error(plan.error.message)
  return plan.value
}

describe('V5.4 预测存证（commit 执行前写入 hash chain）', () => {
  it('存证内容：逐步 p/耗时/预估量 + 事务级连乘；链序先于全部步骤条目', async () => {
    const { engine, chain } = buildEngine(
      () => [goodOp('op-0', 'clean-home-patch', 100), goodOp('op-1', 'remove-storages', 400)],
      { predictor: () => Promise.resolve(fixedModel()) },
    )
    const plan = await beginPlan(engine)
    const committed = await engine.commit(plan)
    expect(committed.ok).toBe(true)

    const entries = chain()
    const predictIdx = entries.findIndex(e => e.action === 'tx-predict')
    expect(predictIdx).toBeGreaterThanOrEqual(0)
    // 链序纪律：存证先于任何步骤条目（预测先于结局 —— 不可抵赖性）
    const firstOpIdx = entries.findIndex(e => e.action.startsWith('op:'))
    expect(firstOpIdx).toBeGreaterThan(predictIdx)

    const detail = entries[predictIdx]!.detail as {
      txSuccessProbability: number
      drill?: boolean
      steps: { operationId: string; predictedP: number; predictedDurationMs: number; estimatedBytes: number }[]
    }
    expect(detail.steps).toHaveLength(2)
    expect(detail.steps[0]).toMatchObject({
      operationId: 'op-0', predictedP: 0.9, predictedDurationMs: 250, estimatedBytes: 100,
    })
    expect(detail.steps[1]!.estimatedBytes).toBe(400)
    // 事务级 = 0.9 × 0.9
    expect(detail.txSuccessProbability).toBeCloseTo(0.81, 10)
    // 非演习：无 drill 标记
    expect(detail.drill).toBeUndefined()
  })

  it('未注入 predictor → 无存证条目（V5.3 语义完全兼容）', async () => {
    const { engine, chain } = buildEngine(() => [goodOp('op-0', 'remove-storages', 50)])
    const plan = await beginPlan(engine)
    const committed = await engine.commit(plan)
    expect(committed.ok).toBe(true)
    expect(chain().some(e => e.action === 'tx-predict')).toBe(false)
  })

  it('统计增强纪律：predictor 抛错绝不阻断真实清理', async () => {
    const { engine, chain } = buildEngine(
      () => [goodOp('op-0', 'remove-storages', 50)],
      { predictor: () => Promise.reject(new Error('模型构建失败')) },
    )
    const plan = await beginPlan(engine)
    const committed = await engine.commit(plan)
    expect(committed.ok).toBe(true)
    expect(chain().some(e => e.action === 'tx-predict')).toBe(false)
  })

  it('演习注入（crashAfterStep）→ 存证带 drill 标记（对账时跳过）', async () => {
    // 独立锁域：模拟崩溃不释放锁，不干扰其他用例
    const drillHome = path.join(tmp, 'drill', '.dsh', '.nuke')
    fs.mkdirSync(drillHome, { recursive: true })
    const auditPath = path.join(drillHome, 'audit', 'chain.jsonl')
    const engine = createTransactionEngine(
      {
        lockManager: createLockManager({ lockRoot: drillHome }),
        wal: createWal({ walRoot: path.join(drillHome, 'tx') }),
        backups: createBackupStore({ backupRoot: path.join(drillHome, 'backups') }),
        audit: createAuditLog({ filePath: auditPath }),
        resolver: null as never,
        logger,
        hooks: createHookRegistry({ dir: path.join(drillHome, 'hooks') }),
        clock: { now: () => new Date() },
        verifyConfirmationToken: () => true,
        predictor: () => Promise.resolve(fixedModel()),
        crashAfterStep: 0,
      },
      () => [goodOp('op-0', 'remove-storages', 50)],
    )
    const plan = await beginPlan(engine)
    await expect(engine.commit(plan)).rejects.toThrow()   // SimulatedCrashError 穿透
    const entries = fs.readFileSync(auditPath, 'utf-8').trim().split('\n')
      .map(l => JSON.parse(l) as ChainEntry)
    const predict = entries.find(e => e.action === 'tx-predict')
    expect(predict).toBeDefined()
    expect(predict!.detail.drill).toBe(true)
  })
})

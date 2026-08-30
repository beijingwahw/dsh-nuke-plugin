// tests/engine.test.ts — 事务引擎核心单测（Saga 回滚 / 崩溃恢复 / dry-run / veto）
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ok } from '../src/contracts/base'
import type { CleanOperation, CleanRequest, TxContext, ITransactionEngine  } from '../src/contracts/transaction'
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'))
  home = path.join(tmp, '.dsh')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

function buildEngine(ops: (req: CleanRequest) => CleanOperation[]) {
  const walRoot = path.join(home, '.nuke', 'tx')
  const backupsRoot = path.join(home, '.nuke', 'backups')
  const auditPath = path.join(home, '.nuke', 'audit', 'chain.jsonl')
  return createTransactionEngine(
    {
      lockManager: createLockManager({ lockRoot: path.join(home, '.nuke') }),
      wal: createWal({ walRoot }),
      backups: createBackupStore({ backupRoot: backupsRoot }),
      audit: createAuditLog({ filePath: auditPath }),
      resolver: null as any,   // 引擎路径校验经由 operation 自身
      logger,
      hooks: createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') }),
      clock: { now: () => new Date() },
      verifyConfirmationToken: (t) => t === 'VALID-TOKEN',
    },
    ops,
  )
}

/** 解包 Result：非 ok 即抛错使测试失败（比 expect(r.ok).toBe(true) 多了类型收窄） */
function okv<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

function request(overrides: Partial<CleanRequest> = {}): CleanRequest {
  return {
    plugins: ['victim-plugin' as any],
    profile: 'web' as any,
    strategy: 'safe',
    dryRun: false,
    actor: 'tester',
    ...overrides,
  }
}

// ── 测试用操作 ─────────────────────────────────────────────
function opRemoveStorage(ctx0?: { dir?: string }): CleanOperation {
  const dir = () => ctx0?.dir ?? path.join(home, 'storages', 'victim-plugin')
  return {
    id: 'op-remove-storage',
    action: 'remove-storages',
    target: 'victim-plugin' as any,
    async preview() {
      const exists = fs.existsSync(dir())
      return {
        summary: `删除 storages/victim-plugin`,
        touchedPaths: [dir() as any],
        estimatedBytesReclaimable: exists ? 1024 : 0,
        requiresExclusiveLock: true,
      }
    },
    async validate() { return ok(undefined) },
    async execute(ctx: TxContext) {
      if (!fs.existsSync(dir())) return ok({ outcome: { bytesFreed: 0, message: '跳过（不存在）' }, backup: null })
      const stat = fs.statSync(dir())
      const backup = await ctx.backups.stageDir(dir() as any)
      return ok({ outcome: { bytesFreed: stat.size, message: '已移入回收区' }, backup })
    },
    async undo() { return ok(undefined) },   // restore 由引擎 manifest 统一执行
  }
}

function opEditPatch(): CleanOperation {
  const file = () => path.join(home, 'cordis.patch.yml')
  return {
    id: 'op-edit-patch',
    action: 'clean-home-patch',
    target: 'victim-plugin' as any,
    async preview() {
      return { summary: '清理 home patch 引用', touchedPaths: [file() as any], estimatedBytesReclaimable: 10, requiresExclusiveLock: true }
    },
    async validate() { return ok(undefined) },
    async execute(ctx: TxContext) {
      const original = fs.readFileSync(file(), 'utf-8')
      const next = original.split('\n').filter(l => !l.includes('victim-plugin')).join('\n')
      if (next === original) return ok({ outcome: { bytesFreed: 0, message: '无需变更' }, backup: null })
      const backup = await ctx.backups.stageEdit(file() as any, next)
      return ok({ outcome: { bytesFreed: 5, message: '已清理 patch' }, backup })
    },
    async undo() { return ok(undefined) },
  }
}

function opFail(): CleanOperation {
  return {
    id: 'op-fail',
    action: 'remove-attachments',
    target: 'victim-plugin' as any,
    async preview() { return { summary: '注定失败', touchedPaths: [], estimatedBytesReclaimable: 0, requiresExclusiveLock: true } },
    async validate() { return ok(undefined) },
    async execute() { return errFrom('E_IO', '模拟失败') },
    async undo() { return ok(undefined) },
  }
}

function errFrom(code: any, message: string): any {
  return Promise.resolve({ ok: false as const, error: { code, message } })
}

function seedWorkspace() {
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, 'storages', 'victim-plugin'), { recursive: true })
  fs.writeFileSync(path.join(home, 'storages', 'victim-plugin', 'data.bin'), 'x'.repeat(100))
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), '- id: keep\n- id: victim-plugin\n')
  fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
}

describe('事务引擎', () => {
  it('commit 成功：目录入回收区 + patch 被清理 + WAL tx-commit', async () => {
    seedWorkspace()
    const engine = buildEngine(() => [opRemoveStorage(), opEditPatch()])
    const session = await engine.begin(request())
    expect(session.ok).toBe(true)
    const plan = await engine.plan(okv(session))
    expect(plan.ok).toBe(true)
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state).toBe('committed')
      expect(result.value.steps.length).toBe(2)
      expect(fs.existsSync(path.join(home, 'storages', 'victim-plugin'))).toBe(false)
      expect(fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf-8')).not.toContain('victim-plugin')
    }
  })

  it('失败自动回滚（Saga）：步骤 2 失败 → 步骤 1 恢复原状', async () => {
    seedWorkspace()
    const engine = buildEngine(() => [opRemoveStorage(), opEditPatch(), opFail()])
    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(false)

    // 关键断言：无半清理脏数据 —— 目录回来了、patch 完整
    expect(fs.existsSync(path.join(home, 'storages', 'victim-plugin', 'data.bin'))).toBe(true)
    expect(fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf-8')).toContain('victim-plugin')

    const status = await engine.status(okv(session).txId)
    expect(status?.state).toBe('rolled-back')
  })

  it('dry-run 零副作用', async () => {
    seedWorkspace()
    const engine = buildEngine(() => [opRemoveStorage(), opEditPatch()])
    const session = await engine.begin(request({ dryRun: true }))
    const plan = await engine.plan(okv(session))
    const report = await engine.dryRun(okv(plan))
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.value.plans.length).toBe(2)
      expect(report.value.estimatedBytesReclaimable).toBeGreaterThan(0)
    }
    expect(fs.existsSync(path.join(home, 'storages', 'victim-plugin'))).toBe(true)
    expect(fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf-8')).toContain('victim-plugin')
  })

  it('V4.1 dry-run 动作明细：带 riskLevel 元数据的操作 → actions 填充；旧式操作 → actions 缺省', async () => {
    seedWorkspace()
    // 1) 带 V4 元数据的操作 → actions 逐条填充（action/target/riskLevel/estimatedBytes）
    const withMeta = opRemoveStorage()
    const detailed = {
      ...withMeta,
      riskLevel: 'medium' as const,
      description: '删除插件 storages 数据目录',
    }
    const engine1 = buildEngine(() => [detailed, opEditPatch()])
    const s1 = await engine1.begin(request({ dryRun: true }))
    const rep1 = await engine1.dryRun(okv(await engine1.plan(okv(s1))))
    expect(rep1.ok).toBe(true)
    if (rep1.ok) {
      expect(rep1.value.actions).toBeDefined()
      const actions = rep1.value.actions!
      expect(actions.length).toBe(1)   // 只有带元数据的操作进入明细
      expect(actions[0]!.action).toBe('remove-storages')
      expect(actions[0]!.target).toBe('victim-plugin')
      expect(actions[0]!.riskLevel).toBe('medium')
      expect(actions[0]!.estimatedBytes).toBeGreaterThan(0)
    }
    // 2) 旧式操作（无 riskLevel）→ actions 保持 undefined（向后兼容）
    await engine1.rollback(okv(s1).txId)   // 释放锁，与生产路径 dry-run 后 rollback 一致
    const engine2 = buildEngine(() => [opRemoveStorage(), opEditPatch()])
    const s2 = await engine2.begin(request({ dryRun: true }))
    const rep2 = await engine2.dryRun(okv(await engine2.plan(okv(s2))))
    expect(rep2.ok).toBe(true)
    if (rep2.ok) expect(rep2.value.actions).toBeUndefined()
    await engine2.rollback(okv(s2).txId)
  })

  it('aggressive 无令牌 → begin 拒绝', async () => {
    seedWorkspace()
    const engine = buildEngine(() => [opRemoveStorage()])
    const r = await engine.begin(request({ strategy: 'aggressive' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_VALIDATION')
  })

  it('aggressive 令牌无效 → plan 产生 blocking 警告，commit 拒绝', async () => {
    seedWorkspace()
    const engine = buildEngine(() => [opRemoveStorage()])
    const session = await engine.begin(request({ strategy: 'aggressive', confirmationToken: 'BAD' }))
    expect(session.ok).toBe(true)
    const plan = await engine.plan(okv(session))
    expect(plan.ok).toBe(true)
    expect(okv(plan).warnings.some(w => w.blocking)).toBe(true)
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(false)
  })

  // V5.8.3 死锁回归：真实故障 —— 令牌复验失败的 commit 拒绝路径不释放
  // 独占锁，且 autoRenew 心跳持续续期 → 持有者（宿主进程）存活期间锁
  // 永不过期，recover() 又跳过"活跃"运行时 → 后续全部事务 E_LOCK_HELD。
  it('aggressive 令牌无效 → commit 拒绝后锁必须释放（下一个事务立即可用）', async () => {
    seedWorkspace()
    const engine = buildEngine(() => [opRemoveStorage()])
    const session = await engine.begin(request({ strategy: 'aggressive', confirmationToken: 'BAD' }))
    expect(session.ok).toBe(true)
    const plan = await engine.plan(okv(session))
    expect(plan.ok).toBe(true)
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(false)
    // 拒绝后事务应已终结：status 报 rolled-back 而非卡在 planned
    const st = await engine.status(okv(session).txId)
    expect(st?.state).toBe('rolled-back')
    // 死锁核心断言：全局独占锁必须已释放 —— 新事务必须能立即拿到锁
    //（旧实现此处 E_LOCK_HELD：持有者=本进程存活 + 心跳续期 → 永久死锁）
    const session2 = await engine.begin(request())
    expect(session2.ok).toBe(true)
    if (session2.ok) {
      const plan2 = await engine.plan(session2.value)
      expect(plan2.ok).toBe(true)
      const r2 = await engine.commit(okv(plan2))
      expect(r2.ok).toBe(true)
    }
  })

  // V5.8.3 锁窗口回归：plan() 的 operationFactory 抛异常若让 plan reject，
  // 工具层 try 之前的调用点无人回滚 → 独占锁 + 心跳逃逸 = 宿主进程内
  // 永久死锁（与 commit 前置拒绝同源）。plan 必须收敛为 Result。
  it('operationFactory 抛异常 → plan 收敛为 Result（不 reject），回滚后锁可用', async () => {
    seedWorkspace()
    const engine = buildEngine(() => { throw new Error('factory boom') })
    const session = await engine.begin(request())
    expect(session.ok).toBe(true)
    const plan = await engine.plan(okv(session))
    expect(plan.ok).toBe(false)
    // 回滚释放后，下一个事务必须能立即拿到锁（无 E_LOCK_HELD）
    const rb = await engine.rollback(okv(session).txId)
    expect(rb.ok).toBe(true)
    const session2 = await engine.begin(request())
    expect(session2.ok).toBe(true)
    if (session2.ok) await engine.rollback(session2.value.txId)
  })

  it('pre 钩子 veto → 回滚', async () => {
    seedWorkspace()
    const engineRef: { current?: ITransactionEngine } = {}
    const registry = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    registry.register({
      id: 'guard',
      timing: 'pre',
      actions: '*',
      priority: 0,
      onFailure: 'best-effort',
      handler: { type: 'inline', run: async () => ({ kind: 'veto' as const, reason: '外部策略禁止' }) },
    })
    // 用带 veto 的 registry 构建引擎
    const walRoot = path.join(home, '.nuke', 'tx')
    const engine = createTransactionEngine(
      {
        lockManager: createLockManager({ lockRoot: path.join(home, '.nuke2') }),
        wal: createWal({ walRoot }),
        backups: createBackupStore({ backupRoot: path.join(home, '.nuke', 'backups') }),
        audit: createAuditLog({ filePath: path.join(home, '.nuke', 'audit', 'chain.jsonl') }),
        resolver: null as any,
        logger,
        hooks: registry,
        clock: { now: () => new Date() },
        verifyConfirmationToken: () => true,
      },
      () => [opRemoveStorage()],
    )
    engineRef.current = engine

    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_HOOK_VETO')
    expect(fs.existsSync(path.join(home, 'storages', 'victim-plugin', 'data.bin'))).toBe(true)
  })

  it('崩溃恢复：模拟半执行事务 → recover() 恢复原状', async () => {
    seedWorkspace()
    // 第一个引擎"崩溃"：begin + 部分执行后进程消失（不 commit，runtime 丢弃）
    const engine1 = buildEngine(() => [opRemoveStorage()])
    const session = await engine1.begin(request())
    await engine1.plan(okv(session))
    // 直接手工执行第一个操作（模拟执行到一半崩溃：WAL 只有 tx-begin + step-intent）
    const wal = createWal({ walRoot: path.join(home, '.nuke', 'tx') })
    await wal.append(okv(session).txId, { type: 'step-intent', index: 0, operationId: 'op-remove-storage', action: 'remove-storages', backup: null })
    const area = await createBackupStore({ backupRoot: path.join(home, '.nuke', 'backups') }).reserve(okv(session).txId)
    await area.stageDir(path.join(home, 'storages', 'victim-plugin') as any)  // 目录已被移走
    expect(fs.existsSync(path.join(home, 'storages', 'victim-plugin'))).toBe(false)

    // 新引擎实例（新进程）启动恢复
    const engine2 = buildEngine(() => [opRemoveStorage()])
    const recovery = await engine2.recover()
    expect(recovery.ok).toBe(true)
    expect(fs.existsSync(path.join(home, 'storages', 'victim-plugin', 'data.bin'))).toBe(true)

    const status = await engine2.status(okv(session).txId)
    expect(status?.state).toBe('rolled-back')
  })

  it('V5.7 list()：本进程活跃事务与崩溃残留（WAL 未终结）合并清单', async () => {
    seedWorkspace()
    // 引擎 A：begin 后保持活跃（本进程 runtime 持锁中）
    const engineA = buildEngine(() => [opRemoveStorage()])
    const sessionA = await engineA.begin(request())
    const entriesA = await engineA.list()
    expect(entriesA).toHaveLength(1)
    expect(entriesA[0]!.origin).toBe('active')
    expect(entriesA[0]!.state).toBe('draft')   // begin 后未 plan

    // 引擎 B（模拟重启的新实例，同一 WAL 目录）：A 的事务在其视角是崩溃残留
    const engineB = buildEngine(() => [opRemoveStorage()])
    const entriesB = await engineB.list()
    expect(entriesB.some(e => e.txId === okv(sessionA).txId && e.origin === 'unfinished')).toBe(true)

    // A 正常 commit 终结后：新实例清单不再包含该事务
    const plan = await engineA.plan(okv(sessionA))
    await engineA.commit(okv(plan))
    const entriesC = await engineB.list()
    expect(entriesC.some(e => e.txId === okv(sessionA).txId)).toBe(false)
  })
})

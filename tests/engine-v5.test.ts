// tests/engine-v5.test.ts — V5 升级单测：
//   transaction-engine：dryRun 并行预览（顺序稳定 / 并发可配 / 异常隔离）、commit 步骤计时
//   hook-registry：priority 可选与稳定排序、错误隔离、veto 短路、inline 超时
//   blast-radius：分层影响分析（direct/transitive）、按 profile 分组影响计数
//   orphan-detector：多 profile 并行检测（引用并集 / 孤儿 / 稳定排序）
//   restore-point：maxPoints 保留策略（在用跳过 / 拿不到事务信息保守跳过）、读回校验
//   health-inspector：检查组并行 + 输出稳定序、inode 压力检查（skipped 语义）
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTransactionEngine } from '../src/engine/transaction-engine'
import type { TxStepWithDuration, TxSummaryWithStepTimings } from '../src/engine/transaction-engine'
import { createHookRegistry } from '../src/engine/hook-registry'
import { createBlastRadiusAnalyzer } from '../src/engine/blast-radius'
import type { BlastRadiusReportV5 } from '../src/engine/blast-radius'
import { createOrphanDetector } from '../src/engine/orphan-detector'
import { createRestorePointManager } from '../src/engine/restore-point'
import { createHealthInspector } from '../src/engine/health-inspector'
import type { HealthCheckResultV5 } from '../src/engine/health-inspector'
import { createLockManager } from '../src/infra/lock-manager'
import { createWal } from '../src/infra/wal'
import { createBackupStore } from '../src/infra/backup-store'
import { createAuditLog } from '../src/infra/audit-log'
import { createLogger } from '../src/infra/logger'
import { ok } from '../src/contracts/base'
import type { NukeError, Result } from '../src/contracts/base'
import type { CleanOperation, CleanRequest, OperationPlan } from '../src/contracts/transaction'
import type { HookContext, HookVerdict, ErrorDirective } from '../src/contracts/hooks'
import type { HookRegistrationInput } from '../src/engine/hook-registry'
import type { DependencyGraph, IDependencyAnalyzer } from '../src/contracts/scan'

// 读回校验故障注入开关：仅 restore-point 的 fail-closed 测试置 true，其余时刻透传真实 fs
const tamperMetaJson = vi.hoisted(() => ({ enabled: false }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: ((p: unknown, opts: unknown) => {
      if (tamperMetaJson.enabled && typeof p === 'string' && p.endsWith('meta.json')) {
        return 'TAMPERED-CONTENT'   // 模拟坏扇区/注入：读回内容与写入内容不一致
      }
      return actual.readFileSync(p as never, opts as never)
    }) as typeof actual.readFileSync,
  }
})

let tmp: string
let home: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-v5-'))
  home = path.join(tmp, '.dsh')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const logger = createLogger({ sink: 'plain', minLevel: 'error' })

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildEngine(
  ops: (req: CleanRequest) => CleanOperation[],
  options?: { previewConcurrency?: number },
) {
  return createTransactionEngine(
    {
      lockManager: createLockManager({ lockRoot: path.join(home, '.nuke') }),
      wal: createWal({ walRoot: path.join(home, '.nuke', 'tx') }),
      backups: createBackupStore({ backupRoot: path.join(home, '.nuke', 'backups') }),
      audit: createAuditLog({ filePath: path.join(home, '.nuke', 'audit', 'chain.jsonl') }),
      resolver: null as any,
      logger,
      hooks: createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') }),
      clock: { now: () => new Date() },
      verifyConfirmationToken: () => true,
    },
    ops,
    options,
  )
}

function okv<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

function request(overrides: Partial<CleanRequest> = {}): CleanRequest {
  return {
    plugins: ['p' as any],
    profile: 'web' as any,
    strategy: 'safe',
    dryRun: true,
    actor: 'tester',
    ...overrides,
  }
}

/** 可控延迟的操作：preview 延迟可配，用于验证并行行为与输出顺序 */
function slowOp(id: string, delayMs: number, bytes: number): CleanOperation {
  return {
    id, action: 'remove-storages', target: 'p' as any,
    async preview(): Promise<OperationPlan> {
      await sleep(delayMs)
      return { summary: `summary-${id}`, touchedPaths: [], estimatedBytesReclaimable: bytes, requiresExclusiveLock: true }
    },
    async validate() { return ok(undefined) },
    async execute() { return ok({ outcome: { bytesFreed: bytes, message: 'done' }, backup: null }) },
    async undo() { return ok(undefined) },
  }
}

// ─── transaction-engine：dryRun 并行预览 ─────────────────────

describe('V5 transaction-engine：dryRun 并行预览', () => {
  it('输出顺序与 plan 严格一致（按索引收集而非完成序）', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    // 完成序为 B(1ms) → C(20ms) → A(30ms)，与 plan 序相反
    const engine = buildEngine(() => [slowOp('A', 30, 100), slowOp('B', 1, 200), slowOp('C', 20, 300)])
    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const report = await engine.dryRun(okv(plan))
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.value.plans.map(p => p.summary)).toEqual(['summary-A', 'summary-B', 'summary-C'])
    expect(report.value.estimatedBytesReclaimable).toBe(600)
    await engine.rollback(okv(session).txId)
  })

  it('预演并发度可配：previewConcurrency=4 时慢操作真实重叠', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    let active = 0
    let peak = 0
    const op = (id: string): CleanOperation => ({
      ...slowOp(id, 25, 10),
      async preview() {
        active++
        peak = Math.max(peak, active)
        await sleep(25)
        active--
        return { summary: `summary-${id}`, touchedPaths: [], estimatedBytesReclaimable: 10, requiresExclusiveLock: true }
      },
    })
    const engine = buildEngine(() => [op('a'), op('b'), op('c'), op('d')], { previewConcurrency: 4 })
    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const report = await engine.dryRun(okv(plan))
    expect(report.ok).toBe(true)
    expect(peak).toBeGreaterThan(1)   // 4 个慢 preview 必然重叠（并发池生效）
    await engine.rollback(okv(session).txId)
  })

  it('previewConcurrency=1 时退化为串行（峰值恒为 1）', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    let active = 0
    let peak = 0
    const op = (id: string): CleanOperation => ({
      ...slowOp(id, 5, 10),
      async preview() {
        active++
        peak = Math.max(peak, active)
        await sleep(5)
        active--
        return { summary: `summary-${id}`, touchedPaths: [], estimatedBytesReclaimable: 10, requiresExclusiveLock: true }
      },
    })
    const engine = buildEngine(() => [op('a'), op('b'), op('c')], { previewConcurrency: 1 })
    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const report = await engine.dryRun(okv(plan))
    expect(report.ok).toBe(true)
    expect(peak).toBe(1)
    await engine.rollback(okv(session).txId)
  })

  it('单个 preview 抛异常 → 整体返回 E_IO（Result 而非异常传播）', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    // plan 阶段会先串行调一轮 preview（成功），dryRun 并行第二轮才抛异常
    let boomCalls = 0
    const boom: CleanOperation = {
      ...slowOp('boom', 1, 10),
      async preview() {
        boomCalls++
        if (boomCalls > 1) throw new Error('preview 炸了')
        return { summary: 'summary-boom', touchedPaths: [], estimatedBytesReclaimable: 10, requiresExclusiveLock: true }
      },
    }
    const engine = buildEngine(() => [slowOp('ok', 1, 5), boom])
    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const report = await engine.dryRun(okv(plan))
    expect(report.ok).toBe(false)
    if (report.ok) return
    expect(report.error.code).toBe('E_IO')
    expect(report.error.message).toContain('preview 炸了')
    await engine.rollback(okv(session).txId)
  })

  it('并发预演下 V4.1 的 actions 明细语义保持不变', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    const detailed = {
      ...slowOp('meta', 5, 42),
      riskLevel: 'high' as const,
      description: '高风险动作',
    }
    const engine = buildEngine(() => [slowOp('plain', 30, 1), detailed], { previewConcurrency: 4 })
    const session = await engine.begin(request())
    const plan = await engine.plan(okv(session))
    const report = await engine.dryRun(okv(plan))
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.value.actions).toBeDefined()
    expect(report.value.actions!.length).toBe(1)   // 只有带 riskLevel 的操作进入明细
    expect(report.value.actions![0]!.estimatedBytes).toBe(42)
    // plans 顺序依旧与 plan 一致（慢的 plain 在前）
    expect(report.value.plans[0]!.summary).toBe('summary-plain')
    await engine.rollback(okv(session).txId)
  })
})

// ─── transaction-engine：commit 步骤计时 ─────────────────────

describe('V5 transaction-engine：commit 步骤计时', () => {
  it('每个成功步骤携带 durationMs（>=0），审计 detail 同步记录', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
    fs.writeFileSync(path.join(home, 'storages', 'x.bin'), 'x'.repeat(64))
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    const engine = buildEngine(() => [slowOp('s1', 1, 10), slowOp('s2', 1, 20)], undefined)
    const session = await engine.begin(request({ dryRun: false }))
    const plan = await engine.plan(okv(session))
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const summary = result.value as TxSummaryWithStepTimings
    expect(summary.steps.length).toBe(2)
    for (const step of summary.steps as readonly TxStepWithDuration[]) {
      expect(typeof step.durationMs).toBe('number')
      expect(step.durationMs!).toBeGreaterThanOrEqual(0)
    }
    // 审计链：op: 前缀条目的 detail 含 durationMs（成功与失败路径都有）
    const audit = createAuditLog({ filePath: path.join(home, '.nuke', 'audit', 'chain.jsonl') })
    const entries = await audit.query({ txId: okv(session).txId })
    const opEntries = entries.filter(e => e.action.startsWith('op:'))
    expect(opEntries.length).toBe(2)
    for (const e of opEntries) {
      expect(typeof (e.detail as Record<string, unknown>).durationMs).toBe('number')
    }
  })

  it('失败步骤同样计时：durationMs 进入失败审计与步骤摘要', async () => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.mkdirSync(path.join(home, '.nuke'), { recursive: true })
    const failing: CleanOperation = {
      ...slowOp('fail', 1, 0),
      async execute() {
        await sleep(3)
        return { ok: false as const, error: { code: 'E_IO' as const, message: '模拟失败' } }
      },
    }
    const engine = buildEngine(() => [failing])
    const session = await engine.begin(request({ dryRun: false }))
    const plan = await engine.plan(okv(session))
    const result = await engine.commit(okv(plan))
    expect(result.ok).toBe(false)
    const audit = createAuditLog({ filePath: path.join(home, '.nuke', 'audit', 'chain.jsonl') })
    const entries = await audit.query({ txId: okv(session).txId })
    const failure = entries.find(e => e.action.startsWith('op:') && e.outcome === 'failure')
    expect(failure).toBeDefined()
    expect(typeof (failure!.detail as Record<string, unknown>).durationMs).toBe('number')
    // 状态查询路径同样可见失败步骤的耗时
    const status = await engine.status(okv(session).txId)
    expect(status?.state).toBe('rolled-back')
  })
})

// ─── hook-registry：优先级 / 错误隔离 / 超时 ───────────────────

function hookCtx(): HookContext {
  return {
    txId: 'tx-test' as any, actor: 'tester', plugin: 'p' as any,
    profile: 'web' as any, strategy: 'safe', action: 'remove-storages',
  }
}

function inlineHook(
  id: string,
  priority: number | undefined,
  fn: () => Promise<HookVerdict | ErrorDirective | void>,
): HookRegistrationInput {
  return {
    id, timing: 'pre' as const, actions: '*' as const, onFailure: 'best-effort' as const,
    ...(priority !== undefined ? { priority } : {}),
    handler: { type: 'inline' as const, run: fn },
  }
}

describe('V5 hook-registry：钩子优先级', () => {
  it('priority 数值越小越先执行；同优先级保持注册序', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    const order: string[] = []
    reg.register(inlineHook('a', 10, async () => { order.push('a') }))
    reg.register(inlineHook('b', -5, async () => { order.push('b') }))
    reg.register(inlineHook('c', 10, async () => { order.push('c') }))
    reg.register(inlineHook('d', -5, async () => { order.push('d') }))
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(true)
    expect(order).toEqual(['b', 'd', 'a', 'c'])
  })

  it('priority 可选：缺省按 0 参与排序', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    const order: string[] = []
    reg.register(inlineHook('late', 5, async () => { order.push('late') }))
    reg.register(inlineHook('default', undefined, async () => { order.push('default') }))
    reg.register(inlineHook('early', -1, async () => { order.push('early') }))
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(true)
    expect(order).toEqual(['early', 'default', 'late'])
  })
})

describe('V5 hook-registry：错误隔离', () => {
  it('单个钩子抛异常不中断整批：后续钩子照常执行，错误收集进结果', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    const order: string[] = []
    reg.register(inlineHook('boom', 0, async () => { throw new Error('钩子炸了') }))
    reg.register(inlineHook('after', 1, async () => { order.push('after') }))
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.executed).toBe(2)
    expect(r.value.failed).toBe(1)
    expect(order).toEqual(['after'])
    expect(r.value.messages.some(m => m.includes('boom') && m.includes('钩子炸了'))).toBe(true)
    expect(r.value.verdict.kind).toBe('proceed')   // 单钩子异常不影响裁决
  })

  it('fail-fast 错误不再提前中断：整批执行完后统一返回 err', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    const order: string[] = []
    reg.register({
      id: 'boom-fast', timing: 'pre', actions: '*', priority: 0, onFailure: 'fail-fast',
      handler: { type: 'inline', run: async () => { throw new Error('快速失败') } },
    })
    reg.register(inlineHook('after', 1, async () => { order.push('after') }))
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_HOOK_VETO')
    expect(r.error.message).toContain('boom-fast')
    expect(order).toEqual(['after'])   // 关键：错误之后的钩子依然执行完
  })

  it('veto 立即短路：后续钩子不再执行，裁决保持 veto', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    const order: string[] = []
    reg.register(inlineHook('vetoer', 0, async () => ({ kind: 'veto' as const, reason: '外部策略禁止' })))
    reg.register(inlineHook('after', 1, async () => { order.push('after') }))
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.verdict.kind).toBe('veto')
    expect(r.value.verdict).toEqual({ kind: 'veto', reason: '外部策略禁止' })
    expect(r.value.executed).toBe(1)      // 短路后只执行了 vetoer
    expect(order).toEqual([])             // after 未执行
  })
})

describe('V5 hook-registry：inline 钩子超时', () => {
  it('超时视为该钩子失败（错误隔离路径），不中断整批', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    const order: string[] = []
    reg.register({
      id: 'slow', timing: 'pre', actions: '*', priority: 0, onFailure: 'best-effort',
      timeoutMs: 20,
      handler: { type: 'inline', run: async () => { await sleep(150); order.push('slow-done') } },
    })
    reg.register(inlineHook('after', 1, async () => { order.push('after') }))
    const startedAt = Date.now()
    const r = await reg.emit('pre', hookCtx())
    const elapsed = Date.now() - startedAt
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.failed).toBe(1)
    expect(r.value.messages.some(m => m.includes('slow') && m.includes('超时'))).toBe(true)
    expect(order).toEqual(['after'])
    expect(elapsed).toBeLessThan(140)   // emit 没有等慢钩子跑完（150ms）
  })

  it('超时 + fail-fast：整批执行完后统一返回 err', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    reg.register({
      id: 'slow-fast', timing: 'pre', actions: '*', priority: 0, onFailure: 'fail-fast',
      timeoutMs: 15,
      handler: { type: 'inline', run: async () => { await sleep(120) } },
    })
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_HOOK_VETO')
    expect(r.error.message).toContain('slow-fast')
  })

  it('未设置 timeoutMs 的慢钩子不受超时约束（兼容旧语义）', async () => {
    const reg = createHookRegistry({ dir: path.join(home, '.nuke', 'hooks') })
    reg.register(inlineHook('slow-legacy', 0, async () => {
      await sleep(60)
      return { kind: 'proceed-with-warning' as const, message: '慢但完成' }
    }))
    const r = await reg.emit('pre', hookCtx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.failed).toBe(0)
    expect(r.value.verdict.kind).toBe('proceed-with-warning')
  })
})

// ─── blast-radius：分层影响分析 + profile 分组计数 ──────────────

/** 带 nodes（declaredIn 声明位置）的 stub 依赖图分析器 */
function stubGraphAnalyzer(
  edges: readonly [string, string][],
  declaredIn: ReadonlyMap<string, readonly string[]>,
): IDependencyAnalyzer {
  const direct = new Map<string, string[]>()
  for (const [from, to] of edges) {
    const list = direct.get(to) ?? []
    list.push(from)
    direct.set(to, list)
  }
  const closureOf = (name: string): string[] => {
    const seen = new Set<string>()
    const queue = [...(direct.get(name) ?? [])]
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      queue.push(...(direct.get(cur) ?? []))
    }
    return [...seen]
  }
  const graph = (): DependencyGraph => ({
    nodes: new Map(
      [...declaredIn].map(([name, dirs]) => [
        name as any,
        { name: name as any, declaredIn: dirs as any, patchRefs: [] },
      ]),
    ),
    edges: edges.map(([from, to]) => ({
      from: from as any, to: to as any, kind: 'dependencies' as const, declaredIn: '' as any,
    })),
    dependentsOf: (n) => closureOf(n as string).map(x => x as any),
    dependenciesOf: () => [],
    hasCycle: () => false,
    cycles: () => [],
  })
  return {
    buildGraph: async (): Promise<Result<DependencyGraph, NukeError>> => ok(graph()),
    blockersOf: async () => ok([]),
  }
}

describe('V5 blast-radius：分层影响分析', () => {
  // 不存在的 home → 磁盘探测全零，聚焦图语义；describe 体在 beforeAll 前执行，需惰性求值
  const dshHome = () => path.join(tmp, 'blast-home')

  it('direct = 1 跳依赖方，transitive = 2+ 跳传递依赖方', async () => {
    // child/consumer 直接依赖 victim（1 跳）；grandchild 经 child 传递（2 跳）
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(),
      analyzer: stubGraphAnalyzer([['child', 'victim'], ['grandchild', 'child'], ['consumer', 'victim']], new Map()),
    })
    const r = await analyzer.simulate(['victim' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.tieredDependents).toBeDefined()
    const tiered = report.tieredDependents!
    expect([...tiered.direct].sort()).toEqual(['child', 'consumer'])
    expect(tiered.transitive).toEqual(['grandchild'])
    // 旧字段保持：broken 仍包含全部三层依赖方
    expect([...r.value.brokenDependents].sort()).toEqual(['child', 'consumer', 'grandchild'])
  })

  it('同一节点同时 1 跳与 2+ 跳可达时取最短跳数（归 direct）', async () => {
    // b 直接依赖 victim，也经 a 传递依赖 victim → BFS 最短 = 1 跳
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(),
      analyzer: stubGraphAnalyzer([['a', 'victim'], ['b', 'a'], ['b', 'victim']], new Map()),
    })
    const r = await analyzer.simulate(['victim' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.tieredDependents!.direct).toContain('b')
    expect(report.tieredDependents!.transitive).not.toContain('b')
  })

  it('删除集合成员与 profile: 合成节点不计入分层', async () => {
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(),
      analyzer: stubGraphAnalyzer([
        ['child', 'victim'],
        ['profile:web', 'child'],      // 合成节点：不算插件依赖方
      ], new Map()),
    })
    const r = await analyzer.simulate(['victim' as any, 'child' as any])   // child 同批删除
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.tieredDependents!.direct).toEqual([])
    expect(report.tieredDependents!.transitive).toEqual([])
  })

  it('impactByProfile：broken+cascade 的声明分布，按 profile 名稳定排序', async () => {
    const declaredIn = new Map<string, readonly string[]>([
      // child 声明于两个 profile（各计一次）；grandchild 仅 web
      ['child', ['/x/profiles/web/package.json', '/x/profiles/api/package.json']],
      ['grandchild', ['/x/profiles/web/package.json']],
    ])
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(),
      analyzer: stubGraphAnalyzer([['child', 'victim'], ['grandchild', 'child']], declaredIn),
    })
    const r = await analyzer.simulate(['victim' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.impactByProfile).toEqual([
      { profile: 'api', affected: 1 },   // child
      { profile: 'web', affected: 2 },   // child + grandchild
    ])
  })

  it('cascade（同批删除）同样计入 impactByProfile', async () => {
    const declaredIn = new Map<string, readonly string[]>([
      ['child', ['/x/profiles/web/package.json']],
      ['grandchild', ['/x/profiles/prod/package.json']],
    ])
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(),
      analyzer: stubGraphAnalyzer([['child', 'victim'], ['grandchild', 'child']], declaredIn),
    })
    // child 同批 → cascade；grandchild → broken
    const r = await analyzer.simulate(['victim' as any, 'child' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.impactByProfile).toEqual([
      { profile: 'prod', affected: 1 },
      { profile: 'web', affected: 1 },
    ])
  })

  it('无受波及插件时 tieredDependents 全空、impactByProfile 为空数组', async () => {
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(), analyzer: stubGraphAnalyzer([], new Map()),
    })
    const r = await analyzer.simulate(['lonely' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.tieredDependents).toEqual({ direct: [], transitive: [] })
    expect(report.impactByProfile).toEqual([])
  })

  it('declaredIn 非 profile 位置（如 patch 引用）不计入分组', async () => {
    const declaredIn = new Map<string, readonly string[]>([
      ['child', ['/x/cordis.patch.yml']],   // 路径中无 profiles 段
    ])
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: dshHome(),
      analyzer: stubGraphAnalyzer([['child', 'victim']], declaredIn),
    })
    const r = await analyzer.simulate(['victim' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: BlastRadiusReportV5 = r.value
    expect(report.impactByProfile).toEqual([])
  })
})

// ─── orphan-detector：多 profile 并行检测 ──────────────────────

describe('V5 orphan-detector：多 profile 并行检测', () => {
  let oHome: string
  let oTemp: string

  function seedTwoProfiles() {
    fs.rmSync(oHome, { recursive: true, force: true })
    // alpha：声明 shared-pkg；node_modules 有 shared-pkg + alpha-orphan(1KB)
    const alpha = path.join(oHome, 'profiles', 'alpha')
    fs.mkdirSync(path.join(alpha, 'node_modules', 'shared-pkg'), { recursive: true })
    fs.mkdirSync(path.join(alpha, 'node_modules', 'alpha-orphan'), { recursive: true })
    fs.writeFileSync(path.join(alpha, 'package.json'), JSON.stringify({
      dependencies: { 'shared-pkg': '^1' },
    }))
    fs.writeFileSync(path.join(alpha, 'node_modules', 'alpha-orphan', 'big.bin'), 'x'.repeat(1000))
    // beta：不声明任何包；node_modules 有 shared-pkg + beta-orphan(2KB)
    const beta = path.join(oHome, 'profiles', 'beta')
    fs.mkdirSync(path.join(beta, 'node_modules', 'shared-pkg'), { recursive: true })
    fs.mkdirSync(path.join(beta, 'node_modules', 'beta-orphan'), { recursive: true })
    fs.writeFileSync(path.join(beta, 'package.json'), JSON.stringify({ dependencies: {} }))
    fs.writeFileSync(path.join(beta, 'node_modules', 'beta-orphan', 'big.bin'), 'y'.repeat(2000))
    // storages 孤儿
    fs.mkdirSync(path.join(oHome, 'storages', 'orphan-data'), { recursive: true })
    fs.writeFileSync(path.join(oHome, 'storages', 'orphan-data', 'd.bin'), 'z'.repeat(100))
    fs.mkdirSync(oTemp, { recursive: true })   // 空 TEMP：无过期条目
  }

  beforeAll(() => {
    oHome = path.join(tmp, 'orphan-home')
    oTemp = path.join(tmp, 'orphan-temp')
    seedTwoProfiles()
  })

  function makeDetector() {
    return createOrphanDetector({ dshHome: oHome, tempRoot: oTemp, now: () => new Date('2026-08-16T00:00:00Z') })
  }

  it('两个 profile 的孤儿都被检出（引用收集并行分发）', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.value.orphanPluginDirs.map(d => path.basename(d.path))
    expect(names).toContain('alpha-orphan')
    expect(names).toContain('beta-orphan')
  })

  it('跨 profile 引用并集：alpha 声明的 shared-pkg 在 beta node_modules 中不是孤儿', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.value.orphanPluginDirs.map(d => path.basename(d.path))
    expect(names).not.toContain('shared-pkg')
  })

  it('orphanPluginDirs 按 sizeBytes 降序稳定排序', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sizes = r.value.orphanPluginDirs.map(d => d.sizeBytes)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
    // beta-orphan(2KB) 必须排在 alpha-orphan(1KB) 前
    expect(r.value.orphanPluginDirs[0]!.path).toContain('beta-orphan')
  })

  it('storages 孤儿（无任何 profile 声明）被标记', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.orphanDataDirs.some(d => d.path.includes('orphan-data'))).toBe(true)
  })
})

// ─── restore-point：保留策略 + 读回校验 ────────────────────────

describe('V5 restore-point：保留策略与读回校验', () => {
  let rpHome: string
  let rpNuke: string
  let tick = 0
  const clock = { now: () => new Date(Date.parse('2026-02-01T00:00:00Z') + tick++ * 1000) }

  beforeAll(() => {
    rpHome = path.join(tmp, 'rp-home')
    rpNuke = path.join(rpHome, '.nuke')
  })

  function seedRp() {
    fs.rmSync(rpHome, { recursive: true, force: true })
    fs.mkdirSync(path.join(rpHome, 'profiles', 'web'), { recursive: true })
    fs.writeFileSync(path.join(rpHome, 'cordis.patch.yml'), '- id: keep\n')
    fs.writeFileSync(path.join(rpHome, 'profiles', 'web', 'package.json'), '{"name":"web"}')
  }

  function rpManager(extra: {
    maxPoints?: number
    unfinishedTxPaths?: () => readonly string[] | null
  } = {}) {
    return createRestorePointManager({
      dshHome: rpHome, nukeRoot: rpNuke, now: clock.now, ...extra,
    })
  }

  function createOne(mgr: ReturnType<typeof rpManager>) {
    return mgr.create({ actor: 'tester', reason: 'v5', profile: 'web' as any })
  }

  it('maxPoints 超限时自动淘汰最旧还原点', async () => {
    seedRp()
    const mgr = rpManager({ maxPoints: 2, unfinishedTxPaths: () => [] })
    const r1 = await createOne(mgr)
    const r2 = await createOne(mgr)
    const r3 = await createOne(mgr)
    expect(r1.ok && r2.ok && r3.ok).toBe(true)
    const list = mgr.list()
    expect(list.length).toBe(2)
    expect(list.map(m => m.id)).not.toContain(r1.ok ? r1.value.id : '')
    expect(list.map(m => m.id)).toContain(r2.ok ? r2.value.id : '')
    expect(list.map(m => m.id)).toContain(r3.ok ? r3.value.id : '')
    // 被淘汰者的目录确实已删除
    expect(fs.existsSync(path.join(rpNuke, 'restore-points', r1.ok ? r1.value.id : ''))).toBe(false)
  })

  it('最旧还原点被未终结事务引用 → 跳过它，淘汰次旧（宁可多留不可误删）', async () => {
    seedRp()
    // 第一阶段：无淘汰策略创建 rp1，记录其目录
    const mgrPlain = rpManager()
    const r1 = await createOne(mgrPlain)
    expect(r1.ok).toBe(true)
    const rp1Dir = path.join(rpNuke, 'restore-points', r1.ok ? r1.value.id : '')
    // 第二阶段：rp1 目录被未终结事务 manifest 引用
    const mgr = rpManager({
      maxPoints: 2,
      unfinishedTxPaths: () => [path.join(rp1Dir, 'home', 'cordis.patch.yml')],
    })
    const r2 = await createOne(mgr)
    const r3 = await createOne(mgr)
    expect(r2.ok && r3.ok).toBe(true)
    const ids = mgr.list().map(m => m.id)
    expect(ids).toContain(r1.ok ? r1.value.id : '')    // 在用 → 保留
    expect(ids).not.toContain(r2.ok ? r2.value.id : '')   // 次旧被淘汰
    expect(ids).toContain(r3.ok ? r3.value.id : '')
  })

  it('拿不到事务信息（未注入 / 返回 null / 抛异常）→ 保守跳过全部淘汰', async () => {
    for (const unfinishedTxPaths of [
      undefined,                          // 未注入
      (() => null) as (() => readonly string[] | null),   // 返回 null
      (() => { throw new Error('tx 状态不可用') }),        // 抛异常
    ]) {
      seedRp()
      const mgr = rpManager({ maxPoints: 1, ...(unfinishedTxPaths ? { unfinishedTxPaths } : {}) })
      for (let i = 0; i < 3; i++) await createOne(mgr)
      expect(mgr.list().length).toBe(3)   // 一个都不淘汰
    }
  })

  it('maxPoints 无效值（0 / 负数 / 非整数）视为未设置', async () => {
    for (const maxPoints of [0, -1, 1.5]) {
      seedRp()
      const mgr = rpManager({ maxPoints, unfinishedTxPaths: () => [] })
      for (let i = 0; i < 3; i++) await createOne(mgr)
      expect(mgr.list().length).toBe(3)
    }
  })

  it('读回校验：manifest 写入后读回不一致 → E_IO 且目录被清理（fail-closed）', async () => {
    seedRp()
    const mgr = rpManager()
    tamperMetaJson.enabled = true
    try {
      const r = await createOne(mgr)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe('E_IO')
        expect(r.error.message).toContain('读回校验')
      }
      // 失败还原点目录必须清理，不留伪快照
      const rpRoot = path.join(rpNuke, 'restore-points')
      const leftovers = fs.readdirSync(rpRoot)
      expect(leftovers.length).toBe(0)
    } finally {
      tamperMetaJson.enabled = false
    }
  })

  it('正常创建路径：读回一致 → ok（读回校验不误伤合法写入）', async () => {
    seedRp()
    const r = await createOne(rpManager())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const metaFile = path.join(rpNuke, 'restore-points', r.value.id, 'meta.json')
    expect(fs.existsSync(metaFile)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
    expect(onDisk.id).toBe(r.value.id)
  })
})

// ─── health-inspector：并行检查 + inode 压力 ───────────────────

describe('V5 health-inspector：并行检查与 inode 压力检查项', () => {
  let hiHome: string

  function seedHealthyEnv() {
    fs.rmSync(hiHome, { recursive: true, force: true })
    const pd = path.join(hiHome, 'profiles', 'default')
    fs.mkdirSync(path.join(pd, 'node_modules', 'foo'), { recursive: true })
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
      dependencies: { foo: '^1.0.0' },
      dsh: { profile: { bundles: ['foo'] } },
    }, null, 2))
    fs.writeFileSync(path.join(pd, 'pnpm-workspace.yaml'), 'allowBuilds:\n  - foo\n')
    fs.writeFileSync(path.join(pd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0')
    fs.writeFileSync(path.join(pd, 'node_modules', 'foo', 'package.json'), '{"name":"foo"}')
  }

  beforeAll(() => {
    hiHome = path.join(tmp, 'health-home')
    seedHealthyEnv()
  })

  const stubOk = () => ({ status: 0, stdout: 'v1.0.0\n', stderr: '' })

  function makeInspector(opts: Partial<Parameters<typeof createHealthInspector>[0]> = {}) {
    return createHealthInspector({
      dshHome: hiHome, runCommand: stubOk as any, walUnfinished: () => [], ...opts,
    })
  }

  it('结果按固定组序输出：config → dependency → runtime → residue（与旧串行一致）', async () => {
    const r = await makeInspector().inspect('default' as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const groupSeq = [...new Set(r.value.results.map(x => x.group))]
    expect(groupSeq).toEqual(['config', 'dependency', 'runtime', 'residue'])
  })

  it('磁盘 inode 压力检查项存在：探测到 → passed 且报告余量', async () => {
    const r = await makeInspector().inspect('default' as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const results: readonly HealthCheckResultV5[] = r.value.results
    const inode = results.find(x => x.check === '磁盘 inode 压力')
    expect(inode).toBeDefined()
    expect(inode!.group).toBe('runtime')
    // 真实 tmp 上 inode 充足：通过且不构成阻断
    expect(inode!.passed).toBe(true)
    expect(inode!.message.length).toBeGreaterThan(0)
    expect(r.value.blocking).toBe(false)
  })

  it('statfs 探测不到（home 路径不存在）→ skipped 而非 failed', async () => {
    const r = await makeInspector({ dshHome: path.join(tmp, 'no-such-home') }).inspect('default' as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const results: readonly HealthCheckResultV5[] = r.value.results
    const inode = results.find(x => x.check === '磁盘 inode 压力')
    expect(inode).toBeDefined()
    expect(inode!.skipped).toBe(true)     // 探测不到 → skipped（能力缺失而非健康问题）
    expect(inode!.passed).toBe(true)      // 不按失败处理
    expect(inode!.severity).toBe('info')  // 不参与阻断与扣分
  })

  it('异步 runCommand 桩可用（V5 并行检查组支持异步探测）', async () => {
    const asyncProbe = async (cmd: string) => {
      await sleep(5)
      return { status: 0, stdout: `${cmd} async-v9\n`, stderr: '' }
    }
    const r = await makeInspector({ runCommand: asyncProbe as any }).inspect('default' as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dsh = r.value.results.find(x => x.check === 'dsh CLI')!
    const pnpm = r.value.results.find(x => x.check === 'pnpm CLI')!
    expect(dsh.passed).toBe(true)
    expect(dsh.message).toContain('async-v9')
    expect(pnpm.passed).toBe(true)
  })
})

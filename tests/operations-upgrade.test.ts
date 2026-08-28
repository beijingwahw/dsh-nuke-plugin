// tests/operations-upgrade.test.ts — V4 操作层升级测试
// 覆盖：exec-ops 瞬态重试/超时上限/结构化输出；fs-ops top-N 影响面明细与 skip 语义；
//       edit-ops 幂等 skip；yaml-edit 字节级保持；index.ts 动作元数据与 makeOperationPlan；
//       policy.contract 增量（freezeWindows fail-closed 默认）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PluginName, ProfileName, TxId } from '../src/contracts/base'
import { hitFreezeWindow, NO_FREEZE_WINDOWS } from '../src/contracts/policy.contract'
import type { BackupArea, TxContext, DryRunReport } from '../src/contracts/transaction'
import { createBackupStore } from '../src/infra/backup-store'
import { createLogger } from '../src/infra/logger'
import { createPathResolver } from '../src/infra/path-resolver'
import { createValidator } from '../src/infra/validator'
import { configEditOps } from '../src/operations/edit-ops'
import {
  MAX_COMMAND_TIMEOUT_MS, makePnpmPruneOp, makeStandardRemoveOp,
  type CommandResult, type CommandRunner,
} from '../src/operations/exec-ops'
import { DEFAULT_IMPACT_TOP_N, dirRemoveOps, makeDirRemoveOp } from '../src/operations/fs-ops'
import {
  ACTION_METADATA, makeOperationFactory, makeOperationPlan, STRATEGY_ACTIONS,
} from '../src/operations/index'
import { removePluginFromYaml } from '../src/operations/yaml-edit'

const PROFILE = 'default' as ProfileName
const VICTIM = 'victim-plugin' as PluginName
const FAST_RETRY = { maxRetries: 2, baseDelayMs: 1 }

// ─── exec-ops：可编程命令桩 ─────────────────────────────────

/** 按序回放的命令桩：每次调用弹出下一个结果；耗尽后重复最后一个 */
function scriptRun(script: CommandResult[]): CommandRunner & { calls: { cmd: string; args: readonly string[]; timeoutMs: number }[] } {
  const calls: { cmd: string; args: readonly string[]; timeoutMs: number }[] = []
  let i = 0
  const run = (cmd: string, args: readonly string[], opts: { timeoutMs: number }): CommandResult => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs })
    const r = script[Math.min(i, script.length - 1)]!
    i++
    return r
  }
  return Object.assign(run, { calls })
}

const okResult = (stdout = 'v1.0.0\n'): CommandResult =>
  ({ status: 0, stdout, stderr: '' })

const errnoResult = (code: string, signal?: string): CommandResult => ({
  status: null, stdout: '', stderr: '',
  error: Object.assign(new Error(`spawn ${code}`), { code }),
  ...(signal !== undefined ? { signal } : {}),
})

// ─── 测试环境 ───────────────────────────────────────────────

let home: string
let dshHome: string
let tempRoot: string
let ctx: TxContext
let area: BackupArea

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-v4-home-'))
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-v4-temp-'))
  dshHome = path.join(home, '.dsh')

  const resolver = createPathResolver({ env: { HOME: home, DSH_HOME: dshHome, TMPDIR: tempRoot } })
  const store = createBackupStore({ backupRoot: path.join(dshHome, '.nuke', 'backups') })
  area = await store.reserve('tx-ops-v4' as TxId)
  ctx = {
    txId: 'tx-ops-v4' as TxId,
    request: { plugins: [VICTIM], profile: PROFILE, strategy: 'balanced', dryRun: false, actor: 'tester' },
    resolver,
    backups: area,
    logger: createLogger({ sink: 'plain', minLevel: 'error' }),
    clock: { now: () => new Date() },
  }
})
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

// ─── exec-ops：瞬态重试 ─────────────────────────────────────

describe('exec-ops 瞬态重试', () => {
  it('EAGAIN 首败后重试成功：attempts=2 且最终 ok', async () => {
    const run = scriptRun([errnoResult('EAGAIN'), okResult()])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: FAST_RETRY,
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.outcome.command?.attempts).toBe(2)
    expect(r.value.outcome.command?.exitCode).toBe(0)
    expect(r.value.outcome.command?.stdout).toBe('v1.0.0\n')
  })

  it('非瞬态错误（ENOENT 命令不存在）不重试：attempts=1', async () => {
    const run = scriptRun([errnoResult('ENOENT')])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: FAST_RETRY,
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.details?.command).toMatchObject({ attempts: 1, exitCode: null })
  })

  it('业务失败（exit 1）不重试：命令跑完自身失败与瞬态无关', async () => {
    const run = scriptRun([{ status: 1, stdout: '', stderr: 'boom' }])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: FAST_RETRY,
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.details?.command).toMatchObject({ attempts: 1, exitCode: 1 })
    expect(r.error.message).toContain('boom')
  })

  it('瞬态错误重试耗尽（默认上限 2 次）→ err，attempts=3', async () => {
    const run = scriptRun([errnoResult('EAGAIN'), errnoResult('EAGAIN'), errnoResult('EAGAIN')])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: FAST_RETRY,
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.details?.command).toMatchObject({ attempts: 3, exitCode: null })
  })

  it('探针同样享受瞬态重试：validate 在 CLI 抖动后仍可通过', async () => {
    const run = scriptRun([errnoResult('EAGAIN'), okResult()])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: FAST_RETRY,
    })
    const v = await op.validate(ctx)
    expect(v.ok).toBe(true)
    expect(run.calls.length).toBe(2)   // 探针重试了一次
  })
})

// ─── exec-ops：超时上限（fail-closed） ──────────────────────

describe('exec-ops 超时上限', () => {
  it('超时（ETIMEDOUT/SIGTERM）重试耗尽 → err 且标记 timedOut，绝不挂死', async () => {
    const run = scriptRun([errnoResult('ETIMEDOUT', 'SIGTERM')])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: { maxRetries: 1, baseDelayMs: 1 },
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('超时')
    expect(r.error.details?.command).toMatchObject({ timedOut: true, attempts: 2 })
  })

  it('配置的超时被钳制在硬上限内（防注入运行器收到天文数字超时）', async () => {
    const run = scriptRun([okResult(), okResult()])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run,
      commandTimeoutMs: 999_999_999, retry: { maxRetries: 0, baseDelayMs: 1 },
    })
    await op.execute(ctx)
    for (const c of run.calls) {
      expect(c.timeoutMs).toBeLessThanOrEqual(MAX_COMMAND_TIMEOUT_MS)
    }
  })

  it('pnpm prune 超时同样 fail-closed', async () => {
    const run = scriptRun([errnoResult('ETIMEDOUT', 'SIGTERM'), errnoResult('ETIMEDOUT', 'SIGTERM')])
    const op = makePnpmPruneOp(PROFILE, () => '/anywhere', {
      validator: createValidator(), runCommand: run, retry: { maxRetries: 1, baseDelayMs: 1 },
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.details?.command).toMatchObject({ timedOut: true })
  })
})

// ─── exec-ops：结构化输出捕获 ───────────────────────────────

describe('exec-ops 结构化输出（stdout/stderr/exitCode/durationMs）', () => {
  it('execute 成功：outcome.command 携带完整结构化捕获（进 WAL step-done 的载体）', async () => {
    const run = scriptRun([{ status: 0, stdout: 'removed 3 packages\n', stderr: '' }])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: { maxRetries: 0, baseDelayMs: 1 },
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const cap = r.value.outcome.command
    expect(cap).toBeDefined()
    expect(cap).toMatchObject({
      cmd: 'dsh',
      args: ['plugin', '--profile', 'default', 'remove', 'victim-plugin'],
      exitCode: 0,
      stdout: 'removed 3 packages\n',
      stderr: '',
    })
    expect(typeof cap?.durationMs).toBe('number')
    expect(cap?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('preview 携带探针的结构化捕获（dry-run 报告可见 CLI 可用性）', async () => {
    const run = scriptRun([{ status: 0, stdout: 'dsh 2.1.0\n', stderr: '' }])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: { maxRetries: 0, baseDelayMs: 1 },
    })
    const p = await op.preview(ctx)
    expect(p.command).toMatchObject({ cmd: 'dsh', args: ['--version'], exitCode: 0, stdout: 'dsh 2.1.0\n' })
    expect(p.command?.durationMs).toBeGreaterThanOrEqual(0)
    expect(p.summary).toContain('标准卸载')
  })

  it('失败路径：结构化捕获进 NukeError.details（审计链可见）', async () => {
    const run = scriptRun([{ status: 1, stdout: '', stderr: 'EPERM: lock' }])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: { maxRetries: 0, baseDelayMs: 1 },
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.details?.command).toMatchObject({ exitCode: 1, stderr: 'EPERM: lock' })
  })

  it('超长输出截断至有界长度（WAL/审计不容噪声膨胀）', async () => {
    const run = scriptRun([{ status: 1, stdout: '', stderr: 'x'.repeat(10_000) }])
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run, retry: { maxRetries: 0, baseDelayMs: 1 },
    })
    const r = await op.execute(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    const cap = r.error.details?.command as { stderr: string }
    expect(cap.stderr.length).toBe(4_000)
  })
})

// ─── fs-ops：top-N 影响面明细 ──────────────────────────────

describe('fs-ops preview 影响面明细（top-N）', () => {
  const nmDir = () => path.join(dshHome, 'profiles', PROFILE, 'node_modules', VICTIM)

  beforeAll(() => {
    fs.mkdirSync(path.join(nmDir(), 'sub1'), { recursive: true })
    fs.mkdirSync(path.join(nmDir(), 'sub2'), { recursive: true })
    fs.writeFileSync(path.join(nmDir(), 'a.js'), 'x'.repeat(100))
    fs.writeFileSync(path.join(nmDir(), 'b.js'), 'x'.repeat(300))
    fs.writeFileSync(path.join(nmDir(), 'c.js'), 'x'.repeat(200))
    fs.writeFileSync(path.join(nmDir(), 'sub1', 'big.bin'), 'x'.repeat(500))
    fs.writeFileSync(path.join(nmDir(), 'sub2', 'tiny.bin'), 'x'.repeat(50))
  })

  it('topFiles/topDirs 按体积降序、默认各取 5 条', async () => {
    const op = dirRemoveOps(VICTIM, PROFILE, () => dshHome)[0]!
    const p = await op.preview(ctx)
    expect(p.impact).toBeDefined()
    const impact = p.impact!
    expect(impact.dir).toBe(nmDir())
    expect(impact.totalBytes).toBe(p.estimatedBytesReclaimable)
    expect(impact.totalBytes).toBe(100 + 300 + 200 + 500 + 50)
    expect(impact.topFiles.map(f => path.basename(f.path))).toEqual(['b.js', 'c.js', 'a.js'])
    expect(impact.topFiles[0]!.bytes).toBe(300)
    expect(impact.topDirs.map(d => path.basename(d.path))).toEqual(['sub1', 'sub2'])
    expect(impact.topDirs[0]!.bytes).toBe(500)
    expect(impact.topFiles.length).toBeLessThanOrEqual(DEFAULT_IMPACT_TOP_N)
    expect(impact.topDirs.length).toBeLessThanOrEqual(DEFAULT_IMPACT_TOP_N)
  })

  it('topN 可配：明细条目数随配置收敛', async () => {
    const op = dirRemoveOps(VICTIM, PROFILE, () => dshHome, { topN: 1 })[0]!
    const p = await op.preview(ctx)
    expect(p.impact!.topFiles.length).toBe(1)
    expect(p.impact!.topFiles[0]!.bytes).toBe(300)
    expect(p.impact!.topDirs.length).toBe(1)
    expect(p.impact!.topDirs[0]!.bytes).toBe(500)
  })

  it('makeDirRemoveOp 直接构造亦生效（spec.topN）', async () => {
    const op = makeDirRemoveOp({
      id: 'op-remove-node-modules', action: 'remove-node-modules', target: VICTIM,
      dirOf: () => nmDir(), description: '移除 node_modules 包目录',
      policy: { allowedRoots: [{ kind: 'profile-dir', profile: PROFILE }], denyGlobs: [], strictWindows: false },
      topN: 2,
    })
    const p = await op.preview(ctx)
    expect(p.impact!.topFiles.length).toBe(2)
    expect(p.impact!.topDirs.length).toBe(2)
  })

  it('目录不存在 → preview/execute 均 skipped 且无影响面明细', async () => {
    const op = dirRemoveOps('ghost-plugin' as PluginName, PROFILE, () => dshHome)[0]!
    const p = await op.preview(ctx)
    expect(p.skipped).toBe(true)
    expect(p.impact).toBeUndefined()
    expect(p.touchedPaths).toEqual([])
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.outcome.skipped).toBe(true)
    expect(r.value.backup).toBeNull()
  })
})

// ─── edit-ops：幂等 skip 语义 ──────────────────────────────

describe('edit-ops 幂等 skip 语义', () => {
  const patchFile = () => path.join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml')

  beforeAll(() => {
    fs.mkdirSync(path.dirname(patchFile()), { recursive: true })
    fs.writeFileSync(patchFile(), 'changes:\n  - id: victim-plugin\n    path: p.patch\n')
  })

  it('引用存在：preview.skipped 不置位', async () => {
    const op = configEditOps(VICTIM, PROFILE, () => dshHome)[1]!
    const p = await op.preview(ctx)
    expect(p.skipped).toBeFalsy()
    expect(p.touchedPaths).toEqual([patchFile()])
  })

  it('引用不存在：preview 返回 skipped 语义（不报错、无触碰路径）', async () => {
    const op = configEditOps('not-referenced' as PluginName, PROFILE, () => dshHome)[1]!
    const p = await op.preview(ctx)
    expect(p.skipped).toBe(true)
    expect(p.touchedPaths).toEqual([])
  })

  it('引用不存在：validate 依旧放行（不报错），execute skipped 且无空操作', async () => {
    const op = configEditOps('not-referenced' as PluginName, PROFILE, () => dshHome)[1]!
    const v = await op.validate(ctx)
    expect(v.ok).toBe(true)
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.outcome.skipped).toBe(true)
    expect(r.value.backup).toBeNull()
    expect(r.value.outcome.bytesFreed).toBe(0)
  })

  it('重复执行幂等：首次摘除后再 preview/execute 均 skipped', async () => {
    const mk = () => configEditOps(VICTIM, PROFILE, () => dshHome)[1]!
    const first = await mk().execute(ctx)
    expect(first.ok).toBe(true)
    expect(first.ok && first.value.outcome.skipped).toBeFalsy()   // 首次真摘除

    const p2 = await mk().preview(ctx)
    expect(p2.skipped).toBe(true)
    const r2 = await mk().execute(ctx)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.value.outcome.skipped).toBe(true)
    expect(r2.value.backup).toBeNull()
  })

  it('文件不存在：preview/execute 均 skipped', async () => {
    const op = configEditOps(VICTIM, PROFILE, () => dshHome)[0]!  // workspace yaml 未创建
    const p = await op.preview(ctx)
    expect(p.skipped).toBe(true)
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.outcome.skipped).toBe(true)
  })
})

// ─── yaml-edit：摘除时其余内容字节级不变 ────────────────────

describe('yaml-edit 字节级保持（含注释与顺序）', () => {
  it('注释与行顺序逐字节保持：输出 = 原文精确删去 victim 两行', () => {
    const content = [
      '# 顶部注释',
      'changes:',
      '  # 块间注释属于保留内容',
      '  - id: victim-plugin',
      '    path: patches/victim.patch',
      '',
      '  - id: keep-plugin',
      '    path: patches/keep.patch',
      '# 尾部注释',
    ].join('\n')
    const expected = [
      '# 顶部注释',
      'changes:',
      '  # 块间注释属于保留内容',
      '',
      '  - id: keep-plugin',
      '    path: patches/keep.patch',
      '# 尾部注释',
    ].join('\n')
    expect(removePluginFromYaml(content, 'victim-plugin')).toBe(expected)
  })

  it('块尾分隔空行不被吞食（旧实现缺陷的回归钉）', () => {
    const content = 'changes:\n  - id: victim-plugin\n    path: a.patch\n\n  - id: keep-plugin\n    path: b.patch\n'
    const expected = 'changes:\n\n  - id: keep-plugin\n    path: b.patch\n'
    expect(removePluginFromYaml(content, 'victim-plugin')).toBe(expected)
  })

  it('块内部的空行（后随块内属性行）随块摘除', () => {
    const content = 'changes:\n  - id: victim-plugin\n    path: a.patch\n\n    note: n\n  - id: keep-plugin\n'
    const expected = 'changes:\n  - id: keep-plugin\n'
    expect(removePluginFromYaml(content, 'victim-plugin')).toBe(expected)
  })

  it('EOF 换行约定保持：原文件无尾换行 → 结果不补换行', () => {
    const content = 'allowBuilds:\n  - victim-plugin\n  - keep-plugin'
    expect(removePluginFromYaml(content, 'victim-plugin')).toBe('allowBuilds:\n  - keep-plugin')
  })

  it('尾部多空行原样保留（不做 \\n{3,} 折叠美化）', () => {
    const content = 'changes:\n  - id: victim-plugin\n\n\n'
    expect(removePluginFromYaml(content, 'victim-plugin')).toBe('changes:\n\n\n')
  })

  it('CRLF 行尾保持', () => {
    const content = 'changes:\r\n  - id: victim-plugin\r\n  - id: keep-plugin\r\n'
    expect(removePluginFromYaml(content, 'victim-plugin')).toBe('changes:\r\n  - id: keep-plugin\r\n')
  })

  it('字符串列表项 / 映射键两形态同样字节级保持', () => {
    expect(removePluginFromYaml('allowBuilds:\n  - victim-plugin\n  - keep-plugin\n', 'victim-plugin'))
      .toBe('allowBuilds:\n  - keep-plugin\n')
    expect(removePluginFromYaml('catalog:\n  victim-plugin: 1.0.0\n  keep-plugin: 2.0.0\n', 'victim-plugin'))
      .toBe('catalog:\n  keep-plugin: 2.0.0\n')
  })

  it('未引用 → null（不产生空操作）', () => {
    expect(removePluginFromYaml('changes:\n  - id: other-plugin\n', 'victim-plugin')).toBeNull()
    expect(removePluginFromYaml('', 'victim-plugin')).toBeNull()
  })
})

// ─── index.ts：动作元数据 + makeOperationPlan ───────────────

describe('动作集元数据化（ACTION_METADATA）', () => {
  it('覆盖全部 CleanAction 且字段完备', () => {
    const allActions = new Set(Object.values(STRATEGY_ACTIONS).flat())
    expect(Object.keys(ACTION_METADATA).length).toBe(allActions.size)
    for (const meta of Object.values(ACTION_METADATA)) {
      expect(['low', 'medium', 'high']).toContain(meta.riskLevel)
      expect(meta.description.length).toBeGreaterThan(0)
      expect(['per-plugin', 'global']).toContain(meta.scope)
    }
  })

  it('工厂产出的每个操作都附带 riskLevel 与 description', () => {
    const factory = makeOperationFactory({
      validator: createValidator(),
      runCommand: scriptRun([okResult()]),
      tempRoot,
    })
    const ops = factory({
      plugins: [VICTIM], profile: PROFILE, strategy: 'aggressive', dryRun: true, actor: 't',
    })
    expect(ops.length).toBe(9)
    for (const op of ops) {
      expect(op.riskLevel).toBeDefined()
      expect(op.description).toBeDefined()
      expect(op.riskLevel).toBe(ACTION_METADATA[op.action].riskLevel)
    }
  })
})

describe('makeOperationPlan（策略+插件 → 动作清单+风险+预估）', () => {
  const planRequest = (strategy: 'safe' | 'balanced' | 'aggressive') => ({
    plugins: [VICTIM], profile: PROFILE, strategy, dryRun: true, actor: 't',
  })

  it('无 resolver：纯元数据清单（safe=4 动作、estimatedBytes 全 0、锁需求按动作推导）', async () => {
    const r = await makeOperationPlan(planRequest('safe'), {
      validator: createValidator(), tempRoot,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.actions.length).toBe(4)
    expect(r.value.actions.every(a => a.estimatedBytes === 0)).toBe(true)
    expect(r.value.totalEstimatedBytes).toBe(0)
    const std = r.value.actions.find(a => a.action === 'standard-remove')!
    expect(std.requiresExclusiveLock).toBe(true)
    expect(std.riskLevel).toBe('medium')
    expect(r.value.actions.find(a => a.action === 'clean-workspace-yaml')!.riskLevel).toBe('low')
  })

  it('无 resolver：aggressive=9 动作、highestRiskLevel=high（storages/prune）', async () => {
    const r = await makeOperationPlan(planRequest('aggressive'), {
      validator: createValidator(), tempRoot,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.actions.length).toBe(9)
    expect(r.value.highestRiskLevel).toBe('high')
    expect(r.value.actions.find(a => a.action === 'pnpm-store-prune')!.requiresExclusiveLock).toBe(true)
  })

  it('与 makeOperationFactory 同构：action 顺序与 operationId 完全一致', async () => {
    const opts = {
      validator: createValidator(),
      runCommand: scriptRun([okResult()]),
      tempRoot,
    }
    const factoryOps = makeOperationFactory(opts)(planRequest('balanced'))
    const plan = await makeOperationPlan(planRequest('balanced'), opts)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.actions.map(a => a.operationId)).toEqual(factoryOps.map(o => o.id))
    expect(plan.value.actions.map(a => a.action)).toEqual(factoryOps.map(o => o.action))
  })

  it('提供 resolver：逐操作真实 preview，预估字节与 skipped 语义可用', async () => {
    // 为 victim 重新落一份 storages 数据（前面用例未建）
    fs.mkdirSync(path.join(dshHome, 'storages', VICTIM), { recursive: true })
    fs.writeFileSync(path.join(dshHome, 'storages', VICTIM, 'data.json'), 'x'.repeat(1234))

    const resolver = createPathResolver({ env: { HOME: home, DSH_HOME: dshHome, TMPDIR: tempRoot } })
    const r = await makeOperationPlan(planRequest('balanced'), {
      validator: createValidator(),
      runCommand: scriptRun([okResult()]),
      tempRoot,
      resolver,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const storages = r.value.actions.find(a => a.action === 'remove-storages')!
    expect(storages.estimatedBytes).toBeGreaterThanOrEqual(1234)
    expect(storages.summary).toContain('storages')
    // workspace yaml 不存在 → skipped 标记透出
    expect(r.value.actions.find(a => a.action === 'clean-workspace-yaml')!.skipped).toBe(true)
    expect(r.value.totalEstimatedBytes).toBe(
      r.value.actions.reduce((s, a) => s + a.estimatedBytes, 0),
    )
  })

  it('产出的 actions 可直接作为 DryRunReport.actions（契约同构）', async () => {
    const r = await makeOperationPlan(planRequest('safe'), {
      validator: createValidator(), tempRoot,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const report: DryRunReport = {
      txId: 'tx-plan' as TxId,
      plans: [],
      estimatedBytesReclaimable: r.value.totalEstimatedBytes,
      warnings: [],
      actions: r.value.actions,   // PlannedActionDetail 是 DryRunActionDetail 的结构超集
    }
    expect(report.actions?.length).toBe(4)
    expect(report.actions?.[0]).toHaveProperty('riskLevel')
    expect(report.actions?.[0]).toHaveProperty('description')
    expect(report.actions?.[0]).toHaveProperty('estimatedBytes')
  })
})

// ─── contracts/policy.contract.ts 增量 ─────────────────────

describe('policy.contract 增量（freezeWindows / maxFilesPerTx）', () => {
  it('fail-closed 默认：空冻结窗列表永不命中（缺省 = 不启用，行为不变）', () => {
    expect(NO_FREEZE_WINDOWS).toEqual([])
    for (let h = 0; h < 24; h++) {
      expect(hitFreezeWindow(NO_FREEZE_WINDOWS, h)).toBeNull()
    }
  })

  it('单窗 [9,18)：工作时段命中、边界语义 [start,end)', () => {
    const w = [{ startHour: 9, endHour: 18 }]
    expect(hitFreezeWindow(w, 8)).toBeNull()
    expect(hitFreezeWindow(w, 9)?.startHour).toBe(9)
    expect(hitFreezeWindow(w, 12)?.endHour).toBe(18)
    expect(hitFreezeWindow(w, 17)?.startHour).toBe(9)
    expect(hitFreezeWindow(w, 18)).toBeNull()
  })

  it('跨零点窗 [22,6)：夜间命中、日间放行', () => {
    const w = [{ startHour: 22, endHour: 6 }]
    expect(hitFreezeWindow(w, 22)).not.toBeNull()
    expect(hitFreezeWindow(w, 23)).not.toBeNull()
    expect(hitFreezeWindow(w, 0)).not.toBeNull()
    expect(hitFreezeWindow(w, 5)).not.toBeNull()
    expect(hitFreezeWindow(w, 6)).toBeNull()
    expect(hitFreezeWindow(w, 12)).toBeNull()
    expect(hitFreezeWindow(w, 21)).toBeNull()
  })

  it('多重窗口：任一命中即返回首个命中窗（含 reason 透传）', () => {
    const ws = [
      { startHour: 1, endHour: 2, reason: '数据库备份' },
      { startHour: 9, endHour: 18, reason: '工作时间' },
    ]
    expect(hitFreezeWindow(ws, 10)?.reason).toBe('工作时间')
    expect(hitFreezeWindow(ws, 1)?.reason).toBe('数据库备份')
    expect(hitFreezeWindow(ws, 3)).toBeNull()
  })
})

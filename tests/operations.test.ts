import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createPathResolver } from '../src/infra/path-resolver'
import { createValidator } from '../src/infra/validator'
import { createBackupStore } from '../src/infra/backup-store'
import { createLogger } from '../src/infra/logger'
import { configEditOps } from '../src/operations/edit-ops'
import { dirRemoveOps, makePurgeTempOp } from '../src/operations/fs-ops'
import { makePnpmPruneOp, makeStandardRemoveOp } from '../src/operations/exec-ops'
import { makeOperationFactory, STRATEGY_ACTIONS } from '../src/operations/index'
import type { BackupArea } from '../src/contracts/transaction'
import type { TxContext } from '../src/contracts/transaction'
import type { PluginName, ProfileName, TxId } from '../src/contracts/base'

let home: string
let dshHome: string
let tempRoot: string
let ctx: TxContext
let area: BackupArea

const PROFILE = 'default' as ProfileName
const VICTIM = 'victim-plugin' as PluginName

const stubRun = (okCmds: string[] = ['dsh', 'pnpm']) =>
  (cmd: string, args: readonly string[]) =>
    okCmds.includes(cmd)
      ? { status: 0, stdout: `${cmd} ${args.join(' ')} ok\n`, stderr: '' }
      : { status: 127, stdout: '', stderr: `${cmd}: not found` }

function seed() {
  const pd = path.join(dshHome, 'profiles', PROFILE)
  fs.mkdirSync(path.join(pd, 'node_modules', VICTIM), { recursive: true })
  fs.writeFileSync(path.join(pd, 'node_modules', VICTIM, 'index.js'), 'x'.repeat(200))
  fs.writeFileSync(path.join(pd, 'pnpm-workspace.yaml'),
    'allowBuilds:\n  - victim-plugin\n  - keep-plugin\n')
  fs.writeFileSync(path.join(pd, 'cordis.patch.yml'),
    'changes:\n  - id: victim-plugin\n    path: patches/victim.patch\n  - id: keep-plugin\n    path: patches/keep.patch\n')
  fs.writeFileSync(path.join(dshHome, 'cordis.patch.yml'),
    'changes:\n  - id: victim-plugin\n    path: patches/victim.patch\n')
  fs.mkdirSync(path.join(dshHome, 'storages', VICTIM), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'storages', VICTIM, 'data.json'), '{"a":1}')
  fs.mkdirSync(path.join(dshHome, 'attachments', 'v1', VICTIM), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'attachments', 'v1', VICTIM, 'f.bin'), '1010')
  // TEMP
  fs.mkdirSync(tempRoot, { recursive: true })
  const old = path.join(tempRoot, 'dsh-tmp-old')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'x'), 'zzz')
  const t = new Date(Date.now() - 30 * 86_400_000)
  fs.utimesSync(old, t, t)
  fs.writeFileSync(path.join(tempRoot, 'dsh-fresh'), 'z')
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-home-'))
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-temp-'))
  dshHome = path.join(home, '.dsh')
  seed()

  const resolver = createPathResolver({ env: { HOME: home, DSH_HOME: dshHome, TMPDIR: tempRoot } })
  const store = createBackupStore({ backupRoot: path.join(dshHome, '.nuke', 'backups') })
  area = await store.reserve('tx-ops-1' as TxId)
  ctx = {
    txId: 'tx-ops-1' as TxId,
    request: {
      plugins: [VICTIM], profile: PROFILE, strategy: 'balanced', dryRun: false, actor: 'tester',
    },
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

describe('configEditOps（配置引用摘除）', () => {
  it('preview 零副作用：文件内容不变', async () => {
    const op = configEditOps(VICTIM, PROFILE, () => dshHome)[1]!  // profile patch
    const before = fs.readFileSync(path.join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf-8')
    await op.preview(ctx)
    const after = fs.readFileSync(path.join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf-8')
    expect(after).toBe(before)
  })

  it('execute 摘除 victim 块保留 keep 块；undo 完整恢复', async () => {
    const op = configEditOps(VICTIM, PROFILE, () => dshHome)[1]!
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    const content = fs.readFileSync(path.join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf-8')
    expect(content).not.toContain('victim-plugin')
    expect(content).toContain('keep-plugin')
    expect(content).toContain('patches/keep.patch')

    const undo = await op.undo(ctx, r.ok ? r.value.backup : null)
    expect(undo.ok).toBe(true)
    expect(fs.readFileSync(path.join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf-8'))
      .toContain('victim-plugin')
  })

  it('未引用时 execute 跳过（backup=null，无副作用）', async () => {
    const op = configEditOps('not-installed' as PluginName, PROFILE, () => dshHome)[2]! // home patch
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.backup).toBeNull()
    expect(r.value.outcome.bytesFreed).toBe(0)
  })

  it('validate：越出白名单（home patch 写到系统路径）→ E_PATH_POLICY', async () => {
    const op = configEditOps(VICTIM, PROFILE, () => '/definitely/not/allowed')[2]!
    const r = await op.validate(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_PATH_POLICY')
  })
})

describe('dirRemoveOps（目录物理回收）', () => {
  it('execute 目录移入回收区且 bytesFreed>0；undo 恢复文件', async () => {
    const storagesOp = dirRemoveOps(VICTIM, PROFILE, () => dshHome)[1]!
    const dir = path.join(dshHome, 'storages', VICTIM)
    const r = await storagesOp.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.outcome.bytesFreed).toBeGreaterThan(0)
    expect(fs.existsSync(dir)).toBe(false)

    const undo = await storagesOp.undo(ctx, r.value.backup)
    expect(undo.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, 'data.json'))).toBe(true)
  })

  it('validate：路径穿越插件名 → E_PATH_POLICY 拒绝', async () => {
    const evil = '../../../etc' as unknown as PluginName
    const op = dirRemoveOps(evil, PROFILE, () => dshHome)[0]!
    const r = await op.validate(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_PATH_POLICY')
  })

  it('dsh 官方基座目录 → denyGlobs 拒绝', async () => {
    const base = '@deepseek-ai/dsh-base' as unknown as PluginName
    fs.mkdirSync(path.join(dshHome, 'storages', '@deepseek-ai'), { recursive: true })
    fs.mkdirSync(path.join(dshHome, 'storages', '@deepseek-ai', 'dsh-base'), { recursive: true })
    const op = dirRemoveOps(base, PROFILE, () => dshHome)[1]!
    const r = await op.validate(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_PATH_POLICY')
  })
})

describe('makePurgeTempOp', () => {
  it('只清过期 dsh 条目；文件/目录均处理', async () => {
    const op = makePurgeTempOp({ tempRoot, ttlDays: 7 })
    const preview = await op.preview(ctx)
    expect(preview.estimatedBytesReclaimable).toBeGreaterThan(0)
    const r = await op.execute(ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.outcome.bytesFreed).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tempRoot, 'dsh-tmp-old'))).toBe(false)
    expect(fs.existsSync(path.join(tempRoot, 'dsh-fresh'))).toBe(true)
  })
})

describe('makeStandardRemoveOp / makePnpmPruneOp', () => {
  it('standard-remove：成功路径 + 失败路径', async () => {
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: stubRun(),
    })
    expect((await op.validate(ctx)).ok).toBe(true)
    const okR = await op.execute(ctx)
    expect(okR.ok).toBe(true)

    const failOp = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: () => ({ status: 1, stdout: '', stderr: 'boom' }),
    })
    const failR = await failOp.execute(ctx)
    expect(failR.ok).toBe(false)
  })

  it('standard-remove：非法插件名 validate 即拒（防注入）', async () => {
    const op = makeStandardRemoveOp('evil; rm -rf' as unknown as PluginName, PROFILE, {
      validator: createValidator(), runCommand: stubRun(),
    })
    const r = await op.validate(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_VALIDATION')
  })

  it('standard-remove：dsh 未找到（ENOENT + 救援落空）→ validate 拒绝并给出修复指引', async () => {
    // V5.1：真实 spawnSync 的"命令不存在"是 status=null + error.code=ENOENT（非 127）
    const enoentRun = (cmd: string) =>
      cmd === 'dsh'
        ? { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }
        : { status: 0, stdout: '', stderr: '' }
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: enoentRun,
      resolveCommand: () => null,   // 救援也找不到
    })
    const r = await op.validate(ctx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_IO')
    expect(r.error.message).toContain('未找到')
    expect(r.error.message).toContain('skip_standard')
  })

  it('standard-remove V5.1：宿主 PATH 缺失但救援命中（绝对路径可执行）→ validate 通过', async () => {
    const calls: string[] = []
    const run = (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'dsh') return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }
      if (cmd.endsWith('/bin/dsh')) return { status: 0, stdout: '0.1.0-rc.6\n', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run,
      resolveCommand: () => ({ path: '/root/.nvm/versions/node/v24.1.0/bin/dsh', dir: '/root/.nvm/versions/node/v24.1.0/bin' }),
    })
    const r = await op.validate(ctx)
    expect(r.ok).toBe(true)
    // 救援确实以绝对路径复核了
    expect(calls).toContain('/root/.nvm/versions/node/v24.1.0/bin/dsh')
  })

  it('standard-remove V5.1：--version 退出码非 0（旗标行为差异）→ 二进制存在，validate 通过', async () => {
    // 旧逻辑 exitCode!==0 一律拒绝 —— 把"执行了但旗标不支持"误判为 CLI 缺失
    const run = (cmd: string) =>
      cmd === 'dsh'
        ? { status: 1, stdout: '', stderr: 'unknown option: --version\n' }
        : { status: 0, stdout: '', stderr: '' }
    const op = makeStandardRemoveOp(VICTIM, PROFILE, {
      validator: createValidator(), runCommand: run,
    })
    const r = await op.validate(ctx)
    expect(r.ok).toBe(true)
  })

  it('pnpm prune：cwd 指向 profile 目录', async () => {
    const calls: { cmd: string; args: readonly string[]; cwd?: string }[] = []
    const op = makePnpmPruneOp(PROFILE, c => c.resolver.profileDir(PROFILE), {
      validator: createValidator(),
      runCommand: (cmd, args, opts) => {
        calls.push({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    expect((await op.validate(ctx)).ok).toBe(true)
    expect((await op.execute(ctx)).ok).toBe(true)
    expect(calls.at(-1)!.cmd).toBe('pnpm')
    expect(calls.at(-1)!.args).toEqual(['store', 'prune'])
    expect(calls.at(-1)!.cwd).toBe(path.join(dshHome, 'profiles', PROFILE))
  })
})

describe('makeOperationFactory（策略编译）', () => {
  it('safe=4 项/插件；balanced=7 项；aggressive=9 项+全局收尾一次', () => {
    const mk = (strategy: 'safe' | 'balanced' | 'aggressive') => {
      const factory = makeOperationFactory({
        validator: createValidator(), runCommand: stubRun(), tempRoot,
      })
      return factory({
        plugins: [VICTIM], profile: PROFILE, strategy, dryRun: true, actor: 't',
      })
    }
    const safe = mk('safe')
    const balanced = mk('balanced')
    const aggressive = mk('aggressive')
    expect(safe.length).toBe(4)
    expect(balanced.length).toBe(7)
    expect(aggressive.length).toBe(9)   // 7 + prune + purge-temp
    expect(new Set(aggressive.map(o => o.id)).size).toBe(aggressive.length)  // id 无重复
  })

  it('多插件：每插件独立操作集', () => {
    const factory = makeOperationFactory({
      validator: createValidator(), runCommand: stubRun(), tempRoot,
    })
    const ops = factory({
      plugins: ['a-plugin' as PluginName, 'b-plugin' as PluginName],
      profile: PROFILE, strategy: 'safe', dryRun: true, actor: 't',
    })
    expect(ops.filter(o => o.id.includes('a-plugin')).length).toBe(4)
    expect(ops.filter(o => o.id.includes('b-plugin')).length).toBe(4)
  })

  it('STRATEGY_ACTIONS 单调扩展：aggressive ⊇ balanced ⊇ safe', () => {
    for (const a of STRATEGY_ACTIONS.safe) expect(STRATEGY_ACTIONS.balanced).toContain(a)
    for (const b of STRATEGY_ACTIONS.balanced) expect(STRATEGY_ACTIONS.aggressive).toContain(b)
  })
})

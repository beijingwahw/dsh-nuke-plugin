import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ProfileName } from '../src/contracts/base'
import { createHealthInspector } from '../src/engine/health-inspector'

let home: string

/** 桩命令运行器：dsh/pnpm 均可用 */
const stubOk = () => ({ status: 0, stdout: 'v1.0.0\n', stderr: '' })

function seedHealthy() {
  const pd = path.join(home, 'profiles', 'default')
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'))
  seedHealthy()
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const PROFILE = 'default' as ProfileName

function make(opts: Partial<Parameters<typeof createHealthInspector>[0]> = {}) {
  return createHealthInspector({
    dshHome: home, runCommand: stubOk as any, walUnfinished: () => [], ...opts,
  })
}

describe('HealthInspector', () => {
  it('健康环境：无 critical 失败，blocking=false，score=100', async () => {
    const r = await make().inspect(PROFILE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.blocking).toBe(false)
    expect(r.value.score).toBe(100)
    const groups = new Set(r.value.results.map(x => x.group))
    expect(groups.has('config')).toBe(true)
    expect(groups.has('dependency')).toBe(true)
    expect(groups.has('runtime')).toBe(true)
    expect(groups.has('residue')).toBe(true)
  })

  it('package.json 语法损坏 → critical → blocking=true 且 score 骤降', async () => {
    const pd = path.join(home, 'profiles', 'default')
    const pkgPath = path.join(pd, 'package.json')
    const backup = fs.readFileSync(pkgPath, 'utf-8')
    fs.writeFileSync(pkgPath, '{ broken json !!')
    try {
      const r = await make().inspect(PROFILE)
      if (!r.ok) throw new Error('inspect failed')
      expect(r.value.blocking).toBe(true)
      expect(r.value.results.some(x => x.severity === 'critical' && !x.passed)).toBe(true)
      expect(r.value.score).toBeLessThan(80)
    } finally {
      fs.writeFileSync(pkgPath, backup)
    }
  })

  it('孤立 bundle（bundles 有而 dependencies 无）→ warning 不阻断', async () => {
    const pd = path.join(home, 'profiles', 'default')
    const pkgPath = path.join(pd, 'package.json')
    const backup = fs.readFileSync(pkgPath, 'utf-8')
    fs.writeFileSync(pkgPath, JSON.stringify({
      dependencies: { foo: '^1.0.0' },
      dsh: { profile: { bundles: ['foo', 'ghost-bundle'] } },
    }, null, 2))
    try {
      const r = await make().inspect(PROFILE)
      if (!r.ok) throw new Error('inspect failed')
      const check = r.value.results.find(x => x.check === 'bundles 一致性')!
      expect(check.passed).toBe(false)
      expect(check.severity).toBe('warning')
      expect(r.value.blocking).toBe(false)
    } finally {
      fs.writeFileSync(pkgPath, backup)
    }
  })

  it('dsh CLI 未找到（ENOENT + 救援落空）→ warning 且不阻断；WAL 有未完成事务 → warning', async () => {
    // V5.1 语义修正：真实 spawnSync 的"命令不存在"是 status=null + error.code=ENOENT
    //（127 是 shell 的 not-found 码，spawnSync 无 shell 不会产生）；
    // 且 CLI 缺失不再 critical —— 残留清理/事务回滚不依赖外部 CLI，仅 standard-remove 需要（可 skip_standard）
    const stubEnoent = (cmd: string) =>
      cmd === 'dsh'
        ? { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }
        : { status: 0, stdout: '9.0.0\n', stderr: '' }
    const r = await make({
      runCommand: stubEnoent as any,
      resolveCommand: (cmd: string) => (cmd === 'pnpm' ? { path: '/usr/local/bin/pnpm', dir: '/usr/local/bin' } : null),
      walUnfinished: () => ['deadbeef'],
    }).inspect(PROFILE)
    if (!r.ok) throw new Error('inspect failed')
    const dsh = r.value.results.find(x => x.check === 'dsh CLI')!
    expect(dsh.passed).toBe(false)
    expect(dsh.severity).toBe('warning')
    expect(dsh.message).toContain('未找到')
    expect(dsh.fix).toContain('skip_standard')
    expect(r.value.blocking).toBe(false)   // CLI 缺失不再阻断清理事务
    const wal = r.value.results.find(x => x.check === 'WAL 未完成事务')!
    expect(wal.passed).toBe(false)
    expect(wal.severity).toBe('warning')
    expect(wal.fix).toBeTruthy()
  })

  it('V5.1 宿主 PATH 缺失但全局 bin 有 dsh（ENOENT + 救援命中）→ 可用并附救援路径提示', async () => {
    // 模拟 nvm 场景：用户 shell 有 dsh（rc 注入 PATH），宿主进程 PATH 没有它
    const probeCalls: string[] = []
    const r = await make({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 测试桩只按 cmd 分支，args/opts 参数仅对齐 runCommand 契约签名
      runCommand: ((cmd: string, _args: readonly string[], _opts: object) => {
        probeCalls.push(cmd)
        // 'dsh' 裸名 ENOENT；救援绝对路径可执行
        if (cmd === 'dsh') {
          return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }
        }
        if (cmd.endsWith('/bin/dsh')) {
          return { status: 0, stdout: '0.1.0-rc.6\n', stderr: '' }
        }
        return { status: 0, stdout: '9.0.0\n', stderr: '' }
      }) as any,
      resolveCommand: () => ({ path: '/root/.nvm/versions/node/v24.1.0/bin/dsh', dir: '/root/.nvm/versions/node/v24.1.0/bin' }),
    }).inspect(PROFILE)
    if (!r.ok) throw new Error('inspect failed')
    // 救援确实以绝对路径重试了（而非拿裸名空手而归）
    expect(probeCalls).toContain('/root/.nvm/versions/node/v24.1.0/bin/dsh')
    const dsh = r.value.results.find(x => x.check === 'dsh CLI')!
    expect(dsh.passed).toBe(true)
    expect(dsh.message).toContain('0.1.0-rc.6')
    expect(dsh.message).toContain('救援路径')
    expect(dsh.message).toContain('/root/.nvm')
    expect(r.value.blocking).toBe(false)
  })

  it('V5.1 --version 退出码非 0（旗标行为差异）→ 判定可用，不误报缺失', async () => {
    // 某些 CLI 版本不支持 --version 旗标（退出码非 0），但二进制确实存在
    const stub = (cmd: string) =>
      cmd === 'dsh'
        ? { status: 1, stdout: '', stderr: 'unknown option: --version\n' }
        : { status: 0, stdout: '9.0.0\n', stderr: '' }
    const r = await make({ runCommand: stub as any }).inspect(PROFILE)
    if (!r.ok) throw new Error('inspect failed')
    const dsh = r.value.results.find(x => x.check === 'dsh CLI')!
    expect(dsh.passed).toBe(true)
    expect(dsh.message).toContain('可用')
    expect(dsh.message).toContain('退出码 1')
  })

  it('V5.1 锁残留检测覆盖 V4/V5 锁协议目录（.nuke/locks/）与 V3 遗留锁', async () => {
    const locksDir = path.join(home, '.nuke', 'locks')
    fs.mkdirSync(locksDir, { recursive: true })
    fs.writeFileSync(path.join(locksDir, 'global.lock'), '{"version":1}')
    try {
      const r = await make().inspect(PROFILE)
      if (!r.ok) throw new Error('inspect failed')
      const lock = r.value.results.find(x => x.check === 'nuke 锁残留')!
      expect(lock.passed).toBe(false)
      expect(lock.message).toContain('global.lock')
      expect(lock.severity).toBe('warning')
      // 锁残留是 warning，不阻断
      expect(r.value.blocking).toBe(false)
    } finally {
      fs.rmSync(locksDir, { recursive: true, force: true })
    }
    // V3 遗留锁也纳入检测
    const legacy = path.join(home, '.nuke.lock')
    fs.writeFileSync(legacy, '{}')
    try {
      const r = await make().inspect(PROFILE)
      if (!r.ok) throw new Error('inspect failed')
      const lock = r.value.results.find(x => x.check === 'nuke 锁残留')!
      expect(lock.passed).toBe(false)
      expect(lock.message).toContain('.nuke.lock')
    } finally {
      fs.rmSync(legacy, { force: true })
    }
  })

  it('package.json 比 lockfile 新 → lockfile 新鲜度 warning', async () => {
    const pd = path.join(home, 'profiles', 'default')
    const lockPath = path.join(pd, 'pnpm-lock.yaml')
    const old = new Date(Date.now() - 86_400_000)
    fs.utimesSync(lockPath, old, old)
    const r = await make().inspect(PROFILE)
    if (!r.ok) throw new Error('inspect failed')
    const check = r.value.results.find(x => x.check === 'lockfile 新鲜度')!
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('warning')
  })
})

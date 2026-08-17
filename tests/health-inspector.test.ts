import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHealthInspector } from '../src/engine/health-inspector'
import type { ProfileName } from '../src/contracts/base'

let home: string

/** 桩命令运行器：dsh/pnpm 均可用 */
const stubOk = () => ({ status: 0, stdout: 'v1.0.0\n', stderr: '' })
const stubNoDsh = (cmd: string) =>
  cmd === 'dsh' ? { status: 127, stdout: '', stderr: 'not found' } : { status: 0, stdout: '9.0.0\n', stderr: '' }

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

  it('dsh CLI 不可用 → critical；WAL 有未完成事务 → warning', async () => {
    const r = await make({
      runCommand: stubNoDsh as any,
      walUnfinished: () => ['deadbeef'],
    }).inspect(PROFILE)
    if (!r.ok) throw new Error('inspect failed')
    expect(r.value.results.find(x => x.check === 'dsh CLI')!.passed).toBe(false)
    expect(r.value.results.find(x => x.check === 'dsh CLI')!.severity).toBe('critical')
    expect(r.value.blocking).toBe(true)
    const wal = r.value.results.find(x => x.check === 'WAL 未完成事务')!
    expect(wal.passed).toBe(false)
    expect(wal.severity).toBe('warning')
    expect(wal.fix).toBeTruthy()
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

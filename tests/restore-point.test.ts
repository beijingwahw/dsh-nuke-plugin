// tests/restore-point.test.ts — 配置还原点单测
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRestorePointManager } from '../src/engine/restore-point'

let tmp: string
let dshHome: string
let nukeRoot: string

/** 可注入时钟：每次调用时间 +1s，保证 createdAt 严格有序 */
let tick = 0
const clock = { now: () => new Date(Date.parse('2026-01-01T00:00:00Z') + tick++ * 1000) }

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-test-'))
  dshHome = path.join(tmp, '.dsh')
  nukeRoot = path.join(dshHome, '.nuke')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function manager() {
  return createRestorePointManager({ dshHome, nukeRoot, now: clock.now })
}

function seedWorkspace() {
  fs.rmSync(dshHome, { recursive: true, force: true })
  fs.mkdirSync(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'cordis.patch.yml'), '- id: keep\n')
  fs.writeFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), '{"name":"web"}')
  fs.writeFileSync(path.join(dshHome, 'profiles', 'web', 'pnpm-lock.yaml'), '# lock v1')
}

describe('还原点创建', () => {
  it('快照 home + profile 配置，meta 持久化', async () => {
    seedWorkspace()
    const rp = manager()
    const r = await rp.create({ actor: 'tester', reason: 'manual', profile: 'web' as any })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.id).toMatch(/^rp-/)
    expect(r.value.files.length).toBe(3)   // home patch + profile pkg + lock
    expect(fs.existsSync(path.join(nukeRoot, 'restore-points', r.value.id, 'meta.json'))).toBe(true)
  })

  it('完全无配置的空环境 → E_VALIDATION（零配置点拒绝）', async () => {
    seedWorkspace()
    fs.rmSync(dshHome, { recursive: true, force: true })   // 掏空整个 home
    const r = await manager().create({ actor: 't', reason: 'm', profile: 'web' as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_VALIDATION')
  })

  it('profile 不存在但 home 配置存在 → 仍快照 home 级配置', async () => {
    seedWorkspace()
    const r = await manager().create({ actor: 't', reason: 'm', profile: 'ghost' as any })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.files.length).toBe(1)   // 仅 home cordis.patch.yml
      expect(r.value.files[0]!.source).toContain('cordis.patch.yml')
    }
  })
})

describe('恢复', () => {
  it('配置被改坏后一键恢复原内容', async () => {
    seedWorkspace()
    const rp = manager()
    const created = await rp.create({ actor: 't', reason: 'pre-clean', profile: 'web' as any })
    expect(created.ok).toBe(true)

    // 模拟清理事故：配置被写坏
    fs.writeFileSync(path.join(dshHome, 'cordis.patch.yml'), 'CORRUPTED')
    fs.writeFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'CORRUPTED')

    const restored = await rp.restore(created.ok ? created.value.id : '')
    expect(restored.ok).toBe(true)
    expect(fs.readFileSync(path.join(dshHome, 'cordis.patch.yml'), 'utf-8')).toBe('- id: keep\n')
    expect(fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf-8')).toBe('{"name":"web"}')
  })

  it('路径穿越 / 不存在的 id → E_VALIDATION', async () => {
    seedWorkspace()
    const rp = manager()
    for (const bad of ['../../etc', 'bogus', '']) {
      const r = await rp.restore(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('E_VALIDATION')
    }
  })
})

describe('list 与 prune', () => {
  it('list 按 createdAt 降序；prune(1) 只留最新', async () => {
    seedWorkspace()
    const rp = manager()
    await rp.create({ actor: 't', reason: 'first', profile: 'web' as any })
    await rp.create({ actor: 't', reason: 'second', profile: 'web' as any })
    await rp.create({ actor: 't', reason: 'third', profile: 'web' as any })

    const all = rp.list()
    expect(all.length).toBe(3)
    expect(all[0]!.reason).toBe('third')
    expect(all[2]!.reason).toBe('first')

    const pruned = await rp.prune(1)
    expect(pruned.ok && pruned.value).toBe(2)
    expect(rp.list().length).toBe(1)
    expect(rp.list()[0]!.reason).toBe('third')
  })
})

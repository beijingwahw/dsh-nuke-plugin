// tests/policy.test.ts — 策略守卫单测
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createPolicyGuard } from '../src/infra/policy-guard'

let tmp: string
let policyFile: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'))
  policyFile = path.join(tmp, 'policy.json')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function writePolicy(p: unknown) {
  fs.writeFileSync(policyFile, JSON.stringify(p), 'utf-8')
}

function guard(hour = 12, freeBytes = 10 * 1024 ** 3) {
  return createPolicyGuard({
    policyFile,
    diskRoot: tmp,
    now: () => new Date(Date.parse(`2026-01-01T${String(hour).padStart(2, '0')}:00:00Z`)),
    freeBytesOf: () => freeBytes,
  })
}

describe('策略加载', () => {
  it('文件缺失 → 默认全放行（fail-open）', () => {
    const g = guard().load()
    expect(g.protectedPlugins.length).toBe(0)
    expect(g.blackout).toBeNull()
  })

  it('损坏 JSON → 同样回退默认', () => {
    fs.writeFileSync(policyFile, '{broken', 'utf-8')
    expect(guard().load().protectedPlugins.length).toBe(0)
  })

  it('未知字段忽略、类型不对回退 null', () => {
    writePolicy({ evil: 'x', maxPluginsPerTx: 'not-a-number' })
    const g = guard().load()
    expect((g as any).evil).toBeUndefined()
    expect(g.maxPluginsPerTx).toBeNull()
  })
})

describe('规则检查', () => {
  it('保护名单命中 → PROTECTED_PLUGIN', async () => {
    writePolicy({ protectedPlugins: ['@corp/critical'] })
    const r = guard().check({ plugins: ['@corp/critical' as any, 'ok-one' as any], estimatedBytes: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.length).toBe(1)
    expect(r.value[0]!.rule).toBe('PROTECTED_PLUGIN')
    expect(r.value[0]!.offending).toEqual(['@corp/critical'])
  })

  it('插件数超上限 → TOO_MANY_PLUGINS', () => {
    writePolicy({ maxPluginsPerTx: 2 })
    const r = guard().check({ plugins: ['a' as any, 'b' as any, 'c' as any], estimatedBytes: null })
    expect(r.ok && r.value.some(v => v.rule === 'TOO_MANY_PLUGINS')).toBe(true)
  })

  it('回收量超上限（plan 后）→ RECLAIM_CAP', () => {
    writePolicy({ maxReclaimBytesPerTx: 1024 })
    const r = guard().check({ plugins: ['a' as any], estimatedBytes: 2048 })
    expect(r.ok && r.value.some(v => v.rule === 'RECLAIM_CAP')).toBe(true)
  })

  it('磁盘余量不足 → LOW_FREE_DISK', () => {
    writePolicy({ minFreeDiskBytes: 100 * 1024 ** 3 })
    const r = guard(12, 1 * 1024 ** 3).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(r.ok && r.value.some(v => v.rule === 'LOW_FREE_DISK')).toBe(true)
  })

  it('黑窗期命中 → BLACKOUT_WINDOW', () => {
    writePolicy({ blackout: { startHour: 9, endHour: 18 } })
    const hit = guard(10).check({ plugins: ['a' as any], estimatedBytes: null })
    const miss = guard(20).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(hit.ok && hit.value.some(v => v.rule === 'BLACKOUT_WINDOW')).toBe(true)
    expect(miss.ok && miss.value.length).toBe(0)
  })

  it('跨零点黑窗（22-6）', () => {
    writePolicy({ blackout: { startHour: 22, endHour: 6 } })
    const night = guard(23).check({ plugins: ['a' as any], estimatedBytes: null })
    const dawn = guard(2).check({ plugins: ['a' as any], estimatedBytes: null })
    const day = guard(12).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(night.ok && night.value.length).toBe(1)
    expect(dawn.ok && dawn.value.length).toBe(1)
    expect(day.ok && day.value.length).toBe(0)
  })
})

describe('pre-hook 纵深防御', () => {
  it('保护名单插件 → veto；普通插件 → 放行', async () => {
    writePolicy({ protectedPlugins: ['@corp/critical'] })
    const hook = guard().asPreHook()
    expect(hook.id).toBe('policy-guard')
    expect(hook.timing).toBe('pre')
    expect(hook.priority).toBeLessThan(0)   // 闸门最先执行

    const blocked = await (hook.handler as any).run({ plugin: '@corp/critical' })
    expect(blocked).toEqual({ kind: 'veto', reason: expect.stringContaining('保护名单') })

    const allowed = await (hook.handler as any).run({ plugin: 'normal' })
    expect(allowed).toBeUndefined()
  })
})

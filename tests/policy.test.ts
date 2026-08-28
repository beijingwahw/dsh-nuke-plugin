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

// ─── V5：冻结窗规则（修复 V4 整合缺口：hitFreezeWindow 此前零调用） ──

describe('V5 冻结窗（FREEZE_WINDOW）', () => {
  it('命中冻结窗 → FREEZE_WINDOW；窗口外放行', () => {
    writePolicy({ freezeWindows: [{ startHour: 1, endHour: 5 }] })
    const hit = guard(3).check({ plugins: ['a' as any], estimatedBytes: null })
    const miss = guard(12).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(hit.ok && hit.value.some(v => v.rule === 'FREEZE_WINDOW')).toBe(true)
    expect(miss.ok && miss.value.length).toBe(0)
  })

  it('跨零点冻结窗（22-6）：夜/晨命中，白天放行', () => {
    writePolicy({ freezeWindows: [{ startHour: 22, endHour: 6 }] })
    const night = guard(23).check({ plugins: ['a' as any], estimatedBytes: null })
    const dawn = guard(5).check({ plugins: ['a' as any], estimatedBytes: null })
    const day = guard(12).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(night.ok && night.value.some(v => v.rule === 'FREEZE_WINDOW')).toBe(true)
    expect(dawn.ok && dawn.value.some(v => v.rule === 'FREEZE_WINDOW')).toBe(true)
    expect(day.ok && day.value.length).toBe(0)
  })

  it('多重窗口任一命中即拒绝，reason 透出到 message', () => {
    writePolicy({
      freezeWindows: [
        { startHour: 2, endHour: 3, reason: '数据库备份窗口' },
        { startHour: 10, endHour: 12 },
      ],
    })
    const r = guard(11).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(r.ok && r.value.length).toBe(1)
    if (r.ok && r.value[0]) {
      expect(r.value[0].rule).toBe('FREEZE_WINDOW')
      expect(r.value[0].message).toContain('10:00-12:00')
    }
    const r2 = guard(2).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(r2.ok && r2.value[0]?.message).toContain('数据库备份窗口')
  })

  it('freezeWindows 缺省/空列表 → 规则不启用（向后兼容）', () => {
    writePolicy({ freezeWindows: [] })
    const r = guard(0).check({ plugins: ['a' as any], estimatedBytes: null })
    expect(r.ok && r.value.length).toBe(0)
  })
})

// ─── V5：单事务文件数上限规则（修复 V4 整合缺口：fileCount 此前无人消费） ──

describe('V5 单事务文件数上限（TOO_MANY_FILES）', () => {
  it('fileCount 超上限 → TOO_MANY_FILES', () => {
    writePolicy({ maxFilesPerTx: 100 })
    const r = guard().check({ plugins: ['a' as any], estimatedBytes: null, fileCount: 101 })
    expect(r.ok && r.value.some(v => v.rule === 'TOO_MANY_FILES')).toBe(true)
  })

  it('fileCount 等于上限 → 放行（边界含等号）', () => {
    writePolicy({ maxFilesPerTx: 100 })
    const r = guard().check({ plugins: ['a' as any], estimatedBytes: null, fileCount: 100 })
    expect(r.ok && r.value.length).toBe(0)
  })

  it('fileCount 缺省/未统计（undefined/null）→ 跳过判定（向后兼容）', () => {
    writePolicy({ maxFilesPerTx: 1 })
    const r1 = guard().check({ plugins: ['a' as any], estimatedBytes: null })
    const r2 = guard().check({ plugins: ['a' as any], estimatedBytes: null, fileCount: null })
    expect(r1.ok && r1.value.length).toBe(0)
    expect(r2.ok && r2.value.length).toBe(0)
  })

  it('策略未配置 maxFilesPerTx → 跳过判定', () => {
    writePolicy({ protectedPlugins: [] })
    const r = guard().check({ plugins: ['a' as any], estimatedBytes: null, fileCount: 999_999 })
    expect(r.ok && r.value.length).toBe(0)
  })
})

describe('V5 违规附带 suggestion', () => {
  it('全部 7 种规则可同时触发，且每条 suggestion 均为含 policy.json 的可读建议', () => {
    writePolicy({
      protectedPlugins: ['@corp/critical'],
      maxPluginsPerTx: 1,
      maxFilesPerTx: 10,
      maxReclaimBytesPerTx: 1024,
      minFreeDiskBytes: 100 * 1024 ** 3,
      blackout: { startHour: 0, endHour: 23 },
      freezeWindows: [{ startHour: 0, endHour: 23 }],
    })
    const r = guard(12, 1 * 1024 ** 3).check({
      plugins: ['@corp/critical' as any, 'b' as any],
      estimatedBytes: 2048,
      fileCount: 11,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(new Set(r.value.map(v => v.rule))).toEqual(new Set([
      'PROTECTED_PLUGIN', 'TOO_MANY_PLUGINS', 'TOO_MANY_FILES', 'RECLAIM_CAP',
      'LOW_FREE_DISK', 'BLACKOUT_WINDOW', 'FREEZE_WINDOW',
    ]))
    for (const v of r.value) {
      expect(typeof v.suggestion).toBe('string')
      expect(v.suggestion!.length).toBeGreaterThan(4)
      expect(v.suggestion).toContain('policy.json')
    }
  })
})

// ─── V5：策略文件加载校验（非法配置绝不静默生效） ──

describe('V5 策略加载校验（loadValidated）', () => {
  it('合法配置 → issues 为空，字段原样生效', () => {
    writePolicy({ maxPluginsPerTx: 5, freezeWindows: [{ startHour: 1, endHour: 3 }], maxFilesPerTx: 10 })
    const report = guard().loadValidated()
    expect(report.issues.length).toBe(0)
    expect(report.policy.maxPluginsPerTx).toBe(5)
    expect(report.policy.maxFilesPerTx).toBe(10)
    expect(report.policy.freezeWindows?.length).toBe(1)
  })

  it('负数/小数上限 → 忽略为 null 并给出 issue 定位', () => {
    writePolicy({ maxPluginsPerTx: -1, maxFilesPerTx: 2.5 })
    const report = guard().loadValidated()
    expect(report.policy.maxPluginsPerTx).toBeNull()
    expect(report.policy.maxFilesPerTx).toBeNull()
    expect(report.issues.length).toBe(2)
    expect(report.issues.some(i => i.field === 'maxPluginsPerTx')).toBe(true)
    expect(report.issues.every(i => i.problem.length > 0)).toBe(true)
  })

  it('畸形冻结窗项（小时越界/非整数）→ 剔除并定位 freezeWindows[i]', () => {
    writePolicy({
      freezeWindows: [
        { startHour: 1, endHour: 3 },
        { startHour: 25, endHour: 6 },
        { startHour: 2.5, endHour: 6 },
      ],
    })
    const report = guard().loadValidated()
    expect(report.policy.freezeWindows?.length).toBe(1)
    expect(report.issues.length).toBe(2)
    expect(report.issues.some(i => i.field === 'freezeWindows[1]')).toBe(true)
    expect(report.issues.some(i => i.field === 'freezeWindows[2]')).toBe(true)
  })

  it('非数组 freezeWindows / 畸形 blackout → 整体忽略并给出 issue', () => {
    writePolicy({ freezeWindows: 'nope', blackout: { startHour: -1, endHour: 6 } })
    const report = guard().loadValidated()
    expect(report.policy.freezeWindows).toBeUndefined()
    expect(report.policy.blackout).toBeNull()
    expect(report.issues.length).toBe(2)
    expect(report.issues.some(i => i.field === 'freezeWindows')).toBe(true)
    expect(report.issues.some(i => i.field === 'blackout')).toBe(true)
  })

  it('非法项被忽略后不影响 check() 判定（-1 若被静默接受将误伤一切请求）', () => {
    writePolicy({ maxFilesPerTx: -1, maxPluginsPerTx: -3 })
    const r = guard().check({ plugins: ['a' as any], estimatedBytes: null, fileCount: 100 })
    expect(r.ok && r.value.length).toBe(0)
  })

  it('文件缺失 → 默认全放行且无 issue（fail-open 行为保持）', () => {
    fs.rmSync(policyFile, { force: true })
    const report = guard().loadValidated()
    expect(report.issues.length).toBe(0)
    expect(report.policy.protectedPlugins.length).toBe(0)
  })
})

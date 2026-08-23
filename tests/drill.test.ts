// tests/drill.test.ts — 混沌演习（崩溃注入 → recover 还原 → 证书签发）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createDrill } from '../src/engine/drill'

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function okv<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

describe('混沌演习（nuke_drill）', () => {
  it('第 1 步后崩溃 → recover() 完整还原 → 签发崩溃安全证书', async () => {
    const drill = createDrill({ nukeRoot: tmp })
    const report = okv(await drill.run({ afterStep: 1 }))
    expect(report.passed).toBe(true)
    expect(report.crashedAtStep).toBe(1)
    expect(report.checks.length).toBeGreaterThanOrEqual(9)
    expect(report.checks.every(c => c.passed)).toBe(true)
    expect(report.auditChainValid).toBe(true)
    expect(report.restoredFiles).toBe(1)   // 第 1 步已备份（第 2 步未执行）
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    // 证书要求的关键检查项逐一在场
    const names = report.checks.map(c => c.name)
    for (const expected of [
      '崩溃注入生效', '崩溃现场保真（半执行状态）', '独占锁悬挂（真实崩溃语义）',
      '崩溃恢复：事务回滚', '数据字节级还原', '配置引用还原',
      '审计链完整（hash chain）', 'WAL 无未终结事务', '新事务畅通（无永久阻塞）',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('第 2 步后崩溃（两步都已执行）→ 双备份全恢复', async () => {
    const drill = createDrill({ nukeRoot: tmp })
    const report = okv(await drill.run({ afterStep: 2 }))
    expect(report.passed).toBe(true)
    expect(report.restoredFiles).toBe(2)
    expect(report.auditChainValid).toBe(true)
  })

  it('非法注入点 → 校验拒绝', async () => {
    const drill = createDrill({ nukeRoot: tmp })
    for (const bad of [0, 3, 1.5, -1]) {
      const r = await drill.run({ afterStep: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('E_VALIDATION')
    }
  })

  it('演习现场保留在 .nuke/drill/ 且自动修剪（默认保留 5 次）', async () => {
    const drill = createDrill({ nukeRoot: tmp, keepRuns: 2 })
    for (let i = 0; i < 4; i++) {
      const r = await drill.run()
      expect(r.ok).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 5))   // runId 时间戳防撞
    }
    const runs = fs.readdirSync(path.join(tmp, 'drill'))
    expect(runs.length).toBeLessThanOrEqual(2)
  })
})

// tests/trend.test.ts — 历史趋势追踪器单测
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTrendTracker } from '../src/engine/trend-tracker'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-test-'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const DAY = 86_400_000
const T0 = Date.parse('2026-01-01T00:00:00Z')

/** 每次调用独立目录：测试间零串扰 */
let seq = 0
function tracker() {
  const dir = path.join(tmp, `history-${seq++}`)
  return { tracker: createTrendTracker({ historyDir: dir }), dir }
}

function snap(atMs: number, bytes: number, trigger: 'scan' | 'clean' | 'doctor' = 'scan') {
  return {
    at: new Date(atMs).toISOString(), trigger,
    profile: 'web' as any, bytesReclaimable: bytes, bytesFreed: 0,
    residualCount: 1, healthScore: 90,
  }
}

describe('趋势记录与分析', () => {
  it('空历史 → 零快照报告', async () => {
    const r = (await tracker().tracker.analyze())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.snapshotCount).toBe(0)
      expect(r.value.latest).toBeNull()
      expect(r.value.projected30dBytes).toBeNull()
    }
  })

  it('线性增长 → 斜率 = 字节/天，30 天外推正确', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + 1 * DAY, 2000))
    await t.record(snap(T0 + 2 * DAY, 3000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.round(r.value.bytesPerDay)).toBe(1000)
    expect(r.value.projected30dBytes).toBe(1000 + 1000 * 32)   // T0+32d 截距外推
    expect(r.value.anomaly.detected).toBe(false)
  })

  it('清理后回落 → 斜率为负（趋势向好）', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 5000))
    await t.record(snap(T0 + DAY, 1000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.bytesPerDay).toBeLessThan(0)
  })

  it('末值 3σ 突增 → 异常检出', async () => {
    const { tracker: t } = tracker()
    // 前四点完美线性，末点暴增 → 残差远超 3σ
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + DAY, 1100))
    await t.record(snap(T0 + 2 * DAY, 1200))
    await t.record(snap(T0 + 3 * DAY, 1300))
    await t.record(snap(T0 + 4 * DAY, 1_000_000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.anomaly.detected).toBe(true)
    expect(r.value.anomaly.detail).toContain('激增')
  })

  it('尾部半行容错：崩溃残留不破坏分析', async () => {
    const { tracker: t, dir } = tracker()
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + DAY, 2000))
    fs.appendFileSync(path.join(dir, 'trend.jsonl'), '{"at":"broken')
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.snapshotCount).toBe(2)
  })

  it('profile 过滤：只统计目标 profile', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 1000))
    await t.record({ ...snap(T0, 9999), profile: 'api' as any })
    const r = await t.analyze('web' as any)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.snapshotCount).toBe(1)
      expect(r.value.latest?.bytesReclaimable).toBe(1000)
    }
  })

  it('坏快照净化：非法日期/缺字段/非有限数整条剔除，不毒化回归', async () => {
    const { tracker: t, dir } = tracker()
    // 正常三点：完美线性 1000/day
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + 1 * DAY, 2000))
    await t.record(snap(T0 + 2 * DAY, 3000))
    // 三类坏条目直接写进 JSONL（模拟损坏/陈旧格式/篡改）
    fs.appendFileSync(path.join(dir, 'trend.jsonl'), [
      JSON.stringify({ ...snap(T0 + 3 * DAY, 999_999), at: 'not-a-date' }),   // 非法日期
      JSON.stringify({ trigger: 'scan', profile: 'web' }),                    // 缺数值字段
      `{"at":"${new Date(T0 + 3 * DAY).toISOString()}","trigger":"scan","profile":"web","bytesReclaimable":1e999,"bytesFreed":0,"residualCount":1,"healthScore":90}`,  // JSON.parse → Infinity
    ].join('\n') + '\n')
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.snapshotCount).toBe(3)                    // 坏条目全部剔除
    expect(Number.isFinite(r.value.bytesPerDay)).toBe(true)  // 绝不下发 NaN/Infinity
    expect(Math.round(r.value.bytesPerDay)).toBe(1000)
    expect(r.value.projected30dBytes).not.toBeNull()
    expect(Number.isFinite(r.value.projected30dBytes!)).toBe(true)
  })
})

// tests/disk-forecast.test.ts — 磁盘写满预测器单测（注入趋势 + 磁盘采样）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createDiskForecaster } from '../src/engine/disk-forecaster'
import { createTrendTracker } from '../src/engine/trend-tracker'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const DAY = 86_400_000
const T0 = Date.parse('2026-01-01T00:00:00Z')
const clock = { now: () => new Date(T0 + 10 * DAY) }

let seq = 0
function makeForecaster(
  disk: { free: number; total: number } | null,
  snapshots: { atMs: number; bytes: number }[],
) {
  const trend = createTrendTracker({ historyDir: path.join(tmp, `h-${seq++}`) })
  for (const s of snapshots) {
    trend.record({
      at: new Date(s.atMs).toISOString(), trigger: 'scan', profile: 'web' as any,
      bytesReclaimable: s.bytes, bytesFreed: 0, residualCount: 1, healthScore: -1,
    })
  }
  return createDiskForecaster({
    diskRoot: tmp, trend, clock,
    sampleDisk: () => disk,
  })
}

describe('磁盘写满预测', () => {
  it('日增 1GB / 余量 10GB → 10 天后写满，severity 视阈值而定', async () => {
    const f = makeForecaster(
      { free: 10 * 1024 ** 3, total: 100 * 1024 ** 3 },
      [
        { atMs: T0, bytes: 1 * 1024 ** 3 },
        { atMs: T0 + DAY, bytes: 2 * 1024 ** 3 },
        { atMs: T0 + 2 * DAY, bytes: 3 * 1024 ** 3 },
      ],
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.growthBytesPerDay).not.toBeNull()
    expect(r.value.daysUntilFull).toBeCloseTo(10, 0)
    expect(r.value.projectedFullAt).not.toBeNull()
    expect(r.value.severity).toBe('warning')   // 10 天 ∈ (3, 14]
    expect(r.value.recommendation).toContain('nuke_orphans')
  })

  it('倒计时 ≤3 天 → critical', async () => {
    const f = makeForecaster(
      { free: 2 * 1024 ** 3, total: 100 * 1024 ** 3 },
      [
        { atMs: T0, bytes: 1 * 1024 ** 3 },
        { atMs: T0 + DAY, bytes: 2 * 1024 ** 3 },
      ],
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.daysUntilFull).toBeCloseTo(2, 0)
      expect(r.value.severity).toBe('critical')
      expect(r.value.recommendation).toContain('nuke_doctor')
    }
  })

  it('净回收趋势（负斜率）→ 倒计时 null，状态 ok', async () => {
    const f = makeForecaster(
      { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      [
        { atMs: T0, bytes: 5 * 1024 ** 3 },
        { atMs: T0 + DAY, bytes: 1 * 1024 ** 3 },
      ],
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.daysUntilFull).toBeNull()
      expect(r.value.severity).toBe('ok')
    }
  })

  it('使用率 ≥95% 即使无增长数据也 critical', async () => {
    const f = makeForecaster({ free: 3 * 1024 ** 3, total: 100 * 1024 ** 3 }, [])
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.usedPct).toBe(97)
      expect(r.value.severity).toBe('critical')
    }
  })

  it('趋势样本不足 → 建议先积累数据', async () => {
    const f = makeForecaster({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 }, [
      { atMs: T0, bytes: 1000 },
    ])
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.growthBytesPerDay).toBeNull()
      expect(r.value.recommendation).toContain('趋势数据不足')
    }
  })

  it('statfs 不可用（null）→ 磁盘字段 null 但不报错', async () => {
    const f = makeForecaster(null, [])
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.freeBytes).toBeNull()
      expect(r.value.usedPct).toBeNull()
    }
  })
})

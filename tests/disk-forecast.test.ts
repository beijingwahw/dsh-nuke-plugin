// tests/disk-forecast.test.ts — 磁盘写满预测器单测（注入趋势 + 磁盘采样）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createDiskForecaster } from '../src/engine/disk-forecaster'
import { createTrendTracker } from '../src/engine/trend-tracker'
import { ok } from '../src/contracts/base'
import type { ITrendTracker } from '../src/contracts/trend.contract'

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

/** 可调趋势参数的构造器：halfLifeDays=Infinity → 均匀权重（经典 Theil-Sen），
 *  成对斜率分位可手工推导，断言可落到精确数值 */
function makeForecasterTuned(
  disk: { free: number; total: number } | null,
  snapshots: { atMs: number; bytes: number }[],
  halfLifeDays?: number,
) {
  const trend = createTrendTracker({
    historyDir: path.join(tmp, `h-${seq++}`),
    ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
  })
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

describe('磁盘写满预测 · 倒计时置信区间与悲观值分级', () => {
  const GB = 1024 ** 3

  it('完美线性数据 → 倒计时 CI 零宽度（low=点=high），默认配置下与旧版行为一致', async () => {
    const f = makeForecasterTuned(
      { free: 10 * GB, total: 100 * GB },
      [
        { atMs: T0, bytes: 1 * GB },
        { atMs: T0 + DAY, bytes: 2 * GB },
        { atMs: T0 + 2 * DAY, bytes: 3 * GB },
      ],
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 全部成对斜率相同 → 任何分位 = 点估计 → 零宽区间（诚实的零不确定性）
    expect(r.value.daysUntilFull).toBeCloseTo(10, 6)
    expect(r.value.daysUntilFullLow).toBeCloseTo(10, 6)
    expect(r.value.daysUntilFullHigh).toBeCloseTo(10, 6)
    expect(r.value.projectedFullAtLow).toBe(r.value.projectedFullAt)
    expect(r.value.projectedFullAtHigh).toBe(r.value.projectedFullAt)
    expect(r.value.severity).toBe('warning')          // 与旧版点估计口径完全一致
    expect(r.value.severityBasis).toContain('置信下界')
  })

  it('噪声数据 → 倒计时 CI 传播（low ≤ 点 ≤ high），悲观值分级上调严重度', async () => {
    // 局部速率 1, 0.5, 1, 0.5, 1 GB/天（均匀权重可手工推导）：
    // 成对斜率 15 个，中位 0.75、2.5% 分位 0.5、97.5% 分位 1 GB/天
    const vals = [0, 1, 1.5, 2.5, 3, 4].map(v => v * GB)
    const f = makeForecasterTuned(
      { free: 13 * GB, total: 40 * GB },
      vals.map((bytes, d) => ({ atMs: T0 + d * DAY, bytes })),
      Infinity,
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value
    // 倒数反演：free/斜率上界 ≤ free/点 ≤ free/斜率下界
    expect(v.daysUntilFull).toBeCloseTo(13 / 0.75, 1)
    expect(v.daysUntilFullLow).toBeCloseTo(13, 6)
    expect(v.daysUntilFullHigh).toBeCloseTo(26, 6)
    expect(v.daysUntilFullLow!).toBeLessThanOrEqual(v.daysUntilFull!)
    expect(v.daysUntilFull!).toBeLessThanOrEqual(v.daysUntilFullHigh!)
    // 点估计 17.3 天仅够 watch；悲观下界 13 天 ≤ 14 → 上调 warning
    expect(v.severity).toBe('warning')
    expect(v.severityBasis).toContain('置信下界')
    expect(v.severityBasis).toContain('≤ 14 天')
    expect(v.projectedFullAtLow).toBe(new Date(T0 + 10 * DAY + 13 * DAY).toISOString())
  })

  it('默认时间加权配置下同样满足 low ≤ 点 ≤ high（分位数单调性）', async () => {
    const vals = [0, 1, 1.5, 2.5, 3, 4].map(v => v * GB)
    const f = makeForecasterTuned(
      { free: 13 * GB, total: 40 * GB },
      vals.map((bytes, d) => ({ atMs: T0 + d * DAY, bytes })),
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value
    expect(v.daysUntilFullLow).not.toBeNull()
    expect(v.daysUntilFullHigh).not.toBeNull()
    expect(v.projectedFullAtLow).not.toBeNull()
    expect(v.projectedFullAtHigh).not.toBeNull()
    expect(v.daysUntilFullLow!).toBeLessThanOrEqual(v.daysUntilFull! + 1e-9)
    expect(v.daysUntilFull!).toBeLessThanOrEqual(v.daysUntilFullHigh! + 1e-9)
    // ISO 时刻与天数界同步有序（同格式 ISO 字符串的字典序 = 时间序）
    expect(v.projectedFullAtLow! <= v.projectedFullAt!).toBe(true)
    expect(v.projectedFullAt! <= v.projectedFullAtHigh!).toBe(true)
  })

  it('斜率 CI 下界 ≤0 → 乐观上界 null（诚实不可界）；悲观下界 ≤3 天 → critical', async () => {
    // 局部速率 -0.1, +0.3, -0.1, +0.2, -0.1 GB/天（均匀权重可手工推导）：
    // 成对斜率中位 0.05（点估计为正）、2.5% 分位 -0.1（CI 含"永不写满"）、
    // 97.5% 分位 0.265 GB/天
    const vals = [2, 1.9, 2.2, 2.1, 2.3, 2.2].map(v => v * GB)
    const f = makeForecasterTuned(
      { free: 0.75 * GB, total: 3 * GB },
      vals.map((bytes, d) => ({ atMs: T0 + d * DAY, bytes })),
      Infinity,
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value
    expect(v.growthBytesPerDay).not.toBeNull()
    expect(v.daysUntilFull).toBeCloseTo(15, 1)            // 点估计 0.75/0.05 = 15 天
    expect(v.daysUntilFullLow).toBeCloseTo(0.75 / 0.265, 2) // 悲观 2.83 天
    expect(v.daysUntilFullHigh).toBeNull()                // 斜率下界 -0.1 ≤ 0 → 乐观侧不可界
    expect(v.projectedFullAtHigh).toBeNull()
    expect(v.projectedFullAtLow).not.toBeNull()
    // 点估计 15 天只会 watch；悲观下界 2.83 天 ≤ 3 → 上调 critical
    expect(v.severity).toBe('critical')
    expect(v.severityBasis).toContain('≤ 3 天')
  })

  it('乐观界超出 Date 值域 → projectedFullAtHigh 为 null（不报错），数值界仍有效', async () => {
    // 局部速率 1, 1, 3e6 字节/天（均匀权重可手工推导）：
    // 成对斜率 2.5% 分位 = 1 字节/天 → 乐观倒计时 ≈ 1GB/1 ≈ 10^9 天，
    // 时间戳 > ±8.64e15 ms 越出 Date 值域（toISOString 会抛 RangeError）
    const f = makeForecasterTuned(
      { free: 1 * GB, total: 3 * GB },
      [0, 1, 2, 3_000_000].map((bytes, d) => ({ atMs: T0 + d * DAY, bytes })),
      Infinity,
    )
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value
    expect(v.daysUntilFull).toBeCloseTo(GB / 500_000.5, 0)  // 中位 500000.5 字节/天
    expect(v.daysUntilFullHigh).toBeCloseTo(GB, 0)          // ≈ 1.07e9 天（数值有效）
    expect(v.projectedFullAtHigh).toBeNull()                // 但日历时刻不可表达
    expect(v.daysUntilFullLow).toBeCloseTo(381.8, 0)        // 97.5% 分位 ≈ 2.81e6 字节/天
    expect(v.projectedFullAtLow).not.toBeNull()
  })

  it('契约型趋势桩（无 CI 字段）→ 优雅降级为点估计，severityBasis 标注口径', async () => {
    const stub: ITrendTracker = {
      record: async () => ok(undefined),
      analyze: async () => ok({
        snapshotCount: 2, firstAt: null, lastAt: null,
        bytesPerDay: 1 * GB, projected30dBytes: null,
        anomaly: { detected: false, detail: null }, latest: null,
      }),
    }
    const f = createDiskForecaster({
      diskRoot: tmp, trend: stub, clock,
      sampleDisk: () => ({ free: 10 * GB, total: 100 * GB }),
    })
    const r = await f.forecast()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.daysUntilFull).toBeCloseTo(10, 6)
    expect(r.value.daysUntilFullLow).toBeNull()
    expect(r.value.daysUntilFullHigh).toBeNull()
    expect(r.value.projectedFullAtLow).toBeNull()
    expect(r.value.projectedFullAtHigh).toBeNull()
    expect(r.value.severity).toBe('warning')
    expect(r.value.severityBasis).toContain('点估计')
  })
})

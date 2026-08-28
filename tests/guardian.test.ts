// tests/guardian.test.ts — 守卫者巡检单测（stub 采集器 + 容错验证）
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ok } from '../src/contracts/base'
import type { Clock, ProfileName, Result } from '../src/contracts/base'
import type { DoctorReport, IDoctor } from '../src/contracts/doctor.contract'
import { createDiskForecaster } from '../src/engine/disk-forecaster'
import { createGuardian } from '../src/engine/guardian'
import { createTrendTracker } from '../src/engine/trend-tracker'

let tmp: string
const clock: Clock = { now: () => new Date('2026-01-15T00:00:00Z') }

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function doctorStub(report: Partial<DoctorReport> = {}) {
  return {
    diagnose: async (): Promise<Result<DoctorReport>> =>
      ok({
        generatedAt: '', profile: 'web' as ProfileName, verdict: 'healthy',
        healthScore: 95, blocking: false, recommendations: [],
        totalReclaimableBytes: 0, ...report,
      }),
  } as unknown as IDoctor
}

function makeGuardian(opts: {
  disk: { free: number; total: number } | null
  snapshots?: { atMs: number; bytes: number }[]
  doctor?: IDoctor
  unfinished?: string[]
  suppressionWindowMs?: number
  clock?: Clock
}) {
  const trend = createTrendTracker({ historyDir: path.join(tmp, `t-${Math.random().toString(36).slice(2)}`) })
  for (const s of opts.snapshots ?? []) {
    void trend.record({
      at: new Date(s.atMs).toISOString(), trigger: 'scan', profile: 'web' as any,
      bytesReclaimable: s.bytes, bytesFreed: 0, residualCount: 1, healthScore: -1,
    })
  }
  const forecaster = createDiskForecaster({
    diskRoot: tmp, trend, clock: opts.clock ?? clock,
    sampleDisk: () => opts.disk,
  })
  return createGuardian({
    forecaster, trend,
    doctor: opts.doctor ?? doctorStub(),
    unfinishedTxIds: () => opts.unfinished ?? [],
    clock: opts.clock ?? clock,
    ...(opts.suppressionWindowMs !== undefined ? { suppressionWindowMs: opts.suppressionWindowMs } : {}),
  })
}


describe('守卫者巡检', () => {
  it('一切正常 → 零告警', async () => {
    const g = makeGuardian({ disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 } })
    const r = await g.patrol()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.alerts.length).toBe(0)
      expect(r.value.partialFailures.length).toBe(0)
      expect(r.value.doctor).not.toBeNull()
      expect(r.value.disk).not.toBeNull()
    }
  })

  it('磁盘 2 天后写满 → DISK_CRITICAL，建议 nuke_doctor', async () => {
    const g = makeGuardian({
      disk: { free: 2 * 1024 ** 3, total: 100 * 1024 ** 3 },
      snapshots: [
        { atMs: Date.parse('2026-01-01T00:00:00Z'), bytes: 1 * 1024 ** 3 },
        { atMs: Date.parse('2026-01-02T00:00:00Z'), bytes: 2 * 1024 ** 3 },
      ],
    })
    const r = await g.patrol()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const alert = r.value.alerts.find(a => a.kind === 'DISK_CRITICAL')
    expect(alert).toBeDefined()
    expect(alert!.severity).toBe('critical')
    expect(alert!.suggestedTool).toBe('nuke_doctor')
  })

  it('未终结事务 → UNFINISHED_TX critical，建议 nuke_recover', async () => {
    const g = makeGuardian({
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      unfinished: ['tx-abc'],
    })
    const r = await g.patrol()
    expect(r.ok).toBe(true)
    if (r.ok) {
      const alert = r.value.alerts.find(a => a.kind === 'UNFINISHED_TX')
      expect(alert?.suggestedTool).toBe('nuke_recover')
      expect(alert?.message).toContain('tx-abc')
    }
  })

  it('健康阻断 → HEALTH_BLOCKING；积压超阈值 → RECLAIM_BACKLOG', async () => {
    const g = makeGuardian({
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      doctor: doctorStub({ blocking: true, healthScore: 30, totalReclaimableBytes: 5 * 1024 ** 3 }),
    })
    const r = await g.patrol()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.alerts.some(a => a.kind === 'HEALTH_BLOCKING')).toBe(true)
    expect(r.value.alerts.some(a => a.kind === 'RECLAIM_BACKLOG')).toBe(true)
  })

  it('趋势突增异常 → TREND_ANOMALY', async () => {
    const g = makeGuardian({
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      snapshots: [
        { atMs: Date.parse('2026-01-01T00:00:00Z'), bytes: 1000 },
        { atMs: Date.parse('2026-01-02T00:00:00Z'), bytes: 1100 },
        { atMs: Date.parse('2026-01-03T00:00:00Z'), bytes: 1200 },
        { atMs: Date.parse('2026-01-04T00:00:00Z'), bytes: 1_000_000 },
      ],
    })
    const r = await g.patrol()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.alerts.some(a => a.kind === 'TREND_ANOMALY')).toBe(true)
    }
  })

  it('采集器失败 → 记入 partialFailures，其余采集照常', async () => {
    const g = createGuardian({
      forecaster: {
        forecast: async () => Promise.resolve({
          ok: false as const, error: { code: 'E_IO' as const, message: 'statfs 不可用' },
        }),
      },
      trend: createTrendTracker({ historyDir: path.join(tmp, `t2-${Math.random().toString(36).slice(2)}`) }),
      doctor: doctorStub(),
      unfinishedTxIds: () => [],
      clock,
    })
    const r = await g.patrol()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.partialFailures.some(p => p.startsWith('disk:'))).toBe(true)
    expect(r.value.doctor).not.toBeNull()   // 体检未受影响
    expect(r.value.alerts.length).toBe(0)
  })
})

describe('守卫者巡检（告警去重键 + 抑制窗口）', () => {
  it('同键告警窗口内不重发，记入 suppressedAlertKeys（可观测）', async () => {
    const g = makeGuardian({
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      unfinished: ['tx-abc'],
    })
    // 第一次：正常发出，附带去重键
    const r1 = await g.patrol()
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.value.alerts.length).toBe(1)
    expect(r1.value.alerts[0]!.dedupKey).toBe('UNFINISHED_TX:tx-abc')
    expect(r1.value.suppressedAlertKeys).toEqual([])
    // 第二次（固定 clock → 窗口内）：同键被抑制，不再重复打扰
    const r2 = await g.patrol()
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.value.alerts.length).toBe(0)
    expect(r2.value.suppressedAlertKeys).toEqual(['UNFINISHED_TX:tx-abc'])
  })

  it('窗口过期 → 同键重新发出；suppressionWindowMs=0 → 关闭抑制（旧行为）', async () => {
    // 可变 clock：t0 巡检 → 推进 7h（越过 6h 默认窗口）→ 再巡检
    let nowMs = Date.parse('2026-01-15T00:00:00Z')
    const mutableClock: Clock = { now: () => new Date(nowMs) }
    const g = makeGuardian({
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      unfinished: ['tx-a'],
      clock: mutableClock,
    })
    const r1 = await g.patrol()
    if (!r1.ok) return
    expect(r1.value.alerts.length).toBe(1)
    nowMs += 7 * 3600_000
    const r2 = await g.patrol()
    if (!r2.ok) return
    expect(r2.value.alerts.length).toBe(1)            // 窗口过期 → 重发
    expect(r2.value.suppressedAlertKeys).toEqual([])

    // 窗口 = 0：每次全报（升级前的逐次行为）
    const g0 = makeGuardian({
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      unfinished: ['tx-a'],
      suppressionWindowMs: 0,
    })
    const a1 = await g0.patrol()
    const a2 = await g0.patrol()
    if (!a1.ok || !a2.ok) return
    expect(a1.value.alerts.length).toBe(1)
    expect(a2.value.alerts.length).toBe(1)
    expect(a2.value.suppressedAlertKeys).toEqual([])
  })

  it('告警解除后复发 → 重新计时；事务集合变化 → 新键立即上报', async () => {
    const opts: { disk: { free: number; total: number }; unfinished: string[] } = {
      disk: { free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 },
      unfinished: ['tx-a'],
    }
    const g = makeGuardian(opts)
    // 发出 tx-a
    const r1 = await g.patrol()
    if (!r1.ok) return
    expect(r1.value.alerts.map(a => a.dedupKey)).toEqual(['UNFINISHED_TX:tx-a'])
    // 告警解除（事务已恢复）→ 无告警也无抑制
    opts.unfinished = []
    const r2 = await g.patrol()
    if (!r2.ok) return
    expect(r2.value.alerts.length).toBe(0)
    expect(r2.value.suppressedAlertKeys).toEqual([])
    // 复发（新事务 tx-b）：旧记忆已清除 → 立即上报
    opts.unfinished = ['tx-b']
    const r3 = await g.patrol()
    if (!r3.ok) return
    expect(r3.value.alerts.map(a => a.dedupKey)).toEqual(['UNFINISHED_TX:tx-b'])
    // 同集合重复 → 抑制；集合扩容（新的事务组合）→ 新键立即上报
    const r4 = await g.patrol()
    if (!r4.ok) return
    expect(r4.value.suppressedAlertKeys).toEqual(['UNFINISHED_TX:tx-b'])
    opts.unfinished = ['tx-a', 'tx-b']
    const r5 = await g.patrol()
    if (!r5.ok) return
    expect(r5.value.alerts.map(a => a.dedupKey)).toEqual(['UNFINISHED_TX:tx-a,tx-b'])
  })
})

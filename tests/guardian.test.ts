// tests/guardian.test.ts — 守卫者巡检单测（stub 采集器 + 容错验证）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createGuardian } from '../src/engine/guardian'
import { createTrendTracker } from '../src/engine/trend-tracker'
import { createDiskForecaster } from '../src/engine/disk-forecaster'
import { ok } from '../src/contracts/base'
import type { Clock, NukeError, ProfileName, Result } from '../src/contracts/base'
import type { DoctorReport, IDoctor } from '../src/contracts/doctor.contract'

let tmp: string
const clock: Clock = { now: () => new Date('2026-01-15T00:00:00Z') }

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function doctorStub(report: Partial<DoctorReport> = {}) {
  return {
    diagnose: async (): Promise<Result<DoctorReport, NukeError>> =>
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
}) {
  const trend = createTrendTracker({ historyDir: path.join(tmp, `t-${Math.random().toString(36).slice(2)}`) })
  for (const s of opts.snapshots ?? []) {
    trend.record({
      at: new Date(s.atMs).toISOString(), trigger: 'scan', profile: 'web' as any,
      bytesReclaimable: s.bytes, bytesFreed: 0, residualCount: 1, healthScore: -1,
    })
  }
  const forecaster = createDiskForecaster({
    diskRoot: tmp, trend, clock,
    sampleDisk: () => opts.disk,
  })
  return createGuardian({
    forecaster, trend,
    doctor: opts.doctor ?? doctorStub(),
    unfinishedTxIds: () => opts.unfinished ?? [],
    clock,
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

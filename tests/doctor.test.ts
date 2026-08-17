// tests/doctor.test.ts — NukeDoctor 编排器单测（stub 感知组件 + 真实评分器）
import { describe, expect, it } from 'vitest'
import { createDoctor } from '../src/engine/doctor'
import { createSeverityScorer } from '../src/engine/severity-scorer'
import { ok } from '../src/contracts/base'
import type { Clock, PluginName, ProfileName, Result } from '../src/contracts/base'
import type { NukeError } from '../src/contracts/base'
import type { ResidualEvidence } from '../src/contracts/scoring'
import type { HealthReport } from '../src/contracts/health.contract'
import type { OrphanReport, ScanEvent } from '../src/contracts/scan'

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00Z') }

function evidence(over: Partial<ResidualEvidence> = {}): ResidualEvidence {
  return {
    location: '/dsh/storages/victim' as any,
    kind: 'storage',
    description: 'storages 残留',
    sizeBytes: 1024,
    lastAccessedAt: null,
    referencedBy: [],
    suggestedAction: 'remove-storages',
    ...over,
  }
}

function healthStub(over: Partial<HealthReport> = {}) {
  return {
    inspect: async (_p: ProfileName): Promise<Result<HealthReport, NukeError>> =>
      ok({
        profile: 'web' as ProfileName, checkedAt: '', results: [],
        blocking: false, score: 95, ...over,
      }),
  }
}

function scannerStub(evidences: ResidualEvidence[]) {
  return {
    scan: async function* (): AsyncGenerator<ScanEvent> {
      for (const e of evidences) yield { type: 'found', evidence: e }
      yield { type: 'done', totalFound: evidences.length, bytesReclaimable: 0 }
    },
  }
}

function orphansStub(report: Partial<OrphanReport> = {}) {
  return {
    detect: async (): Promise<Result<OrphanReport, NukeError>> =>
      ok({
        orphanPluginDirs: [], orphanDataDirs: [], tempOrphans: [],
        totalReclaimableBytes: 0, ...report,
      }),
  }
}

function makeDoctor(evidences: ResidualEvidence[], health: Partial<HealthReport> = {}, orphans: Partial<OrphanReport> = {}) {
  return createDoctor({
    health: healthStub(health) as any,
    scanner: scannerStub(evidences) as any,
    orphans: orphansStub(orphans) as any,
    scorer: createSeverityScorer(),
    clock,
  })
}

describe('NukeDoctor 体检编排', () => {
  it('环境干净 + 高健康度 → healthy / 零处方', async () => {
    const r = await makeDoctor([], { score: 95 }).diagnose('web' as ProfileName)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.verdict).toBe('healthy')
    expect(r.value.recommendations.length).toBe(0)
    expect(r.value.totalReclaimableBytes).toBe(0)
  })

  it('仍被引用的残留 → P1 + 建议先 safe 摘引用', async () => {
    const ev = evidence({ referencedBy: ['other-plugin' as PluginName], kind: 'config-ref' })
    const r = await makeDoctor([ev]).diagnose('web' as ProfileName)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.verdict).toBe('attention')
    const rec = r.value.recommendations.find(x => x.evidence.location === ev.location)
    expect(rec?.priority).toBe(1)
    expect(rec?.suggestedStrategy).toBe('safe')
    expect(rec?.reason).toContain('other-plugin')
  })

  it('健康检查阻断 → verdict=critical', async () => {
    const r = await makeDoctor([], { blocking: true, score: 20 }).diagnose('web' as ProfileName)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.verdict).toBe('critical')
      expect(r.value.blocking).toBe(true)
    }
  })

  it('孤儿报告合并为处方：数据目录→balanced，TEMP→aggressive', async () => {
    const r = await makeDoctor([], {}, {
      orphanDataDirs: [{ path: '/dsh/storages/ghost' as any, sizeBytes: 2048 }],
      tempOrphans: [{ path: '/tmp/dsh-x' as any, sizeBytes: 512, ageDays: 12 }],
    }).diagnose('web' as ProfileName)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.totalReclaimableBytes).toBe(2048 + 512)
    const storage = r.value.recommendations.find(x => x.evidence.kind === 'storage')
    const temp = r.value.recommendations.find(x => x.evidence.kind === 'temp-orphan')
    expect(storage?.suggestedStrategy).toBe('balanced')
    expect(temp?.suggestedStrategy).toBe('aggressive')
  })

  it('处方排序：P1 在前，同级按分值降序', async () => {
    const referenced = evidence({
      location: '/dsh/a' as any, referencedBy: ['x' as PluginName], sizeBytes: 10,
    })
    const bigOrphan = evidence({ location: '/dsh/b' as any, sizeBytes: 100 * 1024 * 1024 })
    const smallOrphan = evidence({ location: '/dsh/c' as any, sizeBytes: 1024 })
    const r = await makeDoctor([smallOrphan, bigOrphan, referenced]).diagnose('web' as ProfileName)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const priorities = r.value.recommendations.map(x => x.priority)
    expect(priorities[0]).toBe(1)
    expect(priorities.slice(1)).toEqual([...priorities.slice(1)].sort((a, b) => a - b))
  })

  it('健康检查失败 → 错误原样传播', async () => {
    const doctor = createDoctor({
      health: { inspect: async () => Promise.resolve({ ok: false as const, error: { code: 'E_IO', message: 'boom' } }) } as any,
      scanner: scannerStub([]) as any,
      orphans: orphansStub() as any,
      scorer: createSeverityScorer(),
      clock,
    })
    const r = await doctor.diagnose('web' as ProfileName)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_IO')
  })
})

import { describe, expect, it } from 'vitest'
import { createSeverityScorer, DEFAULT_WEIGHTS, evidence } from '../src/engine/severity-scorer'
import type { PluginName } from '../src/contracts/base'

const NOW = new Date('2026-08-16T00:00:00Z')

const scorer = createSeverityScorer({ now: () => NOW })

describe('SeverityScorer — 四因子加权评分', () => {
  it('总分落在 [0,100]，breakdown 权重求和 = 配置权重和', () => {
    const s = scorer.score(evidence({
      location: '/home/u/.dsh/storages/foo', kind: 'storage',
      description: 'x', sizeBytes: 1024, suggestedAction: 'remove-storages',
    }))
    expect(s.total).toBeGreaterThanOrEqual(0)
    expect(s.total).toBeLessThanOrEqual(100)
    const weightSum = s.breakdown.reduce((acc, f) => acc + f.weight, 0)
    expect(weightSum).toBe(DEFAULT_WEIGHTS.type + DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.depth + DEFAULT_WEIGHTS.reference + DEFAULT_WEIGHTS.size)
    expect(s.breakdown.every(f => f.note.length > 0)).toBe(true) // 每个因子可解释
  })

  it('仍被引用 → reference 因子高 → 不可自动清理', () => {
    const s = scorer.score(evidence({
      location: '/home/u/.dsh/storages/foo', kind: 'storage',
      description: 'x', sizeBytes: 1024,
      referencedBy: ['bar' as PluginName, 'baz' as PluginName],
      lastAccessedAt: NOW, // 刚访问过 → recency≈0
      suggestedAction: 'remove-storages',
    }))
    const ref = s.breakdown.find(f => f.factor === 'reference')!
    expect(ref.raw).toBeCloseTo(0.8) // 0.7 + 0.1×(2-1)
    expect(s.safeToAutoClean).toBe(false)
  })

  it('config-ref 类型基础分远高于 temp-orphan', () => {
    const mk = (kind: 'config-ref' | 'temp-orphan') => scorer.score(evidence({
      location: '/tmp/dsh-abc', kind, description: 'x',
      sizeBytes: 10, lastAccessedAt: NOW, suggestedAction: 'purge-temp',
    }))
    expect(mk('config-ref').breakdown.find(f => f.factor === 'type')!.raw).toBeGreaterThan(
      mk('temp-orphan').breakdown.find(f => f.factor === 'type')!.raw)
  })

  it('陈旧孤儿（长期未访问 + 无引用）→ 低分且可自动清理', () => {
    const s = scorer.score(evidence({
      location: '/tmp/dsh-orphan-1', kind: 'temp-orphan',
      description: 'x', sizeBytes: 2048,
      lastAccessedAt: new Date(NOW.getTime() - 365 * 86_400_000), // 一年未动
      suggestedAction: 'purge-temp',
    }))
    const recency = s.breakdown.find(f => f.factor === 'recency')!
    expect(recency.raw).toBeGreaterThan(0.9)                       // 半衰期 30d → 衰减近 1
    expect(s.safeToAutoClean).toBe(true)
    expect(['info', 'low']).toContain(s.band)
  })

  it('atime 缺失 → recency 取中性 0.5，不崩溃', () => {
    const s = scorer.score(evidence({
      location: '/home/u/.dsh/storages/no-atime', kind: 'storage',
      description: 'x', sizeBytes: 0, lastAccessedAt: null,
      suggestedAction: 'remove-storages',
    }))
    expect(s.breakdown.find(f => f.factor === 'recency')!.raw).toBe(0.5)
  })

  it('体积对数缩放：1GB 封顶 1.0', () => {
    const s = scorer.score(evidence({
      location: '/home/u/.dsh/storages/huge', kind: 'storage',
      description: 'x', sizeBytes: 1024 ** 3,
      lastAccessedAt: NOW, suggestedAction: 'remove-storages',
    }))
    expect(s.breakdown.find(f => f.factor === 'size')!.raw).toBeCloseTo(1)
  })

  it('rank：按总分降序，平分按体积降序', () => {
    const ranked = scorer.rank([
      evidence({ location: '/a', kind: 'temp-orphan', description: '', sizeBytes: 100, lastAccessedAt: NOW, suggestedAction: 'purge-temp' }),
      evidence({ location: '/b', kind: 'storage', description: '', sizeBytes: 1024 ** 3, lastAccessedAt: new Date(NOW.getTime() - 365 * 86_400_000), suggestedAction: 'remove-storages' }),
      evidence({ location: '/c', kind: 'config-ref', description: '', sizeBytes: 10, lastAccessedAt: NOW, suggestedAction: 'clean-profile-patch' }),
    ])
    expect(ranked.length).toBe(3)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i]!.score.total).toBeLessThanOrEqual(ranked[i - 1]!.score.total)
    }
    expect(ranked[0]!.score.total).toBeGreaterThan(ranked[2]!.score.total)
  })
})

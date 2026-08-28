import { describe, expect, it } from 'vitest'

import type { PluginName } from '../src/contracts/base'
import { createSeverityScorer, DEFAULT_WEIGHTS, evidence } from '../src/engine/severity-scorer'

const NOW = new Date('2026-08-16T00:00:00Z')

const scorer = createSeverityScorer({ now: () => NOW })

describe('SeverityScorer — 五因子加权评分', () => {
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

describe('SeverityScorer — 部分权重覆盖 + 贡献度百分比明细', () => {
  /** 可手工推导的 55 分证据：storage(0.65×30) + 60 天未访问(0.75×20)
   *  + 12 段深路径(1×10) + 无引用(0×30) + 1GB(1×10) = 54.5 → round 55 */
  const ev55 = () => evidence({
    location: '/a/b/c/d/e/f/g/h/i/j/k/l', kind: 'storage',
    description: 'x', sizeBytes: 1024 ** 3,
    lastAccessedAt: new Date(NOW.getTime() - 60 * 86_400_000),
    suggestedAction: 'remove-storages',
  })

  it('贡献度百分比：口径 = 占已挣分数的份额，Σ≈100，零贡献因子 = 0%', () => {
    const s = scorer.score(ev55())
    expect(s.total).toBe(55)
    const pct = (f: string) => s.breakdown.find(x => x.factor === f)!.pctOfTotal
    // Σcontribution = 54.5：19.5/54.5 = 35.8%、15/54.5 = 27.5%、10/54.5 = 18.3%
    expect(pct('type')).toBeCloseTo(35.8, 1)
    expect(pct('recency')).toBeCloseTo(27.5, 1)
    expect(pct('depth')).toBeCloseTo(18.3, 1)
    expect(pct('size')).toBeCloseTo(18.3, 1)
    expect(pct('reference')).toBe(0)   // 无引用零贡献
    // 舍入后合计 ≈ 100（±0.5 容差）
    const sum = s.breakdown.reduce((acc, f) => acc + f.pctOfTotal, 0)
    expect(sum).toBeGreaterThan(99.5)
    expect(sum).toBeLessThan(100.5)
    // 百分比排序与贡献度排序一致（"分主要是谁贡献的"）
    expect(pct('type')).toBeGreaterThan(pct('recency'))
  })

  it('rank 返回的评分同样携带百分比明细', () => {
    const ranked = scorer.rank([ev55()])
    expect(ranked[0]!.score.breakdown.every(f => typeof f.pctOfTotal === 'number')).toBe(true)
  })

  it('单因子覆盖：reference 权重清零 → 贡献与百分比归零，其余因子沿用默认', () => {
    const tuned = createSeverityScorer({
      now: () => NOW,
      weights: { reference: 0 },
    })
    const s = tuned.score(evidence({
      location: '/home/u/.dsh/storages/foo', kind: 'storage',
      description: 'x', sizeBytes: 1024,
      referencedBy: ['bar' as PluginName],
      lastAccessedAt: NOW, suggestedAction: 'remove-storages',
    }))
    const ref = s.breakdown.find(f => f.factor === 'reference')!
    expect(ref.weight).toBe(0)
    expect(ref.contribution).toBe(0)
    expect(ref.pctOfTotal).toBe(0)
    expect(ref.raw).toBeCloseTo(0.7)   // raw 照算（证据本身没变）
    // 未覆盖的因子沿用默认权重
    expect(s.breakdown.find(f => f.factor === 'type')!.weight).toBe(DEFAULT_WEIGHTS.type)
    expect(s.breakdown.find(f => f.factor === 'size')!.weight).toBe(DEFAULT_WEIGHTS.size)
    // 权重清零不绕过引用安全闸：仍被引用的证据绝不自动清理（fail-closed）
    expect(s.safeToAutoClean).toBe(false)
  })

  it('bands 逐键合并：仅抬高 high 阈值，其余分带不变', () => {
    const tuned = createSeverityScorer({
      now: () => NOW,
      weights: { bands: { high: 55 } },
    })
    const sDefault = scorer.score(ev55())     // 55 分 ∈ [40, 60) → medium
    const sTuned = tuned.score(ev55())        // 55 ≥ 55 → high
    expect(sDefault.band).toBe('medium')
    expect(sTuned.band).toBe('high')
    expect(sTuned.total).toBe(sDefault.total) // 分数本身不受 bands 影响
  })

  it('整份完整权重入参（向后兼容）：与默认评分器逐位一致', () => {
    const full = createSeverityScorer({ now: () => NOW, weights: { ...DEFAULT_WEIGHTS } })
    expect(full.score(ev55()).total).toBe(scorer.score(ev55()).total)
    expect(full.score(ev55()).band).toBe(scorer.score(ev55()).band)
  })

  it('病态覆盖（全因子权重清零）→ total 0 / band info / 全因子 0%，无 NaN 出笼', () => {
    const zero = createSeverityScorer({
      now: () => NOW,
      weights: { type: 0, recency: 0, depth: 0, reference: 0, size: 0 },
    })
    const s = zero.score(ev55())
    expect(Number.isNaN(s.total)).toBe(false)
    expect(s.total).toBe(0)
    expect(s.band).toBe('info')
    expect(s.breakdown.every(f => f.pctOfTotal === 0)).toBe(true)
  })
})

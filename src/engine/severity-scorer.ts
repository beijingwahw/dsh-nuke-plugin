// src/engine/severity-scorer.ts — ISeverityScorer 实现：五因子加权评分（可解释）
// 模型：total = clamp(100 × Σ(weight_i × raw_i) / Σweight_i) ∈ [0,100]
// 每个因子返回 raw 值、权重、贡献度与人类可读注释，UI 可展开"为什么是这个分"。
import type { PluginName } from '../contracts/base'
import { fmtBytes } from '../contracts/base'
import type {
  FactorContribution, ISeverityScorer, ResidualEvidence, ResidualKind,
  ScoringWeights, SeverityBand, SeverityScore,
} from '../contracts/scoring'

export const DEFAULT_WEIGHTS: ScoringWeights = {
  type: 30,      // 残留类型基础风险
  recency: 20,   // 越久未访问越该清（分数越低=越安全清）
  depth: 10,     // 越深层越少被引用
  reference: 30, // 仍被引用 → 高危（删了会破坏运行）
  size: 10,      // 体量对数缩放（大目录回收价值高）
  recencyHalfLifeDays: 30,
  bands: { info: 0, low: 20, medium: 40, high: 60, critical: 80 },
}

/** 类型基础风险：config-ref 涉及配置改写最高危；temp 孤儿最低 */
const TYPE_BASE: Record<ResidualKind, number> = {
  'config-ref': 0.90,
  'node-modules': 0.45,
  'storage': 0.65,
  'attachment': 0.40,
  'temp-orphan': 0.15,
  'lockfile': 0.30,
  'unknown': 0.55, // 未知 = 不确定 = 按偏危险处理（防御性）
}

const DAY_MS = 86_400_000

export interface SeverityScorerOptions {
  readonly weights?: ScoringWeights
  readonly now?: () => Date
}

export function createSeverityScorer(options: SeverityScorerOptions = {}): ISeverityScorer {
  const w = options.weights ?? DEFAULT_WEIGHTS
  const now = options.now ?? (() => new Date())
  const weightSum = w.type + w.recency + w.depth + w.reference + w.size

  function bandOf(total: number): SeverityBand {
    const order: SeverityBand[] = ['critical', 'high', 'medium', 'low', 'info']
    for (const b of order) if (total >= w.bands[b]) return b
    return 'info'
  }

  function factorType(e: ResidualEvidence): FactorContribution {
    const raw = TYPE_BASE[e.kind]
    return {
      factor: 'type', weight: w.type, raw,
      contribution: w.type * raw,
      note: `类型 ${e.kind} 基础风险 ${raw.toFixed(2)}`,
    }
  }

  function factorRecency(e: ResidualEvidence): FactorContribution {
    let raw: number
    let note: string
    if (e.lastAccessedAt === null) {
      raw = 0.5
      note = 'atime 不可用 → 中性 0.50'
    } else {
      const ageDays = Math.max(0, (now().getTime() - e.lastAccessedAt.getTime()) / DAY_MS)
      // 指数衰减：从未访问（age→∞）raw→1（越陈旧越接近"纯垃圾"）
      raw = 1 - Math.pow(2, -ageDays / w.recencyHalfLifeDays)
      note = `${Math.round(ageDays)} 天未访问（半衰期 ${w.recencyHalfLifeDays}d）→ 衰减 ${raw.toFixed(2)}`
    }
    return { factor: 'recency', weight: w.recency, raw, contribution: w.recency * raw, note }
  }

  function factorDepth(e: ResidualEvidence): FactorContribution {
    const segs = e.location.replace(/\\/g, '/').split('/').filter(Boolean)
    // 以 4 段为基准根（如 /home/u/.dsh/storages），超出部分每层 +1/8
    const raw = Math.min(1, Math.max(0, segs.length - 4) / 8)
    return {
      factor: 'depth', weight: w.depth, raw,
      contribution: w.depth * raw,
      note: `路径深度 ${segs.length} 段 → ${raw.toFixed(2)}`,
    }
  }

  function factorReference(e: ResidualEvidence): FactorContribution {
    const n = e.referencedBy.length
    const raw = n === 0 ? 0 : Math.min(1, 0.7 + 0.1 * (n - 1))
    return {
      factor: 'reference', weight: w.reference, raw,
      contribution: w.reference * raw,
      note: n === 0 ? '无任何插件引用（孤儿）' : `仍被 ${n} 个插件引用: ${e.referencedBy.join(', ')}`,
    }
  }

  function factorSize(e: ResidualEvidence): FactorContribution {
    // 对数缩放：1KB→0.33 1MB→0.67 1GB→1.0（以 1GB 封顶）
    const raw = Math.min(1, Math.log10(1 + Math.max(0, e.sizeBytes)) / 9)
    return {
      factor: 'size', weight: w.size, raw,
      contribution: w.size * raw,
      note: `${fmtBytes(e.sizeBytes)} → 对数缩放 ${raw.toFixed(2)}`,
    }
  }

  const scorer: ISeverityScorer = {
    score(evidence: ResidualEvidence): SeverityScore {
      const breakdown = [
        factorType(evidence), factorRecency(evidence), factorDepth(evidence),
        factorReference(evidence), factorSize(evidence),
      ]
      const total = Math.round(
        Math.max(0, Math.min(100, (100 * breakdown.reduce((s, f) => s + f.contribution, 0)) / weightSum)),
      )
      return {
        total,
        band: bandOf(total),
        breakdown,
        // 自动清理安全 = 无引用 且 分数未到 high（high/critical 需人工裁决）
        safeToAutoClean: evidence.referencedBy.length === 0 && total < w.bands.high,
      }
    },

    rank(evidences) {
      return evidences
        .map(e => ({ ...e, score: scorer.score(e) }))
        .sort((a, b) => b.score.total - a.score.total || b.sizeBytes - a.sizeBytes)
    },
  }
  return scorer
}

/** 便捷构造：测试与调用方组装 ResidualEvidence 用 */
export function evidence(partial: {
  location: string
  kind: ResidualKind
  description: string
  sizeBytes?: number
  lastAccessedAt?: Date | null
  referencedBy?: readonly PluginName[]
  suggestedAction: ResidualEvidence['suggestedAction']
}): ResidualEvidence {
  return {
    location: partial.location as ResidualEvidence['location'],
    kind: partial.kind,
    description: partial.description,
    sizeBytes: partial.sizeBytes ?? 0,
    lastAccessedAt: partial.lastAccessedAt === undefined ? null : partial.lastAccessedAt,
    referencedBy: partial.referencedBy ?? [],
    suggestedAction: partial.suggestedAction,
  }
}

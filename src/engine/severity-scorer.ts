// src/engine/severity-scorer.ts — ISeverityScorer 实现：五因子加权评分（可解释）
// 模型：total = clamp(100 × Σ(weight_i × raw_i) / Σweight_i) ∈ [0,100]
// 每个因子返回 raw 值、权重、贡献度与人类可读注释，UI 可展开"为什么是这个分"。
//
// 本轮升级（部分权重覆盖 + 贡献度百分比明细；契约字段语义不变，新输出经
// SeverityScoreDetail / FactorContributionDetail 以协变子类型暴露）：
//
//   1. 部分权重覆盖：weights 从"整份 ScoringWeights"放宽为部分覆盖 ——
//      只调想调的因子（如 aggressive 策略仅抬 reference），其余沿用
//      DEFAULT_WEIGHTS；嵌套 bands 逐键合并（如仅抬高 high 阈值）。
//      完整权重对象仍是合法入参（宽化向后兼容）。Σweight ≤ 0 的病态
//      覆盖以 0 分收场（fail-closed），绝不泄漏 NaN 进 total/band。
//
//   2. 贡献度百分比：每个因子附带 pctOfTotal（占已挣分数的百分比，
//      分母 = Σcontribution）—— "这个分主要是谁贡献的"一眼可见，
//      排序/UI 高亮共用同一口径。Σcontribution = 0 → 全因子 0%。
import type { PluginName } from '../contracts/base'
import { fmtBytes } from '../contracts/base'
import type {
  FactorContribution, ISeverityScorer, ResidualEvidence, ResidualKind,
  ScoringWeights, SeverityBand, SeverityScore,
} from '../contracts/scoring'

// ─── 引擎层扩展类型（contracts 只读；新输出字段在此定义并导出） ──

/** 因子贡献度详情：新增"占总分的百分比"（贡献度明细） */
export interface FactorContributionDetail extends FactorContribution {
  /** 该因子贡献占已挣分数的百分比（%，四舍五入 1 位小数）；
   *  Σcontribution = 0（零分或病态权重）→ 全因子 0 */
  readonly pctOfTotal: number
}

/** 评分详情：breakdown 携带贡献度百分比（契约字段语义不变） */
export interface SeverityScoreDetail extends SeverityScore {
  readonly breakdown: readonly FactorContributionDetail[]
}

/** ISeverityScorer 的引擎层扩展：score/rank 返回详情（协变返回类型） */
export interface ISeverityScorerDetail extends ISeverityScorer {
  score(evidence: ResidualEvidence): SeverityScoreDetail
  rank(evidences: readonly ResidualEvidence[]):
    readonly (ResidualEvidence & { score: SeverityScoreDetail })[]
}

/** 部分权重覆盖：因子级可省略（省略 = 沿用默认）；bands 逐键合并 */
export type WeightOverrides =
  Omit<Partial<ScoringWeights>, 'bands'> & {
    readonly bands?: Partial<Record<SeverityBand, number>>
  }

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
  /** 部分权重覆盖（省略的因子沿用 DEFAULT_WEIGHTS；bands 逐键合并） */
  readonly weights?: WeightOverrides
  readonly now?: () => Date
}

export function createSeverityScorer(options: SeverityScorerOptions = {}): ISeverityScorerDetail {
  // 深合并：因子级 + bands 键级。整份 ScoringWeights 也是合法覆盖（向后兼容）
  const w: ScoringWeights = {
    ...DEFAULT_WEIGHTS,
    ...options.weights,
    bands: { ...DEFAULT_WEIGHTS.bands, ...options.weights?.bands },
  }
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

  const scorer: ISeverityScorerDetail = {
    score(evidence: ResidualEvidence): SeverityScoreDetail {
      const base = [
        factorType(evidence), factorRecency(evidence), factorDepth(evidence),
        factorReference(evidence), factorSize(evidence),
      ]
      const sumContribution = base.reduce((s, f) => s + f.contribution, 0)
      // 贡献度百分比：占"已挣分数"的份额（分母 = Σcontribution，与 total 同源）。
      // Σcontribution ≤ 0（零分或病态负权重）→ 全 0：不给无意义的负百分比
      const breakdown: FactorContributionDetail[] = base.map(f => ({
        ...f,
        pctOfTotal: sumContribution > 0
          ? Math.round((1000 * f.contribution) / sumContribution) / 10
          : 0,
      }))
      // Σweight ≤ 0 的病态覆盖：分母退化为 1 → 分数收敛（fail-closed，防 NaN 出笼）
      const denom = weightSum > 0 ? weightSum : 1
      const total = Math.round(
        Math.max(0, Math.min(100, (100 * sumContribution) / denom)),
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

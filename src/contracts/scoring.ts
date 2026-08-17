// contracts/scoring.ts — 子系统一：残留严重程度评分引擎
// 替换现有硬编码 severity(2/3/5)。四因子加权模型，输出可解释：
//   total = clamp(Σ factor_i × weight_i) ∈ [0,100]
// 每个因子贡献度随分数一并返回，UI 可展开"为什么是这个分"。

import type { AbsolutePath, PluginName } from './base'

/** 残留物证据 —— 扫描器的统一产出（替代旧 Residual） */
export interface ResidualEvidence {
  readonly location: AbsolutePath
  readonly kind: ResidualKind
  readonly description: string
  readonly sizeBytes: number
  /** 最近访问时间；null = 文件系统不提供 atime */
  readonly lastAccessedAt: Date | null
  /** 仍引用此路径的插件（来自依赖图）；空数组 = 孤儿 */
  readonly referencedBy: readonly PluginName[]
  readonly suggestedAction: import('./base').CleanAction
}

export type ResidualKind =
  | 'config-ref'      // patch/workspace yaml 中的引用
  | 'node-modules'
  | 'storage'
  | 'attachment'
  | 'temp-orphan'     // TEMP 中的孤儿
  | 'lockfile'
  | 'unknown'

export type SeverityBand = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface FactorContribution {
  readonly factor: 'type' | 'recency' | 'depth' | 'reference' | 'size'
  readonly weight: number      // 该因子权重（配置可调）
  readonly raw: number         // 因子原始值归一 [0,1]
  readonly contribution: number // weight × raw
  readonly note: string        // 人类可读：如 "90 天未访问 → 衰减 0.92"
}

export interface SeverityScore {
  readonly total: number                          // 0-100
  readonly band: SeverityBand                     // 分级阈值可配置
  readonly breakdown: readonly FactorContribution[] // 可解释性
  readonly safeToAutoClean: boolean               // 分数 + 引用状态共同判定
}

/** 评分配置 —— 策略引擎可按 safe/balanced/aggressive 注入不同权重 */
export interface ScoringWeights {
  readonly type: number       // 残留类型基础权重（config-ref 高危 > temp）
  readonly recency: number    // atime 时间衰减：越久未用越该清
  readonly depth: number      // 目录层级风险：越深越少被引用
  readonly reference: number  // 引用状态：referencedBy 非空 → 大幅加分（危险）
  readonly size: number       // 体量对数缩放
  /** 半衰期（天）：atime 衰减用 */
  readonly recencyHalfLifeDays: number
  readonly bands: Readonly<Record<SeverityBand, number>> // 下限阈值
}

export interface ISeverityScorer {
  score(evidence: ResidualEvidence): SeverityScore
  /** 批量评分并按 total 降序；UI 展示与决策排序共用 */
  rank(evidences: readonly ResidualEvidence[]): readonly (ResidualEvidence & { score: SeverityScore })[]
}

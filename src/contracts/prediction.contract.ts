// contracts/prediction.contract.ts — V5.4 先知问责制（预测存证 / 对账计分）
// 核心思想：预测若不可证伪，就与巫术无异。
//
// v5.2 让先知"会算"（帕累托计划合成），v5.3 让先知"会诊"（失败模式
// 处方），v5.4 让先知"可被问责"：
//
//   1. 预测存证 —— 事务引擎在 commit 执行前，把逐步预测（成功率/耗时）
//      写入 hash chain 审计。预测时刻先于结局时刻（时间戳为证），
//      事后任何篡改都会被 nuke_verify 检出 —— 预测在结构上不可抵赖。
//   2. 对账计分 —— 已终结事务的预测 vs 实际结局，用 Brier 评分 +
//      技能分（对照"永远预测基准率"的无技能基线）对账。先知必须
//      公开自己的历史成绩单，用户才知道"这个 81% 有多可信"。
//
// 统计口径（Brier score）：
//   步骤/事务级 Brier = (p − y)²，y ∈ {0,1}。0=完美，0.25=硬币。
//   技能分 = 1 − Brier/Brier_baseline，Brier_baseline = ȳ(1−ȳ)
//   （ȳ=实际结局基准率；基线退化为 0 时技能分无定义 → null）。
//   技能分 > 0 = 优于无技能基线；≤ 0 = 还不如直接报基准率。
import type { TxId } from './base'

/** 单步预测（commit 前存证进 hash chain —— 事后不可篡改） */
export interface StepPrediction {
  readonly index: number
  readonly operationId: string
  readonly action: string
  /** plan/dryRun 缓存的预估回收量（直连 commit 未预演时可能为 null） */
  readonly estimatedBytes: number | null
  /** 该步成功概率（重试感知口径 —— 与引擎实际执行语义对齐） */
  readonly predictedP: number
  /** 该步预计耗时（ms，动作历史时间加权中位；零历史 = null 诚实留白） */
  readonly predictedDurationMs: number | null
}

/** 事务级预测存证（审计条目 detail 的规范形态） */
export interface PredictionRecord {
  readonly steps: readonly StepPrediction[]
  /** 事务全成概率 = ∏ predictedP（Saga 语义） */
  readonly txSuccessProbability: number
  /** 混沌演习事务（人为注入崩溃）—— 对账时跳过，不污染战绩 */
  readonly drill?: boolean
}

/** 已对账事务的战绩条目 */
export interface TxScorecardEntry {
  readonly txId: TxId
  /** 预测存证时间（先于结局时间 —— 不可抵赖性的时间戳证据） */
  readonly predictedAt: string
  readonly predictedP: number
  /** 实际结局：1=committed，0=rolled-back */
  readonly actual: 0 | 1
  /** 该事务的 Brier 贡献 (p − y)² */
  readonly brier: number
  readonly drill: boolean
}

/** 耗时比（actual/predicted）分布摘要：>1 = 实际比预测慢 */
export interface DurationRatioSummary {
  readonly samples: number
  readonly p50: number
  readonly p90: number
}

/** 预测战绩总账（先知问责制的输出） */
export interface PredictionScorecard {
  /** 已对账事务数（跳过未终结/演习事务） */
  readonly scoredTx: number
  /** 已对账步骤数（回滚后未执行到的步骤无结局，不计入） */
  readonly scoredSteps: number
  /** 事务级 Brier 分（0 完美 / 0.25 硬币）；零样本 = null */
  readonly brierTx: number | null
  /** 步骤级 Brier 分；零样本 = null */
  readonly brierSteps: number | null
  /** 无技能基线 Brier（永远预测基准率 ȳ）；零样本或 ȳ∈{0,1} 退化 = null */
  readonly brierBaseline: number | null
  /** 技能分 = 1 − brierTx/brierBaseline（>0 优于基线）；无定义 = null */
  readonly skillScore: number | null
  /** 耗时比分布；样本不足 = null */
  readonly durationRatio: DurationRatioSummary | null
  /** 最近对账明细（新→旧，带上限） */
  readonly recent: readonly TxScorecardEntry[]
}

/** 预测评分级：从审计链对账已存证的预测 */
export interface IPredictionScorer {
  scorecard(): Promise<PredictionScorecard>
}

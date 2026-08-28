// contracts/prediction.contract.ts — V5.4 先知问责制（预测存证 / 对账计分）
// 核心思想：预测若不可证伪，就与巫术无异。
//
// v5.2 让先知"会算"（帕累托计划合成），v5.3 让先知"会诊"（失败模式
// 处方），v5.4 让先知"可被问责"，v5.5 让先知"自我纠偏"：
//
//   1. 预测存证 —— 事务引擎在 commit 执行前，把逐步预测（成功率/耗时）
//      写入 hash chain 审计。预测时刻先于结局时刻（时间戳为证），
//      事后任何篡改都会被 nuke_verify 检出 —— 预测在结构上不可抵赖。
//   2. 对账计分 —— 已终结事务的预测 vs 实际结局，用 Brier 评分 +
//      技能分（对照"永远预测基准率"的无技能基线）对账。先知必须
//      公开自己的历史成绩单，用户才知道"这个 81% 有多可信"。
//   3. 自我校准（V5.5）—— 对账不止打分，还驱动再学习：从"已对账的
//      (预测, 结局) 对"学习系统性偏差（logit 位移），修正未来预测。
//      预测 → 存证 → 对账 → 再学习 → 更准的预测 —— 收敛闭环。
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
  /** V5.5 自我校准：从对账证据学习的偏差修正（证据不足 = null） */
  readonly calibration: CalibrationShift | null
  /** 最近对账明细（新→旧，带上限） */
  readonly recent: readonly TxScorecardEntry[]
}

/** V5.5 自我校准：从已对账 (预测, 结局) 对学习的系统性偏差修正。
 *
 *  口径 —— Platt scaling 的截距版（logit 位移）：
 *    δ_raw = logit(actualRate) − logit(meanPredicted)
 *    δ     = δ_raw · w，w = evidence/(evidence+K)（证据权重收缩：
 *            对账样本 << K 时几乎不动，≥ K 后自身证据过半）
 *    应用：logit(p′) = logit(p) + δ
 *
 *  为何是全局单参数而非按动作分层：按动作分层的对账样本过稀（一个
 *  动作每事务只出 1-2 个已对账步），单参数位移是最抗过拟合的形态；
 *  且可靠性模型的贝叶斯收缩已处理动作层异质性，校准层只修"系统性"
 *  偏差（如设计先验与真实环境的整体落差）—— 两层职责不重叠。 */
export interface CalibrationShift {
  /** logit 位移（已按证据权重收缩）。>0 = 历史预测过保守（实际比预测
   *  好）→ 拉高未来预测；<0 = 过自信（实际比预测差）→ 拉低 */
  readonly delta: number
  /** 已对账步骤对数（证据量；≥ 5 才产出修正） */
  readonly evidence: number
  /** 已对账步骤的平均预测概率（存证口径） */
  readonly meanPredicted: number
  /** 实际成功率（Laplace +1/+2 收缩 —— 全成败时避免 logit 发散） */
  readonly actualRate: number
  /** 证据权重 = evidence/(evidence+K)：修正强度的事实标注 */
  readonly selfWeight: number
  /** 耗时修正因子（中位 actual/predicted，向 1 收缩）；样本不足 = null */
  readonly durationFactor: number | null
  /** 耗时比对账样本数 */
  readonly durationSamples: number
}

/** 应用概率校准：logit(p) + δ → p′，钳制到 [0.001, 0.999]。
 *  shift 为 null / p 退化（≤0 或 ≥1）→ 原样返回（恒等）。 */
export function applyCalibrationShift(p: number, shift: CalibrationShift | null): number {
  if (shift === null || !Number.isFinite(p) || p <= 0 || p >= 1) return p
  const z = Math.log(p / (1 - p)) + shift.delta
  const corrected = 1 / (1 + Math.exp(-z))
  return Math.min(0.999, Math.max(0.001, corrected))
}

/** 应用耗时校准：ms × durationFactor。shift 为 null / 因子缺失 /
 *  ms 非正 → 原样返回。 */
export function applyDurationCorrection(ms: number, shift: CalibrationShift | null): number {
  if (shift === null || shift.durationFactor === null) return ms
  if (!Number.isFinite(ms) || ms <= 0) return ms
  return ms * shift.durationFactor
}

/** 预测评分级：从审计链对账已存证的预测 */
export interface IPredictionScorer {
  scorecard(): Promise<PredictionScorecard>
}

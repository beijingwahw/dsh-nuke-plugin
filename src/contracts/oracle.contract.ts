// contracts/oracle.contract.ts — 先知引擎（后果推演）
// dry-run 回答"我打算做什么"；先知回答"做了会发生什么、有多大把握"。
//
// 概率模型（与引擎语义严格对齐）：
//   事务成功率   P = ∏ p_i     —— Saga 语义：任一步失败即整体回滚，
//                               全成或全无，故成功率是逐步概率的连乘
//   期望回收     E = P × Σ(b_i·c_i^p50)   —— b_i 为 preview 预估，
//                               c 为校准中位数（历史 actual/estimated）
//   回收区间     [Q10, Q90]    —— 成功前提下的校准分位区间（诚实标注口径）
//   最脆弱步骤   argmax (1-p_i)·exposure_i   —— 敞口 = 该步起的预估总量
//   回滚深度     Σ i·P(首败于 i)  —— 失败时的期望补偿步数
import type { CleanAction, CleanStrategy, PluginName, ProfileName, Result } from './base'
import type { CalibrationSummary } from './reliability.contract'

export type OracleConfidence = 'high' | 'medium' | 'low'

export interface OracleStep {
  readonly index: number
  readonly action: CleanAction
  readonly operationId: string
  readonly summary: string
  /** preview 预估回收字节（与 dry-run 同源同值） */
  readonly estimatedBytes: number
  /** 该步骤成功率（贝叶斯后验，收缩后） */
  readonly successProbability: number
  /** 自数据权重 0-1（来自可靠性模型）：0 = 该动作零历史，成功率纯为先验收缩
   *  （冷启动标注 —— 与置信度共同表达"这个数从哪来"） */
  readonly selfWeight?: number
  /** 该步失败将作废的预估回收量（自身 + 后续步骤） */
  readonly exposureBytes: number
  readonly calibration: CalibrationSummary | null
}

export interface OracleWeakestStep {
  readonly index: number
  readonly action: CleanAction
  readonly successProbability: number
  readonly exposureBytes: number
}

export interface OracleReport {
  readonly request: {
    readonly plugins: readonly PluginName[]
    readonly profile: ProfileName
    readonly strategy: CleanStrategy
  }
  readonly steps: readonly OracleStep[]
  readonly totalEstimatedBytes: number
  /** 事务整体成功率（连乘） */
  readonly transactionSuccessProbability: number
  /** 期望回收 = P × Σ(b·c50)。非条件口径：已把失败回滚折算进去 */
  readonly expectedReclaimBytes: number
  /** 成功前提下的悲观/乐观回收（校准分位） */
  readonly reclaimP10IfSuccess: number
  readonly reclaimP90IfSuccess: number
  readonly weakestStep: OracleWeakestStep | null
  /** 失败时的期望补偿深度（步数） */
  readonly expectedRollbackDepth: number
  /** 爆炸半径：删除将损坏的外部依赖方（无波及 = 空数组；分析不可用 = null） */
  readonly brokenDependents: readonly PluginName[] | null
  /** 本次成功清理预计延长磁盘写满倒计时的天数（无趋势数据 = null） */
  readonly diskExtensionDays: number | null
  /** 预测置信度：由可靠性模型样本量驱动 */
  readonly confidence: OracleConfidence
  /** 一句话结论（人类可读） */
  readonly narrative: string
  /** 可靠性数据基础（透明度：预测不是黑盒） */
  readonly evidence: {
    readonly stepSamples: number
    readonly globalSuccessProbability: number
  }
}

export interface IOracle {
  /** 后果推演：零副作用（影子上下文 + preview），不获取任何锁 */
  divine(request: {
    readonly plugins: readonly PluginName[]
    readonly profile: ProfileName
    readonly strategy: CleanStrategy
  }): Promise<Result<OracleReport>>
}

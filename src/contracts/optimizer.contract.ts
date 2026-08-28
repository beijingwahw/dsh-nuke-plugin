// src/contracts/optimizer.contract.ts — 决策智能：清理计划合成器契约
// 先知回答"这个事务多危险"；优化器回答"那我该怎么办"——
// 在成功率 × 回收量的双目标权衡上合成帕累托最优的动作子集。
//
// 数学骨架（Saga 语义，动作子集 S，顺序保持工厂序）：
//   成功率   P(S) = ∏_{i∈S} p_i                （连乘对集合可交换）
//   期望回收 E(S) = P(S) · Σ_{i∈S} w_i          （w_i = cal_i · b_i 校准折算字节）
//   剔除任何动作 → P↑ 且 E↓（成功率与回收量天然冲突）→ 双目标帕累托前沿
//
// 子集合法性：与 skip_standard 语义一致 —— 任意动作子集都是合法事务
// （少做几个清理动作不产生不一致状态），故无需依赖约束，数学干净。
import type { CleanAction } from './base'
import type { OperationRiskLevel } from './transaction'

/** 候选动作（先知推演的步骤投影，含决策所需的全部标量） */
export interface CandidateAction {
  /** 动作类型（如 remove-storages） */
  readonly action: CleanAction
  /** 工厂序索引（保持执行顺序用） */
  readonly index: number
  /** 该步成功率（贝叶斯后验，含大小分桶调制） */
  readonly successProbability: number
  /** 预估回收字节（未校准） */
  readonly estimatedBytes: number
  /** 校准比（预估→实际；null = 无历史，诚实用 1） */
  readonly calibrationRatio: number
  /** 风险等级（影响推荐排序的展示权重，不参与数学） */
  readonly riskLevel: OperationRiskLevel
}

/** 优化目标（三种问法，同一前沿） */
export type OptimizerGoal =
  | { readonly kind: 'max-reclaim'; readonly minSuccessProbability: number }
  | { readonly kind: 'max-success'; readonly minReclaimBytes: number }
  | { readonly kind: 'pareto' }

/** 前沿点：一个候选计划的双目标画像 */
export interface ParetoPoint {
  /** 选中动作的工厂序索引（升序） */
  readonly indices: readonly number[]
  /** 选中动作类型（与 indices 同序，便于阅读） */
  readonly actions: readonly CleanAction[]
  /** 剔除的动作数 */
  readonly dropped: number
  readonly successProbability: number
  readonly expectedReclaimBytes: number
}

/** 被剔除动作的可解释理由 */
export interface DropReason {
  readonly index: number
  readonly action: CleanAction
  /** 剔除该动作对成功率的提升（百分点） */
  readonly successUpliftPct: number
  /** 剔除该动作的期望回收损失（字节） */
  readonly reclaimCostBytes: number
  /** 性价比判定：回收损失每换取 1 个百分点成功率提升的字节数 */
  readonly bytesPerPct: number
}

/** 优化结果：推荐计划 + 前沿 + 剔除理由 */
export interface OptimizedPlan {
  /** 目标（回显） */
  readonly goal: OptimizerGoal
  /** 推荐计划（目标约束下的最优子集，工厂序） */
  readonly recommended: ParetoPoint
  /** 帕累托前沿（成功率升序；recommended 必在其中） */
  readonly frontier: readonly ParetoPoint[]
  /** 全集基准（不剔除任何动作的前沿端点之一） */
  readonly fullSet: ParetoPoint
  /** 相对全集的增量画像：推荐计划 vs 全集 */
  readonly vsFullSet: {
    readonly successUpliftPct: number
    readonly reclaimSacrificePct: number
  }
  /** 推荐计划剔除的每个动作的理由（可解释性核心） */
  readonly drops: readonly DropReason[]
  /** 求解方式：exact = 2^n 精确枚举；heuristic = 贪心+2-swap（n > 16） */
  readonly solver: 'exact' | 'heuristic'
}

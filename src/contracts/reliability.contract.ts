// contracts/reliability.contract.ts — 贝叶斯可靠性模型（数据飞轮）
// 核心思想：清理器不该患"失忆症"——每一次清理的每一步结果都是
// 宝贵的统计证据。本模型从审计链（唯一事实源，hash chain 即信任根）
// 读取全部步骤级结果，为每类 CleanAction 学习两个分布：
//
//   1. 成功率分布 —— Beta 后验 + 经验贝叶斯收缩（James-Stein 精神）：
//      观测少的动作向全局均值收缩（借力 pooled 数据），观测多的
//      动作自信。冷启动（零历史）给出保守的 0.5 先验而非盲目乐观。
//
//   2. 校准分布 —— preview 预估 vs execute 实际的回收比
//      actual/estimated 的分位数（p10/p50/p90）。预演说 100MB
//      实际回收多少？答案从这里来，而不是拍脑袋乘个系数。
//
// 下游消费者：先知引擎（oracle）用它们把 dry-run 的确定性预估
// 升级为概率化的后果推演。
import type { CleanAction } from './base'

/** 校准比（actual/estimated）分布摘要 */
export interface CalibrationSummary {
  readonly samples: number
  /** 悲观分位：实际/预估比的 10% 分位 */
  readonly p10: number
  /** 中位数 */
  readonly p50: number
  /** 乐观分位：90% 分位 */
  readonly p90: number
}

export interface ActionReliability {
  readonly action: CleanAction | string
  readonly successes: number
  readonly failures: number
  /** 后验成功率均值（经验贝叶斯收缩后） */
  readonly successProbability: number
  /** 95% 可信区间（Beta 后验的正态近似） */
  readonly ci95: readonly [number, number]
  /** 自数据权重 0-1：(s+f)/(s+f+κ)。1=完全用自身数据，0=完全用全局先验 */
  readonly selfWeight: number
  /** 校准分布；样本 < minCalibrationSamples 时为 null（诚实的不确定） */
  readonly calibration: CalibrationSummary | null
}

export interface IReliabilityModel {
  /** 全部动作的可靠性快照 */
  byAction(): ReadonlyMap<string, ActionReliability>
  /** 单动作查询（无任何数据时返回收缩先验，不返回 null） */
  reliabilityOf(action: string): ActionReliability
  /** 步骤级观测总样本数（跨动作） */
  readonly sampleCount: number
  /** 全局成功率均值（pooled，冷启动时为 0.5） */
  readonly globalSuccessProbability: number
}

// contracts/reliability.contract.ts — 贝叶斯可靠性模型（数据飞轮）
// 核心思想：清理器不该患"失忆症"——每一次清理的每一步结果都是
// 宝贵的统计证据。本模型从审计链（唯一事实源，hash chain 即信任根）
// 读取全部步骤级结果，为每类 CleanAction 学习两个分布：
//
//   1. 成功率分布 —— Beta 后验 + 经验贝叶斯收缩（James-Stein 精神）：
//      观测少的动作向全局均值收缩（借力 pooled 数据），观测多的
//      动作自信。冷启动（零历史）收缩向设计先验（默认 0.95 ——
//      validate 前置 + 备份 + 回滚的事务引擎，失败属例外），而非
//      误导性的硬币 0.5：后者在先知的 Saga 连乘 ∏p 下指数塌缩，
//      把"零信息"渲染成"高故障"。
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

/** 大小桶（操作级成功率调制的协变量）：
 *  大目录删除更易 EBUSY/长路径/超时 —— "删 2GB 的成功率"≠"删 5MB 的成功率" */
export type SizeBucket = 'small' | 'medium' | 'large'

/** 调用方提供 sizeBytes 时附带的桶级证据画像 */
export interface SizeBucketEvidence {
  readonly bucket: SizeBucket
  /** 桶边界（含下界、不含上界；large 上界 = ∞） */
  readonly rangeBytes: readonly [number, number | null]
  /** 桶内该动作的成败样本数（成功+失败；仅统计可归桶样本） */
  readonly samples: number
  /** 桶层自数据权重 0-1（向动作层收缩的系数；0 = 桶内零样本 → 调制不生效） */
  readonly selfWeight: number
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
  /** V5.2：带 sizeBytes 查询时的桶级调制证据；未查询大小时为 undefined */
  readonly sizeBucket?: SizeBucketEvidence
}

export interface IReliabilityModel {
  /** 全部动作的可靠性快照 */
  byAction(): ReadonlyMap<string, ActionReliability>
  /**
   * 单动作查询（无任何数据时返回收缩先验，不返回 null）。
   * V5.2：可选 sizeBytes → 三层收缩（桶 → 动作 → 全局 → 设计先验），
   * 大小桶是该动作成功率 的协变量调制：桶内零样本时调制不生效
   * （诚实返回动作层估计，sizeBucket.selfWeight=0）。
   */
  reliabilityOf(action: string, opts?: { readonly sizeBytes?: number }): ActionReliability
  /** 步骤级观测总样本数（跨动作） */
  readonly sampleCount: number
  /** 全局成功率均值（pooled，向设计先验收缩；零历史时即设计先验 0.95） */
  readonly globalSuccessProbability: number
}

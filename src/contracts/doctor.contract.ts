// contracts/doctor.contract.ts — NukeDoctor 一键体检编排器
// 世界级清理引擎的"全科医生"：一次调用编排 健康检查 + 残留扫描 +
// 孤儿检测 + 五因子评分，输出带优先级排序的可执行处方。
// 设计约束：纯编排层，不直接碰磁盘/事务 —— 所有感知能力来自注入的四个组件。

import type { CleanStrategy, ProfileName, Result } from './base'
import type { ResidualEvidence, SeverityScore } from './scoring'
import type { ToolResolution } from './tool.contract'

/** 总体判决：healthy=无行动必要 / attention=建议处理 / critical=存在阻断或健康度告急 */
export type DoctorVerdict = 'healthy' | 'attention' | 'critical'

/** 处方优先级：1=立即（仍被引用的残留/阻断项） 2=建议（中高分孤儿） 3=可选（低分） */
export type DoctorPriority = 1 | 2 | 3

export interface DoctorRecommendation {
  readonly priority: DoctorPriority
  /** 已评分证据（score 含可解释的因子分解） */
  readonly evidence: ResidualEvidence & { score: SeverityScore }
  /** 该残留对应的建议清理策略 */
  readonly suggestedStrategy: CleanStrategy
  /** 人类可读的处方理由 */
  readonly reason: string
}

export interface DoctorReport {
  readonly generatedAt: string
  readonly profile: ProfileName
  readonly verdict: DoctorVerdict
  readonly healthScore: number          // 0-100
  readonly blocking: boolean            // critical 检查失败 → 清理事务将被拒绝
  readonly recommendations: readonly DoctorRecommendation[]  // priority 升序、分值降序
  readonly totalReclaimableBytes: number
  /** V5.2 环境矩阵：外部工具（dsh/pnpm）解析结果，来自共享 ToolRegistry
   *  （单一事实源）。缺省 = []（未注入注册表的旧装配形态）。 */
  readonly tools?: readonly ToolResolution[]
}

export interface IDoctor {
  /**
   * 全科体检：health.inspect → scanner.scan（该 profile 全插件） →
   * orphans.detect → scorer.rank → 优先级/策略处方。
   * 取消经 AbortSignal 透传至扫描器。
   */
  diagnose(
    profile: ProfileName,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<DoctorReport>>
}

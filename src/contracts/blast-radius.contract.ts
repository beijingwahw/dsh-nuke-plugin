// contracts/blast-radius.contract.ts — 爆炸半径分析器（what-if 仿真）
// 回答清理前最关键的问题："删掉这些插件，到底会波及谁？"
// 基于依赖图传递闭包做沙盘推演：零副作用、不碰事务引擎。
// 产出：损坏清单（broken）/ 级联可删清单（cascade）/ 风险分级 + 顾问建议。

import type { AbsolutePath, NukeError, PluginName, ProfileName, Result } from './base'

export type RiskLevel = 'low' | 'medium' | 'high' | 'extreme'

export interface BlastRadiusReport {
  /** 本次仿真目标 */
  readonly targets: readonly PluginName[]
  /** 闭包内依赖目标的插件中被同批删除的（有意级联） */
  readonly cascadeRemovable: readonly PluginName[]
  /** 依赖目标且【不在删除集合】→ 删除后会损坏的插件 */
  readonly brokenDependents: readonly PluginName[]
  /** 磁盘上实际存在的配置引用位置（patch/yaml） */
  readonly configRefs: readonly AbsolutePath[]
  /** 轻量磁盘探测：node_modules/storages/attachments 合计可回收 */
  readonly estimatedBytesReclaimable: number
  /** 0-100：broken 数量为主因子，级联规模与体量为次因子 */
  readonly riskScore: number
  readonly riskLevel: RiskLevel
  /** 人类可读顾问建议（如何把 extreme 降为 low） */
  readonly advisories: readonly string[]
}

export interface IBlastRadiusAnalyzer {
  /**
   * 沙盘推演：构建依赖图 → 计算传递闭包 → 区分有意级联 vs 意外损坏 → 风险分级。
   * profile 省略 = 全 profile 图。
   */
  simulate(
    plugins: readonly PluginName[],
    profile?: ProfileName,
  ): Promise<Result<BlastRadiusReport, NukeError>>
}

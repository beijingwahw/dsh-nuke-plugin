// contracts/policy.contract.ts — 策略守卫（行政级防御纵深）
// 事务引擎管"操作对不对"，策略守卫管"该不该现在做"：
//   protectedPlugins       保护名单 —— 永不可删（即使绕过工具层，pre-hook 仍 veto）
//   maxPluginsPerTx        单事务插件数上限（防胖手指批量误删）
//   maxReclaimBytesPerTx   单事务回收量上限（异常大的预估 = 计划出错信号）
//   minFreeDiskBytes       磁盘余量下限（清理产生的临时备份也需要空间）
//   blackout               时间黑窗（如工作时间禁清理）
// 策略来源：<dshHome>/.nuke/policy.json（缺失 = 默认全放行）。

import type { PluginName, Result } from './base'
import type { HookDefinition } from './hooks'

// ─── V4 增量（仅新增可选字段/类型/常量，缺省不启用，不改变现有行为） ──

/** 冻结时间窗（多重黑窗的单元）：小时区间 [startHour, endHour)，
 *  支持跨零点（如 22-6 = 22:00 至次日 06:00）。 */
export interface FreezeWindow {
  readonly startHour: number
  readonly endHour: number
  /** 窗口用途说明（供审计与人读，如"数据库备份窗口"） */
  readonly reason?: string
}

/** 冻结窗缺省值：空列表 = 不启用任何冻结窗（fail-closed 默认 —— 缺省时
 *  绝不因该规则拒绝任何请求，现有行为保持不变）。 */
export const NO_FREEZE_WINDOWS: readonly FreezeWindow[] = []

/** 判断给定小时是否命中任一冻结窗（纯函数，供守卫实现与测试复用）。
 *  返回命中的首个窗口；空列表永不命中（缺省不启用）。
 *  越界小时（<0 或 >23）视为不命中 —— 策略文件自身合法性由加载层把关。 */
export function hitFreezeWindow(
  windows: readonly FreezeWindow[], hour: number,
): FreezeWindow | null {
  for (const w of windows) {
    const inWindow = w.startHour <= w.endHour
      ? hour >= w.startHour && hour < w.endHour
      : hour >= w.startHour || hour < w.endHour
    if (inWindow) return w
  }
  return null
}

export interface CleanPolicy {
  readonly version: 1
  readonly protectedPlugins: readonly string[]
  readonly maxPluginsPerTx: number | null
  readonly maxReclaimBytesPerTx: number | null
  readonly minFreeDiskBytes: number | null
  /** 小时区间 [start, end)，如 9-18 = 工作时间禁清理；null = 无黑窗 */
  readonly blackout: { readonly startHour: number; readonly endHour: number } | null
  /** V4 增量（可选）：多重冻结时间窗，任一命中即拒绝；缺省/空 = 不启用 */
  readonly freezeWindows?: readonly FreezeWindow[]
  /** V4 增量（可选）：单事务文件数上限（防单事务波及面失控）；缺省/null = 不限制 */
  readonly maxFilesPerTx?: number | null
}

export interface PolicyViolation {
  readonly rule: 'PROTECTED_PLUGIN' | 'TOO_MANY_PLUGINS' | 'RECLAIM_CAP'
  | 'LOW_FREE_DISK' | 'BLACKOUT_WINDOW'
  /** V4 增量违规 kind：冻结窗命中 / 单事务文件数超限 */
  | 'FREEZE_WINDOW' | 'TOO_MANY_FILES'
  readonly message: string
  /** 全部违规均为 blocking（策略守卫只做硬闸门，软提示交给警告体系） */
  readonly blocking: true
  readonly offending?: readonly string[]
  /** V5 增量（可选）：人类可读的修复建议（如"调整 policy.json 的 maxPluginsPerTx 或分批清理"） */
  readonly suggestion?: string
}

export interface PolicyCheckRequest {
  readonly plugins: readonly PluginName[]
  /** 计划预估回收量；null = plan 之前的前置检查 */
  readonly estimatedBytes: number | null
  /** V4 增量（可选）：计划涉及的文件数（touchedPaths 去重计数）；
   *  null/缺省 = 未统计（文件数上限规则跳过判定） */
  readonly fileCount?: number | null
}

// ─── V5 增量：策略加载校验报告 ──────────────────────────────
// 策略文件中的非法配置项（负数上限、越界/非整数小时、畸形窗口）绝不静默生效：
// 加载层逐项校验，非法项按 fail-closed 忽略（视为未配置），并在此报告中
// 给出明确的字段定位与问题描述，供上层一次性展示/落审计。

/** 单个非法配置项的定位与描述 */
export interface PolicyLoadIssue {
  /** 触发问题的策略字段（如 "maxPluginsPerTx"、"freezeWindows[1].startHour"） */
  readonly field: string
  /** 人类可读的问题描述（含处置建议） */
  readonly problem: string
}

/** 带校验明细的策略加载结果：issues 为空 = 配置完全合法 */
export interface PolicyLoadReport {
  readonly policy: CleanPolicy
  /** 加载时被忽略（视为未配置）的非法项清单；空数组 = 无非法项 */
  readonly issues: readonly PolicyLoadIssue[]
}

export interface IPolicyGuard {
  /** 读取并校验策略文件；文件缺失/损坏 → 默认全放行策略 */
  load(): CleanPolicy
  /** V5 增量：同 load()，但额外返回被忽略的非法配置项明细（绝不静默接受非法配置） */
  loadValidated(): PolicyLoadReport
  check(request: PolicyCheckRequest): Result<readonly PolicyViolation[]>
  /** 包装为 pre-hook（保护名单逐插件 veto）—— 纵深防御第二层 */
  asPreHook(): HookDefinition
}

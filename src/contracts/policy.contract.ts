// contracts/policy.contract.ts — 策略守卫（行政级防御纵深）
// 事务引擎管"操作对不对"，策略守卫管"该不该现在做"：
//   protectedPlugins       保护名单 —— 永不可删（即使绕过工具层，pre-hook 仍 veto）
//   maxPluginsPerTx        单事务插件数上限（防胖手指批量误删）
//   maxReclaimBytesPerTx   单事务回收量上限（异常大的预估 = 计划出错信号）
//   minFreeDiskBytes       磁盘余量下限（清理产生的临时备份也需要空间）
//   blackout               时间黑窗（如工作时间禁清理）
// 策略来源：<dshHome>/.nuke/policy.json（缺失 = 默认全放行）。

import type { NukeError, PluginName, Result } from './base'
import type { HookDefinition } from './hooks'

export interface CleanPolicy {
  readonly version: 1
  readonly protectedPlugins: readonly string[]
  readonly maxPluginsPerTx: number | null
  readonly maxReclaimBytesPerTx: number | null
  readonly minFreeDiskBytes: number | null
  /** 小时区间 [start, end)，如 9-18 = 工作时间禁清理；null = 无黑窗 */
  readonly blackout: { readonly startHour: number; readonly endHour: number } | null
}

export interface PolicyViolation {
  readonly rule: 'PROTECTED_PLUGIN' | 'TOO_MANY_PLUGINS' | 'RECLAIM_CAP'
  | 'LOW_FREE_DISK' | 'BLACKOUT_WINDOW'
  readonly message: string
  /** 全部违规均为 blocking（策略守卫只做硬闸门，软提示交给警告体系） */
  readonly blocking: true
  readonly offending?: readonly string[]
}

export interface PolicyCheckRequest {
  readonly plugins: readonly PluginName[]
  /** 计划预估回收量；null = plan 之前的前置检查 */
  readonly estimatedBytes: number | null
}

export interface IPolicyGuard {
  /** 读取并校验策略文件；文件缺失/损坏 → 默认全放行策略 */
  load(): CleanPolicy
  check(request: PolicyCheckRequest): Result<readonly PolicyViolation[], NukeError>
  /** 包装为 pre-hook（保护名单逐插件 veto）—— 纵深防御第二层 */
  asPreHook(): HookDefinition
}

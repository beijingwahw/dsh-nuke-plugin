// src/infra/policy-guard.ts — IPolicyGuard 实现：策略守卫
// 双层防御：
//   第一层（工具适配层）：nuke_clean 在 plan 后调用 check()，拿到全部违规明细
//   第二层（引擎 pre-hook）：asPreHook() 注册进 hook registry —— 即使调用方
//     绕过工具层直连事务引擎，保护名单仍然逐插件 veto（纵深防御）
// 策略文件缺失/损坏 → 默认全放行（fail-open：策略是闸门，不是单点故障源）。
// 但"文件级损坏回退默认" ≠ "字段级非法静默生效"：V5 起加载层逐字段做类型与
// 范围校验（负数上限、越界/非整数小时、畸形窗口），非法项一律忽略（视为未
// 配置）并通过 loadValidated() 给出明确定位 —— 绝不静默接受非法配置。
import * as fs from 'fs'
import type { NukeError, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import { statfsBytes } from './fs-utils'
import type { HookDefinition } from '../contracts/hooks'
import type {
  CleanPolicy, FreezeWindow, IPolicyGuard, PolicyCheckRequest,
  PolicyLoadIssue, PolicyLoadReport, PolicyViolation,
} from '../contracts/policy.contract'
import { hitFreezeWindow } from '../contracts/policy.contract'

export interface PolicyGuardOptions {
  /** 策略文件路径（通常 <dshHome>/.nuke/policy.json） */
  readonly policyFile: string
  /** 磁盘余量检测根（statfs 目标） */
  readonly diskRoot: string
  readonly now?: () => Date
  /** 可注入的 free 字节探测（测试用；默认 fs.statfs） */
  readonly freeBytesOf?: (root: string) => number | null
}

export const DEFAULT_POLICY: CleanPolicy = {
  version: 1,
  protectedPlugins: [],
  maxPluginsPerTx: null,
  maxReclaimBytesPerTx: null,
  minFreeDiskBytes: null,
  blackout: null,
}

/** 全部违规规则的人类可读修复建议（check() 输出时逐条附带） */
const SUGGESTIONS: Readonly<Record<PolicyViolation['rule'], string>> = {
  PROTECTED_PLUGIN: '从 policy.json 的 protectedPlugins 中移除该插件，或改选其他清理目标',
  TOO_MANY_PLUGINS: '调整 policy.json 的 maxPluginsPerTx 或分批清理',
  RECLAIM_CAP: '调整 policy.json 的 maxReclaimBytesPerTx，或缩小本次清理范围后重试',
  LOW_FREE_DISK: '先释放磁盘空间再执行，或调低 policy.json 的 minFreeDiskBytes',
  BLACKOUT_WINDOW: '等待黑窗期结束再执行，或调整 policy.json 的 blackout 区间',
  FREEZE_WINDOW: '等待冻结窗结束再执行，或调整 policy.json 的 freezeWindows 配置',
  TOO_MANY_FILES: '调整 policy.json 的 maxFilesPerTx 或分批清理',
}

/** 上限类数值合法性：非负有限整数（NaN/Infinity/负数/小数均视为非法配置） */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** 小时字段合法性：[0, 23] 闭区间内的整数 */
function isHour(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23
}

/** 解析后的策略 + 被忽略的非法配置项明细（绝不静默） */
interface ParsedPolicy {
  readonly policy: CleanPolicy
  readonly issues: readonly PolicyLoadIssue[]
}

/** 白名单式合并：未知字段忽略，已知字段逐一校验类型与范围；
 *  非法项忽略（视为未配置）并记录 issue —— fail-closed，绝不静默生效。 */
function parsePolicy(raw: unknown): ParsedPolicy {
  const obj = (raw ?? {}) as Partial<CleanPolicy>
  const issues: PolicyLoadIssue[] = []

  // 数量上限三兄弟：非负有限整数，否则忽略 + 记录
  const numLimit = (
    field: 'maxPluginsPerTx' | 'maxReclaimBytesPerTx' | 'minFreeDiskBytes' | 'maxFilesPerTx',
  ): number | null => {
    const v = (obj as Record<string, unknown>)[field]
    if (v === undefined || v === null) return null
    if (isCount(v)) return v
    issues.push({
      field,
      problem: `非法数值 ${String(v)}（必须是非负整数），该项已被忽略（视为未配置）；请修正 policy.json`,
    })
    return null
  }

  // 黑窗：两小时字段均须落在 [0,23]
  let blackout: CleanPolicy['blackout'] = null
  if (obj.blackout !== undefined && obj.blackout !== null) {
    const b = obj.blackout as { startHour?: unknown; endHour?: unknown }
    if (isHour(b.startHour) && isHour(b.endHour)) {
      blackout = { startHour: b.startHour, endHour: b.endHour }
    } else {
      issues.push({
        field: 'blackout',
        problem: `畸形黑窗 { startHour: ${String(b.startHour)}, endHour: ${String(b.endHour)} }（小时必须是 0~23 的整数），该窗口已被忽略；请修正 policy.json`,
      })
    }
  }

  // 冻结窗列表：逐项校验，畸形项剔除并定位到 freezeWindows[i]
  let freezeWindows: readonly FreezeWindow[] | undefined
  if (obj.freezeWindows !== undefined && obj.freezeWindows !== null) {
    const list = obj.freezeWindows as readonly unknown[]
    if (Array.isArray(list)) {
      const valid: FreezeWindow[] = []
      list.forEach((w, i) => {
        const win = w as { startHour?: unknown; endHour?: unknown; reason?: unknown } | null
        if (win !== null && typeof win === 'object' && isHour(win.startHour) && isHour(win.endHour)) {
          valid.push({
            startHour: win.startHour,
            endHour: win.endHour,
            ...(typeof win.reason === 'string' ? { reason: win.reason } : {}),
          })
        } else {
          issues.push({
            field: `freezeWindows[${i}]`,
            problem: `畸形冻结窗（小时必须是 0~23 的整数），该项已被剔除；请修正 policy.json`,
          })
        }
      })
      freezeWindows = valid
    } else {
      issues.push({
        field: 'freezeWindows',
        problem: 'freezeWindows 必须是数组，该配置已被整体忽略；请修正 policy.json',
      })
    }
  }

  const policy: CleanPolicy = {
    version: 1,
    protectedPlugins: Array.isArray(obj.protectedPlugins)
      ? obj.protectedPlugins.filter((x): x is string => typeof x === 'string')
      : [],
    maxPluginsPerTx: numLimit('maxPluginsPerTx'),
    maxReclaimBytesPerTx: numLimit('maxReclaimBytesPerTx'),
    minFreeDiskBytes: numLimit('minFreeDiskBytes'),
    blackout,
    ...(freezeWindows !== undefined ? { freezeWindows } : {}),
    maxFilesPerTx: numLimit('maxFilesPerTx'),
  }
  return { policy, issues }
}

export function createPolicyGuard(options: PolicyGuardOptions): IPolicyGuard {
  const now = options.now ?? (() => new Date())

  function freeBytes(root: string): number | null {
    if (options.freeBytesOf) return options.freeBytesOf(root)
    return statfsBytes(root)?.free ?? null   // 不可用时跳过该规则（fail-soft）
  }

  function loadReport(): PolicyLoadReport {
    try {
      return parsePolicy(JSON.parse(fs.readFileSync(options.policyFile, 'utf-8')))
    } catch {
      return { policy: DEFAULT_POLICY, issues: [] }   // 缺失/损坏 → 默认全放行
    }
  }

  function load(): CleanPolicy {
    return loadReport().policy
  }

  function check(request: PolicyCheckRequest): Result<readonly PolicyViolation[], NukeError> {
    try {
      const policy = load()
      const violations: PolicyViolation[] = []

      // 保护名单
      const protectedHit = request.plugins.filter(p => policy.protectedPlugins.includes(p))
      if (protectedHit.length > 0) {
        violations.push({
          rule: 'PROTECTED_PLUGIN', blocking: true, offending: protectedHit,
          message: `保护名单插件禁止删除: ${protectedHit.join(', ')}`,
          suggestion: SUGGESTIONS.PROTECTED_PLUGIN,
        })
      }

      // 单事务插件数上限
      if (policy.maxPluginsPerTx !== null && request.plugins.length > policy.maxPluginsPerTx) {
        violations.push({
          rule: 'TOO_MANY_PLUGINS', blocking: true,
          message: `单事务插件数 ${request.plugins.length} 超过上限 ${policy.maxPluginsPerTx}（防批量误删，请分批）`,
          suggestion: SUGGESTIONS.TOO_MANY_PLUGINS,
        })
      }

      // 单事务文件数上限（V5 执行 V4 契约缺口：请求未统计 fileCount 或策略未
      // 配置 maxFilesPerTx 时跳过判定，保持向后兼容）
      if (policy.maxFilesPerTx !== null && policy.maxFilesPerTx !== undefined
        && request.fileCount !== null && request.fileCount !== undefined
        && request.fileCount > policy.maxFilesPerTx) {
        violations.push({
          rule: 'TOO_MANY_FILES', blocking: true,
          message: `单事务文件数 ${request.fileCount} 超过上限 ${policy.maxFilesPerTx}（防波及面失控，请分批）`,
          suggestion: SUGGESTIONS.TOO_MANY_FILES,
        })
      }

      // 回收量上限（plan 之后才可判定）
      if (policy.maxReclaimBytesPerTx !== null
        && request.estimatedBytes !== null
        && request.estimatedBytes > policy.maxReclaimBytesPerTx) {
        violations.push({
          rule: 'RECLAIM_CAP', blocking: true,
          message: `计划回收量超上限（预估 ${request.estimatedBytes} > ${policy.maxReclaimBytesPerTx}）—— 异常大的预估通常是计划出错的信号`,
          suggestion: SUGGESTIONS.RECLAIM_CAP,
        })
      }

      // 磁盘余量下限
      if (policy.minFreeDiskBytes !== null) {
        const free = freeBytes(options.diskRoot)
        if (free !== null && free < policy.minFreeDiskBytes) {
          violations.push({
            rule: 'LOW_FREE_DISK', blocking: true,
            message: `磁盘余量不足（${free} < ${policy.minFreeDiskBytes}）：清理的备份/回收区本身需要空间`,
            suggestion: SUGGESTIONS.LOW_FREE_DISK,
          })
        }
      }

      // 时间黑窗：支持跨零点区间（如 22-6）
      if (policy.blackout) {
        const hour = now().getHours()
        const { startHour, endHour } = policy.blackout
        const inWindow = startHour <= endHour
          ? hour >= startHour && hour < endHour
          : hour >= startHour || hour < endHour
        if (inWindow) {
          violations.push({
            rule: 'BLACKOUT_WINDOW', blocking: true,
            message: `当前处于清理黑窗期（${startHour}:00-${endHour}:00），拒绝执行`,
            suggestion: SUGGESTIONS.BLACKOUT_WINDOW,
          })
        }
      }

      // 冻结窗（V5 执行 V4 契约缺口：复用契约纯函数 hitFreezeWindow，任一
      // 窗口命中即拒绝；freezeWindows 缺省/空列表永不命中，行为不变）
      if (policy.freezeWindows !== undefined && policy.freezeWindows.length > 0) {
        const hit = hitFreezeWindow(policy.freezeWindows, now().getHours())
        if (hit !== null) {
          violations.push({
            rule: 'FREEZE_WINDOW', blocking: true,
            message: `当前处于冻结窗（${hit.startHour}:00-${hit.endHour}:00${hit.reason ? `：${hit.reason}` : ''}），拒绝执行`,
            suggestion: SUGGESTIONS.FREEZE_WINDOW,
          })
        }
      }

      return ok(violations)
    } catch (e) {
      return err(ioError('策略检查失败', e))
    }
  }

  function asPreHook(): HookDefinition {
    return {
      id: 'policy-guard',
      timing: 'pre',
      actions: '*',
      priority: -100,   // 最先执行：闸门先于一切业务钩子
      onFailure: 'best-effort',
      handler: {
        type: 'inline',
        run: async (ctx) => {
          const policy = load()
          if (policy.protectedPlugins.includes(ctx.plugin)) {
            return { kind: 'veto' as const, reason: `策略守卫: "${ctx.plugin}" 在保护名单中` }
          }
          return undefined
        },
      },
    }
  }

  return { load, loadValidated: loadReport, check, asPreHook }
}

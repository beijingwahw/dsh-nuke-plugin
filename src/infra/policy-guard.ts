// src/infra/policy-guard.ts — IPolicyGuard 实现：策略守卫
// 双层防御：
//   第一层（工具适配层）：nuke_clean 在 plan 后调用 check()，拿到全部违规明细
//   第二层（引擎 pre-hook）：asPreHook() 注册进 hook registry —— 即使调用方
//     绕过工具层直连事务引擎，保护名单仍然逐插件 veto（纵深防御）
// 策略文件缺失/损坏 → 默认全放行（fail-open：策略是闸门，不是单点故障源）。
import * as fs from 'fs'
import type { NukeError, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { HookDefinition } from '../contracts/hooks'
import type {
  CleanPolicy, IPolicyGuard, PolicyCheckRequest, PolicyViolation,
} from '../contracts/policy.contract'

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

export function createPolicyGuard(options: PolicyGuardOptions): IPolicyGuard {
  const now = options.now ?? (() => new Date())

  function freeBytes(root: string): number | null {
    if (options.freeBytesOf) return options.freeBytesOf(root)
    try {
      const st = (fs as any).statfsSync?.(root)   // Node ≥18.15；不可用时跳过该规则
      return st ? Number(st.bsize) * Number(st.bavail) : null
    } catch { return null }
  }

  function load(): CleanPolicy {
    try {
      const raw = JSON.parse(fs.readFileSync(options.policyFile, 'utf-8')) as Partial<CleanPolicy>
      // 白名单式合并：未知字段忽略，已知字段逐一校验类型
      const p: CleanPolicy = {
        version: 1,
        protectedPlugins: Array.isArray(raw.protectedPlugins)
          ? raw.protectedPlugins.filter((x): x is string => typeof x === 'string')
          : [],
        maxPluginsPerTx: typeof raw.maxPluginsPerTx === 'number' ? raw.maxPluginsPerTx : null,
        maxReclaimBytesPerTx: typeof raw.maxReclaimBytesPerTx === 'number' ? raw.maxReclaimBytesPerTx : null,
        minFreeDiskBytes: typeof raw.minFreeDiskBytes === 'number' ? raw.minFreeDiskBytes : null,
        blackout: raw.blackout
          && typeof raw.blackout.startHour === 'number'
          && typeof raw.blackout.endHour === 'number'
          ? { startHour: raw.blackout.startHour, endHour: raw.blackout.endHour }
          : null,
      }
      return p
    } catch { return DEFAULT_POLICY }   // 缺失/损坏 → 默认全放行
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
        })
      }

      // 单事务插件数上限
      if (policy.maxPluginsPerTx !== null && request.plugins.length > policy.maxPluginsPerTx) {
        violations.push({
          rule: 'TOO_MANY_PLUGINS', blocking: true,
          message: `单事务插件数 ${request.plugins.length} 超过上限 ${policy.maxPluginsPerTx}（防批量误删，请分批）`,
        })
      }

      // 回收量上限（plan 之后才可判定）
      if (policy.maxReclaimBytesPerTx !== null
        && request.estimatedBytes !== null
        && request.estimatedBytes > policy.maxReclaimBytesPerTx) {
        violations.push({
          rule: 'RECLAIM_CAP', blocking: true,
          message: `计划回收量超上限（预估 ${request.estimatedBytes} > ${policy.maxReclaimBytesPerTx}）—— 异常大的预估通常是计划出错的信号`,
        })
      }

      // 磁盘余量下限
      if (policy.minFreeDiskBytes !== null) {
        const free = freeBytes(options.diskRoot)
        if (free !== null && free < policy.minFreeDiskBytes) {
          violations.push({
            rule: 'LOW_FREE_DISK', blocking: true,
            message: `磁盘余量不足（${free} < ${policy.minFreeDiskBytes}）：清理的备份/回收区本身需要空间`,
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

  return { load, check, asPreHook }
}

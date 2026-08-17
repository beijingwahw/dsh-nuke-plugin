// src/operations/index.ts — 策略 → 操作集编译器
// 策略分级（与 V3 语义对齐 + V4 扩展）：
//   safe       standard-remove + 三个配置清理
//   balanced   safe + node_modules/storages/attachments 物理回收
//   aggressive balanced + pnpm store prune + TEMP 孤儿清理（需确认令牌）
import type { CleanAction, CleanStrategy } from '../contracts/base'
import type { CleanOperation, CleanRequest, TxContext } from '../contracts/transaction'
import type { IInputValidator } from '../contracts/validation'
import { configEditOps } from './edit-ops'
import { dirRemoveOps, makePurgeTempOp } from './fs-ops'
import { makePnpmPruneOp, makeStandardRemoveOp, type CommandRunner } from './exec-ops'

export const STRATEGY_ACTIONS: Readonly<Record<CleanStrategy, readonly CleanAction[]>> = {
  safe: [
    'standard-remove',
    'clean-workspace-yaml',
    'clean-profile-patch',
    'clean-home-patch',
  ],
  balanced: [
    'standard-remove',
    'clean-workspace-yaml',
    'clean-profile-patch',
    'clean-home-patch',
    'remove-node-modules',
    'remove-storages',
    'remove-attachments',
  ],
  aggressive: [
    'standard-remove',
    'clean-workspace-yaml',
    'clean-profile-patch',
    'clean-home-patch',
    'remove-node-modules',
    'remove-storages',
    'remove-attachments',
    'pnpm-store-prune',
    'purge-temp',
  ],
}

export interface OperationFactoryOptions {
  readonly validator: IInputValidator
  readonly runCommand?: CommandRunner
  readonly tempRoot: string
  readonly tempTtlDays?: number
  readonly now?: () => Date
}

/**
 * 生成引擎用的 operationFactory。
 * 顺序即执行顺序：先标准卸载与配置摘除（轻、可逆），再物理回收目录，最后全局收尾。
 */
export function makeOperationFactory(options: OperationFactoryOptions) {
  return (request: CleanRequest): CleanOperation[] => {
    const dshHomeOf = (c: TxContext) => c.resolver.platform().dshHome
    const actions = new Set(STRATEGY_ACTIONS[request.strategy])
    const ops: CleanOperation[] = []

    // 防御性闸门：插件名必须通过 npm 包名规范校验才参与操作集构建
    const plugins = request.plugins.filter(p => options.validator.validatePluginName(p).ok)

    for (const plugin of plugins) {
      if (actions.has('standard-remove')) {
        ops.push(makeStandardRemoveOp(plugin, request.profile, {
          validator: options.validator,
          ...(options.runCommand ? { runCommand: options.runCommand } : {}),
        }))
      }
      ops.push(...configEditOps(plugin, request.profile, dshHomeOf)
        .filter(op => actions.has(op.action)))
      ops.push(...dirRemoveOps(plugin, request.profile, dshHomeOf)
        .filter(op => actions.has(op.action)))
    }

    if (actions.has('pnpm-store-prune')) {
      ops.push(makePnpmPruneOp(
        request.profile,
        c => c.resolver.profileDir(request.profile),
        {
          validator: options.validator,
          ...(options.runCommand ? { runCommand: options.runCommand } : {}),
        },
      ))
    }
    if (actions.has('purge-temp')) {
      ops.push(makePurgeTempOp({
        tempRoot: options.tempRoot,
        ...(options.tempTtlDays !== undefined ? { ttlDays: options.tempTtlDays } : {}),
        ...(options.now ? { now: options.now } : {}),
      }))
    }
    return ops
  }
}

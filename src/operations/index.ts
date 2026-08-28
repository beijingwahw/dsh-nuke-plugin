// src/operations/index.ts — 策略 → 操作集编译器
// 策略分级（与 V3 语义对齐 + V4 扩展）：
//   safe       standard-remove + 三个配置清理
//   balanced   safe + node_modules/storages/attachments 物理回收
//   aggressive balanced + pnpm store prune + TEMP 孤儿清理（需确认令牌）
//
// V4 升级：
//   1. 动作集元数据化 —— ACTION_METADATA 为每个 CleanAction 给出 riskLevel
//      与人类可读描述；工厂产出的每个操作都附带这两个字段（表驱动单一事实源）
//   2. 构建表驱动化 —— 每插件/全局动作构建器收敛为两张表，新增动作只加一行
//   3. makeOperationPlan —— 策略+插件列表 → 动作清单+风险等级+预估影响，
//      供上层 dry-run 增强（DryRunReport.actions 的直接供给方）
import type { CleanAction, CleanStrategy, NukeError, PluginName, ProfileName, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type {
  CleanOperation, CleanRequest, DryRunActionDetail, OperationPlan, OperationRiskLevel, TxContext,
} from '../contracts/transaction'
import type { IInputValidator } from '../contracts/validation'
import type { IToolRegistry } from '../contracts/tool.contract'
import type { IPathResolver } from '../contracts/paths'
import type { ILogger } from '../contracts/logging'
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

// ─── V4：动作元数据表（riskLevel + 人类可读描述的单一事实源） ──
// 风险定级原则（可逆性 × 影响面）：
//   low    = 行级可逆（yaml-edit 快照恢复）且影响面局限在单 profile
//   medium = 可逆但体量大 / 影响全局配置 / 外部副作用有补偿语义
//   high   = 数据丢失类（持久化数据删除）或全局不可逆动作

export interface ActionMeta {
  readonly action: CleanAction
  readonly riskLevel: OperationRiskLevel
  readonly description: string
  /** 动作粒度：per-plugin = 每插件一个操作；global = 每事务一次 */
  readonly scope: 'per-plugin' | 'global'
}

export const ACTION_METADATA: Readonly<Record<CleanAction, ActionMeta>> = {
  'standard-remove': {
    action: 'standard-remove', riskLevel: 'medium', scope: 'per-plugin',
    description: '调用 dsh CLI 标准卸载插件（外部包管理器副作用，undo 为补偿提示）',
  },
  'clean-workspace-yaml': {
    action: 'clean-workspace-yaml', riskLevel: 'low', scope: 'per-plugin',
    description: '从 profile 的 pnpm-workspace.yaml 摘除插件引用（行级精确摘除，快照可恢复）',
  },
  'clean-profile-patch': {
    action: 'clean-profile-patch', riskLevel: 'low', scope: 'per-plugin',
    description: '从 profile 的 cordis.patch.yml 摘除插件补丁块（行级精确摘除，快照可恢复）',
  },
  'clean-home-patch': {
    action: 'clean-home-patch', riskLevel: 'medium', scope: 'per-plugin',
    description: '从全局 cordis.patch.yml 摘除插件补丁块（影响所有 profile 的全局配置）',
  },
  'remove-node-modules': {
    action: 'remove-node-modules', riskLevel: 'medium', scope: 'per-plugin',
    description: '将插件的 node_modules 包目录原子移入回收区（O(1) 可逆，commit 后才物理清除）',
  },
  'remove-storages': {
    action: 'remove-storages', riskLevel: 'high', scope: 'per-plugin',
    description: '将插件的 storages 持久化数据移入回收区（数据丢失类动作，请确认无需保留）',
  },
  'remove-attachments': {
    action: 'remove-attachments', riskLevel: 'medium', scope: 'per-plugin',
    description: '将插件的 attachments 会话附件移入回收区（可再生的会话产物）',
  },
  'pnpm-store-prune': {
    action: 'pnpm-store-prune', riskLevel: 'high', scope: 'global',
    description: 'pnpm store prune 全局修剪未引用包（全局不可逆，aggressive 专属）',
  },
  'purge-temp': {
    action: 'purge-temp', riskLevel: 'medium', scope: 'global',
    description: '清理 TEMP 下过期的 dsh 痕迹条目（标记+期限双重过滤，进回收区可恢复）',
  },
}

/** 元数据注入：工厂产出的每个操作附带 riskLevel/description（浅拷贝合并，不改行为） */
function withActionMeta(op: CleanOperation): CleanOperation {
  const meta = ACTION_METADATA[op.action]
  return meta ? { ...op, riskLevel: meta.riskLevel, description: meta.description } : op
}

export interface OperationFactoryOptions {
  readonly validator: IInputValidator
  readonly runCommand?: CommandRunner
  readonly tempRoot: string
  readonly tempTtlDays?: number
  readonly now?: () => Date
  /** V5.2：共享工具注册表（CLI 解析单一事实源，注入 exec-ops） */
  readonly toolRegistry?: IToolRegistry
}

// ─── V4：动作构建表（表驱动 —— 新增动作只加一行，不再散落 if 链） ──
// 每插件表（顺序即执行顺序）：标准卸载 → 配置摘除 → 目录回收
type PerPluginBuilder = (
  plugin: PluginName, profile: ProfileName, dshHomeOf: (ctx: TxContext) => string,
  options: OperationFactoryOptions,
) => CleanOperation[]

const PER_PLUGIN_BUILDERS: readonly PerPluginBuilder[] = [
  (plugin, profile, _dshHomeOf, options) => [makeStandardRemoveOp(plugin, profile, {
    validator: options.validator,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
    ...(options.toolRegistry ? { toolRegistry: options.toolRegistry } : {}),
  })],
  (plugin, profile, dshHomeOf) => configEditOps(plugin, profile, dshHomeOf),
  (plugin, profile, dshHomeOf) => dirRemoveOps(plugin, profile, dshHomeOf),
]

// 全局表（每事务一次）：pnpm store 修剪 → TEMP 孤儿清理
type GlobalBuilder = (
  profile: ProfileName, options: OperationFactoryOptions,
) => CleanOperation[]

const GLOBAL_BUILDERS: readonly GlobalBuilder[] = [
  (profile, options) => [makePnpmPruneOp(
    profile,
    c => c.resolver.profileDir(profile),
    {
      validator: options.validator,
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.toolRegistry ? { toolRegistry: options.toolRegistry } : {}),
    },
  )],
  (_profile, options) => [makePurgeTempOp({
    tempRoot: options.tempRoot,
    ...(options.tempTtlDays !== undefined ? { ttlDays: options.tempTtlDays } : {}),
    ...(options.now ? { now: options.now } : {}),
  })],
]

/** 策略 → 有序操作集（makeOperationFactory 与 makeOperationPlan 共享的编译内核） */
function buildOperations(
  request: CleanRequest, options: OperationFactoryOptions,
): CleanOperation[] {
  const dshHomeOf = (c: TxContext) => c.resolver.platform().dshHome
  const actions = new Set(STRATEGY_ACTIONS[request.strategy])
  const ops: CleanOperation[] = []

  // 防御性闸门：插件名必须通过 npm 包名规范校验才参与操作集构建
  const plugins = request.plugins.filter(p => options.validator.validatePluginName(p).ok)

  for (const plugin of plugins) {
    for (const build of PER_PLUGIN_BUILDERS) {
      // 表驱动 + 策略过滤：构建产物中不属于本策略的动作被剔除（顺序保持）
      ops.push(...build(plugin, request.profile, dshHomeOf, options)
        .filter(op => actions.has(op.action))
        .map(withActionMeta))
    }
  }

  for (const build of GLOBAL_BUILDERS) {
    ops.push(...build(request.profile, options)
      .filter(op => actions.has(op.action))
      .map(withActionMeta))
  }
  return ops
}

/**
 * 生成引擎用的 operationFactory。
 * 顺序即执行顺序：先标准卸载与配置摘除（轻、可逆），再物理回收目录，最后全局收尾。
 */
export function makeOperationFactory(options: OperationFactoryOptions) {
  return (request: CleanRequest): CleanOperation[] => buildOperations(request, options)
}

// ─── V4：操作计划（策略+插件 → 动作清单+风险+预估影响） ─────

/** 单条计划动作明细：DryRunActionDetail 的超集（多出定位与执行属性） */
export interface PlannedActionDetail extends DryRunActionDetail {
  readonly operationId: string
  readonly target: PluginName
  readonly requiresExclusiveLock: boolean
  /** preview 的人类可读摘要（resolver 缺省时为空串） */
  readonly summary: string
  /** preview 判定为幂等跳过（目标缺失/引用不存在）时为 true */
  readonly skipped: boolean
}

export interface OperationActionPlan {
  readonly strategy: CleanStrategy
  readonly actions: readonly PlannedActionDetail[]
  readonly totalEstimatedBytes: number
  /** 全部动作中的最高风险等级；无动作时为 null */
  readonly highestRiskLevel: OperationRiskLevel | null
}

export interface OperationPlanOptions extends OperationFactoryOptions {
  /** 提供 resolver 时逐操作零副作用 preview，产出真实预估与 skipped 语义；
   *  缺省则只输出元数据清单（estimatedBytes 一律 0） */
  readonly resolver?: IPathResolver
  readonly logger?: ILogger
}

/** preview 阶段触碰备份区 = 副作用逃逸，立即引爆（与先知引擎同一纪律） */
const BOMB_BACKUPS = {
  stageFile: () => { throw new Error('PLAN_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
  stageDir: () => { throw new Error('PLAN_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
  stageEdit: () => { throw new Error('PLAN_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
} as never

const RISK_ORDER: Readonly<Record<OperationRiskLevel, number>> = { low: 0, medium: 1, high: 2 }

/**
 * 策略 + 插件列表 → "将执行的动作清单 + 风险等级 + 预估影响"。
 * 与 makeOperationFactory 共享同一编译内核（推演与执行严格同构）；
 * 提供 resolver 时逐操作单遍 preview 取真实预估（零副作用，影子上下文）。
 * 任何 preview 失败 → 整体 err（fail-closed：拿不到可信预估就不出计划）。
 */
export async function makeOperationPlan(
  request: CleanRequest,
  options: OperationPlanOptions,
): Promise<Result<OperationActionPlan, NukeError>> {
  try {
    const ops = buildOperations(request, options)
    const details: PlannedActionDetail[] = []

    // 影子上下文：只在提供 resolver 时做真实 preview（备份区为炸弹桩）
    const shadowCtx: TxContext | null = options.resolver
      ? {
        txId: 'plan-shadow' as never,
        request,
        resolver: options.resolver,
        logger: options.logger ?? SILENT_LOGGER,
        clock: { now: () => new Date() },
        backups: BOMB_BACKUPS,
      }
      : null

    for (const op of ops) {
      const meta = ACTION_METADATA[op.action]
      let plan: OperationPlan | null = null
      if (shadowCtx) plan = await op.preview(shadowCtx)
      details.push({
        action: op.action,
        riskLevel: op.riskLevel ?? meta?.riskLevel ?? 'medium',
        description: op.description ?? meta?.description ?? op.action,
        estimatedBytes: plan?.estimatedBytesReclaimable ?? 0,
        operationId: op.id,
        target: op.target,
        // 无 resolver 时按动作元数据推导：exec 类动作触发外部包管理，需要独占锁
        requiresExclusiveLock: plan
          ? plan.requiresExclusiveLock
          : op.action === 'standard-remove' || op.action === 'pnpm-store-prune',
        summary: plan?.summary ?? '',
        skipped: plan?.skipped === true,
      })
    }

    const highest = details.reduce<OperationRiskLevel | null>(
      (acc, d) => (acc === null || RISK_ORDER[d.riskLevel] > RISK_ORDER[acc] ? d.riskLevel : acc),
      null,
    )
    return ok({
      strategy: request.strategy,
      actions: details,
      totalEstimatedBytes: details.reduce((s, d) => s + d.estimatedBytes, 0),
      highestRiskLevel: highest,
    })
  } catch (e) {
    return err(ioError('操作计划编译失败', e))
  }
}

/** 无 logger 注入时的静默桩（preview 不产日志，仅满足 TxContext 形态） */
const SILENT_LOGGER: ILogger = {
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
  progress: () => undefined,
  sink: 'plain',
}

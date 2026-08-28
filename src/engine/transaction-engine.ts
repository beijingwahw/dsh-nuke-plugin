// src/engine/transaction-engine.ts — ITransactionEngine 实现
// ACID 落地：
//   Atomic   任一步骤失败 → manifest 逆序 restore（Saga 反向补偿），WAL 记 tx-rollback
//   Durable  WAL 每步 fdatasync；备份区 manifest.jsonl 独立于 WAL（双保险）
//   Isolated 全程持有独占锁（withLock RAII，异常路径也释放）
//   Consistent plan 阶段做依赖/令牌/路径校验，aggressive 无令牌拒绝进入 commit
import * as crypto from 'crypto'
import * as os from 'os'

import type {
  Clock, Result, TxId,
} from '../contracts/base'
import { err, errorToMessage, ioError, ok, SimulatedCrashError } from '../contracts/base'
import {
  classifyFailureMode, DEFAULT_RETRY_POLICY, MODE_TRANSIENCE,
} from '../contracts/failure.contract'
import type { FailureMode, RetryPolicy } from '../contracts/failure.contract'
import type { IHookRegistry, HookContext } from '../contracts/hooks'
import type { ILockManager, LockOwner } from '../contracts/lock'
import { OP_AUDIT_PREFIX, PREDICT_AUDIT_ACTION } from '../contracts/logging'
import type { IAuditLog, ILogger  } from '../contracts/logging'
import type { IPathResolver } from '../contracts/paths'
import type { CalibrationShift } from '../contracts/prediction.contract'
import { applyCalibrationShift, applyDurationCorrection } from '../contracts/prediction.contract'
import type { IReliabilityModel } from '../contracts/reliability.contract'
import type {
  BackupRecord, CleanOperation, CleanRequest, DryRunActionDetail, DryRunReport,
  IBackupStore, ITransactionEngine, IWal, OperationPlan, PlanWarning, TxContext,
  TxPlan, TxSession, TxState, TxSummary,
} from '../contracts/transaction'
import { forEachPool } from '../infra/fs-utils'

export interface EngineDeps {
  readonly lockManager: ILockManager
  readonly wal: IWal
  readonly backups: IBackupStore
  readonly audit: IAuditLog
  readonly resolver: IPathResolver
  readonly logger: ILogger
  readonly hooks: IHookRegistry
  readonly clock: Clock
  /** aggressive 策略的一次性确认令牌校验（令牌签发方在交互层） */
  readonly verifyConfirmationToken?: (token: string, request: CleanRequest) => boolean
  /** 混沌演习注入点：第 crashAfterStep 步成功落盘（step-done WAL + 审计）
   *  后抛 SimulatedCrashError 穿透 commit —— 不回滚、不释放锁，
   *  语义等价于进程在该点断电死亡。仅沙箱演习/测试使用，生产永不注入。 */
  readonly crashAfterStep?: number
  /** V5.4 预测存证：可靠性模型工厂。注入后 commit 执行前把逐步预测
   *  （成功率/耗时）写入 hash chain —— 预测先于结局（时间戳为证）、
   *  事后不可篡改（链哈希），先知从此可被问责（nuke_scorecard 对账）。
   *  统计增强能力：构建/存证失败只记日志，绝不阻断真实清理。 */
  readonly predictor?: () => Promise<IReliabilityModel>
  /** V5.5 自我校准：校准位移工厂（从存证战绩学习的历史偏差）。
   *  注入后存证的 predictedP/predictedDurationMs 为校准后口径 ——
   *  对账因此衡量"修正后的预测"，残差 → 0 则 δ → 0（迭代收敛）。
   *  学习失败 → 不校准（恒等），绝不阻断真实清理。 */
  readonly calibrator?: () => Promise<CalibrationShift | null>
}

/** V5：引擎行为选项（全部缺省安全，不传即沿用 V4 语义） */
export interface TransactionEngineOptions {
  /** dryRun 预演并发度（有界并发池 lane 数），默认 4。
   *  并发只加速 IO 等待，输出仍严格按 plan 顺序收集（索引序而非完成序）。 */
  readonly previewConcurrency?: number
  /** V5.3：步骤级模式感知重试策略。默认 { maxRetries: 2, backoffMs: 150 }：
   *  execute 失败时按失败分类学判定瞬态性 —— 瞬态（EBUSY/超时/句柄耗尽…）
   *  指数退避后自动重试；永久（校验拒绝/权限/依赖缺失…）立即失败回滚。
   *  maxRetries: 0 完全关闭（回到 V4 语义）。 */
  readonly retryPolicy?: RetryPolicy
}

/** V5：步骤运行时形态 —— 在契约步骤之上可选携带 execute 耗时（毫秒）。
 *  durationMs 为本模块新增的可选字段，非字面量赋值对契约消费方结构兼容。 */
export type TxStepWithDuration = TxSummary['steps'][number] & {
  readonly durationMs?: number
}

/** V5：附带各步耗时的事务摘要（TxSummary 的结构化超集，向后兼容） */
export type TxSummaryWithStepTimings = Omit<TxSummary, 'steps'> & {
  readonly steps: readonly TxStepWithDuration[]
}

const DEFAULT_PREVIEW_CONCURRENCY = 4

/** 退避上限：即使 maxRetries 配置得很大，单次等待也不超过 2s ——
 *  重试总时延有物理上界，独占锁不会被无界退避无限占用 */
const MAX_BACKOFF_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 状态机合法迁移表 */
const TRANSITIONS: Record<TxState, readonly TxState[]> = {
  draft: ['planned'],
  planned: ['validating', 'draft'],
  validating: ['executing', 'planned'],
  executing: ['committing', 'rolling-back'],
  committing: ['committed'],
  'rolling-back': ['rolled-back', 'failed'],
  committed: [], 'rolled-back': [], failed: [],
}

interface TxRuntime {
  readonly txId: TxId
  state: TxState
  request: CleanRequest
  steps: TxStepWithDuration[]
  startedAt: string
  finishedAt?: string
  lockHandle: Awaited<ReturnType<ILockManager['acquire']>> extends Result<infer H, unknown> ? H : never
  backupsArea: Awaited<ReturnType<IBackupStore['reserve']>>
  /** operationId → preview 预估回收字节数（plan/dryRun 时填充，
   *  commit 复用 → 步骤审计里的 estimated 零额外 IO；外部直连 commit
   *  未经过 plan 时按需补一次 preview） */
  estimates: Map<string, number>
}

export function createTransactionEngine(
  deps: EngineDeps,
  operationFactory: (request: CleanRequest) => CleanOperation[],
  options: TransactionEngineOptions = {},
): ITransactionEngine {
  const runtimes = new Map<TxId, TxRuntime>()
  /** dryRun 并发度：非法值（0/负/非整数）回退默认，永不产生无界并发 */
  const previewConcurrency = Number.isInteger(options.previewConcurrency) && (options.previewConcurrency ?? 0) >= 1
    ? (options.previewConcurrency!)
    : DEFAULT_PREVIEW_CONCURRENCY
  /** V5.3 步骤级重试：负值/非整数钳制为 0（关闭），永不产生无界重试 */
  const retryMax = Number.isInteger(options.retryPolicy?.maxRetries)
    ? Math.max(0, options.retryPolicy?.maxRetries ?? 0)
    : DEFAULT_RETRY_POLICY.maxRetries
  const retryBackoffMs = Math.max(0, options.retryPolicy?.backoffMs ?? DEFAULT_RETRY_POLICY.backoffMs)
  /** 终结事务摘要缓存（commit/rollback 后仍可 status 查询；进程重启后回退 WAL 重建）。
   *  LRU 上限：长驻进程中无限增长的 Map 是慢性内存泄漏；溢出逐最旧，
   *  被逐条目仍可从 WAL 重建（status 的第三路径）。 */
  const FINISHED_CACHE_MAX = 128
  const finished = new Map<TxId, TxSummary>()
  function rememberFinished(txId: TxId, summary: TxSummary): void {
    // Map 迭代序 = 插入序：删除首个即逐最旧（写前删除使重写条目刷新热度）
    if (finished.has(txId)) finished.delete(txId)
    else if (finished.size >= FINISHED_CACHE_MAX) {
      const oldest = finished.keys().next().value
      if (oldest !== undefined) finished.delete(oldest)
    }
    finished.set(txId, summary)
  }

  function setState(rt: TxRuntime, next: TxState): Result<void> {
    if (!TRANSITIONS[rt.state].includes(next)) {
      return err({
        code: 'E_TX_STATE',
        message: `非法状态迁移: ${rt.state} → ${next}（tx ${rt.txId}）`,
      })
    }
    rt.state = next
    return ok(undefined)
  }

  function makeCtxFromRt(rt: TxRuntime): TxContext {
    return {
      txId: rt.txId,
      request: rt.request,
      resolver: deps.resolver,
      logger: deps.logger.child({ tx: rt.txId }),
      clock: deps.clock,
      backups: rt.backupsArea,
    }
  }

  function hookCtx(txId: TxId, request: CleanRequest, op: CleanOperation, backup?: BackupRecord | null): HookContext {
    return {
      txId,
      actor: request.actor,
      plugin: op.target,
      profile: request.profile,
      strategy: request.strategy,
      action: op.action,
      ...(backup ? { backup } : {}),
    }
  }

  /** Saga 反向补偿：manifest 逆序 restore（幂等），并逐 op 调 undo 做额外清理。
   *  安全纪律：本函数自身绝不抛出 —— 它运行在 commit 的失败分支与 catch 块中，
   *  一旦抛出会跳过外层的锁释放（独占锁悬挂 = 后续所有事务被阻塞直至 TTL）。 */
  async function rollbackRuntime(rt: TxRuntime, reason: string): Promise<void> {
    const move = setState(rt, 'rolling-back')
    if (!move.ok) {
      // 已处于终态（如 'failed'）的再次补偿：状态机拒绝迁移，但补偿动作仍需尽力执行
      deps.logger.warn('回滚状态迁移被拒，继续执行补偿动作', { tx: rt.txId, state: rt.state })
    }
    const ctx = makeCtxFromRt(rt)
    const records = rt.backupsArea.manifest()
    for (const record of [...records].reverse()) {
      try {
        const r = await rt.backupsArea.restore(record)
        if (!r.ok) deps.logger.error('回滚恢复失败', { path: record.originalPath, error: r.error.message })
      } catch (e) {
        deps.logger.error('回滚恢复异常', { path: record.originalPath, error: errorToMessage(e) })
      }
    }
    // undo 钩子（非备份类清理，如 pnpm prune 无需恢复但可通知）
    const executedOps = new Map(rt.steps.filter(s => s.status === 'done').map(s => [s.operationId, s.backup]))
    for (const op of operationFactory(rt.request)) {
      const backup = executedOps.get(op.id) ?? null
      try {
        const undo = await op.undo(ctx, backup)
        if (!undo.ok) deps.logger.warn('op.undo 报告', { op: op.id, error: undo.error.message })
      } catch (e) {
        deps.logger.error('op.undo 异常', { op: op.id, error: errorToMessage(e) })
      }
      rt.steps = rt.steps.map(s => s.operationId === op.id && s.status === 'done' ? { ...s, status: 'undone' } : s)
    }
    try {
      await deps.wal.append(ctx.txId, { type: 'tx-rollback', txId: ctx.txId, reason })
    } catch (e) {
      deps.logger.error('回滚 WAL 追加失败（事务将保持可恢复状态）', { tx: ctx.txId, error: errorToMessage(e) })
    }
    rt.finishedAt = deps.clock.now().toISOString()
    setState(rt, rt.state === 'rolling-back' ? 'rolled-back' : 'failed')
    try {
      await deps.audit.append({
        timestamp: rt.finishedAt, actor: rt.request.actor, action: 'tx-rollback',
        txId: ctx.txId, outcome: 'failure',
        detail: { reason, undone: records.length },
      })
    } catch (e) {
      deps.logger.error('回滚审计追加失败', { tx: ctx.txId, error: errorToMessage(e) })
    }
  }

  /** 事务终结收尾：摘要入缓存 → 释放独占锁 → 移除运行时。
   *  commit/rollback 的所有终态路径（成功/补偿失败/逃逸异常）都必须经过这里，
   *  否则锁悬挂会阻塞后续全部清理事务。 */
  async function finalize(rt: TxRuntime): Promise<void> {
    rememberFinished(rt.txId, summarize(rt, rt.txId))
    await rt.lockHandle.release()
    runtimes.delete(rt.txId)
  }

  function summarize(rt: TxRuntime, txId: TxId): TxSummaryWithStepTimings {
    return {
      txId,
      state: rt.state,
      steps: rt.steps,
      bytesFreedTotal: rt.steps.reduce((sum, s) => sum + (s.bytesFreed || 0), 0),
      startedAt: rt.startedAt,
      ...(rt.finishedAt ? { finishedAt: rt.finishedAt } : {}),
    }
  }

  /** WAL 重建路径的 startedAt：显式定位 tx-begin，不依赖 query 的返回顺序 */
  async function startedAtFromAudit(txId: TxId): Promise<string> {
    try {
      const entries = await deps.audit.query({ txId })
      return entries.find(e => e.action === 'tx-begin')?.timestamp ?? entries[0]?.timestamp ?? ''
    } catch {
      return ''
    }
  }

  /** 步骤审计（可靠性模型的数据源）：action 前缀 OP_AUDIT_PREFIX（契约
   *  单一事实源，读方 reliability.ts 同源导入）区分于事务级条目。
   *  detail 携带 estimated/actual/ratio —— 每一次清理都在训练下一次预测。
   *  审计失败只记日志不阻断事务：统计飞轮是增强能力，不是关键路径。 */
  async function auditStep(
    rt: TxRuntime, op: CleanOperation, outcome: 'success' | 'failure',
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await deps.audit.append({
        timestamp: deps.clock.now().toISOString(),
        actor: rt.request.actor,
        action: `${OP_AUDIT_PREFIX}${op.action}`,
        txId: rt.txId,
        outcome,
        detail,
      })
    } catch (e) {
      deps.logger.warn('步骤审计追加失败（可靠性统计缺此样本）', { tx: rt.txId, op: op.id, error: errorToMessage(e) })
    }
  }

  return {
    async begin(request) {
      // 输入校验由调用层完成；此处只做策略-令牌前置检查
      if (request.strategy === 'aggressive' && !request.confirmationToken) {
        return err({
          code: 'E_VALIDATION',
          message: 'aggressive 策略必须携带 confirmationToken（二次确认）',
        })
      }
      const owner: LockOwner = {
        pid: process.pid,
        hostname: os.hostname(),
        bootToken: crypto.randomBytes(8).toString('hex'),
        purpose: 'clean',
      }
      const acquired = await deps.lockManager.acquire({
        scope: { kind: 'global' }, mode: 'exclusive', owner, waitTimeoutMs: 5000, ttlMs: 300_000,
      })
      if (!acquired.ok) return err(acquired.error)

      const txId = crypto.randomBytes(8).toString('hex') as TxId
      let backupsArea: Awaited<ReturnType<IBackupStore['reserve']>>
      try {
        backupsArea = await deps.backups.reserve(txId)
      } catch (e) {
        // 锁已持有：reserve 失败必须先释放，否则独占锁悬挂阻塞后续全部事务
        await acquired.value.release()
        return err(ioError('备份区预留失败', e))
      }
      const rt: TxRuntime = {
        txId,
        state: 'draft',
        request,
        steps: [],
        startedAt: deps.clock.now().toISOString(),
        lockHandle: acquired.value,
        backupsArea,
        estimates: new Map(),
      }
      runtimes.set(txId, rt)

      await deps.wal.append(txId, { type: 'tx-begin', txId, request })
      await deps.audit.append({
        timestamp: rt.startedAt, actor: request.actor, action: 'tx-begin',
        txId, outcome: 'success',
        detail: { plugins: request.plugins, profile: request.profile, strategy: request.strategy, dryRun: request.dryRun },
      })
      const session: TxSession = { txId, lockId: acquired.value.id, request }
      return ok(session)
    },

    async plan(session) {
      const rt = runtimes.get(session.txId)
      if (!rt) return err({ code: 'E_TX_NOT_FOUND', message: `事务不存在: ${session.txId}` })
      const st = setState(rt, 'planned')
      if (!st.ok) return err(st.error)

      const ctx = makeCtxFromRt(rt)
      const ops = operationFactory(rt.request)
      const warnings: PlanWarning[] = []

      // aggressive 令牌校验（blocking）
      if (rt.request.strategy === 'aggressive') {
        const token = rt.request.confirmationToken ?? ''
        const valid = deps.verifyConfirmationToken
          ? deps.verifyConfirmationToken(token, rt.request)
          : false   // fail-closed：未注入校验器时一律拒绝，绝不退化为长度检查
        if (!valid) {
          warnings.push({
            code: 'CONFIRMATION_TOKEN_INVALID', blocking: true,
            message: 'aggressive 策略确认令牌无效，commit 被阻止',
          })
        }
      }

      let total = 0
      for (const op of ops) {
        const p = await op.preview(ctx)
        rt.estimates.set(op.id, p.estimatedBytesReclaimable)
        total += p.estimatedBytesReclaimable
      }

      const plan: TxPlan = {
        txId: session.txId,
        operations: ops,
        estimatedBytesReclaimable: total,
        warnings,
        requiresConfirmationToken: rt.request.strategy === 'aggressive',
      }
      return ok(plan)
    },

    async dryRun(plan) {
      const rt = runtimes.get(plan.txId)
      if (!rt) return err({ code: 'E_TX_NOT_FOUND', message: `事务不存在: ${plan.txId}` })
      const ctx = makeCtxFromRt(rt)
      // V5：预演并行化（有界并发池）。forEachPool 的结果槽按输入索引填充，
      // 因此无论各 preview 完成先后，输出顺序都与 plan.operations 严格一致。
      const settled = await forEachPool(plan.operations, previewConcurrency,
        async op => ({ op, preview: await op.preview(ctx) }))   // 零副作用
      const reports: { operation: OperationPlan; summary: string }[] = []
      const actionDetails: DryRunActionDetail[] = []
      let total = 0
      let firstFailure: unknown
      for (const r of settled) {
        // 单个 preview 异常不再炸掉整批：结果仍按索引序产出，首个异常统一上报
        if (r.status === 'rejected') {
          if (firstFailure === undefined) firstFailure = r.reason
          continue
        }
        const { op, preview: p } = r.value
        rt.estimates.set(op.id, p.estimatedBytesReclaimable)
        total += p.estimatedBytesReclaimable
        reports.push({ operation: p, summary: p.summary })
        // V4.1：动作级明细（操作集编译器注入了 riskLevel 元数据时填充；旧注入路径保持旧形态）
        if (op.riskLevel !== undefined) {
          actionDetails.push({
            action: op.action,
            target: op.target,
            riskLevel: op.riskLevel,
            description: op.description ?? op.action,
            estimatedBytes: p.estimatedBytesReclaimable,
            ...(p.skipped !== undefined ? { skipped: p.skipped } : {}),
          })
        }
      }
      if (firstFailure !== undefined) {
        return err(ioError('dry-run 预演失败', firstFailure))
      }
      const actions = actionDetails.length > 0 ? actionDetails : undefined
      const report: DryRunReport = {
        txId: plan.txId,
        plans: reports,
        estimatedBytesReclaimable: total,
        warnings: plan.warnings,
        ...(actions ? { actions } : {}),
      }
      await deps.audit.append({
        timestamp: deps.clock.now().toISOString(), actor: rt.request.actor, action: 'dry-run',
        txId: plan.txId, outcome: 'success',
        detail: { operations: reports.length, estimatedBytes: total },
      })
      return ok(report)
    },

    async commit(plan) {
      const rt = runtimes.get(plan.txId)
      if (!rt) return err({ code: 'E_TX_NOT_FOUND', message: `事务不存在: ${plan.txId}` })

      // aggressive 令牌复验：plan 可能由外部构造，其 warnings 字段不可信。
      // 此处以 begin 时登记的 request 为准重新校验，堵死"伪造 plan 跳过令牌"的路径。
      if (rt.request.strategy === 'aggressive') {
        const tokenOk = deps.verifyConfirmationToken && rt.request.confirmationToken !== undefined
          ? deps.verifyConfirmationToken(rt.request.confirmationToken, rt.request)
          : false
        if (!tokenOk) {
          return err({
            code: 'E_VALIDATION',
            message: 'aggressive 策略确认令牌无效，commit 被拒绝（令牌复验失败）',
          })
        }
      }

      // blocking 警告闸门
      const blocking = plan.warnings.find(w => w.blocking)
      if (blocking) {
        return err({ code: 'E_VALIDATION', message: `计划存在阻断性警告: ${blocking.message}` })
      }

      let st = setState(rt, 'validating')
      if (!st.ok) return err(st.error)
      const ctx = makeCtxFromRt(rt)
      const txId = plan.txId

      // 全程兜底：任何逃逸异常（wal.append/钩子/状态机之外的 IO）都必须终结事务，
      // 否则独占锁悬挂直至 TTL，阻塞后续所有清理。
      try {
        // 全量前置校验
        for (const op of plan.operations) {
          const v = await op.validate(ctx)
          if (!v.ok) {
            await rollbackRuntime(rt, `validate 失败: ${op.id}: ${v.error.message}`)
            await finalize(rt)
            return err(v.error)
          }
        }

        st = setState(rt, 'executing')
        if (!st.ok) return err(st.error)

        // ── V5.4 预测存证：执行前把预测写进 hash chain ──────────
        // 先知问责制的根基：预测时刻先于结局时刻（时间戳为证），事后
        // 任何篡改都会被 nuke_verify 检出。存证口径 = 重试感知成功率
        //（引擎将自动重试瞬态失败 —— 预测与执行语义对齐）。
        // V5.5：注入校准器时存证校准后口径（先知与引擎同一套修正 ——
        // 对账衡量修正后预测，残差→0 则 δ→0，迭代收敛）。
        // 统计增强纪律：模型构建/存证失败只记日志，绝不阻断真实清理。
        if (deps.predictor) {
          try {
            const model = await deps.predictor()
            let shift: CalibrationShift | null = null
            if (deps.calibrator) {
              try {
                shift = await deps.calibrator()
              } catch {
                shift = null   // 学习失败 → 不校准（恒等），不阻断
              }
            }
            const stepPredictions = []
            for (const [i, op] of plan.operations.entries()) {
              // 直连 commit（未经 plan/dryRun）时补一次 preview：
              // 存证要带预估量（大小桶调制的协变量），且缓存后步骤
              // 循环内的 lazy preview 变成零 IO —— 存证反而省了一次重复预演
              let est = rt.estimates.get(op.id)
              if (est === undefined) {
                try {
                  const p = await op.preview(ctx)
                  est = p.estimatedBytesReclaimable
                  rt.estimates.set(op.id, est)
                } catch {
                  est = undefined   // preview 失败：存证缺协变量，不阻断
                }
              }
              const r = model.reliabilityOf(
                op.action,
                est !== undefined && est >= 0 ? { sizeBytes: est } : undefined,
              )
              const pRaw = r.retryAdjustedProbability ?? r.successProbability
              const durRaw = r.duration?.p50 ?? null
              stepPredictions.push({
                index: i,
                operationId: op.id,
                action: op.action,
                estimatedBytes: est ?? null,
                predictedP: applyCalibrationShift(pRaw, shift),
                predictedDurationMs: durRaw !== null
                  ? applyDurationCorrection(durRaw, shift)
                  : null,
              })
            }
            const txP = stepPredictions.reduce((acc, s) => acc * s.predictedP, 1)
            await deps.audit.append({
              timestamp: deps.clock.now().toISOString(),
              actor: rt.request.actor,
              action: PREDICT_AUDIT_ACTION,
              txId, outcome: 'success',
              detail: {
                steps: stepPredictions,
                txSuccessProbability: txP,
                // V5.5：记录所应用的校准（存证可解释 —— 这个数字修正过多少）
                ...(shift !== null
                  ? { calibrationDelta: shift.delta, calibrationEvidence: shift.evidence }
                  : {}),
                // 演习事务（人为注入崩溃）标记后不计入战绩 —— 对账纪律
                ...(deps.crashAfterStep !== undefined ? { drill: true } : {}),
              },
            })
          } catch (e) {
            deps.logger.warn('预测存证失败（战绩缺此样本）', { tx: txId, error: errorToMessage(e) })
          }
        }

        for (const [index, op] of plan.operations.entries()) {
          rt.steps.push({ index, operationId: op.id, action: op.action, status: 'pending', bytesFreed: 0, backup: null })
          await deps.wal.append(txId, { type: 'step-intent', index, operationId: op.id, action: op.action, backup: null })

          // pre 钩子（可 veto）
          const pre = await deps.hooks.emit('pre', hookCtx(txId, rt.request, op))
          if (pre.ok && pre.value.verdict.kind === 'veto') {
            rt.steps[index] = { ...rt.steps[index]!, status: 'skipped' }
            await rollbackRuntime(rt, `pre 钩子否决: ${pre.value.verdict.reason}`)
            await finalize(rt)
            return err({ code: 'E_HOOK_VETO', message: `钩子否决: ${pre.value.verdict.reason}` })
          }

          try {
            // 预估回收量：execute 前取（目标还在原位，preview 才准）。
            // plan/dryRun 已缓存 → 通常零额外 IO；外部直连 commit 才补算。
            let estimated = rt.estimates.get(op.id)
            if (estimated === undefined) {
              try {
                const p = await op.preview(ctx)
                estimated = p.estimatedBytesReclaimable
                rt.estimates.set(op.id, estimated)
              } catch {
                estimated = undefined   // preview 失败不影响执行，只是缺校准样本
              }
            }
            const executed = await (async () => {
              // V5：步骤计时 —— execute 前后取注入时钟，耗时随 step-done 审计与摘要下发
              const startedAt = deps.clock.now().getTime()
              // V5.3：步骤级模式感知重试 —— 失败分类学判定瞬态性：
              //   transient（EBUSY/超时/句柄…）→ 指数退避后重试（有界）
              //   permanent（校验/权限/依赖…）→ 立即失败（重试是纯浪费）
              // 计时覆盖全部尝试（含退避等待），审计 detail 记录 retries
              // 与最终 failureMode —— 可靠性模型的 V5.3 学习数据源。
              let retries = 0
              let r = await op.execute(ctx)
              while (!r.ok && retries < retryMax) {
                const mode = classifyFailureMode(r.error.message)
                if (MODE_TRANSIENCE[mode] !== 'transient') break
                retries++
                const wait = Math.min(MAX_BACKOFF_MS, retryBackoffMs * 2 ** (retries - 1))
                deps.logger.info('步骤瞬态失败，自动重试', {
                  tx: txId, op: op.id, mode, retry: retries, max: retryMax, waitMs: wait,
                  error: r.error.message,
                })
                if (wait > 0) await sleep(wait)
                r = await op.execute(ctx)
              }
              const durationMs = Math.max(0, deps.clock.now().getTime() - startedAt)
              return { r, durationMs, retries }
            })()
            if (!executed.r.ok) {
              const failureMode: FailureMode = classifyFailureMode(executed.r.error.message)
              rt.steps[index] = { ...rt.steps[index]!, status: 'failed', backup: null, durationMs: executed.durationMs }
              await deps.wal.append(txId, { type: 'step-failed', index, error: executed.r.error })
              await auditStep(rt, op, 'failure', {
                operationId: op.id, estimated: estimated ?? null,
                error: executed.r.error.message,
                durationMs: executed.durationMs,
                retries: executed.retries,
                failureMode,
              })
              // error 钩子可建议处置
              const errHook = await deps.hooks.emit('error', {
                ...hookCtx(txId, rt.request, op), error: executed.r.error,
              })
              const directive = errHook.ok ? errHook.value.errorDirective : null
              if (directive === 'skip-and-continue') {
                rt.steps[index] = { ...rt.steps[index]!, status: 'skipped', durationMs: executed.durationMs }
                continue
              }
              await rollbackRuntime(rt, `步骤 ${index}(${op.id}) 失败: ${executed.r.error.message}`)
              await finalize(rt)
              return err(executed.r.error)
            }
            const { outcome, backup } = executed.r.value
            rt.steps[index] = {
              ...rt.steps[index]!, status: 'done', bytesFreed: outcome.bytesFreed, backup,
              durationMs: executed.durationMs,
            }
            await deps.wal.append(txId, { type: 'step-done', index, operationId: op.id, outcome, backup })
            await auditStep(rt, op, 'success', {
              operationId: op.id,
              estimated: estimated ?? null,
              actual: outcome.bytesFreed,
              durationMs: executed.durationMs,
              // V5.3：重试后成功是宝贵证据（瞬态失败被引擎自愈）——
              // retries>0 的成功样本让"重试调整投影"有据可依
              ...(executed.retries > 0 ? { retries: executed.retries } : {}),
              ...(estimated !== undefined && estimated > 0
                ? { ratio: outcome.bytesFreed / estimated }
                : {}),
            })
            await deps.hooks.emit('post', hookCtx(txId, rt.request, op, backup))
            // 混沌演习注入点：step-done WAL + 审计已落盘，此刻"断电"
            if (deps.crashAfterStep === index) {
              throw new SimulatedCrashError(txId, index)
            }
          } catch (e) {
            if (e instanceof SimulatedCrashError) throw e   // 穿透：模拟进程死亡
            await rollbackRuntime(rt, `步骤 ${index}(${op.id}) 异常: ${errorToMessage(e)}`)
            await finalize(rt)
            return err(ioError('事务执行失败', e))
          }
        }

        st = setState(rt, 'committing')
        if (!st.ok) return err(st.error)
        await deps.wal.append(txId, { type: 'tx-commit', txId })
        rt.finishedAt = deps.clock.now().toISOString()
        setState(rt, 'committed')
        await deps.audit.append({
          timestamp: rt.finishedAt, actor: rt.request.actor, action: 'tx-commit',
          txId, outcome: 'success',
          detail: {
            steps: rt.steps.length,
            bytesFreed: rt.steps.reduce((s, x) => s + x.bytesFreed, 0),
          },
        })
        // 释放锁：事务终结
        await finalize(rt)
        return ok(summarize(rt, txId))
      } catch (e) {
        // 混沌演习：模拟进程死亡 —— 不补偿、不释放锁、不写终结审计，
        // 由演习方（nuke_drill）捕获后走真实崩溃恢复路径（recover()）
        if (e instanceof SimulatedCrashError) throw e
        // rollbackRuntime 已保证不抛；此处兜住其余一切逃逸（WAL/审计/钩子 IO）
        try { await rollbackRuntime(rt, `commit 逃逸异常: ${errorToMessage(e)}`) } catch { /* 不可达 */ }
        await finalize(rt)
        return err(ioError('事务执行失败', e))
      }
    },

    async rollback(txId) {
      const rt = runtimes.get(txId)
      if (!rt) return err({ code: 'E_TX_NOT_FOUND', message: `事务不存在: ${txId}` })
      if (rt.state === 'committed' || rt.state === 'rolled-back') {
        return err({ code: 'E_TX_STATE', message: `事务已终结（${rt.state}），无法回滚` })
      }
      try {
        await rollbackRuntime(rt, '手动回滚')
      } finally {
        await finalize(rt)
      }
      return ok(summarize(rt, txId))
    },

    async recover() {
      const recovered: TxSummary[] = []
      for (const txId of deps.wal.unfinishedTxIds()) {
        if (runtimes.has(txId)) continue   // 活跃事务跳过
        // 单事务隔离：一个事务的 IO 异常不中断其余事务的恢复
        try {
          // 步骤清单从 WAL step-intent 重建（含 operationId 与 action）
          const records = await deps.wal.replay(txId)
          const intents = records.filter(
            (r): r is Extract<typeof r, { type: 'step-intent' }> => r.type === 'step-intent',
          )
          // 从备份区 manifest 逆序恢复（崩溃时备份依据不依赖内存）
          const area = await deps.backups.reserve(txId)
          const manifest = area.manifest()
          let restoreFailures = 0
          for (const record of [...manifest].reverse()) {
            try {
              const r = await area.restore(record)
              if (!r.ok) restoreFailures++
            } catch {
              restoreFailures++
            }
          }
          if (restoreFailures > 0 || area.orphanArtifacts() > 0) {
            // 关键安全纪律：restore 未全部成功、或备份区存在 manifest 未覆盖的
            // 崩溃残留产物时绝不 purge —— 这些产物可能是数据唯一完整副本
            // （stageDir 已把原位移走），purge 即永久丢失。同时不写
            // tx-rollback，保持事务"未终结"，下次 recover 自动重试。
            deps.logger.error('崩溃恢复存在失败项/孤儿产物：备份保留待人工核查/下次重试', {
              txId, failures: restoreFailures, orphans: area.orphanArtifacts(), total: manifest.length,
            })
            recovered.push({
              txId, state: 'failed',
              steps: intents.map(r => ({
                index: r.index, operationId: r.operationId, action: r.action,
                status: 'undone' as const, bytesFreed: 0, backup: null,
              })),
              bytesFreedTotal: 0,
              startedAt: await startedAtFromAudit(txId),
            })
            continue
          }
          await deps.wal.append(txId, { type: 'tx-rollback', txId, reason: 'crash-recovery' })
          await area.purge(txId)
          const summary: TxSummary = {
            txId,
            state: 'rolled-back',
            steps: intents.map(r => ({
              index: r.index, operationId: r.operationId, action: r.action,
              status: 'undone' as const, bytesFreed: 0, backup: null,
            })),
            bytesFreedTotal: 0,
            startedAt: await startedAtFromAudit(txId),
          }
          recovered.push(summary)
          deps.logger.info('崩溃恢复完成', { txId, restored: manifest.length })
        } catch (e) {
          deps.logger.error('崩溃恢复事务异常，跳过', { txId, error: errorToMessage(e) })
        }
      }
      return ok(recovered)
    },

    async status(txId) {
      const rt = runtimes.get(txId)
      if (rt) return summarize(rt, txId)
      const cached = finished.get(txId)
      if (cached) {
        // 读刷新热度（真 LRU 语义）：删除重插 = 移到 MRU 端
        finished.delete(txId)
        finished.set(txId, cached)
        return cached
      }
      // 进程重启后的终结事务：从 WAL 重建（尽力而为）
      const records = await deps.wal.replay(txId)
      if (records.length === 0) return null
      const begin = records.find(r => r.type === 'tx-begin')
      if (begin?.type !== 'tx-begin') return null
      // step-done 记录不含 action：以 step-intent 的 action 按 index 关联回填，
      // 否则所有步骤都会被误报为 standard-remove
      const actionByIndex = new Map<number, string>()
      for (const r of records) {
        if (r.type === 'step-intent') actionByIndex.set(r.index, r.action)
      }
      const steps = records
        .filter((r): r is Extract<typeof r, { type: 'step-done' }> => r.type === 'step-done')
        .map(r => ({
          index: r.index, operationId: r.operationId,
          action: (actionByIndex.get(r.index) ?? 'standard-remove') as 'standard-remove',
          status: 'done' as const, bytesFreed: r.outcome.bytesFreed, backup: r.backup,
        }))
      const state: TxState = records.some(r => r.type === 'tx-commit') ? 'committed'
        : records.some(r => r.type === 'tx-rollback') ? 'rolled-back' : 'failed'
      return {
        txId,
        state,
        steps,
        bytesFreedTotal: steps.reduce((s, x) => s + x.bytesFreed, 0),
        startedAt: await startedAtFromAudit(txId),
      }
    },
  }
}

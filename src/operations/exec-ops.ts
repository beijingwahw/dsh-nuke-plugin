// src/operations/exec-ops.ts — 外部命令类操作（dsh 标准卸载 / pnpm store prune）
// 这类操作的副作用发生在外部进程，无法本地备份；undo 语义为"补偿提示"而非文件恢复。
// 命令执行经注入的 CommandRunner（默认 spawnSync），argv 数组形态、无 shell。
//
// V4 升级：
//   1. 瞬态重试 —— spawn 失败且错误码可重试（EAGAIN/超时/句柄耗尽类）时最多退避重试 2 次；
//      非瞬态失败（如 ENOENT 命令不存在）立即失败，不做无意义重试
//   2. 超时上限 —— 单命令超时钳制在 MAX_COMMAND_TIMEOUT_MS 内，超时 fail-closed
//      返回 err 而非挂死；重试耗尽仍超时同样 err
//   3. 输出结构化 —— stdout/stderr/exitCode/durationMs/attempts 进入 preview（探针）
//      与 execute（真实命令）的 detail，随 step-done 落 WAL/审计链
import { spawnSync } from 'child_process'
import type { NukeError, PluginName, ProfileName, Result } from '../contracts/base'
import { err, ok } from '../contracts/base'
import type {
  CleanOperation, CommandExecutionDetail, ExecutedStep, OperationPlan, TxContext,
} from '../contracts/transaction'
import type { IInputValidator } from '../contracts/validation'

/** 命令运行器返回形态（error/signal 为 V4 增量可选字段，旧注入实现无需改动） */
export interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** spawn 层错误（如 ENOENT/EAGAIN/ETIMEDOUT）；缺省 = 运行器未提供 */
  readonly error?: unknown
  /** 子进程被信号终止时的信号名（spawnSync 超时默认 SIGTERM） */
  readonly signal?: string | null
}

export type CommandRunner = (
  cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number },
) => CommandResult

/** spawnSync 包装：归一化 stdout/stderr（spawn 失败时可能为 null），
 *  调用方拿到的永远是 string —— 消灭各调用点的 String(x || '') 兜底重复。
 *  V4：透传 error/signal 供瞬态判定与超时识别。 */
export const defaultCommandRunner: CommandRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, encoding: 'utf-8', timeout: opts.timeoutMs,
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.signal !== null ? { signal: r.signal } : {}),
  }
}

// ─── V4：瞬态重试与超时纪律 ─────────────────────────────────

/** 单命令超时硬上限（5 分钟）：任何配置值都被钳制在此之下，
 *  保证最坏情况（首跑 + 2 次重试全超时）也有界，绝不无限挂死。 */
export const MAX_COMMAND_TIMEOUT_MS = 300_000

/** 视为瞬态可重试的 spawn 错误码（EAGAIN/超时类）。
 *  ENOENT（命令不存在）是永久性错误，重试毫无意义 —— 不在列表中。 */
const RETRYABLE_ERRNOS: ReadonlySet<string> = new Set([
  'EAGAIN',      // 资源暂不可用
  'ETIMEDOUT',   // 命令超时被终止
  'EMFILE',      // 进程级句柄耗尽
  'ENFILE',      // 系统级文件表满
  'EINTR',       // 被信号打断
  'EBUSY',       // 资源占用（Windows 常见）
])

/** 结构化捕获中 stdout/stderr 的截断上限（字节级安全边界：WAL/审计链不容噪声膨胀） */
const MAX_CAPTURE_CHARS = 4_000

/** 瞬态重试策略 */
export interface CommandRetryPolicy {
  /** 重试次数上限（不含首次执行），默认 2 */
  readonly maxRetries: number
  /** 首次退避基准（ms）；第 k 次重试前等待 base×2^(k-1) */
  readonly baseDelayMs: number
}

export const DEFAULT_RETRY_POLICY: CommandRetryPolicy = { maxRetries: 2, baseDelayMs: 25 }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 判定一次命令结果是否值得重试：
 *  - 有退出码（status !== null）= 命令跑完自己失败了 → 不重试（业务失败）
 *  - status === null 且 error.code 命中瞬态集合 → 重试
 *  - status === null 且无 error 信息（自定义运行器/被信号击杀）→ 重试
 *    （fail-safe：拿不到根因时宁可多试一次，也不把可自愈抖动升级为用户可见错误） */
function isRetryable(r: CommandResult): boolean {
  if (r.status !== null) return false
  const code = (r.error as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string') return RETRYABLE_ERRNOS.has(code)
  return true
}

/** 是否因超时终止：spawnSync 超时以 ETIMEDOUT 错误码或 SIGTERM 信号呈现 */
function isTimedOut(r: CommandResult): boolean {
  const code = (r.error as { code?: unknown } | null | undefined)?.code
  return code === 'ETIMEDOUT' || r.signal === 'SIGTERM'
}

/** 带瞬态重试的命令执行：返回结构化捕获（含总尝试次数与总耗时） */
export async function runCommandWithRetry(
  run: CommandRunner,
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs: number },
  retry: CommandRetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<CommandExecutionDetail> {
  // 超时上限钳制：配置值再大也不能突破硬顶（fail-closed 的物理保证）
  const timeoutMs = Math.min(Math.max(1, Math.round(opts.timeoutMs)), MAX_COMMAND_TIMEOUT_MS)
  const startedAt = Date.now()
  let attempts = 0
  let last: CommandResult
  for (;;) {
    attempts++
    last = run(cmd, args, { ...(opts.cwd ? { cwd: opts.cwd } : {}), timeoutMs })
    if (!isRetryable(last) || attempts > retry.maxRetries) break
    await sleep(Math.min(1_000, retry.baseDelayMs * 2 ** (attempts - 1)))
  }
  return {
    cmd,
    args,
    exitCode: last.status,
    stdout: last.stdout.slice(0, MAX_CAPTURE_CHARS),
    stderr: last.stderr.slice(0, MAX_CAPTURE_CHARS),
    durationMs: Date.now() - startedAt,
    attempts,
    timedOut: isTimedOut(last),
  }
}

export interface ExecOpOptions {
  readonly validator: IInputValidator
  readonly runCommand?: CommandRunner
  readonly commandTimeoutMs?: number
  /** V4 增量：瞬态重试策略（缺省 = 最多 2 次退避重试） */
  readonly retry?: CommandRetryPolicy
}

/** 失败路径的统一错误构造：结构化捕获进 details（审计链可见） */
function commandError(context: string, cap: CommandExecutionDetail): NukeError {
  const tail = (cap.stderr || cap.stdout).trim().slice(0, 200)
  const message = cap.timedOut
    ? `${context}超时（${cap.durationMs}ms / 上限 ${MAX_COMMAND_TIMEOUT_MS}ms 内未完成，fail-closed 拒绝）`
    : `${context}失败（exit ${cap.exitCode}）: ${tail}`
  return {
    code: 'E_IO',
    message,
    details: { command: cap },
  }
}

// ─── standard-remove ───────────────────────────────────────

export function makeStandardRemoveOp(
  target: PluginName, profile: ProfileName, options: ExecOpOptions,
): CleanOperation {
  const run = options.runCommand ?? defaultCommandRunner
  const timeoutMs = options.commandTimeoutMs ?? 60_000
  const retry = options.retry ?? DEFAULT_RETRY_POLICY

  return {
    id: `op-standard-remove:${target}`,
    action: 'standard-remove',
    target,

    async preview(): Promise<OperationPlan> {
      // 只读探针（--version）：dry-run 报告即可见 CLI 可用性与版本输出，零副作用
      const probe = await runCommandWithRetry(run, 'dsh', ['--version'], { timeoutMs: 5_000 }, retry)
      const probeNote = probe.exitCode === 0
        ? `（CLI 探针 ${probe.durationMs}ms）`
        : `（⚠ CLI 探针 exit=${probe.exitCode ?? 'null'}，validate 将复核）`
      return {
        summary: `dsh plugin --profile ${profile} remove ${target}（标准卸载）${probeNote}`,
        touchedPaths: [],
        estimatedBytesReclaimable: 0,
        requiresExclusiveLock: true,   // 触发外部包管理，独占
        command: probe,
      }
    },

    async validate(): Promise<Result<void, NukeError>> {
      const name = options.validator.validatePluginName(target)
      if (!name.ok) {
        return err({
          code: 'E_VALIDATION',
          message: `插件名非法: ${target}`,
          details: { violations: name.error },
        })
      }
      const prof = options.validator.validateProfileName(profile)
      if (!prof.ok) {
        return err({
          code: 'E_VALIDATION',
          message: `profile 名非法: ${profile}`,
          details: { violations: prof.error },
        })
      }
      const probe = await runCommandWithRetry(run, 'dsh', ['--version'], { timeoutMs: 5_000 }, retry)
      if (probe.exitCode !== 0) {
        return err({
          code: 'E_IO',
          message: 'dsh CLI 不可用（standard-remove 需要 dsh 在 PATH 中）',
          details: { command: probe },
        })
      }
      return ok(undefined)
    },

    async execute(): Promise<Result<ExecutedStep, NukeError>> {
      const cap = await runCommandWithRetry(
        run, 'dsh', ['plugin', '--profile', profile, 'remove', target], { timeoutMs }, retry,
      )
      if (cap.exitCode !== 0) {
        return err(commandError('dsh 卸载', cap))
      }
      return ok({
        outcome: {
          bytesFreed: 0,
          message: `标准卸载完成: ${target}（${cap.attempts} 次尝试，${cap.durationMs}ms）`,
          command: cap,
        },
        backup: null,   // 外部系统副作用，undo 为补偿提示
      })
    },

    async undo(): Promise<Result<void, NukeError>> {
      // 外部进程操作不可本地恢复；补偿动作 = 重新安装提示（不自动执行，防副作用放大）
      return ok(undefined)
    },
  }
}

// ─── pnpm-store-prune（aggressive 专属，全局一次） ─────────

export function makePnpmPruneOp(
  profile: ProfileName, profileDirOf: (ctx: TxContext) => string, options: ExecOpOptions,
): CleanOperation {
  const run = options.runCommand ?? defaultCommandRunner
  const timeoutMs = options.commandTimeoutMs ?? 120_000
  const retry = options.retry ?? DEFAULT_RETRY_POLICY

  return {
    id: 'op-pnpm-store-prune:global',
    action: 'pnpm-store-prune',
    target: '*store*' as PluginName,

    async preview(): Promise<OperationPlan> {
      // 只读探针：与 standard-remove 同纪律
      const probe = await runCommandWithRetry(run, 'pnpm', ['--version'], { timeoutMs: 5_000 }, retry)
      const probeNote = probe.exitCode === 0
        ? `（CLI 探针 ${probe.durationMs}ms）`
        : `（⚠ CLI 探针 exit=${probe.exitCode ?? 'null'}，validate 将复核）`
      return {
        summary: `pnpm store prune（清理 profile ${profile} 关联的 pnpm 全局 store 未引用包）${probeNote}`,
        touchedPaths: [],
        estimatedBytesReclaimable: 0,   // 体量由 pnpm 决定，无法预估
        requiresExclusiveLock: true,
        command: probe,
      }
    },

    async validate(): Promise<Result<void, NukeError>> {
      const probe = await runCommandWithRetry(run, 'pnpm', ['--version'], { timeoutMs: 5_000 }, retry)
      if (probe.exitCode !== 0) {
        return err({
          code: 'E_IO',
          message: 'pnpm CLI 不可用（pnpm-store-prune 需要 pnpm 在 PATH 中）',
          details: { command: probe },
        })
      }
      return ok(undefined)
    },

    async execute(ctx): Promise<Result<ExecutedStep, NukeError>> {
      const cap = await runCommandWithRetry(
        run, 'pnpm', ['store', 'prune'], { cwd: profileDirOf(ctx), timeoutMs }, retry,
      )
      if (cap.exitCode !== 0) {
        return err(commandError('pnpm store prune', cap))
      }
      return ok({
        outcome: {
          bytesFreed: 0,
          message: `pnpm store prune 完成（实际回收以 pnpm 输出为准；${cap.attempts} 次尝试，${cap.durationMs}ms）`,
          command: cap,
        },
        backup: null,
      })
    },

    async undo(): Promise<Result<void, NukeError>> { return ok(undefined) },
  }
}

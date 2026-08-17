// src/operations/exec-ops.ts — 外部命令类操作（dsh 标准卸载 / pnpm store prune）
// 这类操作的副作用发生在外部进程，无法本地备份；undo 语义为"补偿提示"而非文件恢复。
// 命令执行经注入的 CommandRunner（默认 spawnSync），argv 数组形态、无 shell。
import { spawnSync } from 'child_process'
import type { NukeError, PluginName, ProfileName, Result } from '../contracts/base'
import { err, ok } from '../contracts/base'
import type {
  CleanOperation, ExecutedStep, OperationPlan, TxContext,
} from '../contracts/transaction'
import type { IInputValidator } from '../contracts/validation'

export type CommandRunner = (
  cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number },
) => { status: number | null; stdout: string; stderr: string }

/** spawnSync 包装：归一化 stdout/stderr（spawn 失败时可能为 null），
 *  调用方拿到的永远是 string —— 消灭各调用点的 String(x || '') 兜底重复。 */
export const defaultCommandRunner: CommandRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, encoding: 'utf-8', timeout: opts.timeoutMs,
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

export interface ExecOpOptions {
  readonly validator: IInputValidator
  readonly runCommand?: CommandRunner
  readonly commandTimeoutMs?: number
}

// ─── standard-remove ───────────────────────────────────────

export function makeStandardRemoveOp(
  target: PluginName, profile: ProfileName, options: ExecOpOptions,
): CleanOperation {
  const run = options.runCommand ?? defaultCommandRunner
  const timeoutMs = options.commandTimeoutMs ?? 60_000

  return {
    id: `op-standard-remove:${target}`,
    action: 'standard-remove',
    target,

    async preview(): Promise<OperationPlan> {
      return {
        summary: `dsh plugin --profile ${profile} remove ${target}（标准卸载）`,
        touchedPaths: [],
        estimatedBytesReclaimable: 0,
        requiresExclusiveLock: true,   // 触发外部包管理，独占
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
      const probe = run('dsh', ['--version'], { timeoutMs: 5000 })
      if (probe.status !== 0) {
        return err({ code: 'E_IO', message: 'dsh CLI 不可用（standard-remove 需要 dsh 在 PATH 中）' })
      }
      return ok(undefined)
    },

    async execute(): Promise<Result<ExecutedStep, NukeError>> {
      const r = run('dsh', ['plugin', '--profile', profile, 'remove', target], { timeoutMs })
      if (r.status !== 0) {
        return err({
          code: 'E_IO',
          message: `dsh 卸载失败（exit ${r.status}）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
        })
      }
      return ok({
        outcome: { bytesFreed: 0, message: `标准卸载完成: ${target}` },
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

  return {
    id: 'op-pnpm-store-prune:global',
    action: 'pnpm-store-prune',
    target: '*store*' as PluginName,

    async preview(): Promise<OperationPlan> {
      return {
        summary: `pnpm store prune（清理 profile ${profile} 关联的 pnpm 全局 store 未引用包）`,
        touchedPaths: [],
        estimatedBytesReclaimable: 0,   // 体量由 pnpm 决定，无法预估
        requiresExclusiveLock: true,
      }
    },

    async validate(): Promise<Result<void, NukeError>> {
      const probe = run('pnpm', ['--version'], { timeoutMs: 5000 })
      if (probe.status !== 0) {
        return err({ code: 'E_IO', message: 'pnpm CLI 不可用（pnpm-store-prune 需要 pnpm 在 PATH 中）' })
      }
      return ok(undefined)
    },

    async execute(ctx): Promise<Result<ExecutedStep, NukeError>> {
      const r = run('pnpm', ['store', 'prune'], { cwd: profileDirOf(ctx), timeoutMs })
      if (r.status !== 0) {
        return err({
          code: 'E_IO',
          message: `pnpm store prune 失败（exit ${r.status}）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
        })
      }
      return ok({
        outcome: { bytesFreed: 0, message: 'pnpm store prune 完成（实际回收以 pnpm 输出为准）' },
        backup: null,
      })
    },

    async undo(): Promise<Result<void, NukeError>> { return ok(undefined) },
  }
}

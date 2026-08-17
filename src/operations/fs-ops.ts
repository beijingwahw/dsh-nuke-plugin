// src/operations/fs-ops.ts — 目录/文件物理清理（node_modules / storages / attachments / TEMP）
// 安全链：validate 阶段 assertDeletable 白名单闸门；
// execute 阶段目录走 stageDir（原子改名进回收区，O(1) 可逆），TEMP 文件走 stageFile+unlink。
import * as fs from 'fs'
import * as path from 'path'
import type { AbsolutePath, NukeError, PluginName, Result } from '../contracts/base'
import { err, errorToMessage, ioError, ok } from '../contracts/base'
import type {
  CleanOperation, ExecutedStep, OperationPlan, TxContext,
} from '../contracts/transaction'
import type { PathPolicy } from '../contracts/paths'
import { dirSize, existsSafe, tempOrphanEntries } from '../infra/fs-utils'

const DENY = ['**/@deepseek-ai/dsh-base*', '**/.nuke/**', '**/node_modules/.pnpm/**']

interface DirOpSpec {
  readonly id: string
  readonly action: 'remove-node-modules' | 'remove-storages' | 'remove-attachments'
  readonly target: PluginName
  readonly dirOf: (ctx: TxContext) => string
  readonly description: string
  readonly policy: PathPolicy
}

export function makeDirRemoveOp(spec: DirOpSpec): CleanOperation {
  return {
    id: `${spec.id}:${spec.target}`,
    action: spec.action,
    target: spec.target,

    async preview(ctx): Promise<OperationPlan> {
      const dir = spec.dirOf(ctx)
      if (!existsSafe(dir)) {
        return {
          summary: `${spec.description}: 目录不存在，跳过（${dir}）`,
          touchedPaths: [], estimatedBytesReclaimable: 0, requiresExclusiveLock: false,
        }
      }
      const bytes = dirSize(dir)
      return {
        summary: `${spec.description}: ${dir}（${bytes} 字节 → 回收区）`,
        touchedPaths: [dir as AbsolutePath],
        estimatedBytesReclaimable: bytes,
        requiresExclusiveLock: false,
      }
    },

    async validate(ctx): Promise<Result<void, NukeError>> {
      // 路径策略先于存在性检查：目录不存在也要先过白名单闸门（纵深防御）
      const dir = spec.dirOf(ctx)
      const check = await ctx.resolver.assertDeletable(dir, spec.policy)
      if (!check.ok) return check
      return ok(undefined)
    },

    async execute(ctx): Promise<Result<ExecutedStep, NukeError>> {
      const dir = spec.dirOf(ctx)
      if (!existsSafe(dir)) {
        return ok({ outcome: { bytesFreed: 0, message: '目录不存在，跳过' }, backup: null })
      }
      try {
        const backup = await ctx.backups.stageDir(dir as AbsolutePath)
        // 字节复用：stageDir 的 fingerprintOf 已计算目录体积，
        // 再调 dirSize 意味着同一目录二次全量遍历（大目录 = 秒级浪费）
        return ok({
          outcome: { bytesFreed: backup.fingerprint.size, message: `${spec.description}: 已移入回收区` },
          backup,
        })
      } catch (e) {
        return err(ioError(`${spec.description} 失败`, e))
      }
    },

    async undo(ctx, record): Promise<Result<void, NukeError>> {
      if (!record) return ok(undefined)
      return ctx.backups.restore(record)
    },
  }
}

/** 便捷构造：单插件的三个目录清理操作 */
export function dirRemoveOps(
  target: PluginName, profile: string, dshHomeOf: (ctx: TxContext) => string,
): CleanOperation[] {
  const profileScoped: PathPolicy = {
    allowedRoots: [{ kind: 'profile-dir', profile }],
    denyGlobs: DENY, strictWindows: true,
  }
  const storagesPolicy: PathPolicy = {
    allowedRoots: [{ kind: 'storages' }],
    denyGlobs: DENY, strictWindows: true,
  }
  const attachmentsPolicy: PathPolicy = {
    allowedRoots: [{ kind: 'attachments' }],
    denyGlobs: DENY, strictWindows: true,
  }
  return [
    makeDirRemoveOp({
      id: 'op-remove-node-modules', action: 'remove-node-modules', target,
      dirOf: ctx => path.join(dshHomeOf(ctx), 'profiles', profile, 'node_modules', ...target.split('/')),
      description: '移除 node_modules 包目录', policy: profileScoped,
    }),
    makeDirRemoveOp({
      id: 'op-remove-storages', action: 'remove-storages', target,
      dirOf: ctx => path.join(dshHomeOf(ctx), 'storages', target),
      description: '移除 storages 持久化数据', policy: storagesPolicy,
    }),
    makeDirRemoveOp({
      id: 'op-remove-attachments', action: 'remove-attachments', target,
      dirOf: ctx => path.join(dshHomeOf(ctx), 'attachments', 'v1', target),
      description: '移除 attachments 会话附件', policy: attachmentsPolicy,
    }),
  ]
}

// ─── TEMP 孤儿清理（aggressive 专属） ─────────────────────

export interface PurgeTempOptions {
  readonly tempRoot: string
  readonly ttlDays?: number
  readonly now?: () => Date
  readonly markerRe?: RegExp
}

const DEFAULT_MARKER = /dsh|deepseek|cordis/i

export function makePurgeTempOp(options: PurgeTempOptions): CleanOperation {
  const ttlDays = options.ttlDays ?? 7
  const now = options.now ?? (() => new Date())
  const marker = options.markerRe ?? DEFAULT_MARKER

  /** 共享实现（fs-utils.tempOrphanEntries）：标记 + 期限 + 体积，符号链接排除 */
  const staleEntries = () =>
    tempOrphanEntries(options.tempRoot, ttlDays, now, marker)
      .map(e => ({ entry: e.path, isDir: e.isDir, size: e.sizeBytes }))

  return {
    id: 'op-purge-temp:global',
    action: 'purge-temp',
    target: '*temp*' as PluginName,

    async preview(): Promise<OperationPlan> {
      const entries = staleEntries()
      const bytes = entries.reduce((s, e) => s + e.size, 0)
      return {
        summary: `TEMP 孤儿清理: ${entries.length} 个过期条目（≥${ttlDays} 天，${bytes} 字节）`,
        touchedPaths: entries.map(e => e.entry as AbsolutePath),
        estimatedBytesReclaimable: bytes,
        requiresExclusiveLock: false,
      }
    },

    async validate(): Promise<Result<void, NukeError>> { return ok(undefined) },

    async execute(ctx): Promise<Result<ExecutedStep, NukeError>> {
      const entries = staleEntries()
      if (entries.length === 0) {
        return ok({ outcome: { bytesFreed: 0, message: '无过期 TEMP 条目' }, backup: null })
      }
      let bytes = 0
      let backup = null
      const failures: string[] = []
      for (const e of entries) {
        try {
          if (e.isDir) {
            const rec = await ctx.backups.stageDir(e.entry as AbsolutePath)
            backup = backup ?? rec
            bytes += e.size
          } else {
            const rec = await ctx.backups.stageFile(e.entry as AbsolutePath)
            backup = backup ?? rec
            fs.unlinkSync(e.entry)
            bytes += e.size
          }
        } catch (err2) {
          failures.push(`${e.entry}: ${errorToMessage(err2)}`)
        }
      }
      if (failures.length > 0 && bytes === 0) {
        return err({ code: 'E_IO', message: `TEMP 清理全部失败: ${failures.join('; ')}` })
      }
      return ok({
        outcome: {
          bytesFreed: bytes,
          message: `TEMP 清理 ${entries.length - failures.length}/${entries.length} 条${failures.length > 0 ? `（失败 ${failures.length}）` : ''}`,
        },
        backup,
      })
    },

    async undo(ctx, record): Promise<Result<void, NukeError>> {
      if (!record) return ok(undefined)
      return ctx.backups.restore(record)
    },
  }
}

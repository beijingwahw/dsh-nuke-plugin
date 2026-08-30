// src/operations/fs-ops.ts — 目录/文件物理清理（node_modules / storages / attachments / TEMP）
// 安全链：validate 阶段 assertDeletable 白名单闸门；
// execute 阶段目录走 stageDir（原子改名进回收区，O(1) 可逆），TEMP 文件走 stageFile+unlink。
//
// V4 升级：
//   1. preview 增强 —— 目录存在时给出 top-N 大文件/子目录明细（N 默认 5，可配），
//      dry-run 报告即可展示影响面（谁占了大头、动的是哪些子目录）
//   2. 幂等 skip 语义 —— 目标缺失时 preview/execute 均标记 skipped，
//      不报错、不产生空操作（机器可读，供上层统计与展示）
import * as fs from 'fs'
import * as path from 'path'

import type { AbsolutePath, NukeError, PluginName, Result } from '../contracts/base'
import { err, errorToMessage, ioError, ok } from '../contracts/base'
import type { PathPolicy } from '../contracts/paths'
import type {
  BackupRecord, CleanOperation, DirImpactDetail, DirImpactEntry, ExecutedStep,
  OperationPlan, TxContext,
} from '../contracts/transaction'
import { dirSize, dirStats, existsSafe, tempOrphanEntries } from '../infra/fs-utils'

const DENY = ['**/@deepseek-ai/dsh-base*', '**/.nuke/**', '**/node_modules/.pnpm/**']

/** preview 影响面明细的默认条目数（top-N 大文件/子目录各取 N 条） */
export const DEFAULT_IMPACT_TOP_N = 5

interface DirOpSpec {
  readonly id: string
  readonly action: 'remove-node-modules' | 'remove-storages' | 'remove-attachments'
  readonly target: PluginName
  readonly dirOf: (ctx: TxContext) => string
  readonly description: string
  readonly policy: PathPolicy
  /** V4 增量：preview 影响面明细条目数，缺省 5 */
  readonly topN?: number
}

/** 目录直接子项的体积画像：文件取 statSync.size，子目录取递归 dirSize。
 *  fail-soft：任何条目读不到按 0 计、整体失败返回空明细（preview 不因探测失败而炸）。 */
function topSizeEntries(dir: string, limit: number): Pick<DirImpactDetail, 'topFiles' | 'topDirs'> {
  const files: DirImpactEntry[] = []
  const dirs: DirImpactEntry[] = []
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      try {
        if (e.isFile()) {
          files.push({ path: full as AbsolutePath, bytes: fs.statSync(full).size })
        } else if (e.isDirectory()) {
          dirs.push({ path: full as AbsolutePath, bytes: dirSize(full) })
        }
        // 符号链接与其他类型不计入影响面（与 dirSize 的"链接不跟随"纪律一致）
      } catch { /* 单条目读不到按缺省跳过 */ }
    }
  } catch { return { topFiles: [], topDirs: [] } }
  const byBytesDesc = (a: DirImpactEntry, b: DirImpactEntry) => b.bytes - a.bytes
  return {
    topFiles: [...files].sort(byBytesDesc).slice(0, limit),
    topDirs: [...dirs].sort(byBytesDesc).slice(0, limit),
  }
}

export function makeDirRemoveOp(spec: DirOpSpec): CleanOperation {
  const topN = spec.topN ?? DEFAULT_IMPACT_TOP_N
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
          skipped: true,
        }
      }
      const { bytes, fileCount } = dirStats(dir)
      // V4：top-N 影响面明细（一次 readdir + 逐子项 stat；子目录递归体积复用 dirSize 纪律）
      const { topFiles, topDirs } = topSizeEntries(dir, topN)
      const impact: DirImpactDetail = { dir: dir as AbsolutePath, totalBytes: bytes, topFiles, topDirs }
      return {
        summary: `${spec.description}: ${dir}（${bytes} 字节 → 回收区）`,
        touchedPaths: [dir as AbsolutePath],
        estimatedBytesReclaimable: bytes,
        requiresExclusiveLock: false,
        impact,
        // V5：涉及文件数（策略守卫 maxFilesPerTx 的数据源；dirStats 一次遍历同时产出）
        fileCount,
      }
    },

    async validate(ctx): Promise<Result<void>> {
      // 路径策略先于存在性检查：目录不存在也要先过白名单闸门（纵深防御）
      const dir = spec.dirOf(ctx)
      const check = await ctx.resolver.assertDeletable(dir, spec.policy)
      if (!check.ok) return check
      return ok(undefined)
    },

    async execute(ctx): Promise<Result<ExecutedStep>> {
      const dir = spec.dirOf(ctx)
      if (!existsSafe(dir)) {
        return ok({
          outcome: { bytesFreed: 0, message: '目录不存在，跳过', skipped: true },
          backup: null,
        })
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

    async undo(ctx, record): Promise<Result<void>> {
      if (!record) return ok(undefined)
      return ctx.backups.restore(record)
    },
  }
}

/** 便捷构造：单插件的三个目录清理操作（options.topN 可配影响面明细条目数） */
export function dirRemoveOps(
  target: PluginName, profile: string, dshHomeOf: (ctx: TxContext) => string,
  options?: { readonly topN?: number },
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
      ...(options?.topN !== undefined ? { topN: options.topN } : {}),
    }),
    makeDirRemoveOp({
      id: 'op-remove-storages', action: 'remove-storages', target,
      dirOf: ctx => path.join(dshHomeOf(ctx), 'storages', target),
      description: '移除 storages 持久化数据', policy: storagesPolicy,
      ...(options?.topN !== undefined ? { topN: options.topN } : {}),
    }),
    makeDirRemoveOp({
      id: 'op-remove-attachments', action: 'remove-attachments', target,
      dirOf: ctx => path.join(dshHomeOf(ctx), 'attachments', 'v1', target),
      description: '移除 attachments 会话附件', policy: attachmentsPolicy,
      ...(options?.topN !== undefined ? { topN: options.topN } : {}),
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

/** child 是否位于 parent 目录内部（不含 parent 自身）。
 *  purge-temp 的 undo 用它从 manifest 筛出本操作 stage 的条目 ——
 *  判定纪律与 backup-store 的路径包含逻辑同源（'..' 越出 = 在外）。 */
function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

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
        // V5：条目数即文件数（maxFilesPerTx 数据源）
        fileCount: entries.length,
        ...(entries.length === 0 ? { skipped: true } : {}),
      }
    },

    async validate(): Promise<Result<void>> { return ok(undefined) },

    async execute(ctx): Promise<Result<ExecutedStep>> {
      const entries = staleEntries()
      if (entries.length === 0) {
        return ok({
          outcome: { bytesFreed: 0, message: '无过期 TEMP 条目', skipped: true },
          backup: null,
        })
      }
      let bytes = 0
      let backup = null
      const failures: string[] = []
      let vanished = 0
      for (const e of entries) {
        try {
          let rec: BackupRecord
          if (e.isDir) {
            rec = await ctx.backups.stageDir(e.entry as AbsolutePath)
          } else {
            rec = await ctx.backups.stageFile(e.entry as AbsolutePath)
            fs.unlinkSync(e.entry)
          }
          // 契约的 backup 字段是单记录形态，本操作实际 stage 了 N 条 ——
          // 完整恢复依据是 manifest（undo 按 tempRoot 筛选全量恢复），
          // 此字段只承载"首条记录"（status/审计可观测用）
          backup = backup ?? rec
          bytes += e.size
        } catch (err2) {
          // 扫描与执行之间条目消失（OS 临时目录清洁器/并发清理的常态）：
          // 目标已不存在 = 该条目已被别人清理，幂等跳过而非失败 ——
          // 否则无竞争失败的整个事务会被这 N 个 ENOENT 拖垮回滚
          if ((err2 as NodeJS.ErrnoException).code === 'ENOENT') {
            vanished++
            continue
          }
          failures.push(`${e.entry}: ${errorToMessage(err2)}`)
        }
      }
      if (failures.length > 0 && bytes === 0) {
        return err({ code: 'E_IO', message: `TEMP 清理全部失败: ${failures.join('; ')}` })
      }
      const done = entries.length - failures.length - vanished
      const notes: string[] = []
      if (failures.length > 0) notes.push(`失败 ${failures.length}`)
      if (vanished > 0) notes.push(`已被并发清理 ${vanished}`)
      return ok({
        outcome: {
          bytesFreed: bytes,
          message: `TEMP 清理 ${done}/${entries.length} 条${notes.length > 0 ? `（${notes.join('，')}）` : ''}`,
          // 全部条目都被并发清掉 = 目标已达成，与"无过期条目"同一幂等语义
          ...(done === 0 && failures.length === 0 ? { skipped: true } : {}),
        },
        backup,
      })
    },

    async undo(ctx, record): Promise<Result<void>> {
      // 本操作 stage 的条目数与过期 TEMP 条目数一致（可能 N 个），而 WAL
      // step-done 只携带单条 backup。恢复的第一事实源是 manifest：凡
      // originalPath 位于 tempRoot 内的记录都属于本操作，逆序全量恢复
      //（与引擎 rollbackRuntime 的 manifest 逆序纪律一致）；只恢复传入
      // 单条会漏掉其余 N-1 个条目。manifest 为空时退回单条记录兜底。
      const mine = ctx.backups.manifest()
        .filter(r => isInsideDir(options.tempRoot, r.originalPath))
      const targets = mine.length > 0
        ? [...mine].reverse()
        : record !== null
          ? [record]
          : []
      if (targets.length === 0) return ok(undefined)
      let firstError: NukeError | null = null
      for (const t of targets) {
        const r = await ctx.backups.restore(t)
        if (!r.ok && firstError === null) firstError = r.error
      }
      return firstError === null ? ok(undefined) : err(firstError)
    },
  }
}

// src/engine/backup-gc.ts — IBackupGc 实现：备份保留策略执行器
// 设计立场：备份必须有死期，但死期由策略（时间宽限期 + 空间配额）决定，
// 不由"事务成功"这个事件决定 —— commit 证明的是引擎做对了，不是用户
// 不再需要。反面同样成立：回收区无界增长是自我否定（dir-move 只是改名，
// 字节并未释放，台账却已记 freed）。
//
// 淘汰纪律（安全边界）：
//   1. 未终结事务（WAL 无终结符）永不淘汰 —— 备份可能是数据唯一完整副本
//   2. WAL 缺失/损坏的事务跳过（fail-closed 保留现场，宁可泄漏不可误删）
//   3. 宽限期是常规纪律（只约束时间维度）；配额是紧急泄压阀 —— 硬上限
//      可压过宽限期，但按 mtime LRU 从最老开始：宽限期内的新备份只在
//      老备份不足以泄压时才被动用，且墓碑/审计如实标注 reason=quota
//   4. 拆安全网（物理删除备份）必须可审计：每轮 GC 写审计链
//
// 台账结算（诚实性闭环）：dir-move 步骤 commit 时记 pending（已隔离
// 未释放），备份区物理销毁时转 freed（真实物理回收）—— totalFreed
// 从此只报真实物理回收，与磁盘实际可用字节的口径一致。
//
// 全程持有全局独占锁：并发 GC 会产生双重 purge/双重结算（两个进程都
// replay 到同一终结事务、都 rm、都写台账）。拿不到锁 = 有并发清理在
// 进行，本轮静默让位（空报告，非错误）。
import * as crypto from 'crypto'
import * as os from 'os'

import type { CleanAction, Clock, Result, TxId } from '../contracts/base'
import { err, errorToMessage, ioError, isCleanAction, ok } from '../contracts/base'
import type { ILedger } from '../contracts/ledger.contract'
import { LEDGER_GLOBAL } from '../contracts/ledger.contract'
import type { ILockManager, LockOwner } from '../contracts/lock'
import type { IAuditLog, ILogger } from '../contracts/logging'
import type {
  BackupGcReport, BackupPurgeReason, IBackupGc, WalRecord,
} from '../contracts/transaction'
import type { BackupStoreRuntime } from '../infra/backup-store'
import type { WalRuntime } from '../infra/wal'

/** GC 的策略输入（由装配层从 policy.json 归一化后注入）：
 *  retentionDays = null 表示显式关闭时间维度；quotaBytes = null 表示无配额。 */
export interface BackupGcPolicy {
  readonly retentionDays: number | null
  readonly quotaBytes: number | null
}

export interface BackupGcDeps {
  readonly backups: BackupStoreRuntime
  readonly wal: WalRuntime
  readonly ledger: ILedger
  readonly audit: IAuditLog
  readonly lockManager: ILockManager
  readonly logger: ILogger
  readonly clock: Clock
  /** 每轮读取当前策略（policy.json 可被热修改，不做进程内缓存） */
  readonly policy: () => BackupGcPolicy
}

/** GC 审计条目的 action（与 tx-commit 等同级的生命周期事件）。 */
export const BACKUP_GC_AUDIT_ACTION = 'backup-gc'

/** GC 独占锁：短 TTL + 短等待 —— GC 是顺带动作，绝不与真实清理抢锁。
 *  拿不到锁直接让位（返回空报告），锁竞争在这里是常态而非异常。 */
const GC_LOCK_WAIT_MS = 1_000
const GC_LOCK_TTL_MS = 60_000

const MS_PER_DAY = 86_400_000

/** 终结性判定：WAL 含 tx-commit / tx-rollback 即终结。
 *  归档区文件同样可判（replay 自动回退归档区）。 */
function terminalRecord(r: WalRecord): boolean {
  return r.type === 'tx-commit' || r.type === 'tx-rollback'
}

export function createBackupGc(deps: BackupGcDeps): IBackupGc {
  const log = deps.logger.child({ mod: 'backup-gc' })

  /** 空报告（clock 化：测试注入假时钟时 durationMs 语义一致） */
  const emptyReport = (startedMs: number): BackupGcReport => ({
    purged: [],
    skippedUnfinished: 0,
    skippedUnknown: 0,
    retainedBytes: 0,
    settledBytes: 0,
    durationMs: deps.clock.now().getTime() - startedMs,
  })

  return {
    async run(options) {
      const started = deps.clock.now().getTime()
      const dryRun = options?.dryRun === true
      try {
        // ── 0) 快速通道：无备份区 = 无事可做（零 IO，常态零成本） ──
        const areas = deps.backups.listAreas()
        if (areas.length === 0) {
          return ok(emptyReport(started))
        }

        // ── 1) 全局独占锁：串行化并发 GC / 与真实清理互斥 ──
        const owner: LockOwner = {
          pid: process.pid,
          hostname: os.hostname(),
          bootToken: crypto.randomBytes(8).toString('hex'),
          purpose: 'backup-gc',
        }
        const acquired = await deps.lockManager.acquire({
          scope: { kind: 'global' }, mode: 'exclusive', owner,
          waitTimeoutMs: GC_LOCK_WAIT_MS, ttlMs: GC_LOCK_TTL_MS,
        })
        if (!acquired.ok) {
          // 常态让位：另一进程正在清理/GC，本轮跳过（非错误）
          log.info('全局锁被占用，本轮 GC 让位', { waitMs: GC_LOCK_WAIT_MS })
          return ok(emptyReport(started))
        }
        try {
          return await collect({ dryRun, areas, started })
        } finally {
          // V5.8.7：释放失败不再静默 —— 锁残留会阻塞后续 GC/清理事务，
          // 且 GC 进程存活期间陈旧回收不会接管（须等 TTL 过期）
          const released = await acquired.value.release()
          if (!released.ok) {
            log.warn('备份 GC 锁释放失败（TTL 到期后自动回收）', { error: released.error.message })
          }
        }
      } catch (e) {
        return err(ioError('备份 GC 失败', e))
      }
    },
  }

  async function collect(input: {
    dryRun: boolean
    areas: readonly { txId: TxId; mtimeMs: number }[]
    started: number
  }): Promise<Result<BackupGcReport>> {
    const { dryRun, areas, started } = input
    const policy = deps.policy()
    const now = deps.clock.now()

    // ── 2) 终结性分类（安全边界的第一道闸） ──
    const unfinished = new Set(deps.wal.unfinishedTxIds())
    const candidates: { txId: TxId; mtimeMs: number }[] = []
    let skippedUnfinished = 0
    let skippedUnknown = 0
    for (const a of areas) {
      if (unfinished.has(a.txId)) {
        skippedUnfinished++
        continue
      }
      // replay 兼容活跃区与归档区；损坏/缺失 → 记录为空 → 状态不明
      const records = await deps.wal.replay(a.txId)
      if (!records.some(terminalRecord)) {
        skippedUnknown++
        continue
      }
      candidates.push(a)
    }

    // ── 3) 时间维度：宽限期到期（常规纪律） ──
    const victims = new Map<TxId, BackupPurgeReason>()
    if (policy.retentionDays !== null) {
      const cutoff = now.getTime() - policy.retentionDays * MS_PER_DAY
      for (const c of candidates) {
        if (c.mtimeMs < cutoff) victims.set(c.txId, 'retention')
      }
    }

    // ── 4) 空间维度：配额泄压（mtime LRU 硬上限，可压过宽限期） ──
    // 字节计量一次性算全量（后续墓碑/报告/配额共用），无二次遍历。
    const bytesOf = new Map<TxId, number>()
    let totalBytes = 0
    for (const a of areas) {
      const b = deps.backups.areaBytes(a.txId)
      bytesOf.set(a.txId, b)
      totalBytes += b
    }
    if (policy.quotaBytes !== null && totalBytes > policy.quotaBytes) {
      // 老 → 新逐个淘汰直到回到配额内（LRU：宽限期内的新备份最后才被动）；
      // 候选（已终结）耗尽仍超限 = 剩余均为未终结/状态不明事务 —— 它们
      // fail-closed 永不淘汰，如实报告 retainedBytes 超限
      const byOldest = [...candidates].sort((x, y) => x.mtimeMs - y.mtimeMs)
      for (const c of byOldest) {
        if (totalBytes <= policy.quotaBytes) break
        if (victims.has(c.txId)) {
          totalBytes -= bytesOf.get(c.txId) ?? 0
          continue
        }
        victims.set(c.txId, 'quota')
        totalBytes -= bytesOf.get(c.txId) ?? 0
      }
    }

    // ── 5) dry-run：报告到此为止，不动盘 ──
    if (dryRun) {
      return ok({
        purged: [...victims].map(([txId, reason]) => ({
          txId, reason, bytes: bytesOf.get(txId) ?? 0,
        })),
        skippedUnfinished,
        skippedUnknown,
        retainedBytes: totalBytes,
        settledBytes: 0,
        durationMs: deps.clock.now().getTime() - started,
      })
    }

    // ── 6) 物理清理 + 立碑 + 台账结算 ──
    const purged: { txId: TxId; bytes: number; reason: BackupPurgeReason }[] = []
    let settledBytes = 0
    for (const [txId, reason] of victims) {
      const bytes = bytesOf.get(txId) ?? 0
      const rm = deps.backups.purgeArea(txId)
      if (!rm.ok) {
        // 单区失败不中断其余受害者；该区保留现场，下轮 GC 重试
        log.error('备份区清理失败', { txId, error: rm.error.message })
        totalBytes += bytes   // 未删成：字节数回滚计入残余
        continue
      }
      deps.backups.recordTombstone(txId, reason, bytes, now.toISOString())
      purged.push({ txId, bytes, reason })
      settledBytes += await settleLedger(txId, now)
    }

    // ── 7) WAL 归档对齐：终结事务的 WAL 移入 archive/（崩溃恢复扫描面
    //    随 GC 单调收缩）。失败只降级为日志 —— 归档是优化不是正确性前提。
    try {
      const archived = await deps.wal.archiveFinished()
      if (!archived.ok) {
        log.warn('WAL 归档失败（不影响本轮 GC 结果）', { error: archived.error.message })
      }
    } catch (e) {
      log.warn('WAL 归档异常（不影响本轮 GC 结果）', { error: errorToMessage(e) })
    }

    // ── 8) 审计存证：拆安全网的动作必须可审计（零受害者不写，防链膨胀） ──
    if (purged.length > 0) {
      try {
        await deps.audit.append({
          timestamp: now.toISOString(),
          actor: 'nuke-gc',
          action: BACKUP_GC_AUDIT_ACTION,
          outcome: 'success',
          detail: {
            purged: purged.map(p => ({ txId: p.txId, reason: p.reason, bytes: p.bytes })),
            policy: {
              retentionDays: policy.retentionDays,
              ...(policy.quotaBytes !== null ? { quotaBytes: policy.quotaBytes } : {}),
            },
            settledBytes,
            retainedBytes: totalBytes,
            skippedUnfinished,
            skippedUnknown,
          },
        })
      } catch (e) {
        // 备份已物理销毁，审计失败不可回滚 —— 记日志保观测（链校验会暴露缺口）
        log.error('GC 审计追加失败（数据已销毁，结果不受影响）', { error: errorToMessage(e) })
      }
    }

    return ok({
      purged,
      skippedUnfinished,
      skippedUnknown,
      retainedBytes: totalBytes,
      settledBytes,
      durationMs: deps.clock.now().getTime() - started,
    })
  }

  /** 台账结算：已提交事务的 dir-move 步骤 pending → freed。
   *  只结算 tx-commit 事务 —— tx-rollback 事务的备份是恢复用过即弃的
   *  副本（数据已回原位），结算它们会把"已还原"误记为"已回收"。
   *  结算顺序在 purge 之后：purge 成功才结算（宁可少记不可多记 ——
   *  崩溃窗口留下未结算的 pending 是保守误差，反向则是虚增 freed）。 */
  async function settleLedger(txId: TxId, now: Date): Promise<number> {
    try {
      const records = await deps.wal.replay(txId)
      if (!records.some(r => r.type === 'tx-commit')) return 0

      const profile = records.find(
        (r): r is Extract<WalRecord, { type: 'tx-begin' }> => r.type === 'tx-begin',
      )?.request.profile
      // action 经运行时守卫窄化（与 status() 的 WAL 重建同一纪律：
      // WAL 数据不可信，未知值不参与结算）
      const actionByIndex = new Map<number, CleanAction>()
      for (const r of records) {
        if (r.type === 'step-intent' && isCleanAction(r.action)) {
          actionByIndex.set(r.index, r.action)
        }
      }

      let settled = 0
      for (const r of records) {
        if (r.type !== 'step-done') continue
        // 仅结算 dir-move 隔离量：file-copy/exec 类步骤在 commit 时已是 freed
        if (r.backup?.kind !== 'dir-move') continue
        if (r.outcome.bytesFreed <= 0) continue
        const action = actionByIndex.get(r.index)
        if (action === undefined) continue   // intent 缺失/未知 action：宁可不结算
        const rec = await deps.ledger.record({
          at: now.toISOString(),
          kind: 'freed',
          txId,
          profile: profile ?? LEDGER_GLOBAL,
          plugin: null,
          action,
          bytes: r.outcome.bytesFreed,
          note: `备份保留期已过，物理回收（事务 ${txId} 步骤 ${r.index}）`,
        })
        if (!rec.ok) {
          log.warn('GC 台账结算失败（该步骤保持 pending，偏保守）', {
            txId, index: r.index, error: rec.error.message,
          })
          continue
        }
        settled += r.outcome.bytesFreed
      }
      return settled
    } catch (e) {
      // 结算失败不影响 purge 结果（数据已销毁）；pending 留待下轮——
      // 但区已删，实际是永久 pending：偏保守方向的误差，可接受
      log.warn('GC 台账结算异常（保持 pending 口径）', { txId, error: errorToMessage(e) })
      return 0
    }
  }
}

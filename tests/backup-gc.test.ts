// tests/backup-gc.test.ts — V5.8 备份保留策略（GC 引擎）全量契约测试
//
// 测试策略：全真实基建（backup-store / wal / ledger / audit / lock 均为生产
// 实现，仅时钟注入）—— GC 是"删别人数据"的组件，桩测无法暴露真实文件
// 系统语义（mtime / 原子性 / 幂等）。
// 覆盖的纪律（与 backup-gc.ts 头注释一一对应）：
//   1. 未终结事务永不淘汰
//   2. WAL 缺失/损坏 → fail-closed 跳过
//   3. 宽限期 = 常规纪律；配额 = 紧急泄压（只加速老备份死亡）
//   4. 物理删除必须可审计（审计链条目）+ 墓碑留证
//   5. 台账结算：dir-move pending → freed（诚实性闭环）
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Clock, TxId } from '../src/contracts/base'
import { createBackupGc } from '../src/engine/backup-gc'
import type { BackupGcDeps, BackupGcPolicy } from '../src/engine/backup-gc'
import { createAuditLog } from '../src/infra/audit-log'
import { createBackupStore } from '../src/infra/backup-store'
import type { BackupStoreRuntime } from '../src/infra/backup-store'
import { createLedger } from '../src/infra/ledger'
import { createLockManager, defaultProcessProbe } from '../src/infra/lock-manager'
import type { LockManagerRuntime } from '../src/infra/lock-manager'
import { createLogger } from '../src/infra/logger'
import { createWal } from '../src/infra/wal'
import type { WalRuntime } from '../src/infra/wal'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-gc-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ─── 测试基建 ───────────────────────────────────────────────

const NOW_MS = Date.UTC(2026, 0, 20)   // 固定"现在"：2026-01-20
const NOW = new Date(NOW_MS)
const clock: Clock = { now: () => NOW }
const DAY = 86_400_000

/** 16 位十六进制 txId（TXID_RE 白名单约束） */
const tx = (s: string) => s.padEnd(16, '0').slice(0, 16) as TxId

interface Harness {
  readonly root: string
  readonly backups: BackupStoreRuntime
  readonly wal: WalRuntime
  readonly ledger: ReturnType<typeof createLedger>
  readonly audit: ReturnType<typeof createAuditLog>
  readonly lockManager: LockManagerRuntime
  readonly gc: ReturnType<typeof createBackupGc>
  /** 造一个"已终结事务 + 备份区（含实体文件）"的完整现场 */
  seedCommitted: (id: string, opts?: {
    readonly ageDays?: number
    readonly dirMoveBytes?: number
    readonly bytes?: number
    readonly rollback?: boolean
  }) => Promise<TxId>
}

function makeHarness(policy: BackupGcPolicy): Harness {
  const root = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
  const backupRoot = path.join(root, 'backups')
  const backups = createBackupStore({ backupRoot })
  const wal = createWal({ walRoot: path.join(root, 'wal') })
  const ledger = createLedger({ historyDir: path.join(root, 'history') })
  const audit = createAuditLog({ filePath: path.join(root, 'audit', 'chain.jsonl') })
  // 锁管理器用真实时钟：acquire 的截止线判定依赖时钟推进，冻结时钟
  // 会让竞争者的等待重试永不超时（GC 让位语义反而测不到）
  const lockManager = createLockManager({
    lockRoot: path.join(root, 'locks'),
    now: () => Date.now(),
    probe: defaultProcessProbe(),
  })
  const deps: BackupGcDeps = {
    backups, wal, ledger, audit, lockManager,
    logger: createLogger({ sink: 'plain', minLevel: 'error' }),
    clock, policy: () => policy,
  }
  return {
    root, backups, wal, ledger, audit, lockManager,
    gc: createBackupGc(deps),
    async seedCommitted(id, opts = {}) {
      const txId = tx(id)
      const area = await backups.reserve(txId)
      // 备份区放一个实体文件（areaBytes 计量 + purge 真删的物理凭证）：
      // stageFile 复制留档，原文件保留在区外供断言
      const victim = path.join(root, `${id}.bin`)
      fs.writeFileSync(victim, 'v'.repeat(opts.bytes ?? 4096))
      await area.stageFile(victim as never)
      await wal.append(txId, {
        type: 'tx-begin', txId,
        request: { plugins: ['demo-plugin' as never], profile: 'web' as never, strategy: 'balanced', dryRun: false, actor: 't' },
      })
      if (opts.dirMoveBytes !== undefined && opts.dirMoveBytes > 0) {
        await wal.append(txId, {
          type: 'step-intent', index: 0, operationId: 'op0',
          action: 'remove-storages', backup: null,
        })
        await wal.append(txId, {
          type: 'step-done', index: 0, operationId: 'op0',
          outcome: { bytesFreed: opts.dirMoveBytes, message: 'ok' },
          backup: {
            operationId: 'op0', kind: 'dir-move',
            originalPath: '/x' as never, backupPath: '/b' as never,
            fingerprint: 'f' as never,
          },
        })
        // 预置 pending 台账（模拟 nuke_clean commit 时的双轨记账）
        await ledger.record({
          at: new Date(NOW_MS - 20 * DAY).toISOString(), kind: 'pending', txId,
          profile: 'web' as never, plugin: null, action: 'remove-storages',
          bytes: opts.dirMoveBytes, note: '预置 pending',
        })
      }
      await wal.append(txId, opts.rollback === true
        ? { type: 'tx-rollback', txId, reason: 'test' }
        : { type: 'tx-commit', txId })
      // 年龄注入：改备份区目录 mtime（GC 时间维度的数据源）
      const age = (opts.ageDays ?? 0) * DAY
      fs.utimesSync(path.join(backupRoot, txId), new Date(NOW_MS - age), new Date(NOW_MS - age))
      return txId
    },
  }
}

/** 解包 Result：非 ok 即抛错（带类型收窄） */
function okv<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

// ─── 测试 ───────────────────────────────────────────────────

describe('备份 GC：安全边界（永不淘汰纪律）', () => {
  it('未终结事务（WAL 无终结符）永不淘汰', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = tx('unfin')
    const area = await h.backups.reserve(txId)
    const victim = path.join(h.root, 'unfin.bin')
    fs.writeFileSync(victim, 'x'.repeat(100))
    await area.stageFile(victim as never)
    // WAL 只有 tx-begin：事务未终结（活跃/崩溃残留）
    await h.wal.append(txId, {
      type: 'tx-begin', txId,
      request: { plugins: [] as never, profile: 'web' as never, strategy: 'safe', dryRun: false, actor: 't' },
    })

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)
    expect(r.skippedUnfinished).toBe(1)
    expect(h.backups.listAreas().find(a => a.txId === txId)).toBeDefined()  // 区还在
    expect(h.backups.tombstone(txId)).toBeNull()                            // 无墓碑
  })

  it('WAL 缺失（状态不明）→ fail-closed 跳过，宁可泄漏不可误删', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = tx('orphan')
    const area = await h.backups.reserve(txId)   // 有区无 WAL：外部残留/WAL 被删
    const victim = path.join(h.root, 'orphan.bin')
    fs.writeFileSync(victim, 'x'.repeat(100))
    await area.stageFile(victim as never)

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)
    expect(r.skippedUnknown).toBe(1)
    expect(h.backups.tombstone(txId)).toBeNull()
  })

  it('全局锁被占用 → 本轮让位（空报告，非错误）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    await h.seedCommitted('blocked', { ageDays: 30 })   // 本应到期清理

    // 竞争者先持全局独占锁（模拟并发清理进行中）
    const holder = await h.lockManager.acquire({
      scope: { kind: 'global' }, mode: 'exclusive',
      owner: { pid: process.pid, hostname: os.hostname(), bootToken: 'rival', purpose: 'clean' },
      waitTimeoutMs: 0, ttlMs: 60_000,
    })
    expect(holder.ok).toBe(true)

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)                    // 让位：什么都没删
    expect(h.backups.listAreas()).toHaveLength(1)       // 现场原样保留

    if (holder.ok) await holder.value.release()
  })
})

describe('备份 GC：时间维度（宽限期 = 常规纪律）', () => {
  it('宽限期到期 → 物理清理 + 墓碑留证', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = await h.seedCommitted('expired', { ageDays: 20 })
    const beforeBytes = h.backups.areaBytes(txId)   // 含 manifest 等区内全部产物

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(r.purged[0]!.reason).toBe('retention')
    expect(r.purged[0]!.bytes).toBe(beforeBytes)     // 报告 = 区体积（诚实计量）

    const tomb = h.backups.tombstone(txId)
    expect(tomb).not.toBeNull()
    expect(tomb!.reason).toBe('retention')
    expect(tomb!.bytes).toBe(beforeBytes)            // 墓碑 = 报告（口径一致）
    expect(tomb!.purgedAt).toBe(NOW.toISOString())

    // 备份区已物理消失
    expect(h.backups.listAreas().find(a => a.txId === txId)).toBeUndefined()
  })

  it('宽限期内 → 保留（14 天策略下 10 天的新鲜备份不动）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = await h.seedCommitted('fresh', { ageDays: 10 })

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)
    expect(r.retainedBytes).toBeGreaterThan(0)
    expect(h.backups.tombstone(txId)).toBeNull()
    expect(h.backups.listAreas().find(a => a.txId === txId)).toBeDefined()
  })

  it('retentionDays=null → 显式关闭时间维度（不因时间清理）', async () => {
    const h = makeHarness({ retentionDays: null, quotaBytes: null })
    await h.seedCommitted('ancient', { ageDays: 365 })
    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)
  })

  it('rollback 事务到期同样清理（恢复用过即弃的副本）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    await h.seedCommitted('rolled', { ageDays: 20, rollback: true })
    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
  })
})

describe('备份 GC：空间维度（配额 = 紧急泄压阀）', () => {
  it('配额超限 → mtime LRU 淘汰最老备份，reason=quota', async () => {
    const h = makeHarness({ retentionDays: null, quotaBytes: 4600 })  // 只容一个区
    const oldTx = await h.seedCommitted('older', { ageDays: 10, bytes: 4096 })
    await h.seedCommitted('newer', { ageDays: 1, bytes: 4096 })

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(r.purged[0]!.txId).toBe(oldTx)
    expect(r.purged[0]!.reason).toBe('quota')
    expect(r.retainedBytes).toBeLessThanOrEqual(4600)   // 泄压后回到配额内
  })

  it('配额可压过宽限期（硬上限）：老备份不够泄压时才动新备份', async () => {
    // 两区均在宽限期内（1/2 天龄）+ 配额只容一区 → LRU 淘汰老的
    const h = makeHarness({ retentionDays: 14, quotaBytes: 4600 })
    const oldTx = await h.seedCommitted('young2', { ageDays: 2, bytes: 4096 })
    const newTx = await h.seedCommitted('young1', { ageDays: 1, bytes: 4096 })

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(r.purged[0]!.txId).toBe(oldTx)               // 老的先死（LRU）
    expect(r.purged[0]!.reason).toBe('quota')
    expect(h.backups.tombstone(newTx)).toBeNull()       // 新备份最后被动
  })

  it('候选耗尽仍超限 → 未终结/状态不明区永不淘汰，如实报告超限', async () => {
    // 备份区只有未终结事务（无候选可淘汰）+ 极小配额
    const h = makeHarness({ retentionDays: 14, quotaBytes: 100 })
    const txId = tx('unfin2')
    const area = await h.backups.reserve(txId)
    const victim = path.join(h.root, 'unfin2.bin')
    fs.writeFileSync(victim, 'x'.repeat(4096))
    await area.stageFile(victim as never)
    await h.wal.append(txId, {
      type: 'tx-begin', txId,
      request: { plugins: [] as never, profile: 'web' as never, strategy: 'safe', dryRun: false, actor: 't' },
    })

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)
    expect(r.skippedUnfinished).toBe(1)
    expect(r.retainedBytes).toBeGreaterThan(100)        // 如实超限，不撒谎
  })
})

describe('备份 GC：台账结算（诚实性闭环）', () => {
  it('dir-move pending → freed：purge 时结算为真实物理回收', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = await h.seedCommitted('settle', { ageDays: 20, dirMoveBytes: 8192 })

    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(r.settledBytes).toBe(8192)

    // 台账出现 freed 条目（带结算动机）
    const freed = h.ledger.entries({ kind: 'freed' })
    expect(freed.some(e => e.txId === txId && e.bytes === 8192)).toBe(true)
  })

  it('非 dir-move 事务清理不结算（commit 时已记 freed，无双重记账）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    await h.seedCommitted('plain', { ageDays: 20 })   // 无 dirMoveBytes
    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(r.settledBytes).toBe(0)
  })

  it('rollback 事务不结算（已还原 ≠ 已回收）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    await h.seedCommitted('nosettle', { ageDays: 20, dirMoveBytes: 8192, rollback: true })
    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(r.settledBytes).toBe(0)
  })
})

describe('备份 GC：dry-run 与审计', () => {
  it('dry_run=true → 报告受害者但零物理副作用', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = await h.seedCommitted('dry', { ageDays: 20, dirMoveBytes: 8192 })

    const r = okv(await h.gc.run({ dryRun: true }))
    expect(r.purged).toHaveLength(1)
    expect(r.purged[0]!.reason).toBe('retention')
    expect(r.settledBytes).toBe(0)                       // 不结算

    // 零副作用三连：区在 / 无墓碑 / 台账无 freed
    expect(h.backups.listAreas().find(a => a.txId === txId)).toBeDefined()
    expect(h.backups.tombstone(txId)).toBeNull()
    expect(h.ledger.entries({ kind: 'freed' })).toHaveLength(0)
  })

  it('物理清理写审计链（拆安全网必须可审计）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    await h.seedCommitted('audited', { ageDays: 20 })
    await h.gc.run()

    const trail = await h.audit.query({ actor: 'nuke-gc' })
    expect(trail).toHaveLength(1)
    const detail = (trail[0] as unknown as { detail: { purged: unknown[] } }).detail
    expect(detail.purged).toHaveLength(1)
  })

  it('零受害者不写审计（防哈希链膨胀）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    await h.seedCommitted('keep', { ageDays: 1 })
    await h.gc.run()
    const trail = await h.audit.query({ actor: 'nuke-gc' })
    expect(trail).toHaveLength(0)
  })
})

describe('备份 GC：快速通道', () => {
  it('无备份区 → 零工作空报告（常态零成本）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(0)
    expect(r.retainedBytes).toBe(0)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('dry_run 缺省 = 真实执行（真删 + 立碑）', async () => {
    const h = makeHarness({ retentionDays: 14, quotaBytes: null })
    const txId = await h.seedCommitted('real', { ageDays: 20 })
    const r = okv(await h.gc.run())
    expect(r.purged).toHaveLength(1)
    expect(h.backups.tombstone(txId)).not.toBeNull()
  })
})

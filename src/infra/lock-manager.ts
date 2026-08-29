// src/infra/lock-manager.ts — ILockManager 实现
// 关键安全属性：
//  1. 获取原子性：O_EXCL('wx') 创建 + 重试退避，绝不 check-then-create
//  2. 破锁安全性：verifiedDead(进程已死) && ttlExpired 才允许删除，
//     且以文件内容中的 bootToken 匹配为准（防误删他人重建的锁）
//  3. shared 引用计数：同一 scope 下 shared 可并存计数，exclusive 排斥一切
//  4. 读-改-写互斥：shared 的 acquire/release/breakStale 全部经由固定名
//     guard 目录（mkdir 原子 EEXIST，不跟随符号链接）串行化 —— 旧实现的
//     随机后缀 guard 每个进程创建不同文件名，O_EXCL 永不冲突，形同虚设。
//  5. 等待重试 = 指数退避 + 等值抖动（防惊群）；acquire 可选自动心跳续期
//  6. V5.6.2 陈旧锁自动回收：获取路径内嵌 reapStale —— 全体 owner 均
//     TTL 过期且进程已死（verifiedDead && ttlExpired 双条件，纪律同 2.）
//     的锁文件在 guard 互斥下就地删除。修复缺陷：持有者崩溃后锁文件永久
//     残留，O_EXCL 永远失败，acquire 只能 E_LOCK_HELD —— 全部 nuke 操作
//     被一个早已死亡的进程无限期阻塞（breakStale 从未被生产代码调用）。
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { LockId, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type {
  ILockManager, LockHandle, LockOwner, LockRequest, LockScope, ProcessProbe, StaleProof,
} from '../contracts/lock'

interface LockFileContent {
  readonly version: 1
  readonly scope: string
  readonly mode: 'shared' | 'exclusive'
  readonly owners: readonly { owner: LockOwner; acquiredAt: string; expiresAt: number }[]
}

const LOCK_DIR_NAME = 'locks'

export interface LockManagerOptions {
  /** 锁文件根目录，默认 <dshHome>/.nuke/locks */
  readonly lockRoot: string
  readonly probe?: ProcessProbe
  readonly now?: () => number
}

/** acquire 请求的可选自动续期字段（叠加在 LockRequest 之上，向后兼容：
 *  不携带该字段的既有调用行为完全不变） */
export interface LockAutoRenewOptions {
  /** 后台心跳周期（ms）：> 0 时句柄持有期间定时调用 refresh 防 TTL 到期
   *  被他人安全破锁；release 时自动清除定时器。建议取 ttlMs 的 1/3 左右
   *  （单次心跳失败仍有缓冲窗口）。定时器 unref —— 不阻止进程退出。 */
  readonly autoRenewMs?: number
}

/** 携带自动续期扩展的获取请求 */
export type LockRenewRequest = LockRequest & LockAutoRenewOptions

/** createLockManager 的运行时能力集：ILockManager 契约的超集（只增不改）。
 *  任何 LockRequest 都是合法的 LockRenewRequest（扩展字段全可选），
 *  既有按 ILockManager 编写的调用方零改动。 */
export interface LockManagerRuntime extends ILockManager {
  acquire(request: LockRenewRequest): Promise<Result<LockHandle>>
  tryAcquire(request: LockRenewRequest): Promise<LockHandle | null>
  withLock<T>(
    request: LockRenewRequest,
    fn: (handle: LockHandle) => Promise<Result<T>>,
  ): Promise<Result<T>>
}

// ─── 等待重试：指数退避 + 等值抖动（equal jitter） ─────────────
// 旧实现的固定 50ms 自旋有惊群问题：多个等待者在同一相位醒来重试，锁释放
// 瞬间的冲突概率随等待者数叠加。指数退避拉开重试间隔，等值抖动
// delay ∈ [backoff/2, backoff] 打散相位且期望值不塌向 0（优于全抖动）。
// 退避上限与旧实现的固定间隔一致（50ms）—— 短等待场景不被拖慢。
const RETRY_BASE_MS = 5
const RETRY_FACTOR = 2
const RETRY_CAP_MS = 50

function scopeKey(scope: LockScope): string {
  switch (scope.kind) {
    case 'global': return 'global'
    case 'profile': return `profile:${scope.profile}`
    case 'plugin': return `plugin:${scope.profile}/${scope.plugin}`
  }
}

/** owner 内容等值（pid + bootToken）：反序列化后对象引用不同，禁止用 === 比较 */
function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.bootToken === b.bootToken
}

export function createLockManager(options: LockManagerOptions): LockManagerRuntime {
  const lockDir = path.join(options.lockRoot, LOCK_DIR_NAME)
  const now = options.now ?? (() => Date.now())
  const probe: ProcessProbe = options.probe ?? {
    isAlive(pid, hostname) {
      if (hostname !== os.hostname()) return false
      try { process.kill(pid, 0); return true } catch { return false }
    },
  }

  fs.mkdirSync(lockDir, { recursive: true })

  function lockPath(scope: LockScope): string {
    return path.join(lockDir, `${scopeKey(scope).replace(/[/@]/g, '_')}.lock`)
  }

  function readLock(p: string): LockFileContent | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown
      // 结构校验：锁文件是磁盘上可被篡改的数据，缺失字段一律视为无锁
      if (typeof parsed !== 'object' || parsed === null) return null
      const c = parsed as Partial<LockFileContent>
      if (c.version !== 1) return null
      if (c.mode !== 'shared' && c.mode !== 'exclusive') return null
      if (!Array.isArray(c.owners)) return null
      // Array.isArray 会把 readonly 数组收窄成 any[]，此处显式按 unknown 逐字段校验（磁盘数据不可信）
      for (const o of c.owners as readonly unknown[]) {
        if (typeof o !== 'object' || o === null) return null
        const slot = o as { owner?: { pid?: unknown; bootToken?: unknown }; expiresAt?: unknown }
        if (typeof slot.owner?.pid !== 'number' || typeof slot.owner.bootToken !== 'string') return null
        if (typeof slot.expiresAt !== 'number') return null
      }
      return parsed as LockFileContent
    } catch { return null }
  }

  function writeLockAtomic(p: string, content: LockFileContent): boolean {
    // O_EXCL：仅当文件不存在时创建；存在即失败 —— 获取互斥的物理保证
    try {
      const fd = fs.openSync(p, 'wx')
      fs.writeSync(fd, JSON.stringify(content, null, 2))
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      return true
    } catch {
      return false
    }
  }

  /** V5.6.2 锁文件整体陈旧判定：全体 owner 均 TTL 过期且进程已死
   *  （verifiedDead && ttlExpired 双条件，与 breakStale 同纪律）。任一
   *  owner 未过期或仍存活 → false：慢而未死（SIGSTOP/长 GC）的持有者
   *  可能随时恢复工作，绝不能在它头上并发第二个清理者。空 owners 视为
   *  非陈旧（结构异常保守处理）。 */
  function allSlotsStale(cur: LockFileContent, t: number): boolean {
    return cur.owners.length > 0 && cur.owners.every(o =>
      o.expiresAt <= t && !probe.isAlive(o.owner.pid, o.owner.hostname))
  }

  /** V5.6.2 陈旧锁自动回收（获取路径内嵌，唯一被生产触发的破锁路径）：
   *  锁文件全体 owner 过期且死亡 → 在 guard 互斥下删除，返回 true 表示
   *  锁已消失（调用方立即重试创建）。guard 内二次核验防 TOCTOU：等待
   *  guard 期间持有者可能已正常释放（readLock null → true）或新 shared
   *  持有者已加入（重新判定，不可回收则返回 false）。guard 不可用返回
   *  false —— 保守留给下轮重试，绝不强拆。 */
  async function reapStale(p: string): Promise<boolean> {
    const pre = readLock(p)
    if (pre === null) return true // 锁文件已消失：直接进入重试创建
    if (!allSlotsStale(pre, now())) return false
    const done = await withGuard(p, now, () => {
      const cur = readLock(p)
      if (cur === null) return true
      if (!allSlotsStale(cur, now())) return false
      try { fs.unlinkSync(p) } catch { /* 并发已回收 */ }
      return !fs.existsSync(p)
    })
    return done === true
  }

  /** 单次获取尝试（不含等待循环） */
  async function tryOnce(request: LockRenewRequest): Promise<LockHandle | null> {
    const p = lockPath(request.scope)
    const me = { owner: request.owner, acquiredAt: new Date(now()).toISOString(), expiresAt: now() + request.ttlMs }

    if (request.mode === 'shared') {
      // shared：在 guard 互斥下完成"读-改-写"。关键点：重读后若发现
      // exclusive 占据（早检与入锁之间被独占方抢先）必须放弃，绝不能以
      // 新 shared 内容覆盖 exclusive 锁文件。
      const acquired = await withGuard(p, now, () => {
        let cur = readLock(p)
        // V5.6.2 陈旧锁回收（guard 内原子判定）：exclusive 陈旧锁同样会把
        // shared 挡死在门外；回收后重读（可能被并发抢先）走正常建文件路径
        if (cur !== null && allSlotsStale(cur, now())) {
          try { fs.unlinkSync(p) } catch { /* 并发已回收 */ }
          cur = readLock(p)
        }
        if (cur?.mode === 'exclusive') return false
        const content: LockFileContent = cur?.mode === 'shared'
          ? { ...cur, owners: [...cur.owners.filter(o => o.expiresAt > now()), me] }
          : { version: 1, scope: scopeKey(request.scope), mode: 'shared', owners: [me] }
        const tmp = p + '.tmp.' + crypto.randomBytes(4).toString('hex')
        fs.writeFileSync(tmp, JSON.stringify(content, null, 2))
        fs.renameSync(tmp, p)
        return true
      })
      if (acquired !== true) return null
    } else {
      // exclusive：O_EXCL 创建，已存在（任何模式）即失败
      const content: LockFileContent = {
        version: 1, scope: scopeKey(request.scope), mode: 'exclusive', owners: [me],
      }
      let created = writeLockAtomic(p, content)
      if (!created && await reapStale(p)) {
        // 陈旧锁已回收（全体持有者过期且死亡）：立即重试一次创建；
        // 再失败 = 并发者抢先重建，走正常等待重试语义
        created = writeLockAtomic(p, content)
      }
      if (!created) return null
    }

    const lockId = crypto.randomBytes(8).toString('hex') as LockId
    let released = false

    // refresh/release 的核心实现：提取为闭包，供句柄方法与自动续期共用
    const doRefresh = async (): Promise<Result<void>> => {
      if (released) return err({ code: 'E_LOCK_STATE', message: '锁已释放' })
      // refresh 也是读-改-写，与 acquire/release 共享同一 guard 互斥
      const done = await withGuard(p, now, () => {
        const cur = readLock(p)
        if (!cur) return false
        const slot = cur.owners.find(o => sameOwner(o.owner, request.owner))
        if (!slot) return false
        const content: LockFileContent = {
          ...cur,
          owners: cur.owners.map(o => sameOwner(o.owner, request.owner)
            ? { ...o, expiresAt: now() + request.ttlMs } : o),
        }
        const tmp = p + '.tmp.' + crypto.randomBytes(4).toString('hex')
        fs.writeFileSync(tmp, JSON.stringify(content, null, 2))
        fs.renameSync(tmp, p)
        return true
      })
      if (done === null) return err({ code: 'E_LOCK_STATE', message: '刷新锁失败：互斥 guard 在等待窗口内不可用' })
      if (!done) return err({ code: 'E_LOCK_STALE', message: '锁文件已消失或本持有者已不在锁中（可能被安全破锁）' })
      return ok(undefined)
    }

    const doRelease = async (): Promise<Result<void>> => {
      if (released) return ok(undefined) // 幂等
      released = true
      try {
        // exclusive：unlink 原子，无需互斥；shared：读-改-写必须进 guard，
        // 否则两个并发 release 的 rename 互相覆盖，丢失对方的移除结果。
        if (request.mode === 'shared') {
          const done = await withGuard(p, now, () => {
            const cur = readLock(p)
            if (!cur) return true
            const rest = cur.owners.filter(o => !sameOwner(o.owner, request.owner))
            if (rest.length === 0) {
              try { fs.unlinkSync(p) } catch {}
            } else {
              const tmp = p + '.tmp.' + crypto.randomBytes(4).toString('hex')
              fs.writeFileSync(tmp, JSON.stringify({ ...cur, owners: rest }, null, 2))
              fs.renameSync(tmp, p)
            }
            return true
          })
          if (done !== true) {
            return err({ code: 'E_LOCK_STATE', message: '释放锁失败：互斥 guard 在等待窗口内不可用' })
          }
        } else {
          try { fs.unlinkSync(p) } catch {}
        }
        return ok(undefined)
      } catch (e) {
        return err(ioError('释放锁失败', e))
      }
    }

    // ─── 自动心跳续期：acquire 携带 autoRenewMs > 0 时启用 ──────
    // 后台定时 refresh 防 TTL 到期被安全破锁；release 时清除（不清除 =
    // 定时器泄漏 + 已释放锁被反复"复活"）。锁确认丢失（E_LOCK_STALE）
    // 后停跳止血 —— 对已不存在的锁续期只是空转 IO。
    // unref()：心跳不阻止进程正常退出（守护语义，非生命周期语义）。
    const autoRenewMs = request.autoRenewMs
    let renewTimer: NodeJS.Timeout | null = null
    const stopAutoRenew = (): void => {
      if (renewTimer !== null) {
        clearInterval(renewTimer)
        renewTimer = null
      }
    }
    if (autoRenewMs !== undefined && autoRenewMs > 0) {
      renewTimer = setInterval(() => {
        void doRefresh().then(r => {
          if (!r.ok && r.error.code === 'E_LOCK_STALE') stopAutoRenew()
        })
      }, autoRenewMs)
      renewTimer.unref()
    }

    return {
      id: lockId,
      request,
      acquiredAt: me.acquiredAt,
      refresh: doRefresh,
      async release() {
        // 先停心跳再释放：避免释放后残留一轮续期与 unlink 竞争
        stopAutoRenew()
        return await doRelease()
      },
    }
  }

  async function acquire(request: LockRenewRequest): Promise<Result<LockHandle>> {
    const deadline = now() + request.waitTimeoutMs
    let attempt = 0
    for (;;) {
      const handle = await tryOnce(request)
      if (handle) return ok(handle)
      if (now() >= deadline) {
        // 超时：报告当前持有者及其存活/过期状态（V5.6.2 监控增强：
        // 区分 活跃 / 已过期仍存活 / 已死未到期（给出自动回收倒计时）/
        // 陈旧残留 —— 旧报错把 11 小时前死亡的持有者仍报告为"当前持有"）
        const cur = readLock(lockPath(request.scope))
        const t = now()
        const holders = cur?.owners.map(o => {
          const dead = !probe.isAlive(o.owner.pid, o.owner.hostname)
          const expired = o.expiresAt <= t
          if (!dead && !expired) return `${o.owner.purpose}(pid ${o.owner.pid}, 活跃)`
          if (dead && expired) return `${o.owner.purpose}(pid ${o.owner.pid}, 陈旧残留)`
          if (dead) {
            const remainSec = Math.max(0, Math.round((o.expiresAt - t) / 1000))
            return `${o.owner.purpose}(pid ${o.owner.pid}, 进程已死, TTL 剩余 ${remainSec}s 后自动回收)`
          }
          return `${o.owner.purpose}(pid ${o.owner.pid}, 已过期但进程仍存活)`
        }).join(', ') ?? 'unknown'
        return err({
          code: 'E_LOCK_HELD',
          message: `获取锁超时（${request.waitTimeoutMs}ms）：scope=${scopeKey(request.scope)} mode=${request.mode}，当前持有: ${holders}`,
        })
      }
      // 指数退避 + 等值抖动（见常量块注释）；绝不睡过截止线
      const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * RETRY_FACTOR ** attempt)
      const jittered = backoff / 2 + Math.random() * (backoff / 2)
      await sleep(Math.min(Math.max(1, jittered), Math.max(1, deadline - now())))
      attempt++
    }
  }

  return {
    acquire,
    async tryAcquire(request) { return await tryOnce(request) },

    async withLock<T>(request: LockRenewRequest, fn: (handle: LockHandle) => Promise<Result<T>>): Promise<Result<T>> {
      const got = await acquire(request)
      if (!got.ok) return got
      try {
        return await fn(got.value)
      } catch (e) {
        return err(ioError('临界区异常', e))
      } finally {
        await got.value.release()
      }
    },

    async breakStale(proof: StaleProof): Promise<Result<void>> {
      if (!proof.verifiedDead) {
        return err({ code: 'E_LOCK_STALE', message: '拒绝破锁：持有者进程仍存活，未满足 verifiedDead' })
      }
      if (!proof.ttlExpired) {
        return err({ code: 'E_LOCK_STALE', message: '拒绝破锁：TTL 未过期' })
      }
      // bootToken 内容匹配（文件头声明的安全属性）：只允许破坏 proof.owner
      // 自己持有的陈旧锁，杜绝"一个 proof 破坏任意到期锁"的越权行为。
      // 遍历全部锁文件：同一 owner 可能在多个 scope 持有陈旧锁，逐个清除。
      let broken = 0
      for (const f of fs.readdirSync(lockDir)) {
        if (!f.endsWith('.lock')) continue
        const fp = path.join(lockDir, f)
        // 破锁同样是读-改-写：必须与 acquire/release 共享 guard 互斥，
        // 否则与并发 acquire 的 rename 竞争会丢失/复活 owner 条目。
        const done = await withGuard(fp, now, () => {
          const cur = readLock(fp)
          if (!cur) return
          const staleSlots = cur.owners.filter(o =>
            sameOwner(o.owner, proof.owner)
            && o.expiresAt <= now()
            && !probe.isAlive(o.owner.pid, o.owner.hostname))
          if (staleSlots.length === 0) return
          const rest = cur.owners.filter(o => !staleSlots.includes(o))
          if (rest.length === 0) {
            try { fs.unlinkSync(fp) } catch {}
          } else {
            const tmp = fp + '.tmp.' + crypto.randomBytes(4).toString('hex')
            fs.writeFileSync(tmp, JSON.stringify({ ...cur, owners: rest }, null, 2))
            fs.renameSync(tmp, fp)
          }
          broken++
        })
        if (done === null) continue // 该锁的 guard 不可用：跳过，留待下次巡检
      }
      if (broken === 0) {
        return err({ code: 'E_LOCK_STALE', message: '未找到符合条件的陈旧锁' })
      }
      return ok(undefined)
    },

    holders(scope: LockScope): readonly LockOwner[] {
      const cur = readLock(lockPath(scope))
      if (!cur) return []
      return cur.owners.filter(o => o.expiresAt > now()).map(o => o.owner)
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── guard 目录互斥：锁文件读-改-写的串行化基建 ─────────────────
// 方案：固定名目录 + mkdir 原子性。mkdir 遇同名路径（含符号链接）返回
// EEXIST 且不跟随 —— 既是互斥量又是 symlink-DoS 防护；guard 目录内写
// owner token，释放前核验归属，防止"强拆超时 guard 后误删他人 guard"。
// 崩溃残留的 guard 按年龄阈值（SUPERSEDE_MS）强制拆除，防永久死锁。

const GUARD_SUFFIX = '.mut'
const GUARD_SUPERSEDE_MS = 10_000
const GUARD_RETRY_MS = 20
const GUARD_MAX_WAIT_MS = 15_000

/** 在 p 的 guard 保护下执行 fn（同步体）。返回 null = guard 在等待窗口内不可用。 */
async function withGuard<T>(p: string, now: () => number, fn: () => T): Promise<T | null> {
  const guard = p + GUARD_SUFFIX
  const token = crypto.randomBytes(8).toString('hex')
  const start = now()
  for (;;) {
    try {
      fs.mkdirSync(guard)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
      // 崩溃残留判定：超过年龄阈值的 guard 强拆后立即重试
      try {
        const st = fs.statSync(guard)
        if (now() - st.mtimeMs > GUARD_SUPERSEDE_MS) {
          fs.rmSync(guard, { recursive: true, force: true })
          continue
        }
      } catch { /* guard 恰被释放，直接重试 mkdir */ }
      if (now() - start > GUARD_MAX_WAIT_MS) return null
      await sleep(GUARD_RETRY_MS)
      continue
    }
    try {
      fs.writeFileSync(path.join(guard, 'owner'), token, 'utf-8')
      return fn()
    } finally {
      try {
        // 归属核验：guard 可能已被强拆并被他人重建，只删自己的
        if (fs.readFileSync(path.join(guard, 'owner'), 'utf-8') === token) {
          fs.rmSync(guard, { recursive: true, force: true })
        }
      } catch { /* guard 已消失/被接管 */ }
    }
  }
}

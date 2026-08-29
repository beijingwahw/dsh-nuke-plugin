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
import { spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { LockId, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type {
  ILockManager, LockFileStatus, LockHandle, LockOwner, LockRequest, LockScope,
  LockSlotStatus, ProcessProbe, StaleProof,
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

/** @deprecated V5.7：autoRenewMs 已并入契约 LockRequest；保留别名向后兼容 */
export type LockRenewRequest = LockRequest

/** createLockManager 的运行时能力集 = ILockManager 契约（V5.7 起超集
 *  能力全部上收进契约：autoRenewMs 心跳、inspect 诊断）。 */
export type LockManagerRuntime = ILockManager

// ─── V5.7 进程启动时间指纹：PID 复用甄别的物理依据 ─────────────
// 场景：持有者崩溃 → PID 被无关新进程复用 → kill(pid,0) 恒真 →
// 「已过期但进程仍存活」→ 陈旧锁永不回收 → 全部 nuke 操作无限期阻塞。
// bootToken 是锁文件内容的一部分，只能防"内容伪造"，无法对抗操作系统
// 层面的 PID 复用；启动时间是内核事实，不随锁文件内容变化。
// 三平台策略：
//   Linux   /proc/<pid>/stat 第 22 字段（自启动的时钟滴答）+ /proc/stat btime
//   Windows libuv 无启动时间 API → cmd→powershell 查询（数百 ms，仅陈旧
//           回收冷路径调用 + 短 TTL 记忆化，绝不进入获取热路径）
//   macOS   无 /proc 且无免 native 方案 → null（退回保守纯存活判定）
const WIN_PLATFORM = process.platform === 'win32'
const CLK_TCK_FALLBACK = 100
const FINGERPRINT_TTL_MS = 5_000
/** 跨读取方式的时钟抖动容忍（btime 秒精度 × clk 粒度 + FILETIME 换算余量） */
const START_TIME_TOLERANCE_MS = 2_000

let cachedClkTck: number | null = null
let cachedBtimeMs: number | null = null
const startFingerprintCache = new Map<number, { at: number; value: number | null }>()

function linuxStartTimeOf(pid: number): number | null {
  try {
    if (cachedClkTck === null) {
      const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf-8', timeout: 2_000 })
      const n = Number(r.stdout.trim())
      cachedClkTck = Number.isInteger(n) && n > 0 ? n : CLK_TCK_FALLBACK
    }
    if (cachedBtimeMs === null) {
      const m = /(?:^|\n)btime:\s*(\d+)/.exec(fs.readFileSync('/proc/stat', 'utf-8'))
      if (!m) return null
      cachedBtimeMs = Number(m[1]) * 1000
    }
    // comm 字段可含空格与括号：从最后一个 ')' 之后切分，避免字段错位
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
    // 切分后 index 0 = 第 3 字段（state）→ 第 22 字段在 index 19
    const ticks = Number(fields[19])
    if (!Number.isFinite(ticks) || ticks < 0) return null
    return Math.round(cachedBtimeMs + (ticks * 1000) / cachedClkTck)
  } catch { return null }
}

function winStartTimeOf(pid: number): number | null {
  try {
    const r = spawnSync(
      process.env.comspec ?? 'cmd.exe',
      ['/d', '/c', 'powershell', '-NoProfile', '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
      { encoding: 'utf-8', timeout: 5_000 },
    )
    const ft = Number(r.stdout.trim())
    if (!Number.isFinite(ft) || ft <= 0) return null
    // FILETIME（1601 起 100ns 单位）→ Unix epoch 毫秒
    return Math.round(ft / 10_000 - 11_644_473_600_000)
  } catch { return null }
}

/** 平台默认指纹（带短 TTL 记忆化含负缓存：防重试循环反复 spawn） */
function defaultStartTimeOf(pid: number): number | null {
  const t = Date.now()
  const hit = startFingerprintCache.get(pid)
  if (hit && t - hit.at < FINGERPRINT_TTL_MS) return hit.value
  const value = process.platform === 'linux'
    ? linuxStartTimeOf(pid)
    : WIN_PLATFORM ? winStartTimeOf(pid) : null
  startFingerprintCache.set(pid, { at: t, value })
  return value
}

/** 缺省存活探测（可注入替换）。V5.7 修复：EPERM(POSIX) 与 EACCES(Windows
 *  libuv) 都表示「进程存在但无权限」—— 旧实现只认 EPERM，Windows 上活
 *  持有者（提权/跨会话/系统进程）被误判为已死 → 陈旧回收活锁 →
 *  两个清理者并发交叉写。保守方向统一：两种码均按存活处理。 */
export function defaultProcessProbe(): ProcessProbe {
  return {
    isAlive(pid, hostname) {
      if (hostname !== os.hostname()) return false
      try { process.kill(pid, 0); return true } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        return code === 'EPERM' || code === 'EACCES'
      }
    },
    startTimeOf: defaultStartTimeOf,
  }
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
  const probe: ProcessProbe = options.probe ?? defaultProcessProbe()

  fs.mkdirSync(lockDir, { recursive: true })

  /** V5.7 PID 复用甄别：锁记录的启动时间与当前该 PID 的真实启动时间
   *  不一致 → 原持有者必死（PID 已被无关新进程复用）。
   *  null = 无记录指纹或本平台不可用（无法甄别，保守）。 */
  function pidReuseOf(owner: LockOwner): boolean | null {
    if (owner.startTime === undefined || !probe.startTimeOf) return null
    const cur = probe.startTimeOf(owner.pid)
    if (cur === null) return null
    return Math.abs(cur - owner.startTime) > START_TIME_TOLERANCE_MS
  }

  /** 持有者存活判定（存活探测 + 复用甄别的合成结论）：陈旧回收、破锁、
   *  超时报错、诊断全部走这一个口径，杜绝"回收判活、报错判死"的分裂。 */
  function holderAlive(owner: LockOwner): boolean {
    if (!probe.isAlive(owner.pid, owner.hostname)) return false
    return pidReuseOf(owner) !== true
  }

  /** guard 强拆核验：pid 维度的存活查询（guard owner 文件只记 pid，
   *  hostname 取本机 —— guard 是本地文件系统互斥量） */
  const guardHolderAlive = (pid: number): boolean =>
    holderAlive({ pid, hostname: os.hostname(), bootToken: '', purpose: 'guard' })

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
        const slot = o as {
          owner?: { pid?: unknown; bootToken?: unknown; startTime?: unknown }
          expiresAt?: unknown
        }
        const pid = slot.owner?.pid
        // pid 必须正整数：非正值传入 kill(pid,0) 会演化为进程组/全体信号探测
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
        if (typeof slot.owner?.bootToken !== 'string') return null
        // V5.7 启动时间指纹（可选字段）：类型不符视为结构非法（磁盘数据不可信）
        //（上一行已隐式证明 owner 非空）
        const startAt = slot.owner.startTime
        if (startAt !== undefined && typeof startAt !== 'number') return null
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
      o.expiresAt <= t && !holderAlive(o.owner))
  }

  /** V5.6.2 陈旧锁自动回收（获取路径内嵌，唯一被生产触发的破锁路径）：
   *  ① 锁文件全体 owner 过期且死亡 → guard 互斥下删除；
   *  ② 文件存在但结构非法（写入中途崩溃的截断 JSON / 被篡改）→ 无法证明
   *    任何持有者存在，视为不可信残留同样回收 —— 旧实现把它与"文件不
   *    存在"混为一谈，reap 后重试创建必然失败，损坏文件永久阻塞获取。
   *  guard 内二次核验防 TOCTOU：等待 guard 期间持有者可能已正常释放或
   *  新持有者已加入（重新判定，不可回收则返回 false）。guard 不可用返回
   *  false —— 保守留给下轮重试，绝不强拆。 */
  async function reapStale(p: string): Promise<boolean> {
    if (!fs.existsSync(p)) return true // 锁文件已消失：直接进入重试创建
    const pre = readLock(p)
    if (pre !== null && !allSlotsStale(pre, now())) return false
    const done = await withGuard(p, now, () => {
      const cur = readLock(p)
      if (cur === null) {
        // 结构非法 = 不可信残留 → 删除回收（若已被并发删/重建，下面 exists 判定兜底）
        try { fs.unlinkSync(p) } catch { /* 并发已回收 */ }
        return !fs.existsSync(p)
      }
      if (!allSlotsStale(cur, now())) return false
      try { fs.unlinkSync(p) } catch { /* 并发已回收 */ }
      return !fs.existsSync(p)
    }, guardHolderAlive)
    return done === true
  }

  /** 单次获取尝试（不含等待循环） */
  async function tryOnce(request: LockRequest): Promise<LockHandle | null> {
    const p = lockPath(request.scope)
    // V5.7 启动时间指纹补全：本进程的启动时刻写入锁文件，供后续陈旧回收
    // 时甄别 PID 复用。平台不可用（null）→ 不写入，退回保守存活判定。
    const myStart = probe.startTimeOf?.(process.pid) ?? null
    const owner: LockOwner = myStart !== null
      ? { ...request.owner, startTime: myStart }
      : request.owner
    const me = { owner, acquiredAt: new Date(now()).toISOString(), expiresAt: now() + request.ttlMs }

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
      }, guardHolderAlive)
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
      }, guardHolderAlive)
      if (done === null) return err({ code: 'E_LOCK_STATE', message: '刷新锁失败：互斥 guard 在等待窗口内不可用' })
      if (!done) return err({ code: 'E_LOCK_STALE', message: '锁文件已消失或本持有者已不在锁中（可能被安全破锁）' })
      return ok(undefined)
    }

    const doRelease = async (): Promise<Result<void>> => {
      if (released) return ok(undefined) // 幂等：此前一次成功释放后
      // 先停心跳再释放：避免释放后残留一轮续期与 unlink 竞争
      //（移入 doRelease：失败重试路径同样不允许心跳复活已删的锁）
      stopAutoRenew()
      try {
        // exclusive：unlink 原子，无需互斥；shared：读-改-写必须进 guard，
        // 否则两个并发 release 的 rename 互相覆盖，丢失对方的移除结果。
        if (request.mode === 'shared') {
          const done = await withGuard(p, now, () => {
            const cur = readLock(p)
            if (!cur) return true
            const rest = cur.owners.filter(o => !sameOwner(o.owner, request.owner))
            if (rest.length === 0) {
              // V5.7：unlink 失败（Windows AV/索引器短暂占用 → EPERM/EBUSY）
              // 不再吞错——静默成功会把"锁文件残留+进程存活"伪装成已释放，
              // 该锁到进程退出前都不可回收（allSlotsStale 要求进程死亡）。
              fs.unlinkSync(p)
            } else {
              const tmp = p + '.tmp.' + crypto.randomBytes(4).toString('hex')
              fs.writeFileSync(tmp, JSON.stringify({ ...cur, owners: rest }, null, 2))
              fs.renameSync(tmp, p)
            }
            return true
          }, guardHolderAlive)
          if (done !== true) {
            // released 未置位：guard 恢复后可重试 release
            return err({ code: 'E_LOCK_STATE', message: '释放锁失败：互斥 guard 在等待窗口内不可用（可重试 release）' })
          }
        } else {
          fs.unlinkSync(p)
        }
        released = true
        return ok(undefined)
      } catch (e) {
        // released 未置位：锁文件可能仍存在，调用方可重试 release 或交给
        // 陈旧回收（进程退出 + TTL 过期后自动兜底）
        return err(ioError('释放锁失败（锁文件可能被暂时占用，可重试 release）', e))
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

  async function acquire(request: LockRequest): Promise<Result<LockHandle>> {
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
          const reuse = pidReuseOf(o.owner)
          const dead = reuse === true || !probe.isAlive(o.owner.pid, o.owner.hostname)
          const expired = o.expiresAt <= t
          // 四象限单口径（与 inspect()/allSlotsStale 同判据）：
          //  活跃 / 已过期仍存活（SIGSTOP/长 GC，绝不可回收）/ 已死未到期
          //  （给出自动回收倒计时）/ 陈旧残留（reap 不可达时的兜底报告）
          if (!dead && !expired) return `${o.owner.purpose}(pid ${o.owner.pid}, 活跃)`
          if (!dead) return `${o.owner.purpose}(pid ${o.owner.pid}, 已过期但进程仍存活)`
          if (expired) return `${o.owner.purpose}(pid ${o.owner.pid}, 陈旧残留)`
          const remainSec = Math.max(0, Math.round((o.expiresAt - t) / 1000))
          return `${o.owner.purpose}(pid ${o.owner.pid}, 进程已死, TTL 剩余 ${remainSec}s 后自动回收)`
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

    async withLock<T>(request: LockRequest, fn: (handle: LockHandle) => Promise<Result<T>>): Promise<Result<T>> {
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
            && !holderAlive(o.owner))
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
        }, guardHolderAlive)
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

    /** V5.7 锁诊断：全部锁文件的零副作用快照。存活判定与陈旧回收同一
     *  口径（holderAlive），杜绝"诊断说活、回收说死"的分裂报告。 */
    inspect(): readonly LockFileStatus[] {
      const out: LockFileStatus[] = []
      let names: readonly string[]
      try { names = fs.readdirSync(lockDir) } catch { return out }
      const t = now()
      for (const f of names) {
        if (!f.endsWith('.lock')) continue
        const cur = readLock(path.join(lockDir, f))
        if (!cur) continue
        // 全体 owner 进程已死 → TTL 全部过期后自动回收（allSlotsStale 同判据）
        const allDead = cur.owners.length > 0
          && cur.owners.every(o => !holderAlive(o.owner))
        const lastExpire = Math.max(...cur.owners.map(o => o.expiresAt))
        const slots: readonly LockSlotStatus[] = cur.owners.map(o => {
          const reuse = pidReuseOf(o.owner)
          const alive = reuse !== true && probe.isAlive(o.owner.pid, o.owner.hostname)
          return {
            pid: o.owner.pid,
            hostname: o.owner.hostname,
            purpose: o.owner.purpose,
            acquiredAt: o.acquiredAt,
            expiresAt: o.expiresAt,
            alive,
            expired: o.expiresAt <= t,
            pidReused: reuse,
            autoReapInSec: allDead ? Math.max(0, Math.round((lastExpire - t) / 1000)) : null,
          }
        })
        out.push({ file: f, scope: cur.scope, mode: cur.mode, slots })
      }
      return out
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

/** 在 p 的 guard 保护下执行 fn（同步体）。返回 null = guard 在等待窗口内不可用。
 *  V5.7 第四参 isHolderAlive：guard 持有进程的存活查询（owner 文件记录
 *  pid），年龄强拆前核验 —— 持有者活着只是慢（SMB/NFS/AV 钩住）不允许拆。 */
async function withGuard<T>(
  p: string,
  now: () => number,
  fn: () => T,
  isHolderAlive?: (pid: number) => boolean,
): Promise<T | null> {
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
          // V5.7：强拆前核验持有进程。旧实现纯按年龄拆：guard 临界区是同步
          // fs 调用，被慢速存储/杀软钩住超 10s 完全可能 —— 慢而未死的持有者
          // 被强拆后并发进入，两个进程的读-改-写 rename 互相覆盖、owner 条目
          // 丢失，互斥语义被破坏。持有者已死（或无法判定身份）才允许拆。
          let gp = -1
          try {
            const raw = fs.readFileSync(path.join(guard, 'owner'), 'utf-8')
            const n = Number(raw.split('\n')[1] ?? '')
            if (Number.isInteger(n) && n > 0) gp = n
          } catch { /* owner 不可读：无法证明持有者存活，维持旧强拆语义 */ }
          if (gp <= 0 || !isHolderAlive?.(gp)) {
            fs.rmSync(guard, { recursive: true, force: true })
            continue
          }
          // 持有者活着只是慢：不拆，继续等待（受 GUARD_MAX_WAIT_MS 上界约束）
        }
      } catch { /* guard 恰被释放，直接重试 mkdir */ }
      if (now() - start > GUARD_MAX_WAIT_MS) return null
      await sleep(GUARD_RETRY_MS)
      continue
    }
    try {
      // owner 文件第二行记录 pid：供强拆核验（第一行仍是归属 token）
      fs.writeFileSync(path.join(guard, 'owner'), `${token}\n${process.pid}`, 'utf-8')
      return fn()
    } finally {
      try {
        // 归属核验：guard 可能已被强拆并被他人重建，只删自己的
        if (fs.readFileSync(path.join(guard, 'owner'), 'utf-8') === `${token}\n${process.pid}`) {
          fs.rmSync(guard, { recursive: true, force: true })
        }
      } catch { /* guard 已消失/被接管 */ }
    }
  }
}

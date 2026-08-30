// contracts/lock.ts — 子系统二：并发安全锁（共享/独占双模式）
// 对现有 lock.ts 三大缺陷的修正：
//  1. check-then-create 竞态 → 获取只用 O_EXCL 原子创建，失败才进入读取分析
//  2. 无脑 unlink 破锁 → 安全破锁需同时证明「持有者进程已死亡」且「TTL 已过」，
//     并携带一次性 breakToken 防止误删他人刚重建的锁
//  3. 仅独占 → shared 模式引用计数，扫描/预演可并发，写操作才独占

import type { LockId, Result } from './base'

export type LockMode = 'shared' | 'exclusive'

/** 锁作用域：全局串行化或按 profile / plugin 细粒度 */
export type LockScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'profile'; readonly profile: string }
  | { readonly kind: 'plugin'; readonly profile: string; readonly plugin: string }

export interface LockOwner {
  readonly pid: number
  readonly hostname: string
  /** 随机 token：区分同 PID 复活的进程，防止陈旧 PID 误判 */
  readonly bootToken: string
  readonly purpose: string   // 'clean' | 'scan' | 'dry-run' | 'health'
  /** V5.7 进程启动时间指纹（epoch ms，由 lock-manager 获取时自动补全）：
   *  PID 复用甄别的物理依据 —— pid 存活但启动时间与记录不符 = 原持有者
   *  已死、PID 被无关新进程复用，陈旧锁可安全回收。bootToken 只能区分
   *  本插件自己写入的锁内容，无法对抗"PID 被复用后存活探测恒真"；
   *  启动时间是操作系统事实，不随锁文件内容伪造。 */
  readonly startTime?: number
}

export interface LockRequest {
  readonly scope: LockScope
  readonly mode: LockMode
  readonly owner: LockOwner
  /** 获取等待上限；0 = 不等待立即失败 */
  readonly waitTimeoutMs: number
  /** 锁 TTL：持有者崩溃后锁自动失效的窗口（需配合 refresh 心跳） */
  readonly ttlMs: number
  /** V5.7 后台心跳周期（ms）：> 0 时句柄持有期间自动 refresh 防 TTL 到期。
   *  原为 lock-manager 私有扩展，并入契约后引擎/调用方无需感知扩展类型。
   *  建议取 ttlMs 的 1/3；定时器 unref 不阻止进程退出。 */
  readonly autoRenewMs?: number
  /** V5.8.7 心跳续期的持有硬上限（ms）：> 0 时自获取起经过此时长后心跳
   *  停跳，锁交还 TTL 自然到期回收。防「句柄被调用方遗忘 + autoRenew
   *  无限续期」—— TTL 永不到期 = 锁在进程存活期间永久占用，全部清理
   *  事务被阻塞（「绝不占用」的兜底上限）。正常路径不受影响：release
   *  幂等且先于上限触发。最坏占用被界定为 maxHoldMs + ttlMs。 */
  readonly maxHoldMs?: number
}

export interface LockHandle {
  readonly id: LockId
  readonly request: LockRequest
  readonly acquiredAt: string
  /** 续期：长事务定期调用，防止 TTL 到期被他人安全破锁 */
  refresh(): Promise<Result<void>>
  /** 释放：幂等；shared 模式递减引用计数 */
  release(): Promise<Result<void>>
}

/** 持有者存活探测 —— 破锁流程的依赖注入点，单测时可 mock */
export interface ProcessProbe {
  isAlive(pid: number, hostname: string): boolean
  /** V5.7 进程启动时间指纹（epoch ms）：null = 本平台不可用（退回纯
   *  存活判定，保守）。仅被陈旧锁回收路径调用（锁已 TTL 过期后），
   *  不在获取热路径上。 */
  startTimeOf?(pid: number): number | null
}

export interface StaleProof {
  readonly lockId: LockId
  readonly owner: LockOwner
  readonly verifiedDead: boolean   // ProcessProbe 证实进程已死
  readonly ttlExpired: boolean
}

/** V5.7 锁诊断（nuke_locks 零副作用工具的数据源）：单个持有者槽位的
 *  现场快照 —— 存活判定 / TTL 状态 / 自动回收倒计时 / PID 复用甄别。 */
export interface LockSlotStatus {
  readonly pid: number
  readonly hostname: string
  readonly purpose: string
  readonly acquiredAt: string
  readonly expiresAt: number
  /** 进程存活（含指纹核验：PID 复用视为已死） */
  readonly alive: boolean
  /** TTL 已过期 */
  readonly expired: boolean
  /** PID 被无关进程复用（原持有者确死）——null = 本平台无法甄别 */
  readonly pidReused: boolean | null
  /** 全体 owner 陈旧时的自动回收等待秒数；不可回收为 null */
  readonly autoReapInSec: number | null
}

/** V5.7 单个锁文件的诊断视图 */
export interface LockFileStatus {
  readonly file: string
  readonly scope: string
  readonly mode: LockMode
  readonly slots: readonly LockSlotStatus[]
}

export interface ILockManager {
  /** 阻塞获取（waitTimeoutMs 内自旋/退避重试） */
  acquire(request: LockRequest): Promise<Result<LockHandle>>
  /** 非阻塞：拿不到立即返回 null，不产生错误 */
  tryAcquire(request: LockRequest): Promise<LockHandle | null>
  /** RAII 式：fn 抛错/返回 err 都保证释放锁，推荐入口 */
  withLock<T>(
    request: LockRequest,
    fn: (handle: LockHandle) => Promise<Result<T>>,
  ): Promise<Result<T>>
  /** 安全破锁：verifiedDead && ttlExpired 才允许，且需 breakToken 匹配 */
  breakStale(proof: StaleProof): Promise<Result<void>>
  /** 当前某作用域下的全部持有者（调试/健康检查展示用） */
  holders(scope: LockScope): readonly LockOwner[]
  /** V5.7 全部锁文件的零副作用诊断快照（nuke_locks 工具数据源） */
  inspect(): readonly LockFileStatus[]
}

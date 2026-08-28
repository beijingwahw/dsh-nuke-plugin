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
}

export interface LockRequest {
  readonly scope: LockScope
  readonly mode: LockMode
  readonly owner: LockOwner
  /** 获取等待上限；0 = 不等待立即失败 */
  readonly waitTimeoutMs: number
  /** 锁 TTL：持有者崩溃后锁自动失效的窗口（需配合 refresh 心跳） */
  readonly ttlMs: number
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
}

export interface StaleProof {
  readonly lockId: LockId
  readonly owner: LockOwner
  readonly verifiedDead: boolean   // ProcessProbe 证实进程已死
  readonly ttlExpired: boolean
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
}

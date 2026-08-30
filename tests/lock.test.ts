import * as fs from 'fs'
import type * as FsModule from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ok } from '../src/contracts/base'
import type { LockOwner, LockRequest } from '../src/contracts/lock'
import { createLockManager, defaultProcessProbe } from '../src/infra/lock-manager'

// ─── V5.8.6 释放重试故障注入（ESM 命名空间不可 spyOn，与
// engine-v5.test.ts 的 tamperMetaJson 同模式：vi.mock 透传真实 fs，
// 仅按队列逐次注入 errno 抛出；队列空 = 完全透传，其余测试不受影响）───
const releaseFailures = vi.hoisted(() => ({
  unlink: [] as string[],
  unlinkCalls: 0,
  rename: [] as string[],
  renameCalls: 0,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const errnoThrow = (code: string): never => {
    const e = new Error(`${code}: simulated transient failure`) as NodeJS.ErrnoException
    e.code = code
    throw e
  }
  return {
    ...actual,
    unlinkSync: (((p: fs.PathLike) => {
      releaseFailures.unlinkCalls++
      const code = releaseFailures.unlink.shift()
      if (code !== undefined) errnoThrow(code)
      return actual.unlinkSync(p)
    }) as typeof actual.unlinkSync),
    renameSync: (((a: fs.PathLike, b: fs.PathLike) => {
      releaseFailures.renameCalls++
      const code = releaseFailures.rename.shift()
      if (code !== undefined) errnoThrow(code)
      return actual.renameSync(a, b)
    }) as typeof actual.renameSync),
  }
})

let tmp: string
const nowStub = { value: 1_000_000 }

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function makeManager(alivePids: number[] = []) {
  return createLockManager({
    lockRoot: path.join(tmp, `run-${Math.random().toString(36).slice(2)}`),
    now: () => nowStub.value,
    probe: { isAlive: (pid) => alivePids.includes(pid) },
  })
}

/** 解包 Result：非 ok 即抛错使测试失败（比 expect(r.ok).toBe(true) 多了类型收窄） */
function okv<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.message}`)
  return r.value
}

const ownerA: LockOwner = { pid: 111, hostname: 'h', bootToken: 'a', purpose: 'clean' }
const ownerB: LockOwner = { pid: 222, hostname: 'h', bootToken: 'b', purpose: 'scan' }

function req(owner: LockOwner, mode: 'shared' | 'exclusive', ttlMs = 60_000): LockRequest {
  return { scope: { kind: 'global' }, mode, owner, waitTimeoutMs: 0, ttlMs }
}

describe('独占锁', () => {
  it('第二个 exclusive 获取失败（E_LOCK_HELD）', async () => {
    const m = makeManager()
    const h1 = await m.acquire(req(ownerA, 'exclusive'))
    expect(h1.ok).toBe(true)
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(false)
    if (!h2.ok) expect(h2.error.code).toBe('E_LOCK_HELD')
    await okv(h1).release()
  })

  it('exclusive 存在时 shared 也被拒绝', async () => {
    const m = makeManager()
    const h1 = await m.acquire(req(ownerA, 'exclusive'))
    expect((await m.tryAcquire(req(ownerB, 'shared')))).toBeNull()
    await okv(h1).release()
  })

  it('release 幂等', async () => {
    const m = makeManager()
    const h = await m.acquire(req(ownerA, 'exclusive'))
    expect(h.ok).toBe(true)
    await okv(h).release()
    expect((await okv(h).release()).ok).toBe(true)
  })
})

describe('V5.8.6 释放瞬态重试（用完即放，绝不占用）', () => {
  beforeEach(() => {
    releaseFailures.unlink.length = 0
    releaseFailures.rename.length = 0
    releaseFailures.unlinkCalls = 0
    releaseFailures.renameCalls = 0
  })
  // 队列残留清理：未消费的注入项绝不允许泄漏进后续 describe 的测试
  afterEach(() => {
    releaseFailures.unlink.length = 0
    releaseFailures.rename.length = 0
  })

  it('unlink 首次 EPERM（Windows AV 短暂占用）→ 退避重试后释放成功', async () => {
    const m = makeManager()
    const h = okv(await m.acquire(req(ownerA, 'exclusive')))
    releaseFailures.unlink.push('EPERM')   // 仅首次失败，其后透传真实实现
    const r = await h.release()
    expect(r.ok).toBe(true)                      // 瞬态抖动在 release 内自愈
    expect(releaseFailures.unlinkCalls).toBe(2)  // 失败 1 次 + 重试成功 1 次
    // 锁确实已删：下一个获取者立即成功（不等 TTL/陈旧回收兜底）
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(true)
    if (h2.ok) await h2.value.release()
  })

  it('非瞬态错误（永久性故障）→ 立即失败，不做无意义重试', async () => {
    const m = makeManager()
    const h = okv(await m.acquire(req(ownerA, 'exclusive')))
    // 队列备足 4 份：若实现错误地重试，第 2 次调用仍会抛（计数断言拆穿）
    releaseFailures.unlink.push('EISDIR', 'EISDIR', 'EISDIR', 'EISDIR')
    const r = await h.release()
    expect(r.ok).toBe(false)
    expect(releaseFailures.unlinkCalls).toBe(1)  // 单次尝试即透传非瞬态错误
  })

  it('瞬态错误持续 → 3 次尝试耗尽后报错（不无限重试）', async () => {
    const m = makeManager()
    const h = okv(await m.acquire(req(ownerA, 'exclusive')))
    releaseFailures.unlink.push('EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY')
    const r = await h.release()
    expect(r.ok).toBe(false)
    expect(releaseFailures.unlinkCalls).toBe(3)  // 1 + 2 次重试 = 上限
  })

  it('shared 模式 rename 瞬态失败同样重试自愈', async () => {
    const m = makeManager()
    const h1 = okv(await m.acquire(req(ownerA, 'shared')))
    okv(await m.acquire(req(ownerB, 'shared')))
    // 第二个 shared 获取走读-改-写也调 renameSync：清零后只观测 release 阶段
    releaseFailures.renameCalls = 0
    releaseFailures.rename.push('EACCES')   // 首次 rename 失败
    const r = await h1.release()
    expect(r.ok).toBe(true)
    expect(releaseFailures.renameCalls).toBe(2)  // 失败 1 次 + 重试成功 1 次
    // ownerA 已移除，仅剩 ownerB：引用计数正确
    expect(m.holders({ kind: 'global' }).length).toBe(1)
  })
})

describe('共享锁（引用计数）', () => {
  it('多个 shared 并存，全释放后锁消失', async () => {
    const m = makeManager()
    const h1 = await m.acquire(req(ownerA, 'shared'))
    const h2 = await m.acquire(req(ownerB, 'shared'))
    expect(h1.ok && h2.ok).toBe(true)
    expect(m.holders({ kind: 'global' }).length).toBe(2)
    await okv(h1).release()
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    await okv(h2).release()
    expect(m.holders({ kind: 'global' }).length).toBe(0)
  })

  it('shared 占用时 exclusive 被拒', async () => {
    const m = makeManager()
    await m.acquire(req(ownerA, 'shared'))
    const x = await m.acquire(req(ownerB, 'exclusive'))
    expect(x.ok).toBe(false)
  })

  it('并发 shared acquire 不丢失 owner 条目（guard 串行化回归）', async () => {
    const m = makeManager()
    const owners = Array.from({ length: 8 }, (_, i): LockOwner =>
      ({ pid: 1000 + i, hostname: 'h', bootToken: `t${i}`, purpose: 'scan' }))
    const handles = await Promise.all(owners.map(o => m.acquire(req(o, 'shared'))))
    expect(handles.every(h => h.ok)).toBe(true)
    // 旧实现的随机后缀 guard 无互斥效果：并发读-改-写会互相覆盖，8 个只剩 1~2 个
    expect(m.holders({ kind: 'global' }).length).toBe(8)
    for (const h of handles) await (h as { value: { release(): Promise<unknown> } }).value.release()
  })

  it('并发 release 不互相覆盖（全部释放后锁文件消失）', async () => {
    const m = makeManager()
    const owners = Array.from({ length: 8 }, (_, i): LockOwner =>
      ({ pid: 2000 + i, hostname: 'h', bootToken: `r${i}`, purpose: 'scan' }))
    const handles = await Promise.all(owners.map(o => m.acquire(req(o, 'shared'))))
    expect(handles.every(h => h.ok)).toBe(true)
    await Promise.all(handles.map(h => (h as { value: { release(): Promise<unknown> } }).value.release()))
    expect(m.holders({ kind: 'global' }).length).toBe(0)
  })
})

describe('TTL 与 refresh', () => {
  it('TTL 过期后 holders 不再计入', async () => {
    const m = makeManager()
    const h = await m.acquire(req(ownerA, 'exclusive', 1000))
    expect(h.ok).toBe(true)
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    nowStub.value += 2000  // 时间前进 2s > TTL
    expect(m.holders({ kind: 'global' }).length).toBe(0)
  })

  it('refresh 续期', async () => {
    const m = makeManager()
    const h = await m.acquire(req(ownerA, 'exclusive', 1000))
    nowStub.value += 800
    expect((await okv(h).refresh()).ok).toBe(true)
    nowStub.value += 800   // 距 refresh 又过 800ms < 新 TTL 1000
    expect(m.holders({ kind: 'global' }).length).toBe(1)
  })
})

describe('安全破锁', () => {
  it('进程存活时拒绝破锁', async () => {
    const m = makeManager([111])   // 111 存活
    await m.acquire(req(ownerA, 'exclusive', 1))
    nowStub.value += 100  // TTL 过期但进程活着
    const r = await m.breakStale({
      lockId: 'x' as any, owner: ownerA, verifiedDead: false, ttlExpired: true,
    })
    expect(r.ok).toBe(false)
  })

  it('TTL 未过期拒绝破锁', async () => {
    const m = makeManager([])   // 111 已死
    await m.acquire(req(ownerA, 'exclusive', 10_000))
    const r = await m.breakStale({
      lockId: 'x' as any, owner: ownerA, verifiedDead: true, ttlExpired: false,
    })
    expect(r.ok).toBe(false)
  })

  it('进程已死 + TTL 过期 → 破锁成功且新锁可获取', async () => {
    const m = makeManager([])
    await m.acquire(req(ownerA, 'exclusive', 500))
    nowStub.value += 1000
    const r = await m.breakStale({
      lockId: 'x' as any, owner: ownerA, verifiedDead: true, ttlExpired: true,
    })
    expect(r.ok).toBe(true)
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(true)
  })
})

describe('陈旧锁自动回收（V5.6.2）', () => {
  it('exclusive 陈旧锁（过期且进程死亡）在下次获取时自动回收', async () => {
    const m = makeManager([])   // 111 已死
    okv(await m.acquire(req(ownerA, 'exclusive', 500)))
    nowStub.value += 1000      // TTL 过期：旧实现此处永久 E_LOCK_HELD
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(true)
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    if (h2.ok) await h2.value.release()
  })

  it('exclusive 陈旧锁不再阻塞 shared 获取（guard 内回收）', async () => {
    const m = makeManager([])
    okv(await m.acquire(req(ownerA, 'exclusive', 500)))
    nowStub.value += 1000
    const h2 = await m.acquire(req(ownerB, 'shared'))
    expect(h2.ok).toBe(true)
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    if (h2.ok) await h2.value.release()
  })

  it('持有者已死但 TTL 未到期 → 不回收，报错携带自动回收倒计时', async () => {
    // 跨主机保守边界（ownerA.hostname='h' ≠ os.hostname()）：共享锁目录上
    // 本机永远探不到他机进程，TTL 过期是远程持有者的唯一保护（V5.8.5）
    const m = makeManager([])
    okv(await m.acquire(req(ownerA, 'exclusive', 10_000)))
    nowStub.value += 4000   // 剩余 6s
    const r = await m.acquire(req(ownerB, 'exclusive'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_LOCK_HELD')
    expect(r.error.message).toContain('进程已死')
    expect(r.error.message).toContain('6')
    expect(r.error.message).toContain('自动回收')
  })

  // V5.8.5 同机已死立即回收（"用完即放，绝不占用"）：本机 kill 探测权威
  // （ESRCH = 内核证明进程不存在），死亡即终局，TTL 不再是必要条件。
  // 现实价值：崩溃/被 kill 的持有者不再让后续全部 nuke 操作白等 5 分钟 TTL。
  it('V5.8.5 同机持有者已死但 TTL 未到期 → exclusive 获取路径立即回收', async () => {
    const m = makeManager([])   // 111 已死
    const localA: LockOwner = { pid: 111, hostname: os.hostname(), bootToken: 'a', purpose: 'clean' }
    okv(await m.acquire(req(localA, 'exclusive', 10_000)))
    nowStub.value += 1000   // TTL 剩余 9s：旧实现报 E_LOCK_HELD + 倒计时
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(true)
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    if (h2.ok) await h2.value.release()
  })

  it('V5.8.5 同机持有者已死但 TTL 未到期 → shared 获取路径（guard 内回收）同样立即回收', async () => {
    const m = makeManager([])
    const localA: LockOwner = { pid: 111, hostname: os.hostname(), bootToken: 'a', purpose: 'clean' }
    okv(await m.acquire(req(localA, 'exclusive', 10_000)))
    nowStub.value += 1000
    const h2 = await m.acquire(req(ownerB, 'shared'))
    expect(h2.ok).toBe(true)
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    if (h2.ok) await h2.value.release()
  })

  it('持有者存活且过期 → 严格破锁纪律，不自动回收（防 SIGSTOP/长 GC 误伤）', async () => {
    const m = makeManager([111])   // 111 存活
    okv(await m.acquire(req(ownerA, 'exclusive', 500)))
    nowStub.value += 1000
    const r = await m.acquire(req(ownerB, 'exclusive'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('已过期但进程仍存活')
  })

  it('活跃持有者不受回收影响（exclusive 仍阻塞 shared）', async () => {
    const m = makeManager([111])
    okv(await m.acquire(req(ownerA, 'exclusive')))
    expect(await m.tryAcquire(req(ownerB, 'shared'))).toBeNull()
  })

  it('E_LOCK_HELD 报错区分活跃与陈旧持有者', async () => {
    const m = makeManager([111])
    okv(await m.acquire(req(ownerA, 'exclusive')))
    const r = await m.acquire(req(ownerB, 'exclusive'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('活跃')
  })

  it('v5.6.2 锁文件 pid 非正整数（磁盘可被篡改）→ 视为无锁，不探测进程组', async () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const m = createLockManager({ lockRoot, now: () => nowStub.value })
    const lockDir = path.join(lockRoot, 'locks')
    fs.mkdirSync(lockDir, { recursive: true })
    for (const bad of [-1, 0, 3.5]) {
      fs.writeFileSync(path.join(lockDir, 'global.lock'), JSON.stringify({
        version: 1, scope: 'global', mode: 'exclusive',
        owners: [{ owner: { pid: bad, hostname: 'h', bootToken: 'x', purpose: 'clean' },
          acquiredAt: 't', expiresAt: nowStub.value + 60_000 }],
      }))
      const h = await m.acquire(req(ownerB, 'exclusive'))
      expect(h.ok).toBe(true)
      if (h.ok) await h.value.release()
    }
  })

  it('v5.6.2 结构损坏的锁文件（截断 JSON）→ 自动回收不阻塞获取', async () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const m = createLockManager({ lockRoot, now: () => nowStub.value, probe: { isAlive: () => false } })
    const p = path.join(lockRoot, 'locks', 'global.lock')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{"version":1,"scope":"global","mode":"exclu')  // 模拟写入中途崩溃
    const h = await m.acquire(req(ownerB, 'exclusive'))
    expect(h.ok).toBe(true)
    if (h.ok) await h.value.release()
  })
})

describe('withLock RAII', () => {
  it('fn 抛异常也释放锁', async () => {
    const m = makeManager()
    const r = await m.withLock(req(ownerA, 'exclusive'), async () => {
      throw new Error('boom')
    })
    expect(r.ok).toBe(false)
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(true)
  })

  it('正常路径透传 Result', async () => {
    const m = makeManager()
    const r = await m.withLock(req(ownerA, 'exclusive'), async () => ok(42))
    expect(r.ok && r.value).toBe(42)
  })
})

describe('锁升级（指数退避等待 + 自动心跳续期）', () => {
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

  /** 真实时钟 manager（心跳/退避依赖真实 setTimeout，不能冻结 now stub） */
  function realManager() {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    return {
      lockRoot,
      m: createLockManager({ lockRoot, probe: { isAlive: () => false } }),
    }
  }

  it('等待重试（指数退避+抖动）：超时返回 E_LOCK_HELD 并报告当前持有者', async () => {
    const { m } = realManager()
    okv(await m.acquire(req(ownerA, 'exclusive')))
    const r = await m.acquire({ ...req(ownerB, 'exclusive'), waitTimeoutMs: 120 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_LOCK_HELD')
    expect(r.error.message).toContain('clean')
    expect(r.error.message).toContain('111')
  })

  it('等待重试：锁释放后等待者在截止线内成功获取', async () => {
    const { m } = realManager()
    const h1 = okv(await m.acquire(req(ownerA, 'exclusive')))
    // 80ms 后释放；ownerB 等待窗口 2s，退避期间应等到
    void (async () => { await sleep(80); await h1.release() })()
    const r = await m.acquire({ ...req(ownerB, 'exclusive'), waitTimeoutMs: 2_000 })
    expect(r.ok).toBe(true)
    if (r.ok) await r.value.release()
  })

  it('autoRenewMs 心跳续期：TTL 到期前自动 refresh，长持有不失效', async () => {
    const { m } = realManager()
    const r = await m.acquire({
      scope: { kind: 'global' }, mode: 'exclusive', owner: ownerA,
      waitTimeoutMs: 0, ttlMs: 150, autoRenewMs: 40,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await sleep(400)   // 远超 TTL 150ms：无心跳必然过期
    expect(m.holders({ kind: 'global' }).length).toBe(1)   // 心跳保活
    await r.value.release()
    await sleep(80)    // 过一个心跳周期：释放后定时器清除，锁不复活
    expect(m.holders({ kind: 'global' }).length).toBe(0)
  })

  it('对照：无自动续期的锁在 TTL 后自然失效', async () => {
    const { m } = realManager()
    okv(await m.acquire(req(ownerA, 'exclusive', 150)))
    await sleep(400)
    expect(m.holders({ kind: 'global' }).length).toBe(0)
  })

  it('锁被外部清除后心跳停跳止血（不复活已消失的锁）', async () => {
    const { m, lockRoot } = realManager()
    const r = await m.acquire({
      scope: { kind: 'global' }, mode: 'exclusive', owner: ownerA,
      waitTimeoutMs: 0, ttlMs: 10_000, autoRenewMs: 30,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const lockFile = path.join(lockRoot, 'locks', 'global.lock')
    fs.unlinkSync(lockFile)   // 模拟被安全破锁（锁文件消失）
    await sleep(100)          // 期间心跳数次全部 E_LOCK_STALE → 停跳
    expect(fs.existsSync(lockFile)).toBe(false)   // 心跳绝不重建锁文件
    expect(m.holders({ kind: 'global' }).length).toBe(0)
    await r.value.release()
  })

  // V5.8.7 maxHoldMs：autoRenew 的无限续期把 TTL 变成永不到期 —— 句柄
  // 被调用方遗忘（事务半途被宿主抛弃）= 锁在进程存活期间永久占用。
  it('V5.8.7 maxHoldMs 持有硬上限：超限后心跳停跳，锁交还 TTL 回收（遗忘句柄不再永久占用）', async () => {
    const { m } = realManager()
    const r = await m.acquire({
      scope: { kind: 'global' }, mode: 'exclusive', owner: ownerA,
      waitTimeoutMs: 0, ttlMs: 150, autoRenewMs: 40, maxHoldMs: 120,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 400ms > maxHold 120ms：停跳发生在首次超限 tick（≈120~160ms），
    // 最后一次续期最多保到 ≈停跳点+TTL 150ms < 400ms
    await sleep(400)
    expect(m.holders({ kind: 'global' }).length).toBe(0)   // 不再无限续期
    await r.value.release()
  })

  it('V5.8.7 对照：未设 maxHoldMs 的心跳持续保活（硬上限不误伤正常长持有）', async () => {
    const { m } = realManager()
    const r = await m.acquire({
      scope: { kind: 'global' }, mode: 'exclusive', owner: ownerA,
      waitTimeoutMs: 0, ttlMs: 150, autoRenewMs: 40,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await sleep(400)   // 与上例同窗口：无上限 → 心跳保活
    expect(m.holders({ kind: 'global' }).length).toBe(1)
    await r.value.release()
  })
})

describe('V5.7 存活探测：EACCES/EPERM 误判修复', () => {
  /** process.kill mock：指定 pid 抛携带 errno 的异常（模拟跨会话/提权进程） */
  function mockKill(code: string | null) {
    return vi.spyOn(process, 'kill').mockImplementation((() => {
      if (code === null) return true
      throw Object.assign(new Error(`mock ${code}`), { code })
    }) as typeof process.kill)
  }

  it('EACCES（Windows libuv 的"存在但无权限"）→ 按存活处理，绝不误判已死', () => {
    const k = mockKill('EACCES')
    try {
      // 旧实现只认 EPERM：Windows 提权/跨会话持有者被误判已死 → 活锁被回收
      expect(defaultProcessProbe().isAlive(process.pid, os.hostname())).toBe(true)
    } finally { k.mockRestore() }
  })

  it('EPERM（POSIX 的"存在但无权限"）→ 按存活处理', () => {
    const k = mockKill('EPERM')
    try {
      expect(defaultProcessProbe().isAlive(process.pid, os.hostname())).toBe(true)
    } finally { k.mockRestore() }
  })

  it('ESRCH（进程真不存在）→ 已死', () => {
    const k = mockKill('ESRCH')
    try {
      expect(defaultProcessProbe().isAlive(process.pid, os.hostname())).toBe(false)
    } finally { k.mockRestore() }
  })

  it('主机名不匹配（其他机器的持有者）→ 已死，不探测本地 pid', () => {
    const k = mockKill(null)
    try {
      expect(defaultProcessProbe().isAlive(process.pid, 'other-host')).toBe(false)
      expect(k).not.toHaveBeenCalled()
    } finally { k.mockRestore() }
  })
})

describe('V5.7 PID 复用甄别（进程启动时间指纹）', () => {
  /** 带指纹探测的 manager：startTimes 模拟"该 pid 当前真实启动时间" */
  function managerWith(
    alivePids: number[],
    startTimes: Record<number, number>,
    clock = (() => nowStub.value),
  ) {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    return {
      lockRoot,
      m: createLockManager({
        lockRoot, now: clock,
        probe: {
          isAlive: pid => alivePids.includes(pid),
          startTimeOf: pid => startTimes[pid] ?? null,
        },
      }),
    }
  }

  it('获取时自动补写本进程启动时间指纹进锁文件', async () => {
    const { lockRoot, m } = managerWith([process.pid], { [process.pid]: 1_234_567 })
    okv(await m.acquire(req(ownerA, 'exclusive')))
    const raw = JSON.parse(fs.readFileSync(
      path.join(lockRoot, 'locks', 'global.lock'), 'utf-8',
    )) as { owners: { owner: { startTime?: number } }[] }
    expect(raw.owners[0]!.owner.startTime).toBe(1_234_567)
  })

  it('PID 存活但启动时间不符（PID 被复用）→ 视为已死，TTL 过期后自动回收', async () => {
    // 持有者 111 获取锁时指纹 = 1_000_000；之后 PID 111 被"新进程"复用，
    // 当前真实启动时间 = 1_500_000（差 500s ≫ 容差 2s）
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'global.lock'), JSON.stringify({
      version: 1, scope: 'global', mode: 'exclusive',
      owners: [{ owner: { ...ownerA, startTime: 1_000_000 }, acquiredAt: 't', expiresAt: nowStub.value - 1 }],
    }))
    const m = createLockManager({
      lockRoot, now: () => nowStub.value,
      probe: { isAlive: pid => pid === 111, startTimeOf: pid => pid === 111 ? 1_500_000 : null },
    })
    const h2 = await m.acquire(req(ownerB, 'exclusive'))
    expect(h2.ok).toBe(true)   // 旧实现：kill(111,0) 恒真 → 永远 E_LOCK_HELD
    if (h2.ok) await h2.value.release()
  })

  it('PID 存活且启动时间吻合（容差内）→ 真持有者，过期也不回收（防误伤）', async () => {
    // ownerA 持有指纹 1_000_000；探测返回 1_000_800（差 800ms < 2s 容差）
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'global.lock'), JSON.stringify({
      version: 1, scope: 'global', mode: 'exclusive',
      owners: [{ owner: { ...ownerA, startTime: 1_000_000 }, acquiredAt: 't', expiresAt: nowStub.value - 1 }],
    }))
    const m = createLockManager({
      lockRoot, now: () => nowStub.value,
      probe: { isAlive: pid => pid === 111, startTimeOf: pid => pid === 111 ? 1_000_800 : null },
    })
    const r = await m.acquire(req(ownerB, 'exclusive'))
    expect(r.ok).toBe(false)   // 指纹吻合 → 判活 → 不回收
    if (!r.ok) expect(r.error.message).toContain('已过期但进程仍存活')
  })

  it('指纹平台不可用（startTimeOf 恒 null）→ 退回保守纯存活判定', async () => {
    const m = createLockManager({
      lockRoot: path.join(tmp, `run-${Math.random().toString(36).slice(2)}`),
      now: () => nowStub.value,
      probe: { isAlive: pid => pid === 111 },   // 无 startTimeOf
    })
    okv(await m.acquire(req(ownerA, 'exclusive', 500)))
    nowStub.value += 1000
    const r = await m.acquire(req(ownerB, 'exclusive'))
    expect(r.ok).toBe(false)   // 无法甄别 → 保守：仍按存活处理
    if (!r.ok) expect(r.error.message).toContain('已过期但进程仍存活')
  })

  it('E_LOCK_HELD 报错：PID 复用 + TTL 未到期 → 报"进程已死 + 回收倒计时"（不再误报为存活）', async () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'global.lock'), JSON.stringify({
      version: 1, scope: 'global', mode: 'exclusive',
      owners: [{ owner: { ...ownerA, startTime: 1_000_000 }, acquiredAt: 't', expiresAt: nowStub.value + 6_000 }],
    }))
    const m = createLockManager({
      lockRoot, now: () => nowStub.value,
      // kill(111,0) 恒真（PID 被复用）但指纹不符：旧实现报"已过期但进程仍存活"
      probe: { isAlive: () => true, startTimeOf: () => 9_999_999 },
    })
    const r = await m.acquire(req(ownerB, 'exclusive'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('进程已死')
      expect(r.error.message).toContain('自动回收')
    }
  })
})

describe('V5.7 inspect() 锁诊断快照', () => {
  it('活跃 / 已死未到期 / 陈旧残留 / PID 复用四形态的合成口径', () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    const t = nowStub.value
    const mk = (pid: number, start: number | undefined, expiresAt: number): unknown => ({
      owner: { pid, hostname: 'h', bootToken: `t${pid}`, purpose: 'clean', ...(start !== undefined ? { startTime: start } : {}) },
      acquiredAt: 't0', expiresAt,
    })
    // 三个 scope 三种形态：active(111) / dead-not-expired(222) / stale(333)
    fs.writeFileSync(path.join(dir, 'global.lock'), JSON.stringify({
      version: 1, scope: 'global', mode: 'exclusive',
      owners: [mk(111, 1_000_000, t + 60_000)],
    }))
    fs.writeFileSync(path.join(dir, 'profile_web.lock'), JSON.stringify({
      version: 1, scope: 'profile:web', mode: 'shared',
      owners: [mk(222, undefined, t + 5_000)],
    }))
    fs.writeFileSync(path.join(dir, 'plugin_web_x.lock'), JSON.stringify({
      version: 1, scope: 'plugin:web/x', mode: 'exclusive',
      owners: [mk(333, 2_000_000, t - 1)],
    }))
    const m = createLockManager({
      lockRoot, now: () => t,
      probe: {
        // 222 已死（未到期）；111 活着且指纹吻合；333 被 PID 复用
        isAlive: pid => pid === 111 || pid === 333,
        startTimeOf: pid => pid === 111 ? 1_000_500 : pid === 333 ? 8_888_888 : null,
      },
    })
    const files = m.inspect()
    expect(files).toHaveLength(3)
    const byFile = new Map(files.map(f => [f.file, f]))
    const active = byFile.get('global.lock')!.slots[0]!
    expect(active.alive).toBe(true)        // 指纹吻合（差 500ms）→ 判活
    expect(active.expired).toBe(false)
    expect(active.pidReused).toBe(false)
    expect(active.autoReapInSec).toBeNull()  // 有活人 → 不可自动回收
    const dead = byFile.get('profile_web.lock')!.slots[0]!
    expect(dead.alive).toBe(false)         // isAlive=false（无指纹也判死）
    expect(dead.expired).toBe(false)
    expect(dead.autoReapInSec).toBe(5)     // TTL 剩余 5s 后可回收
    const reused = byFile.get('plugin_web_x.lock')!.slots[0]!
    expect(reused.pidReused).toBe(true)    // 指纹不符 → PID 被复用
    expect(reused.alive).toBe(false)
    expect(reused.autoReapInSec).toBe(0)   // 已过期 → 立即可回收
  })

  it('V5.8.5 同机全体已死（TTL 未过期）→ autoReapInSec=0（立即可回收，不再倒计时）', () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    const t = nowStub.value
    fs.writeFileSync(path.join(dir, 'global.lock'), JSON.stringify({
      version: 1, scope: 'global', mode: 'exclusive',
      owners: [{ owner: { pid: 999, hostname: os.hostname(), bootToken: 'z', purpose: 'clean' },
        acquiredAt: 't0', expiresAt: t + 60_000 }],
    }))
    const m = createLockManager({ lockRoot, now: () => t, probe: { isAlive: () => false } })
    const slot = m.inspect()[0]!.slots[0]!
    expect(slot.alive).toBe(false)
    expect(slot.expired).toBe(false)          // TTL 未过期
    expect(slot.autoReapInSec).toBe(0)        // 同机已死 → 立即回收（旧实现为 60）
  })

  it('空锁目录 → 空快照（不抛错）', () => {
    const m = createLockManager({
      lockRoot: path.join(tmp, `run-${Math.random().toString(36).slice(2)}`),
      now: () => nowStub.value,
    })
    expect(m.inspect()).toEqual([])
  })

  it('结构损坏的锁文件不出现在快照中（readLock 同口径过滤）', () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'broken.lock'), '{"version":1,"mode":"exclu')
    const m = createLockManager({ lockRoot, now: () => nowStub.value })
    expect(m.inspect()).toEqual([])
  })
})

describe('V5.7 guard 强拆核验（慢而未死不拆）', () => {
  /** 手工构造超龄 guard（mtime=epoch）+ owner 文件记录 pid */
  function plantAgedGuard(lockRoot: string, pid: number): string {
    const dir = path.join(lockRoot, 'locks')
    fs.mkdirSync(dir, { recursive: true })
    const guard = path.join(dir, 'global.lock.mut')
    fs.mkdirSync(guard)
    fs.writeFileSync(path.join(guard, 'owner'), `tok-${pid}\n${pid}`)
    fs.utimesSync(guard, 0, 0)   // mtime=epoch → 远超 10s 强拆阈值
    return guard
  }

  it('超龄 guard 的持有进程已死 → 强拆后获取成功', async () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const guard = plantAgedGuard(lockRoot, 4242)
    const m = createLockManager({
      lockRoot, now: () => nowStub.value,
      probe: { isAlive: pid => pid !== 4242 },   // 4242 已死 → 允许强拆
    })
    const h = await m.acquire(req(ownerA, 'shared'))   // shared 路径经由 guard
    expect(h.ok).toBe(true)
    expect(fs.existsSync(guard)).toBe(false)   // 被强拆并由本次获取者接管后正常释放
    if (h.ok) await h.value.release()
  })

  it('超龄 guard 的持有进程仍存活 → 核验生效不强拆（互斥语义保全）', async () => {
    const lockRoot = path.join(tmp, `run-${Math.random().toString(36).slice(2)}`)
    const guard = plantAgedGuard(lockRoot, 5252)
    const m = createLockManager({
      lockRoot, now: () => Date.now(),   // 真实时钟：等待循环依赖时间推进
      probe: { isAlive: pid => pid === 5252 },   // 5252 活着（只是慢）→ 绝不拆
    })
    const acquiring = m.acquire(req(ownerA, 'shared'))
    await new Promise(r => setTimeout(r, 400))
    // 旧实现纯按年龄强拆：400ms 内必然已被拆掉。核验生效 → guard 仍在
    expect(fs.existsSync(guard)).toBe(true)
    // 让等待方退出（GUARD_MAX_WAIT_MS=15s 太久，直接移除 guard 模拟持有者完成）
    fs.rmSync(guard, { recursive: true, force: true })
    const h = await acquiring
    expect(h.ok).toBe(true)
    if (h.ok) await h.value.release()
  })
})

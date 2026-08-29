import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ok } from '../src/contracts/base'
import type { LockOwner, LockRequest } from '../src/contracts/lock'
import { createLockManager } from '../src/infra/lock-manager'

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
})

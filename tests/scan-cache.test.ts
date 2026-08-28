// tests/scan-cache.test.ts — 增量扫描缓存 + 有界并发池单测（突破升级守护）
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dirSize, dirSizeAsync, forEachPool, fsyncDir, walk, withTransientRetry } from '../src/infra/fs-utils'
import { createScanCache } from '../src/infra/scan-cache'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scancache-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('ScanCache（mtime+size 指纹缓存）', () => {
  it('指纹匹配命中 / mtime 或 size 变化即失效', async () => {
    const file = path.join(tmp, 'c1.json')
    const target = path.join(tmp, 'data1.txt')
    fs.writeFileSync(target, 'hello')
    const st = fs.statSync(target)
    const cache = createScanCache({ filePath: file })

    cache.set(target, { mtimeMs: st.mtimeMs, size: st.size, containsHit: true })
    expect(cache.get(target, st.mtimeMs, st.size)?.containsHit).toBe(true)
    expect(cache.stats().hits).toBe(1)

    // size 变化 → miss
    expect(cache.get(target, st.mtimeMs, st.size + 1)).toBeNull()
    // mtime 变化 → miss
    expect(cache.get(target, st.mtimeMs + 1, st.size)).toBeNull()
    expect(cache.stats().misses).toBe(2)
  })

  it('flush 后新实例从磁盘重建；损坏文件 → 空缓存起步', () => {
    const file = path.join(tmp, 'c2.json')
    const cache = createScanCache({ filePath: file })
    cache.set('/a', { mtimeMs: 1, size: 2, dirBytes: 100 })
    cache.flush()
    const reloaded = createScanCache({ filePath: file })
    expect(reloaded.get('/a', 1, 2)?.dirBytes).toBe(100)

    // 损坏持久化文件 → 空缓存（磁盘数据不可信纪律）
    fs.writeFileSync(file, '{CORRUPT')
    const corrupted = createScanCache({ filePath: file })
    expect(corrupted.get('/a', 1, 2)).toBeNull()
    expect(corrupted.stats().entries).toBe(0)
  })

  it('无变更 flush 零写入（dirty 标记）', () => {
    const file = path.join(tmp, 'c3.json')
    const cache = createScanCache({ filePath: file })
    cache.flush()   // 从未 set → 不应产生文件
    expect(fs.existsSync(file)).toBe(false)
  })

  it('LRU 驱逐：超上限逐最旧，读刷新热度', () => {
    const file = path.join(tmp, 'c4.json')
    const cache = createScanCache({ filePath: file, maxEntries: 2 })
    cache.set('/1', { mtimeMs: 0, size: 0 })
    cache.set('/2', { mtimeMs: 0, size: 0 })
    expect(cache.get('/1', 0, 0)).not.toBeNull()   // /1 刷新为最新
    cache.set('/3', { mtimeMs: 0, size: 0 })       // 溢出 → 逐 /2（最旧）
    expect(cache.get('/2', 0, 0)).toBeNull()
    expect(cache.get('/1', 0, 0)).not.toBeNull()   // /1 仍在
    expect(cache.get('/3', 0, 0)).not.toBeNull()
  })

  it('TTL 兜底：过期条目即使指纹匹配也失效（目录嵌套原地改写的边界）', () => {
    // 新鲜条目正常命中
    const fresh = createScanCache({ filePath: path.join(tmp, 'c5a.json'), maxAgeMs: 60_000 })
    fresh.set('/dir', { mtimeMs: 100, size: 4096, dirBytes: 5000 })
    expect(fresh.get('/dir', 100, 4096)?.dirBytes).toBe(5000)
    // maxAgeMs=0：写入即过期 —— 指纹匹配也必须 miss
    const zero = createScanCache({ filePath: path.join(tmp, 'c5b.json'), maxAgeMs: 0 })
    zero.set('/d', { mtimeMs: 1, size: 1 })
    expect(zero.get('/d', 1, 1)).toBeNull()
  })
})

describe('forEachPool（有界并发池）', () => {
  it('结果保持输入顺序；错误隔离不炸整池', async () => {
    const items = [5, 4, 3, 2, 1, 0]
    const out = await forEachPool(items, 3, async n => {
      await new Promise(r => setTimeout(r, n * 5))
      if (n === 0) throw new Error('boom')
      return n * 10
    })
    // 顺序保持
    expect(out.map((r, i) => r.status === 'fulfilled' ? r.value : `e${items[i]}`))
      .toEqual([50, 40, 30, 20, 10, 'e0'])
  })

  it('并发上界受控（峰值在途 ≤ concurrency）', async () => {
    let inflight = 0
    let peak = 0
    await forEachPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise(r => setTimeout(r, 10))
      inflight--
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)   // 确认真的并发了
  })
})

describe('dirSizeAsync（并行目录体积）', () => {
  it('与同步 dirSize 结果一致（含嵌套/多文件）', async () => {
    const dir = path.join(tmp, 'tree')
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'f1'), Buffer.alloc(100))
    fs.writeFileSync(path.join(dir, 'a', 'f2'), Buffer.alloc(200))
    fs.writeFileSync(path.join(dir, 'a', 'b', 'f3'), Buffer.alloc(300))
    expect(await dirSizeAsync(dir)).toBe(dirSize(dir))
  })

  it('符号链接入口返回 0（与同步语义一致）', async () => {
    const dir = path.join(tmp, 'tree')
    const link = path.join(tmp, 'treelink')
    try { fs.unlinkSync(link) } catch {}
    fs.symlinkSync(dir, link)
    expect(await dirSizeAsync(link)).toBe(0)
    fs.unlinkSync(link)
  })

  it('AbortSignal 中止：立即停止并返回已累计的部分值', async () => {
    const dir = path.join(tmp, 'tree-abort')
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'f1'), Buffer.alloc(100))
    fs.writeFileSync(path.join(dir, 'a', 'f2'), Buffer.alloc(200))
    const ac = new AbortController()
    ac.abort()   // 预先中止：整个遍历立即停止
    const n = await dirSizeAsync(dir, { signal: ac.signal })
    expect(n).toBe(0)
  })
})

describe('walk（统一目录遍历原语）', () => {
  it('先序流式产出：名字序、深度正确、root 本身不产出', async () => {
    const root = path.join(tmp, 'walk1')
    fs.mkdirSync(path.join(root, 'b', 'c'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    fs.writeFileSync(path.join(root, 'b', 'y.txt'), 'y')
    fs.writeFileSync(path.join(root, 'b', 'c', 'z.txt'), 'z')
    const out: { rel: string; depth: number; kind: string }[] = []
    for await (const e of walk(root)) {
      out.push({ rel: path.relative(root, e.path), depth: e.depth, kind: e.kind })
    }
    expect(out.map(o => o.rel)).toEqual(['a.txt', 'b', 'b/c', 'b/y.txt', 'b/c/z.txt'])
    expect(out.map(o => o.depth)).toEqual([1, 1, 2, 2, 3])
    expect(out.map(o => o.kind)).toEqual(['file', 'dir', 'dir', 'file', 'file'])
  })

  it('maxDepth 截断：更深子树不再产出', async () => {
    const root = path.join(tmp, 'walk2')
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'd.txt'), 'd')
    const out: string[] = []
    for await (const e of walk(root, { maxDepth: 2 })) out.push(path.relative(root, e.path))
    expect(out).toEqual(['a', 'a/b'])   // a/b/c 深度 3 > 2 被截断
  })

  it('符号链接：默认跳过；skipSymlinks=false 产出但绝不下降', async () => {
    const root = path.join(tmp, 'walk3')
    fs.mkdirSync(path.join(root, 'real'), { recursive: true })
    fs.writeFileSync(path.join(root, 'real', 'f.txt'), 'f')
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))

    const skipped: string[] = []
    for await (const e of walk(root)) skipped.push(path.relative(root, e.path))
    expect(skipped).toEqual(['real', 'real/f.txt'])   // link 不产出

    const yielded: string[] = []
    for await (const e of walk(root, { skipSymlinks: false })) yielded.push(path.relative(root, e.path))
    expect(yielded).toContain('link')              // 产出 symlink 条目
    expect(yielded).not.toContain('link/f.txt')    // 但绝不下降进入（防 DoS 底线）
  })

  it('AbortSignal：置位后立即停止产出', async () => {
    const root = path.join(tmp, 'walk4')
    fs.mkdirSync(path.join(root, 'a'), { recursive: true })
    fs.writeFileSync(path.join(root, 'f1'), '1')
    fs.writeFileSync(path.join(root, 'a', 'f2'), '2')
    const ac = new AbortController()
    const out: string[] = []
    for await (const e of walk(root, { signal: ac.signal })) {
      out.push(e.name)
      ac.abort()
    }
    expect(out.length).toBe(1)   // 第一个条目后立即中止
  })

  it('onEntryError：读失败的路径上报后跳过（fail-soft 不抛错）', async () => {
    const root = path.join(tmp, 'walk5')
    fs.mkdirSync(root, { recursive: true })
    // 把"文件"当 root 遍历：readdir ENOTDIR → 回调上报 + 空遍历
    const notDir = path.join(root, 'plain.txt')
    fs.writeFileSync(notDir, 'x')
    const errors: string[] = []
    const out: string[] = []
    for await (const e of walk(notDir, { onEntryError: dir => errors.push(dir) })) out.push(e.name)
    expect(out).toEqual([])
    expect(errors).toEqual([notDir])
  })
})

describe('withTransientRetry（瞬态错误退避重试）', () => {
  const emfile = (): NodeJS.ErrnoException => {
    const e = new Error('too many open files') as NodeJS.ErrnoException
    e.code = 'EMFILE'
    return e
  }

  it('瞬态错误退避重试后成功', async () => {
    let calls = 0
    const v = await withTransientRetry(async () => {
      calls++
      if (calls < 3) throw emfile()
      return 42
    }, { baseDelayMs: 1 })
    expect(v).toBe(42)
    expect(calls).toBe(3)
  })

  it('非瞬态错误零重试、立即透传', async () => {
    let calls = 0
    await expect(withTransientRetry(async () => {
      calls++
      const e = new Error('permission denied') as NodeJS.ErrnoException
      e.code = 'EACCES'
      throw e
    })).rejects.toThrow('permission denied')
    expect(calls).toBe(1)
  })

  it('重试耗尽后抛出最后一次错误', async () => {
    let calls = 0
    await expect(withTransientRetry(async () => {
      calls++
      throw emfile()
    }, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('too many open files')
    expect(calls).toBe(3)   // 首次执行 + 2 次重试
  })
})

describe('fsyncDir（目录条目持久化）', () => {
  it('存在/不存在的目录都不抛错（fail-soft 降级）', () => {
    expect(() => fsyncDir(tmp)).not.toThrow()
    expect(() => fsyncDir(path.join(tmp, 'no-such-dir'))).not.toThrow()
  })
})

describe('缓存命中 touch（新鲜度重置）', () => {
  it('持续命中的热条目不过期；闲置冷条目按 TTL 失效', async () => {
    const cache = createScanCache({ filePath: path.join(tmp, 'touch1.json'), maxAgeMs: 150 })
    cache.set('/hot', { mtimeMs: 1, size: 1 })
    cache.set('/cold', { mtimeMs: 1, size: 1 })
    await sleep(100)                                  // 距 set 100ms
    expect(cache.get('/hot', 1, 1)).not.toBeNull()    // 命中 → cachedAt 重置
    await sleep(100)                                  // 距上次 touch 100ms < 150；距 set 200ms > 150
    expect(cache.get('/hot', 1, 1)).not.toBeNull()    // 热条目仍新鲜
    expect(cache.get('/cold', 1, 1)).toBeNull()       // 冷条目 TTL 到期失效
  })
})

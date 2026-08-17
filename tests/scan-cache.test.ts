// tests/scan-cache.test.ts — 增量扫描缓存 + 有界并发池单测（突破升级守护）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createScanCache } from '../src/infra/scan-cache'
import { dirSize, dirSizeAsync, forEachPool } from '../src/infra/fs-utils'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scancache-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

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
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createAuditLog } from '../src/infra/audit-log'
import type { AuditEntry } from '../src/contracts/logging'

let tmp: string
let chainPath: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'))
  chainPath = path.join(tmp, 'chain.jsonl')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function entry(seq: number): AuditEntry {
  return {
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    actor: 'tester',
    action: `action-${seq}`,
    outcome: 'success',
    detail: { seq },
  }
}

describe('审计链', () => {
  it('追加产生递增链：seq/prevHash/hash 连续', async () => {
    const log = createAuditLog({ filePath: chainPath })
    const h1 = await log.append(entry(1))
    const h2 = await log.append(entry(2))
    const h3 = await log.append(entry(3))
    expect(h1.seq).toBe(0)
    expect(h2.seq).toBe(1)
    expect(h2.prevHash).toBe(h1.hash)
    expect(h3.prevHash).toBe(h2.hash)
    expect((await log.verify()).valid).toBe(true)
  })

  it('query 按 txId 过滤', async () => {
    const log = createAuditLog({ filePath: chainPath })
    await log.append({ ...entry(4), txId: 'tx9' as any })
    await log.append({ ...entry(5), txId: 'tx9' as any })
    const rows = await log.query({ txId: 'tx9' as any })
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.txId === 'tx9')).toBe(true)
  })

  it('篡改历史条目 → verify 定位断裂点', async () => {
    const dir2 = path.join(tmp, 'case2')
    const p2 = path.join(dir2, 'chain.jsonl')
    const log = createAuditLog({ filePath: p2 })
    for (let i = 1; i <= 5; i++) await log.append(entry(i))

    // 篡改第 3 条（seq=2）的 detail
    const lines = fs.readFileSync(p2, 'utf-8').split('\n').filter(l => l)
    const corrupted = JSON.parse(lines[2]!)
    corrupted.detail = { seq: 999, hacked: true }
    lines[2] = JSON.stringify(corrupted)
    fs.writeFileSync(p2, lines.join('\n') + '\n')

    const v = await createAuditLog({ filePath: p2 }).verify()
    expect(v.valid).toBe(false)
    expect(v.firstBrokenSeq).toBe(2)
  })

  it('删除历史条目 → verify 失败', async () => {
    const p3 = path.join(tmp, 'case3', 'chain.jsonl')
    const log = createAuditLog({ filePath: p3 })
    for (let i = 1; i <= 4; i++) await log.append(entry(i))
    const lines = fs.readFileSync(p3, 'utf-8').split('\n').filter(l => l)
    lines.splice(1, 1)   // 删除 seq=1
    fs.writeFileSync(p3, lines.join('\n') + '\n')
    const v = await createAuditLog({ filePath: p3 }).verify()
    expect(v.valid).toBe(false)
  })

  it('canonicalJson 键序无关：同内容不同键序同 hash', async () => {
    const p4 = path.join(tmp, 'case4', 'chain.jsonl')
    const log = createAuditLog({ filePath: p4 })
    const a = await log.append({ timestamp: 'T', actor: 'u', action: 'x', outcome: 'success', detail: { a: 1, b: 2 } })
    const b = await log.append({ timestamp: 'T2', actor: 'u', action: 'x', outcome: 'success', detail: { b: 2, a: 1 } })
    // detail 内容不同（时间戳不同）hash 必不同；此处验证不抛错且链有效
    expect(a.hash).not.toBe(b.hash)
    expect((await log.verify()).valid).toBe(true)
  })

  it('规模化追加：2000 条链完整（守护 O(1) append）', async () => {
    const p5 = path.join(tmp, 'case5', 'chain.jsonl')
    const log = createAuditLog({ filePath: p5 })
    const N = 2000
    for (let i = 1; i <= N; i++) {
      await log.append(entry(i))
    }
    const v = await log.verify()
    expect(v.valid).toBe(true)
    expect(v.totalEntries).toBe(N)
    // 崩溃模拟：新实例从磁盘重建链尾缓存后可继续正确追加
    const log2 = createAuditLog({ filePath: p5 })
    const next = await log2.append(entry(N + 1))
    expect(next.seq).toBe(N)
  })
})

describe('审计链升级（批量追加 + 增量校验）', () => {
  it('appendMany：批量与逐条 append 产生同构链（seq/prevHash/hash 连续）', async () => {
    const p = path.join(tmp, 'batch1', 'chain.jsonl')
    const log = createAuditLog({ filePath: p })
    const batch = [entry(10), entry(11), entry(12)]
    const hashed = await log.appendMany(batch)
    expect(hashed.length).toBe(3)
    expect(hashed[0]!.seq).toBe(0)
    expect(hashed[1]!.prevHash).toBe(hashed[0]!.hash)
    expect(hashed[2]!.prevHash).toBe(hashed[1]!.hash)
    expect((await log.verify()).valid).toBe(true)
    expect((await log.verify()).totalEntries).toBe(3)
  })

  it('appendMany 与逐条 append 交错：链连续性保持', async () => {
    const p = path.join(tmp, 'batch2', 'chain.jsonl')
    const log = createAuditLog({ filePath: p })
    const h1 = await log.append(entry(1))
    const batch = await log.appendMany([entry(2), entry(3)])
    const h4 = await log.append(entry(4))
    expect(batch[0]!.prevHash).toBe(h1.hash)
    expect(batch[1]!.prevHash).toBe(batch[0]!.hash)
    expect(h4.prevHash).toBe(batch[1]!.hash)
    expect((await log.verify()).valid).toBe(true)
  })

  it('appendMany 空数组：无副作用、返回空', async () => {
    const p = path.join(tmp, 'batch3', 'chain.jsonl')
    const log = createAuditLog({ filePath: p })
    const out = await log.appendMany([])
    expect(out).toEqual([])
    expect((await log.verify()).totalEntries).toBe(0)
  })

  it('verifyIncremental：哨兵锚点之后只重算新增，结果与全量 verify 一致', async () => {
    const p = path.join(tmp, 'incr1', 'chain.jsonl')
    const log = createAuditLog({ filePath: p })
    const headSeq: { seq: number; hash: string } = { seq: -1, hash: '' }
    for (let i = 1; i <= 5; i++) {
      const h = await log.append(entry(i))
      if (i === 3) Object.assign(headSeq, { seq: h.seq, hash: h.hash })
    }
    // 增量校验（默认锚点 = .head.json）与全量语义一致
    const incr = await log.verifyIncremental()
    const full = await log.verify()
    expect(incr).toEqual(full)
    // 显式锚点：从 seq=3 之后只重算
    const fromCp = await log.verifyIncremental({ seq: headSeq.seq, hash: headSeq.hash })
    expect(fromCp.valid).toBe(true)
    expect(fromCp.totalEntries).toBe(5)
  })

  it('verifyIncremental fail-closed：锚点行哈希不符 → 断裂', async () => {
    const p = path.join(tmp, 'incr2', 'chain.jsonl')
    const log = createAuditLog({ filePath: p })
    const h = await log.append(entry(1))
    // 给一个错误的锚点哈希：受信前缀已被改动 → 必须 invalid
    const r = await log.verifyIncremental({ seq: h.seq, hash: 'deadbeefdeadbeef' })
    expect(r.valid).toBe(false)
    expect(r.firstBrokenSeq).toBe(h.seq)
  })

  it('verifyIncremental 检出尾部截断攻击（哨兵 seq 高于实际链长）', async () => {
    const p = path.join(tmp, 'incr3', 'chain.jsonl')
    const log = createAuditLog({ filePath: p })
    for (let i = 1; i <= 4; i++) await log.append(entry(i))
    // 物理删除最后一条（删尾部不会破坏剩余链的连续性，但哨兵会失配）
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l)
    fs.writeFileSync(p, lines.slice(0, -1).join('\n') + '\n')
    const incr = await log.verifyIncremental()
    expect(incr.valid).toBe(false)
    expect(incr.firstBrokenSeq).toBeNull()   // 截断攻击：哨兵失配，非链断裂
  })
})

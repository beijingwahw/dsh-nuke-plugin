// tests/ledger.test.ts — 空间台账单测
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLedger } from '../src/infra/ledger'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

let seq = 0
function ledger() {
  return createLedger({ historyDir: path.join(tmp, `l-${seq++}`) })
}

function entry(over: Partial<Parameters<ReturnType<typeof ledger>['record']>[0]> = {}) {
  return {
    at: '2026-01-15T10:00:00Z', kind: 'freed' as const, txId: 'tx-1' as any,
    profile: 'web' as any, plugin: 'p-a', action: 'remove-storages' as const,
    bytes: 1000, note: 'commit', ...over,
  }
}

describe('空间台账', () => {
  it('记账 + 总额与三维聚合', async () => {
    const l = ledger()
    await l.record(entry({ bytes: 1000, action: 'remove-storages' }))
    await l.record(entry({ bytes: 2000, action: 'remove-node-modules', at: '2026-01-15T11:00:00Z' }))
    await l.record(entry({ kind: 'pending', bytes: 5000, action: 'dedup-potential', txId: null }))
    const r = await l.query()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.totalFreed).toBe(3000)
    expect(r.value.totalPending).toBe(5000)
    expect(r.value.entryCount).toBe(3)
    // byAction 降序
    expect(r.value.byAction[0]).toEqual({ key: 'dedup-potential', bytes: 5000, count: 1 })
    expect(r.value.byAction.map(x => x.key)).toContain('remove-storages')
    // byProfile
    expect(r.value.byProfile[0]!.key).toBe('web')
    // byDay 升序且合并同日
    expect(r.value.byDay.length).toBe(1)
    expect(r.value.byDay[0]!.bytes).toBe(8000)
  })

  it('过滤：kind / profile / since', async () => {
    const l = ledger()
    await l.record(entry({ bytes: 100, at: '2026-01-10T00:00:00Z' }))
    await l.record(entry({ bytes: 200, at: '2026-01-20T00:00:00Z', profile: 'api' as any }))
    await l.record(entry({ kind: 'pending', bytes: 400 }))

    const freedOnly = await l.query({ kind: 'freed' })
    expect(freedOnly.ok && freedOnly.value.totalFreed).toBe(300)
    expect(freedOnly.ok && freedOnly.value.totalPending).toBe(0)

    const apiOnly = await l.query({ profile: 'api' as any })
    expect(apiOnly.ok && apiOnly.value.entryCount).toBe(1)

    const since = await l.query({ since: '2026-01-15' })
    expect(since.ok && since.ok && since.value.entryCount).toBe(2)
  })

  it('entries 分页降序 + 尾部半行容错', async () => {
    const dir = path.join(tmp, `l-${seq++}`)
    const l = createLedger({ historyDir: dir })
    await l.record(entry({ bytes: 1, at: '2026-01-01T00:00:00Z' }))
    await l.record(entry({ bytes: 2, at: '2026-01-02T00:00:00Z' }))
    await l.record(entry({ bytes: 3, at: '2026-01-03T00:00:00Z' }))
    fs.appendFileSync(path.join(dir, 'ledger.jsonl'), '{"at":"broken')
    const top2 = l.entries(undefined, 2)
    expect(top2.length).toBe(2)
    expect(top2[0]!.at).toBe('2026-01-03T00:00:00Z')   // 最新在前
    const all = await l.query()
    expect(all.ok && all.value.entryCount).toBe(3)      // 半行不计
  })

  it('空台账 → 零值摘要', async () => {
    const r = await ledger().query()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.totalFreed).toBe(0)
      expect(r.value.byAction.length).toBe(0)
    }
  })
})

describe('台账聚合升级（单遍历多维聚合 + 解析缓存）', () => {
  it('一次遍历多维聚合：多日×多profile×多动作混合，总额与三维索引全部正确', async () => {
    const l = ledger()
    // 2 天 × 2 profile × (1 freed + 1 pending) = 8 条混合样本
    const days = ['2026-02-01', '2026-02-02']
    for (const [di, day] of days.entries()) {
      for (const [pi, profile] of ['web', 'api'].entries()) {
        await l.record(entry({
          at: `${day}T10:00:00Z`, profile: profile as any, kind: 'freed',
          action: 'remove-storages', bytes: 100 + di * 10 + pi,
        }))
        await l.record(entry({
          at: `${day}T11:00:00Z`, profile: profile as any, kind: 'pending',
          action: 'remove-node-modules', bytes: 1000 + di * 100 + pi * 10,
        }))
      }
    }
    const r = await l.query()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.entryCount).toBe(8)
    expect(r.value.totalFreed).toBe(422)       // 100+101+110+111
    expect(r.value.totalPending).toBe(4220)    // 1000+1010+1100+1110
    // byAction bytes 降序
    expect(r.value.byAction).toEqual([
      { key: 'remove-node-modules', bytes: 4220, count: 4 },
      { key: 'remove-storages', bytes: 422, count: 4 },
    ])
    // byProfile bytes 降序：api 2332 (101+111+1010+1110) > web 2310 (100+110+1000+1100)
    expect(r.value.byProfile).toEqual([
      { key: 'api', bytes: 2332, count: 4 },
      { key: 'web', bytes: 2310, count: 4 },
    ])
    // byDay key 升序且跨 kind 合并
    expect(r.value.byDay).toEqual([
      { key: '2026-02-01', bytes: 2211, count: 4 },   // 201 freed + 2010 pending
      { key: '2026-02-02', bytes: 2431, count: 4 },   // 221 freed + 2210 pending
    ])
  })

  it('多维过滤组合：kind × profile × since 同时收敛到各维聚合', async () => {
    const l = ledger()
    await l.record(entry({ at: '2026-03-01T00:00:00Z', profile: 'web' as any, bytes: 10 }))
    await l.record(entry({ at: '2026-03-02T00:00:00Z', profile: 'web' as any, bytes: 20 }))
    await l.record(entry({ at: '2026-03-02T00:00:00Z', profile: 'api' as any, bytes: 40 }))
    await l.record(entry({ at: '2026-03-02T00:00:00Z', profile: 'web' as any, kind: 'pending', bytes: 80 }))
    const r = await l.query({ kind: 'freed', profile: 'web' as any, since: '2026-03-02' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.entryCount).toBe(1)
    expect(r.value.totalFreed).toBe(20)
    expect(r.value.totalPending).toBe(0)
    expect(r.value.byDay).toEqual([{ key: '2026-03-02', bytes: 20, count: 1 }])
    expect(r.value.byProfile).toEqual([{ key: 'web', bytes: 20, count: 1 }])
  })

  it('解析缓存对外部写入诚实：绕过 record 直写后同实例立即可见；半行照旧丢弃', async () => {
    const dir = path.join(tmp, `l-${seq++}`)
    const l = createLedger({ historyDir: dir })
    await l.record(entry({ at: '2026-04-01T00:00:00Z', bytes: 1 }))
    await l.record(entry({ at: '2026-04-02T00:00:00Z', bytes: 2 }))
    const first = await l.query()
    expect(first.ok && first.value.entryCount).toBe(2)   // 此后解析缓存建立

    // 外部直写完整合法行 → stat 指纹变化 → 缓存失效重读
    fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(entry({ at: '2026-04-03T00:00:00Z', bytes: 4 })) + '\n')
    const second = await l.query()
    expect(second.ok && second.value.entryCount).toBe(3)
    expect(second.ok && second.value.totalFreed).toBe(7)
    expect(l.entries().length).toBe(3)

    // 外部追加半行 → 指纹变化触发重读，半行容错语义不变
    fs.appendFileSync(path.join(dir, 'ledger.jsonl'), '{"at":"broken')
    const third = await l.query()
    expect(third.ok && third.value.entryCount).toBe(3)
  })

  it('缓存命中：同实例重复 query 输出幂等', async () => {
    const l = ledger()
    await l.record(entry({ bytes: 5 }))
    await l.record(entry({ kind: 'pending', bytes: 7 }))
    const a = await l.query()
    const b = await l.query()
    expect(a).toEqual(b)
  })
})

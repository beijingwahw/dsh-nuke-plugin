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

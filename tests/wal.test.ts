import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createWal } from '../src/infra/wal'
import type { TxId } from '../src/contracts/base'
import type { WalRecord } from '../src/contracts/transaction'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const TX = 'abc123' as TxId

describe('WAL', () => {
  it('append + replay 往返一致', async () => {
    const wal = createWal({ walRoot: path.join(tmp, 'w1') })
    const records: WalRecord[] = [
      { type: 'tx-begin', txId: TX, request: { plugins: ['p' as any], profile: 'web' as any, strategy: 'safe', dryRun: false, actor: 't' } },
      { type: 'step-intent', index: 0, operationId: 'op0', action: 'remove-storages', backup: null },
      { type: 'step-done', index: 0, operationId: 'op0', outcome: { bytesFreed: 10, message: 'ok' }, backup: null },
    ]
    for (const r of records) await wal.append(TX, r)
    const replayed = await wal.replay(TX)
    expect(replayed).toEqual(records)
  })

  it('尾部写半的行被丢弃', async () => {
    const dir = path.join(tmp, 'w2')
    const wal = createWal({ walRoot: dir })
    await wal.append(TX, { type: 'tx-begin', txId: TX, request: {} as any })
    // 模拟崩溃：手动追加半行 JSON
    fs.appendFileSync(path.join(dir, `${TX}.wal.jsonl`), '{"type":"step-int')
    const replayed = await wal.replay(TX)
    expect(replayed.length).toBe(1)
  })

  it('unfinishedTxIds 区分已终结/未终结事务', async () => {
    const wal = createWal({ walRoot: path.join(tmp, 'w3') })
    const txA = 'aaaa' as TxId
    const txB = 'bbbb' as TxId
    await wal.append(txA, { type: 'tx-begin', txId: txA, request: {} as any })
    await wal.append(txA, { type: 'tx-commit', txId: txA })
    await wal.append(txB, { type: 'tx-begin', txId: txB, request: {} as any })
    await wal.append(txB, { type: 'step-intent', index: 0, operationId: 'x', action: 'remove-storages', backup: null })
    expect(wal.unfinishedTxIds()).toEqual([txB])
  })
})

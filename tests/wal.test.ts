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

describe('WAL 升级（归档 + 尾部修复 + CRC 完整性）', () => {
  it('archiveFinished：已终结事务移入 archive/，replay 仍可读，unfinished 不再列', async () => {
    const dir = path.join(tmp, 'arch1')
    const wal = createWal({ walRoot: dir })
    const txA = 'a111' as TxId
    const txB = 'b222' as TxId
    await wal.append(txA, { type: 'tx-begin', txId: txA, request: {} as any })
    await wal.append(txA, { type: 'tx-commit', txId: txA })
    await wal.append(txB, { type: 'tx-begin', txId: txB, request: {} as any })
    expect(wal.unfinishedTxIds()).toEqual([txB])

    const r = await wal.archiveFinished()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toContain(txA)
    expect(r.value).not.toContain(txB)
    expect(fs.existsSync(path.join(dir, `${txA}.wal.jsonl`))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'archive', `${txA}.wal.jsonl`))).toBe(true)
    expect(wal.unfinishedTxIds()).toEqual([txB])
    // 归档后 replay 仍可读（append-only 语义保留）
    expect((await wal.replay(txA)).length).toBe(2)
  })

  it('archiveFinished 幂等：重复调用不重复移动、不报错', async () => {
    const dir = path.join(tmp, 'arch2')
    const wal = createWal({ walRoot: dir })
    const tx = 'c333' as TxId
    await wal.append(tx, { type: 'tx-begin', txId: tx, request: {} as any })
    await wal.append(tx, { type: 'tx-rollback', txId: tx, reason: 'test' })
    const first = await wal.archiveFinished()
    expect(first.ok && first.value).toEqual([tx])
    const second = await wal.archiveFinished()
    expect(second.ok && second.value).toEqual([])
  })

  it('archiveFinished fail-closed：中间行 CRC 损坏的事务不归档', async () => {
    const dir = path.join(tmp, 'arch3')
    const wal = createWal({ walRoot: dir })
    const tx = 'd444' as TxId
    await wal.append(tx, { type: 'tx-begin', txId: tx, request: {} as any })
    await wal.append(tx, { type: 'step-intent', index: 0, operationId: 'x', action: 'remove-storages', backup: null })
    await wal.append(tx, { type: 'tx-commit', txId: tx })
    // 篡改中间行（step-intent）：CRC 失配 → 中间损坏，事务状态不可信
    const fp = path.join(dir, `${tx}.wal.jsonl`)
    const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l)
    const tampered = JSON.parse(lines[1]!)
    tampered.extra = 'tamper'
    lines[1] = JSON.stringify(tampered)
    fs.writeFileSync(fp, lines.join('\n') + '\n')
    const r = await wal.archiveFinished()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual([])   // 损坏事务留在活跃区
  })

  it('repairTail：尾部崩溃半行截断到最后一行完整记录', async () => {
    const dir = path.join(tmp, 'rep1')
    const wal = createWal({ walRoot: dir })
    const tx = 'e555' as TxId
    await wal.append(tx, { type: 'tx-begin', txId: tx, request: {} as any })
    await wal.append(tx, { type: 'step-intent', index: 0, operationId: 'x', action: 'remove-storages', backup: null })
    fs.appendFileSync(path.join(dir, `${tx}.wal.jsonl`), '{"type":"step-int')   // 尾部半行
    const r = await wal.repairTail(tx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.repaired).toBe(true)
    expect(r.value.truncatedBytes).toBeGreaterThan(0)
    expect(r.value.records.length).toBe(2)   // 半行被截断，前两条完整保留
    expect(r.value.warning).not.toBeNull()
    // 修复后 replay 与记录集一致
    expect((await wal.replay(tx)).length).toBe(2)
  })

  it('repairTail：尾部完好记录缺换行 → 补 \\n，零截断', async () => {
    const dir = path.join(tmp, 'rep2')
    const wal = createWal({ walRoot: dir })
    const tx = 'f666' as TxId
    // 手工构造：一条完整合法记录（旧版无 CRC 行）但无行尾换行
    const fp = path.join(dir, `${tx}.wal.jsonl`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(fp, JSON.stringify({ type: 'tx-begin', txId: tx, request: {} }))
    const r = await wal.repairTail(tx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.repaired).toBe(true)
    expect(r.value.truncatedBytes).toBe(0)
    expect(r.value.records.length).toBe(1)
    // 修复后文件应以 \n 结尾（后续 append 不粘连）
    expect(fs.readFileSync(fp, 'utf-8').endsWith('\n')).toBe(true)
  })

  it('repairTail fail-closed：中间行 CRC 损坏拒绝修复', async () => {
    const dir = path.join(tmp, 'rep3')
    const wal = createWal({ walRoot: dir })
    const tx = 'g777' as TxId
    await wal.append(tx, { type: 'tx-begin', txId: tx, request: {} as any })
    await wal.append(tx, { type: 'step-intent', index: 0, operationId: 'x', action: 'remove-storages', backup: null })
    // 篡改中间行（第一条）的 type 字段：CRC 失配 → 非尾部半行 → 拒绝
    const fp = path.join(dir, `${tx}.wal.jsonl`)
    const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l)
    const tampered = JSON.parse(lines[0]!)
    tampered.tampered = true
    lines[0] = JSON.stringify(tampered)
    fs.writeFileSync(fp, lines.join('\n') + '\n')
    const r = await wal.repairTail(tx)
    expect(r.ok).toBe(false)
  })

  it('repairTail：文件不存在 → 无可修复，返回 repaired=false', async () => {
    const dir = path.join(tmp, 'rep4')
    const wal = createWal({ walRoot: dir })
    const r = await wal.repairTail('nonexistent' as TxId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.repaired).toBe(false)
    expect(r.value.records).toEqual([])
  })

  it('CRC 完整性：写入带 __crc，replay 校验通过；篡改中间记录字段 → 整条事务判损坏', async () => {
    const dir = path.join(tmp, 'crc1')
    const wal = createWal({ walRoot: dir })
    const tx = 'h888' as TxId
    await wal.append(tx, { type: 'tx-begin', txId: tx, request: {} as any })
    const fp = path.join(dir, `${tx}.wal.jsonl`)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('__crc')   // 写入时确实带了 CRC
    await wal.append(tx, { type: 'step-intent', index: 0, operationId: 'x', action: 'remove-storages', backup: null })
    await wal.append(tx, { type: 'tx-commit', txId: tx })
    // 篡改中间行（step-intent）的 operationId 但不动 __crc → CRC 校验失败
    const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l)
    const tampered = JSON.parse(lines[1]!)
    tampered.operationId = 'tampered'
    lines[1] = JSON.stringify(tampered)
    fs.writeFileSync(fp, lines.join('\n') + '\n')
    expect((await wal.replay(tx))).toEqual([])   // 中间行损坏 → 空记录集（宁可保守也不误恢复）
  })
})

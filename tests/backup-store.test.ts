import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createBackupStore } from '../src/infra/backup-store'
import type { TxId } from '../src/contracts/base'
import type { IBackupStore } from '../src/contracts/transaction'

let tmp: string
let store: IBackupStore
const TX = 'tx1' as TxId

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'))
  store = createBackupStore({ backupRoot: path.join(tmp, 'backups') })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('BackupArea', () => {
  it('stageEdit：原内容快照 + 恢复', async () => {
    const area = await store.reserve(TX)
    const p = path.join(tmp, 'patch.yml') as any
    fs.writeFileSync(p, '- id: keep\n- id: victim\n')
    const rec = await area.stageEdit(p, '- id: keep\n')
    expect(fs.readFileSync(p, 'utf-8')).toBe('- id: keep\n')
    expect(rec.originalContent).toBe('- id: keep\n- id: victim\n')

    const r = await area.restore(rec)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('- id: keep\n- id: victim\n')
  })

  it('stageDir：原子移入回收区 + 恢复（含嵌套文件）', async () => {
    const area = await store.reserve(TX)
    const dir = path.join(tmp, 'storages', 'victim-plugin') as any
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'data.json'), '{"k":1}')
    fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'deep')

    const rec = await area.stageDir(dir)
    expect(fs.existsSync(dir)).toBe(false)           // 原位置已消失
    expect(fs.existsSync(rec.backupPath)).toBe(true)  // 回收区存在

    const r = await area.restore(rec)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'sub', 'deep.txt'), 'utf-8')).toBe('deep')
  })

  it('restore 幂等：重复恢复安全', async () => {
    const area = await store.reserve(TX)
    const p = path.join(tmp, 'idem.txt') as any
    fs.writeFileSync(p, 'v1')
    const rec = await area.stageEdit(p, 'v2')
    expect((await area.restore(rec)).ok).toBe(true)
    expect((await area.restore(rec)).ok).toBe(true)
    expect(fs.readFileSync(p, 'utf-8')).toBe('v1')
  })

  it('备份被篡改 → 拒绝恢复', async () => {
    const area = await store.reserve(TX)
    const p = path.join(tmp, 'tamper.yml') as any
    fs.writeFileSync(p, 'original')
    const rec = await area.stageEdit(p, 'modified')
    // 篡改备份产物
    fs.writeFileSync(rec.backupPath, 'EVIL')
    const r = await area.restore(rec)
    expect(r.ok).toBe(false)
  })

  it('purge 清空事务备份区', async () => {
    const area = await store.reserve('tx2' as TxId)
    const p = path.join(tmp, 'purge-me.txt') as any
    fs.writeFileSync(p, 'x')
    await area.stageFile(p)
    const r = await area.purge('tx2' as TxId)
    expect(r.ok).toBe(true)
  })
})

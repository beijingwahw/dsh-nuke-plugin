import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TxId } from '../src/contracts/base'
import { createBackupStore } from '../src/infra/backup-store'
import type { BackupStoreRuntime } from '../src/infra/backup-store'

let tmp: string
let store: BackupStoreRuntime
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

describe('BackupArea 升级（restoreAll 并行恢复 + 指纹复验）', () => {
  it('restoreAll：混合记录批量恢复 + 指纹复验全部通过', async () => {
    const area = await store.reserve('txr1' as TxId)
    const f1 = path.join(tmp, 'ra-f1.txt') as any
    fs.writeFileSync(f1, 'content-f1')
    await area.stageFile(f1)
    const e1 = path.join(tmp, 'ra-e1.yml') as any
    fs.writeFileSync(e1, 'original\n')
    await area.stageEdit(e1, 'modified\n')
    const d1 = path.join(tmp, 'ra-d1') as any
    fs.mkdirSync(path.join(d1, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(d1, 'sub', 'f.txt'), 'deep')
    await area.stageDir(d1)

    const r = await area.restoreAll()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(fs.readFileSync(f1, 'utf-8')).toBe('content-f1')
      expect(fs.readFileSync(e1, 'utf-8')).toBe('original\n')
      expect(fs.readFileSync(path.join(d1, 'sub', 'f.txt'), 'utf-8')).toBe('deep')
    }
  })

  it('restoreAll 依赖分层：目录内的编辑先于目录 stage → 恢复时目录先就位再恢复内部编辑', async () => {
    const area = await store.reserve('txr2' as TxId)
    const dir = path.join(tmp, 'ra-nest') as any
    fs.mkdirSync(dir)
    const inner = path.join(dir, 'inner.txt') as any
    fs.writeFileSync(inner, 'orig')
    await area.stageEdit(inner, 'edited')   // 先 stage：记录序靠前（成员）
    await area.stageDir(dir)                // 后 stage：目录包含成员（容器）
    expect(fs.existsSync(dir)).toBe(false)  // 目录已整体移入回收区

    const r = await area.restoreAll()
    expect(r.ok).toBe(true)
    // 恢复顺序：容器（目录）先就位，成员（编辑）再恢复 → 最终回到 stage 前状态
    expect(fs.readFileSync(inner, 'utf-8')).toBe('orig')
  })

  it('restoreAll 指纹复验：产物被篡改 → 返回错误保持未终结语义', async () => {
    const area = await store.reserve('txr3' as TxId)
    const dir = path.join(tmp, 'ra-verify') as any
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'f.txt'), 'v1')
    const rec = await area.stageDir(dir)
    // 模拟"已恢复但产物被篡改"：备份移回原位后改内容
    // （走 dir-move 幂等分支放行，由复验拦截静默漂移）
    fs.renameSync(rec.backupPath, rec.originalPath)
    fs.writeFileSync(path.join(dir, 'tampered.txt'), 'evil')
    const r = await area.restoreAll([rec])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('复验')
  })

  it('restoreAll 空 manifest → 直接成功', async () => {
    const area = await store.reserve('txr4' as TxId)
    const r = await area.restoreAll()
    expect(r.ok).toBe(true)
  })
})

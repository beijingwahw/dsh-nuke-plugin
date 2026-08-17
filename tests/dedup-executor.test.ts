// tests/dedup-executor.test.ts — 硬链接去重执行器单测（突破升级守护）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { createDedupExecutor } from '../src/engine/dedup-executor'
import type { DedupReport } from '../src/contracts/dedup.contract'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupexec-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function hash(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/** 构造一份两副本的 DedupReport */
function twoCopyReport(content: string): { report: DedupReport; a: string; b: string } {
  const dir = fs.mkdtempSync(path.join(tmp, 'grp-'))
  const a = path.join(dir, 'a.js')
  const b = path.join(dir, 'b.js')
  fs.writeFileSync(a, content)
  fs.writeFileSync(b, content)
  const h = hash(a)
  const report: DedupReport = {
    groups: [{
      hash: h, sizeBytes: Buffer.byteLength(content),
      copies: [
        { path: a as any, profile: 'web' as any },
        { path: b as any, profile: 'api' as any },
      ],
      reclaimableBytes: Buffer.byteLength(content),
    }],
    totalReclaimableBytes: Buffer.byteLength(content),
    filesScanned: 2, bytesScanned: Buffer.byteLength(content) * 2, durationMs: 0,
  }
  return { report, a, b }
}

describe('DedupExecutor（verify-then-link 硬链接实收）', () => {
  it('两副本 → victim 替换为 canonical 的硬链接（同 inode），bytesSaved 诚实计数', async () => {
    const { report, a, b } = twoCopyReport('console.log("SAME-CONTENT-FOR-LINK")')
    const exec = createDedupExecutor()
    const r = await exec.apply(report)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.linkedFiles).toBe(1)
    expect(r.value.bytesSaved).toBe(r.value.journal[0]!.sizeBytes)
    expect(fs.statSync(b).ino).toBe(fs.statSync(a).ino)   // 硬链接成立
    expect(fs.statSync(a).nlink).toBe(2)
    // 内容不变
    expect(fs.readFileSync(b, 'utf-8')).toBe('console.log("SAME-CONTENT-FOR-LINK")')
  })

  it('TOCTOU 防护：分析后 victim 被改写 → 复验失败跳过（绝不错链）', async () => {
    const { report, b } = twoCopyReport('ORIGINAL')
    // 分析与执行之间 victim 被修改（同尺寸改写，绕过尺寸快检）
    fs.writeFileSync(b, 'MODIFIED-BUT-SAME-LEN!!'.slice(0, 8))
    const exec = createDedupExecutor()
    const r = await exec.apply(report)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.linkedFiles).toBe(0)
    expect(r.value.skipped.length).toBe(1)
    expect(r.value.skipped[0]!.reason).toContain('复验失败')
    expect(fs.readFileSync(b, 'utf-8')).toBe('MODIFIED')   // 原文件未被触碰
  })

  it('TOCTOU 防护：canonical 被换 → 整组跳过', async () => {
    const { report, a, b } = twoCopyReport('CANONICAL-CONTENT')
    fs.writeFileSync(a, 'TAMPERED-CANONICAL')
    const exec = createDedupExecutor()
    const r = await exec.apply(report)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.linkedFiles).toBe(0)
    expect(r.value.skipped.some(s => s.reason.includes('canonical'))).toBe(true)
    void b
  })

  it('undo：从 canonical 复制回独立 inode（链接破坏，内容保留）', async () => {
    const { report, a, b } = twoCopyReport('UNDOABLE-CONTENT-XYZ')
    const exec = createDedupExecutor()
    const r = await exec.apply(report)
    if (!r.ok) return
    expect(fs.statSync(b).ino).toBe(fs.statSync(a).ino)
    const u = await exec.undo(r.value.journal)
    expect(u.ok).toBe(true)
    expect(fs.statSync(b).ino).not.toBe(fs.statSync(a).ino)   // 独立 inode
    expect(fs.readFileSync(b, 'utf-8')).toBe('UNDOABLE-CONTENT-XYZ')
  })

  it('重复 apply：已是同一 inode → 跳过（幂等）', async () => {
    const { report } = twoCopyReport('IDEMPOTENT-CONTENT-123')
    const exec = createDedupExecutor()
    await exec.apply(report)
    const second = await exec.apply(report)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.linkedFiles).toBe(0)
    expect(second.value.skipped[0]!.reason).toContain('已链接')
  })

  it('中途取消：journal 不丢失（已完成部分仍可 undo，绝不失记）', async () => {
    const { report, a, b } = twoCopyReport('CANCEL-SAFE-CONTENT')
    const controller = new AbortController()
    controller.abort()   // 进入循环前即取消
    const exec = createDedupExecutor()
    const r = await exec.apply(report, { signal: controller.signal })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.cancelled).toBe(true)
    expect(r.value.linkedFiles).toBe(0)
    // 非取消对照：正常执行后 journal 非空
    const r2 = await exec.apply(report)
    expect(r2.ok && r2.value.journal.length).toBe(1)
    void a; void b
  })

  it('victim 为符号链接 → 跳过（不虚增 bytesSaved，不破坏链接语义）', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'sym-'))
    const real = path.join(dir, 'real.js')
    const a = path.join(dir, 'a.js')
    const link = path.join(dir, 'link.js')
    const content = 'SYMLINK-VICTIM-CONTENT'
    fs.writeFileSync(real, content)
    fs.writeFileSync(a, content)
    fs.symlinkSync(real, link)   // link → real（内容同 a）
    const report: DedupReport = {
      groups: [{
        hash: hash(a), sizeBytes: Buffer.byteLength(content),
        copies: [
          { path: a as any, profile: 'web' as any },
          { path: link as any, profile: 'api' as any },
        ],
        reclaimableBytes: Buffer.byteLength(content),
      }],
      totalReclaimableBytes: Buffer.byteLength(content),
      filesScanned: 2, bytesScanned: Buffer.byteLength(content) * 2, durationMs: 0,
    }
    const exec = createDedupExecutor()
    const r = await exec.apply(report)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.linkedFiles).toBe(0)
    expect(r.value.bytesSaved).toBe(0)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)   // 符号链接原封未动
    expect(r.value.skipped.some(s => s.reason.includes('符号链接'))).toBe(true)
  })

  it('undo best-effort：单条失败不中断其余恢复，进度如实报告', async () => {
    const g1 = twoCopyReport('GROUP-ONE-CONTENT')
    const g2 = twoCopyReport('GROUP-TWO-CONTENT')
    const exec = createDedupExecutor()
    const r1 = await exec.apply(g1.report)
    const r2 = await exec.apply(g2.report)
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    const journal = [...r1.value.journal, ...r2.value.journal]
    expect(journal.length).toBe(2)
    // 人为让 g2 的 canonical 消失 → 对应 undo 条目失败，另一条仍应成功
    fs.rmSync(g2.a)
    const u = await exec.undo(journal)
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(u.value.undone).toBe(1)
    expect(u.value.failed.length).toBe(1)
    expect(fs.statSync(g1.b).ino).not.toBe(fs.statSync(g1.a).ino)   // g1 恢复独立 inode
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createOrphanDetector } from '../src/engine/orphan-detector'

let home: string
let tempRoot: string
const NOW = new Date('2026-08-16T00:00:00Z')

function seed() {
  const pd = path.join(home, 'profiles', 'default')
  fs.mkdirSync(pd, { recursive: true })
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
    dependencies: { 'declared-plugin': '^1' },
    dsh: { profile: { bundles: ['declared-plugin'] } },
  }))
  // 已声明的包 + 孤儿包
  fs.mkdirSync(path.join(pd, 'node_modules', 'declared-plugin'), { recursive: true })
  fs.writeFileSync(path.join(pd, 'node_modules', 'declared-plugin', 'package.json'), '{"name":"declared-plugin"}')
  fs.mkdirSync(path.join(pd, 'node_modules', 'orphan-pkg'), { recursive: true })
  fs.writeFileSync(path.join(pd, 'node_modules', 'orphan-pkg', 'big.bin'), 'x'.repeat(1000))
  // dsh 官方包受保护
  fs.mkdirSync(path.join(pd, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })

  // storages：一个有主（declared-plugin）+ 一个孤儿
  fs.mkdirSync(path.join(home, 'storages', 'declared-plugin'), { recursive: true })
  fs.mkdirSync(path.join(home, 'storages', 'orphan-storage'), { recursive: true })
  fs.writeFileSync(path.join(home, 'storages', 'orphan-storage', 'd.bin'), 'y'.repeat(500))
  // attachments：孤儿
  fs.mkdirSync(path.join(home, 'attachments', 'v1', 'orphan-attach'), { recursive: true })
  fs.writeFileSync(path.join(home, 'attachments', 'v1', 'orphan-attach', 'a.bin'), 'z'.repeat(300))

  // TEMP：过期 dsh 条目 + 新鲜 dsh + 无关
  fs.mkdirSync(tempRoot, { recursive: true })
  const oldAtime = new Date(NOW.getTime() - 30 * 86_400_000)
  for (const name of ['dsh-cache', 'cordis-tmp']) {
    const p = path.join(tempRoot, name)
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'f'), 'q')
    fs.utimesSync(p, oldAtime, oldAtime)
  }
  const fresh = path.join(tempRoot, 'dsh-fresh')
  fs.mkdirSync(fresh, { recursive: true })
  fs.writeFileSync(path.join(fresh, 'f'), 'q')
  fs.writeFileSync(path.join(tempRoot, 'unrelated'), 'x')
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-home-'))
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-temp-'))
  seed()
})
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function makeDetector() {
  return createOrphanDetector({ dshHome: home, tempRoot, now: () => NOW })
}

describe('OrphanDetector', () => {
  it('node_modules 孤儿：未声明包被标记，已声明与 dsh 官方包被保护', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.value.orphanPluginDirs.map(d => path.basename(d.path))
    expect(names).toContain('orphan-pkg')
    expect(names).not.toContain('declared-plugin')
    expect(names.some(n => n.includes('dsh-base'))).toBe(false)
  })

  it('storages/attachments 无主目录被标记；有主目录不标记', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    if (!r.ok) throw new Error('detect failed')
    const paths = r.value.orphanDataDirs.map(d => d.path)
    expect(paths.some(p => p.includes('orphan-storage'))).toBe(true)
    expect(paths.some(p => p.includes('orphan-attach'))).toBe(true)
    expect(paths.some(p => p.includes(path.join('storages', 'declared-plugin')))).toBe(false)
  })

  it('TEMP 孤儿：超龄 dsh/cordis 条目命中，新鲜与无关条目排除，ageDays 正确', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    if (!r.ok) throw new Error('detect failed')
    const names = r.value.tempOrphans.map(t => path.basename(t.path))
    expect(names).toContain('dsh-cache')
    expect(names).toContain('cordis-tmp')
    expect(names).not.toContain('dsh-fresh')
    expect(names).not.toContain('unrelated')
    const cache = r.value.tempOrphans.find(t => t.path.includes('dsh-cache'))!
    expect(cache.ageDays).toBeGreaterThan(29)
  })

  it('totalReclaimableBytes = 三类孤儿体积之和', async () => {
    const r = await makeDetector().detect({ tempMaxAgeDays: 7 })
    if (!r.ok) throw new Error('detect failed')
    const sum = r.value.orphanPluginDirs.reduce((s, d) => s + d.sizeBytes, 0)
      + r.value.orphanDataDirs.reduce((s, d) => s + d.sizeBytes, 0)
      + r.value.tempOrphans.reduce((s, d) => s + d.sizeBytes, 0)
    expect(r.value.totalReclaimableBytes).toBe(sum)
    expect(sum).toBeGreaterThan(0)
  })

  it('AbortSignal 取消 → E_CANCELLED', async () => {
    const c = new AbortController()
    c.abort()
    const r = await makeDetector().detect({ tempMaxAgeDays: 7, signal: c.signal })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('E_CANCELLED')
  })
})

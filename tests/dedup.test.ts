// tests/dedup.test.ts — 内容寻址去重分析器单测
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createDedupAnalyzer } from '../src/engine/dedup-analyzer'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function seedTwoProfiles() {
  const base = path.join(tmp, `p-${Math.random().toString(36).slice(2)}`)
  const web = path.join(base, 'profiles', 'web', 'node_modules', 'pkg-a')
  const api = path.join(base, 'profiles', 'api', 'node_modules', 'pkg-a')
  fs.mkdirSync(web, { recursive: true })
  fs.mkdirSync(api, { recursive: true })
  fs.writeFileSync(path.join(web, 'index.js'), 'console.log("SAME")')
  fs.writeFileSync(path.join(api, 'index.js'), 'console.log("SAME")')
  // 唯一内容文件：size 桶只有 1 个成员，零哈希淘汰
  fs.writeFileSync(path.join(web, 'unique.js'), 'console.log("WEB-ONLY")')
  return { base, web, api }
}

describe('DedupAnalyzer', () => {
  it('跨 profile 同内容文件 → 1 组，reclaimable = (n-1)×size', async () => {
    const { base, web } = seedTwoProfiles()
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({
      roots: [path.join(base, 'profiles', 'web', 'node_modules'), path.join(base, 'profiles', 'api', 'node_modules')] as any,
      minSizeBytes: 1,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.groups.length).toBe(1)
    const g = r.value.groups[0]!
    expect(g.copies.length).toBe(2)
    expect(g.reclaimableBytes).toBe(g.sizeBytes)
    expect(r.value.totalReclaimableBytes).toBe(g.sizeBytes)
    expect(r.value.filesScanned).toBe(3)
    // profile 推断
    const profiles = g.copies.map(c => c.profile)
    expect(profiles).toContain('web')
    expect(profiles).toContain('api')
    void web
  })

  it('minSizeBytes 过滤小文件', async () => {
    const { base } = seedTwoProfiles()
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ minSizeBytes: 1024 * 1024 } as any)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.groups.length).toBe(0)
  })

  it('符号链接跳过（不重复计数）', async () => {
    const { base, web } = seedTwoProfiles()
    fs.symlinkSync(path.join(web, 'index.js'), path.join(web, 'link.js'))
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ roots: [web] as any, minSizeBytes: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.groups.length).toBe(0)   // link 被跳过 → 无重复
    fs.unlinkSync(path.join(web, 'link.js'))
  })

  it('已取消的 AbortSignal → E_CANCELLED', async () => {
    const { base } = seedTwoProfiles()
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const controller = new AbortController()
    controller.abort()
    const r = await analyzer.analyze({ signal: controller.signal } as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_CANCELLED')
  })

  it('默认根：profiles/*/node_modules', async () => {
    // 同一 node_modules 内两份同内容文件
    const base = path.join(tmp, `d-${Math.random().toString(36).slice(2)}`)
    const nm = path.join(base, 'profiles', 'web', 'node_modules')
    fs.mkdirSync(path.join(nm, 'a'), { recursive: true })
    fs.mkdirSync(path.join(nm, 'b'), { recursive: true })
    fs.writeFileSync(path.join(nm, 'a', 'f.js'), 'DUPLICATE-CONTENT')
    fs.writeFileSync(path.join(nm, 'b', 'f.js'), 'DUPLICATE-CONTENT')
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ minSizeBytes: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.groups.length).toBe(1)
  })

  it('无默认根（profiles 不存在）→ 空报告', async () => {
    const analyzer = createDedupAnalyzer({ dshHome: path.join(tmp, 'nope') })
    const r = await analyzer.analyze()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.groups.length).toBe(0)
  })
})

describe('DedupAnalyzer 三级瀑布（突破升级守护）', () => {
  function mkDir(): string {
    return path.join(tmp, `w-${Math.random().toString(36).slice(2)}`)
  }

  it('同尺寸不同内容 → 采样阶段淘汰，零全量哈希零误报', async () => {
    const base = mkDir()
    const nm = path.join(base, 'nm')
    fs.mkdirSync(nm, { recursive: true })
    // 三个同尺寸文件：头部相同、尾部不同（头尾采样必须区分的场景）
    const head = 'A'.repeat(8192)
    fs.writeFileSync(path.join(nm, 'f1'), head + 'TAIL-ONE!!')
    fs.writeFileSync(path.join(nm, 'f2'), head + 'TAIL-TWO!!')
    fs.writeFileSync(path.join(nm, 'f3'), head + 'TAIL-THREE')
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ roots: [nm] as any, minSizeBytes: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 内容全不同 → 无重复组（三级瀑布的最终裁决保证零误报）
    expect(r.value.groups.length).toBe(0)
    // 但阶段统计必须记录采样淘汰
    expect(r.value.stages).toBeDefined()
    const st = r.value.stages!
    expect(st.sampleEliminated).toBe(3)
    expect(st.fullHashed).toBe(0)                    // 全部在采样阶段出局
    expect(st.bytesSavedBySampling).toBe(3 * (8192 + 10))
  })

  it('头尾相同中段不同 → 中段采样直接淘汰（旧盲区已消除，零全量哈希）', async () => {
    const base = mkDir()
    const nm = path.join(base, 'nm')
    fs.mkdirSync(nm, { recursive: true })
    // 头尾各 4KB 相同，中段不同：旧头尾双段采样会碰撞（盲区），
    // 三段采样的中段窗口正落在差异区 → 阶段二即淘汰
    const head = Buffer.alloc(4096, 1)
    const tail = Buffer.alloc(4096, 2)
    const mid1 = Buffer.alloc(8192, 0xAA)
    const mid2 = Buffer.alloc(8192, 0xBB)
    fs.writeFileSync(path.join(nm, 'f1'), Buffer.concat([head, mid1, tail]))
    fs.writeFileSync(path.join(nm, 'f2'), Buffer.concat([head, mid2, tail]))
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ roots: [nm] as any, minSizeBytes: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 无重复组（正确性不变），且中段采样省掉了全量哈希
    expect(r.value.groups.length).toBe(0)
    expect(r.value.stages!.sampleEliminated).toBe(2)
    expect(r.value.stages!.fullHashed).toBe(0)
  })

  it('三段采样窗口外的差异 → 采样碰撞后全量裁决为非重复（零误报兜底）', async () => {
    const base = mkDir()
    const nm = path.join(base, 'nm')
    fs.mkdirSync(nm, { recursive: true })
    // 16KB 文件，三段采样窗口 = 头 [0,4K) / 中 [6144,10240) / 尾 [12K,16K)。
    // 差异放在 [4K,6K) —— 三段指纹完全相同，但内容不同：
    // 必须落入全量哈希 → 判定非重复（采样只是过滤器，绝不产生最终判定）
    const size = 16384
    const mk = (diffByte: number): Buffer => {
      const b = Buffer.alloc(size, 0x01)
      b.fill(diffByte, 4096, 4097)   // 采样窗口外的单字节差异
      return b
    }
    fs.writeFileSync(path.join(nm, 'f1'), mk(0xCC))
    fs.writeFileSync(path.join(nm, 'f2'), mk(0xDD))
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ roots: [nm] as any, minSizeBytes: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.groups.length).toBe(0)   // 全量裁决：内容确实不同
    expect(r.value.stages!.fullHashed).toBe(2)
  })

  it('阶段统计：尺寸唯一淘汰与真重复分组并存', async () => {
    const base = mkDir()
    const nm = path.join(base, 'nm')
    fs.mkdirSync(nm, { recursive: true })
    fs.writeFileSync(path.join(nm, 'dup1'), 'X'.repeat(100))
    fs.writeFileSync(path.join(nm, 'dup2'), 'X'.repeat(100))
    fs.writeFileSync(path.join(nm, 'uniq'), 'Y'.repeat(200))   // 尺寸唯一
    const analyzer = createDedupAnalyzer({ dshHome: base })
    const r = await analyzer.analyze({ roots: [nm] as any, minSizeBytes: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.groups.length).toBe(1)
    const st = r.value.stages!
    expect(st.sizeEliminated).toBe(1)
    expect(st.sampleEliminated).toBe(0)   // dup1/dup2 采样碰撞 → 进全量
    expect(st.fullHashed).toBe(2)
  })
})

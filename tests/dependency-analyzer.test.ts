import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PluginName, ProfileName } from '../src/contracts/base'
import { createDependencyAnalyzer } from '../src/engine/dependency-analyzer'

let home: string

function seed() {
  // profile: default
  //   依赖: foo, bar；bundles: foo, bar
  //   node_modules: foo(依赖 bar), bar, orphan-pkg（无声明）
  // profile: dev
  //   依赖: bar（跨 profile 引用同一插件）
  // patch（home）: 引用 foo
  const pd = path.join(home, 'profiles', 'default')
  fs.mkdirSync(path.join(pd, 'node_modules', 'foo'), { recursive: true })
  fs.mkdirSync(path.join(pd, 'node_modules', 'bar'), { recursive: true })
  fs.mkdirSync(path.join(pd, 'node_modules', 'orphan-pkg'), { recursive: true })
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
    dependencies: { foo: '^1.0.0', bar: '^1.0.0' },
    dsh: { profile: { bundles: ['foo', 'bar'] } },
  }, null, 2))
  fs.writeFileSync(path.join(pd, 'node_modules', 'foo', 'package.json'), JSON.stringify({
    name: 'foo', dependencies: { bar: '^1.0.0' },
  }))
  fs.writeFileSync(path.join(pd, 'node_modules', 'bar', 'package.json'), JSON.stringify({ name: 'bar' }))
  fs.writeFileSync(path.join(pd, 'node_modules', 'orphan-pkg', 'package.json'), JSON.stringify({ name: 'orphan-pkg' }))

  const dev = path.join(home, 'profiles', 'dev')
  fs.mkdirSync(dev, { recursive: true })
  fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({
    dependencies: { bar: '^1.0.0' },
    dsh: { profile: { bundles: ['bar'] } },
  }, null, 2))

  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), [
    'changes:',
    '  - id: foo',
    '    path: patches/foo.patch',
  ].join('\n'))
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-analyzer-'))
  seed()
})
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const P = (s: string) => s as PluginName

describe('DependencyAnalyzer', () => {
  it('构建图：profile 合成节点 + bundle 间依赖 + patch 引用三类边齐全', async () => {
    const analyzer = createDependencyAnalyzer({ dshHome: home })
    const g = await analyzer.buildGraph()
    expect(g.ok).toBe(true)
    if (!g.ok) return

    expect([...g.value.nodes.keys()]).toContain('profile:default')
    expect([...g.value.nodes.keys()]).toContain('foo')
    expect([...g.value.nodes.keys()]).toContain('bar')

    const kinds = new Set(g.value.edges.map(e => e.kind))
    expect(kinds.has('dependencies')).toBe(true)     // profile → 插件
    expect(kinds.has('patch-ref')).toBe(true)        // home patch → foo

    // bundle 间边：foo → bar
    expect(g.value.edges.some(e => e.from === P('foo') && e.to === P('bar'))).toBe(true)

    // foo 的 patchRefs 指向 home patch 文件
    expect(g.value.nodes.get(P('foo'))?.patchRefs.join()).toContain('cordis.patch.yml')
  })

  it('dependenciesOf / dependentsOf 闭包正确（含传递）', async () => {
    const analyzer = createDependencyAnalyzer({ dshHome: home })
    const g = await analyzer.buildGraph()
    if (!g.ok) throw new Error('buildGraph failed')

    expect(g.value.dependenciesOf(P('foo'))).toContain(P('bar'))
    // bar 的依赖方闭包：foo + 两个 profile 合成节点
    const dependents = g.value.dependentsOf(P('bar'))
    expect(dependents).toContain(P('foo'))
    expect(dependents).toContain(P('profile:default'))
    expect(dependents).toContain(P('profile:dev'))
  })

  it('blockersOf：删 bar 被阻断（被 foo 与两个 profile 依赖）；同批互删不算阻断', async () => {
    const analyzer = createDependencyAnalyzer({ dshHome: home })
    const r = await analyzer.blockersOf([P('bar')])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.length).toBe(1)
    expect(r.value[0]!.plugin).toBe('bar')
    expect(r.value[0]!.blockedBy).toContain('foo')

    // foo + bar 一起删：bar 的依赖方 foo 在删除集合内 → 不阻断 bar
    const r2 = await analyzer.blockersOf([P('foo'), P('bar')])
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.value.find(b => b.plugin === 'bar')).toBeUndefined()
  })

  it('环检测：a→b→c→a 报告 SCC', async () => {
    const cyc = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-cycle-'))
    const pd = path.join(cyc, 'profiles', 'default')
    for (const [pkg, dep] of [['a', 'b'], ['b', 'c'], ['c', 'a']] as const) {
      fs.mkdirSync(path.join(pd, 'node_modules', pkg), { recursive: true })
      fs.writeFileSync(path.join(pd, 'node_modules', pkg, 'package.json'),
        JSON.stringify({ name: pkg, dependencies: { [dep]: '^1' } }))
    }
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
      dependencies: { a: '^1', b: '^1', c: '^1' },
    }))
    try {
      const analyzer = createDependencyAnalyzer({ dshHome: cyc })
      const g = await analyzer.buildGraph()
      if (!g.ok) throw new Error('buildGraph failed')
      expect(g.value.hasCycle()).toBe(true)
      const cycNodes = g.value.cycles().flat()
      expect(cycNodes).toContain(P('a'))
      expect(cycNodes).toContain(P('b'))
      expect(cycNodes).toContain(P('c'))
    } finally {
      fs.rmSync(cyc, { recursive: true, force: true })
    }
  })

  it('buildGraph(profile) 限定单 profile：不读 dev', async () => {
    const analyzer = createDependencyAnalyzer({ dshHome: home })
    const g = await analyzer.buildGraph('dev' as ProfileName)
    if (!g.ok) throw new Error('buildGraph failed')
    expect([...g.value.nodes.keys()]).toContain('profile:dev')
    expect([...g.value.nodes.keys()]).not.toContain('profile:default')
  })

  it('指纹缓存：二次构建零读盘全命中，文件变更后精确失效重读', async () => {
    const analyzer = createDependencyAnalyzer({ dshHome: home })

    // 首次构建：全部读盘解析。home patch 会被 default/dev 两个 profile 各访问
    // 一次 —— 构建内第二次访问即命中（缓存对构建内重复同样生效）
    const g1 = await analyzer.buildGraph()
    expect(g1.ok).toBe(true)
    const s1 = analyzer.cacheStats()
    expect(s1.filesRead).toBeGreaterThan(0)
    const totalAccesses = s1.filesRead + s1.cacheHits
    expect(totalAccesses).toBeGreaterThan(s1.filesRead)   // 构建内确有重复访问

    // 二次构建：磁盘未变 → 零读盘、全命中；图结构逐位一致
    const g2 = await analyzer.buildGraph()
    expect(g2.ok).toBe(true)
    const s2 = analyzer.cacheStats()
    expect(s2.filesRead).toBe(0)
    expect(s2.cacheHits).toBe(totalAccesses)              // 访问总数不变，全部命中
    if (!g1.ok || !g2.ok) return
    expect([...g2.value.nodes.keys()].sort()).toEqual([...g1.value.nodes.keys()].sort())
    expect(g2.value.edges.length).toBe(g1.value.edges.length)

    // 变更 default 的 package.json（新增依赖）→ 仅该文件指纹失效重读
    const pkgPath = path.join(home, 'profiles', 'default', 'package.json')
    const original = fs.readFileSync(pkgPath, 'utf-8')
    try {
      fs.writeFileSync(pkgPath, JSON.stringify({
        dependencies: { foo: '^1.0.0', bar: '^1.0.0', 'new-pkg': '^1.0.0' },
        dsh: { profile: { bundles: ['foo', 'bar'] } },
      }, null, 2))
      const g3 = await analyzer.buildGraph()
      expect(g3.ok).toBe(true)
      const s3 = analyzer.cacheStats()
      expect(s3.filesRead).toBe(1)                        // 只有变更的那一个
      expect(s3.cacheHits).toBe(totalAccesses - 1)        // 其余访问全部命中
      if (!g3.ok) return
      expect([...g3.value.nodes.keys()]).toContain('new-pkg')
    } finally {
      fs.writeFileSync(pkgPath, original)
    }
  })
})

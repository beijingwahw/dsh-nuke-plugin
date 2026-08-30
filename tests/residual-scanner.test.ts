import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PluginName, ProfileName } from '../src/contracts/base'
import type { ScanEvent } from '../src/contracts/scan'
import { createResidualScanner } from '../src/engine/residual-scanner'
import { createScanCache } from '../src/infra/scan-cache'

let home: string
let tempRoot: string
const NOW_MS = Date.now()

async function collect(iter: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const out: ScanEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

/** found 事件窄化（替代 as any，规避 no-unsafe-call） */
function isFound(e: ScanEvent): e is Extract<ScanEvent, { type: 'found' }> {
  return e.type === 'found'
}

function seed() {
  const pd = path.join(home, 'profiles', 'default')
  fs.mkdirSync(pd, { recursive: true })
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
    dependencies: { 'victim-plugin': '^1', 'keep-plugin': '^1' },
    dsh: { profile: { bundles: ['victim-plugin', 'keep-plugin'] } },
  }))
  // 三处配置引用
  fs.writeFileSync(path.join(pd, 'pnpm-workspace.yaml'), 'allowBuilds:\n  - victim-plugin\n')
  fs.writeFileSync(path.join(pd, 'cordis.patch.yml'), 'changes:\n  - id: victim-plugin\n')
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), 'changes:\n  - id: victim-plugin\n')
  // 目录残留
  fs.mkdirSync(path.join(pd, 'node_modules', 'victim-plugin'), { recursive: true })
  fs.writeFileSync(path.join(pd, 'node_modules', 'victim-plugin', 'index.js'), 'x'.repeat(100))
  fs.mkdirSync(path.join(home, 'storages', 'victim-plugin'), { recursive: true })
  fs.writeFileSync(path.join(home, 'storages', 'victim-plugin', 'data.json'), '{"a":1}')
  fs.mkdirSync(path.join(home, 'attachments', 'v1', 'victim-plugin'), { recursive: true })
  fs.writeFileSync(path.join(home, 'attachments', 'v1', 'victim-plugin', 'f.bin'), '1010')
  // TEMP：一个过期 dsh 条目 + 一个新鲜条目 + 一个无关条目
  fs.mkdirSync(tempRoot, { recursive: true })
  const old = path.join(tempRoot, 'dsh-tmp-old')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'x'), 'zzz')
  fs.utimesSync(old, new Date(NOW_MS - 30 * 86_400_000), new Date(NOW_MS - 30 * 86_400_000))
  const fresh = path.join(tempRoot, 'dsh-tmp-fresh')
  fs.mkdirSync(fresh, { recursive: true })
  fs.writeFileSync(path.join(fresh, 'y'), 'z')
  fs.writeFileSync(path.join(tempRoot, 'unrelated.txt'), 'nope')
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-home-'))
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-temp-'))
  seed()
})
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function makeScanner() {
  return createResidualScanner({ dshHome: home, tempRoot })
}

describe('ResidualScanner', () => {
  it('单插件扫描：命中全部 6 类残留（3 配置 + 3 目录），done 汇总正确', async () => {
    const events = await collect(makeScanner().scan({
      plugin: 'victim-plugin' as PluginName,
      profile: 'default' as ProfileName,
      strategy: 'balanced', includeTemp: false,
    }))
    const found = events.filter(e => e.type === 'found')
    expect(found.length).toBe(6)
    const kinds = new Set(found.map(e => (e as any).evidence.kind))
    expect(kinds.has('config-ref')).toBe(true)
    expect(kinds.has('node-modules')).toBe(true)
    expect(kinds.has('storage')).toBe(true)
    expect(kinds.has('attachment')).toBe(true)

    const done = events.at(-1)!
    expect(done.type).toBe('done')
    expect((done as any).totalFound).toBe(6)
    expect((done as any).bytesReclaimable).toBeGreaterThan(0)
  })

  it('V5.8.9 悬空声明：已声明未安装 → config-ref 残留（下次 install 将复活）', async () => {
    // --skip-standard 卸载 / pnpm remove 中途中断的真实后果：
    // deps/bundles 仍声明、node_modules 已删 —— 旧扫描器对此报"无残留"
    const pd = path.join(home, 'profiles', 'dangling-prof')
    fs.mkdirSync(pd, { recursive: true })
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
      dependencies: { 'zombie-plugin': '^1' },
      dsh: { profile: { bundles: ['zombie-plugin'] } },
    }))
    try {
      const events = await collect(makeScanner().scan({
        plugin: 'zombie-plugin' as PluginName,
        profile: 'dangling-prof' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      const found = events.filter(e => e.type === 'found')
      expect(found.length).toBe(1)
      const ev = (found[0] as any).evidence
      expect(ev.kind).toBe('config-ref')
      expect(ev.suggestedAction).toBe('clean-package-json')
      expect(ev.description).toContain('悬空声明')
    } finally {
      fs.rmSync(pd, { recursive: true, force: true })
    }
  })

  it('V5.8.9 对照：已声明且已安装 → 非悬空，不产出声明残留（正常安装不误报）', async () => {
    const pd = path.join(home, 'profiles', 'installed-prof')
    fs.mkdirSync(path.join(pd, 'node_modules', 'alive-plugin'), { recursive: true })
    fs.writeFileSync(path.join(pd, 'node_modules', 'alive-plugin', 'index.js'), 'x')
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
      dependencies: { 'alive-plugin': '^1' },
      dsh: { profile: { bundles: ['alive-plugin'] } },
    }))
    try {
      const events = await collect(makeScanner().scan({
        plugin: 'alive-plugin' as PluginName,
        profile: 'installed-prof' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      // node_modules 目录本身是残留（balanced 会回收），但绝无"悬空声明"
      const decl = events.filter(e =>
        isFound(e) && e.evidence.description.includes('悬空声明'))
      expect(decl.length).toBe(0)
    } finally {
      fs.rmSync(pd, { recursive: true, force: true })
    }
  })

  it('V5.9.0 pnpm 虚拟存储：链接层已删 → .pnpm 实体是残留；正常安装不误报', async () => {
    const pd = path.join(home, 'profiles', 'pnpm-prof')
    const mk = (name: string) => {
      const d = path.join(pd, 'node_modules', '.pnpm', name, 'node_modules', 'pkg-plugin')
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'index.js'), 'x'.repeat(200))
    }
    mk('pkg-plugin@1.0.0')
    mk('pkg-plugin@2.0.0')
    mk('other-lib@9.9.9')   // 他人实体，绝不能命中
    try {
      // 场景 1：链接层存在（正常安装）→ .pnpm 实体不报
      fs.mkdirSync(path.join(pd, 'node_modules', 'pkg-plugin'), { recursive: true })
      let events = await collect(makeScanner().scan({
        plugin: 'pkg-plugin' as PluginName,
        profile: 'pnpm-prof' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      let pnpmFound = events.filter(isFound).filter(e => e.evidence.location.includes('.pnpm'))
      expect(pnpmFound.length).toBe(0)

      // 场景 2：链接层删除（卸载后）→ 两个版本实体全部命中，other-lib 不碰
      fs.rmSync(path.join(pd, 'node_modules', 'pkg-plugin'), { recursive: true, force: true })
      events = await collect(makeScanner().scan({
        plugin: 'pkg-plugin' as PluginName,
        profile: 'pnpm-prof' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      pnpmFound = events.filter(isFound).filter(e => e.evidence.location.includes('.pnpm'))
      expect(pnpmFound.length).toBe(2)
      for (const e of pnpmFound) {
        expect(e.evidence.suggestedAction).toBe('remove-pnpm-store')
        expect(e.evidence.sizeBytes).toBeGreaterThan(0)
        expect(e.evidence.location).not.toContain('other-lib')
      }
    } finally {
      fs.rmSync(pd, { recursive: true, force: true })
    }
  })

  it('V5.9.0 lockfile 残留：引用命中 → lockfile 证据（report-only，不虚报体积）', async () => {
    const pd = path.join(home, 'profiles', 'lock-prof')
    fs.mkdirSync(pd, { recursive: true })
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ dependencies: {} }))
    fs.writeFileSync(path.join(pd, 'pnpm-lock.yaml'), 'packages:\n\n  lock-victim@1.0.0:\n    resolution: {integrity: sha512-x}\n')
    try {
      const events = await collect(makeScanner().scan({
        plugin: 'lock-victim' as PluginName,
        profile: 'lock-prof' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      const lockEv = events.filter(isFound).filter(e => e.evidence.kind === 'lockfile')
      expect(lockEv.length).toBe(1)
      const ev = lockEv[0]!
      expect(ev.evidence.suggestedAction).toBe('report-only')
      // report-only 语义：文件不删不编辑 → 体积恒 0（不虚报可回收空间）
      expect(ev.evidence.sizeBytes).toBe(0)
      expect(ev.evidence.description).toContain('install')
    } finally {
      fs.rmSync(pd, { recursive: true, force: true })
    }
  })

  it('配置文件不含插件名 → 不产出 config-ref 证据', async () => {
    const pd = path.join(home, 'profiles', 'clean-prof')
    fs.mkdirSync(pd, { recursive: true })
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ dependencies: { 'other-plugin': '^1' } }))
    fs.writeFileSync(path.join(pd, 'pnpm-workspace.yaml'), 'allowBuilds:\n  - other-plugin\n')
    try {
      const events = await collect(makeScanner().scan({
        plugin: 'ghost-plugin' as PluginName,
        profile: 'clean-prof' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      const found = events.filter(e => e.type === 'found')
      expect(found.length).toBe(0) // 无任何残留
    } finally {
      fs.rmSync(pd, { recursive: true, force: true })
    }
  })

  it('TEMP 孤儿：仅 aggressive + includeTemp 纳入，且过滤新鲜/无关条目', async () => {
    async function scanTemp(strategy: 'safe' | 'aggressive', includeTemp: boolean) {
      const events = await collect(makeScanner().scan({
        plugin: 'victim-plugin' as PluginName,
        profile: 'default' as ProfileName,
        strategy, includeTemp,
      }))
      return events
        .filter(e => e.type === 'found' && (e as any).evidence.kind === 'temp-orphan')
        .map(e => (e as any).evidence.location as string)
    }
    expect(await scanTemp('safe', true)).toEqual([])          // safe 不碰 TEMP
    expect(await scanTemp('aggressive', false)).toEqual([])   // 未启用 includeTemp
    const temps = await scanTemp('aggressive', true)
    expect(temps.some(p => p.includes('dsh-tmp-old'))).toBe(true)
    expect(temps.some(p => p.includes('dsh-tmp-fresh'))).toBe(false)
    expect(temps.some(p => p.includes('unrelated'))).toBe(false)
  })

  it('AbortSignal 触发 → 停止产出 found 并正常收尾 done', async () => {
    const controller = new AbortController()
    const events: ScanEvent[] = []
    for await (const e of makeScanner().scan({
      plugin: 'victim-plugin' as PluginName,
      profile: 'default' as ProfileName,
      strategy: 'safe', includeTemp: false,
      signal: controller.signal,
    })) {
      events.push(e)
      if (events.filter(x => x.type === 'found').length >= 1) controller.abort()
    }
    const foundCount = events.filter(e => e.type === 'found').length
    expect(foundCount).toBeLessThan(6)
    expect(events.at(-1)!.type).toBe('done')
  })

  it('全局模式（无 plugin）：以 profile 依赖并集为目标，能发现 keep-plugin 的残留', async () => {
    // 给 keep-plugin 造一个 storage 残留
    fs.mkdirSync(path.join(home, 'storages', 'keep-plugin'), { recursive: true })
    try {
      const events = await collect(makeScanner().scan({
        profile: 'default' as ProfileName,
        strategy: 'safe', includeTemp: false,
      }))
      const found = events.filter(e => e.type === 'found')
      const plugins = new Set(found.map(e => path.basename((e as any).evidence.location)))
      expect(plugins.has('keep-plugin')).toBe(true)
      expect(plugins.has('victim-plugin')).toBe(true)
    } finally {
      fs.rmSync(path.join(home, 'storages', 'keep-plugin'), { recursive: true, force: true })
    }
  })

  it('progress 限频：窗口内事件合并为最后一个计数，首事件必发', async () => {
    // 40 个插件的 profile：全局模式 = 40+ 插件 × 6 检查点 ≈ 246 个路径。
    // 10s 窗口下真实执行远小于窗口 → 只有首事件逃出限频（洪泛被抑制）
    const profDir = path.join(home, 'profiles', 'many-prof')
    fs.mkdirSync(profDir, { recursive: true })
    const deps: Record<string, string> = {}
    for (let i = 0; i < 40; i++) deps[`p${i}-plugin`] = '^1'
    fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ dependencies: deps }))
    try {
      const events = await collect(createResidualScanner({
        dshHome: home, tempRoot, progressIntervalMs: 10_000,
      }).scan({ profile: 'many-prof' as ProfileName, strategy: 'safe', includeTemp: false }))
      const progress = events.filter(e => e.type === 'progress')
      expect(progress.length).toBe(1)                       // 只有首事件
      expect((progress[0] as any).scannedPaths).toBe(1)     // 首事件在路径 1 发出
      // found 不受限频影响：victim-plugin 的 storages 残留照常产出
      expect(events.some(e =>
        e.type === 'found' && (e as any).evidence.kind === 'storage')).toBe(true)
    } finally {
      fs.rmSync(profDir, { recursive: true, force: true })
    }
  })

  it('progressIntervalMs=0：关闭限频，逐路径事件（旧行为兼容）', async () => {
    const events = await collect(createResidualScanner({
      dshHome: home, tempRoot, progressIntervalMs: 0,
    }).scan({
      plugin: 'victim-plugin' as PluginName,
      profile: 'default' as ProfileName,
      strategy: 'safe', includeTemp: false,
    }))
    const progress = events.filter(e => e.type === 'progress')
    // 单插件 8 检查点（V5.8.9 悬空声明 + V5.9.0 lockfile；default 种子无
    // .pnpm 目录 → 不产出额外检查点）：progress 在 stat 之前发出
    expect(progress.length).toBe(8)
    expect(progress.map(e => (e as any).scannedPaths)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('增量缓存（突破升级）：二次扫描结果一致且全量命中缓存', async () => {
    const cacheFile = path.join(home, '.cache', 'scan-cache.json')
    const req = {
      plugin: 'victim-plugin' as PluginName,
      profile: 'default' as ProfileName,
      strategy: 'safe', includeTemp: false,
    } as const

    // 第一次扫描：填充缓存
    const cache1 = createScanCache({ filePath: cacheFile })
    const scanner1 = createResidualScanner({ dshHome: home, tempRoot, scanCache: cache1 })
    const first = (await collect(scanner1.scan(req))).filter(e => e.type === 'found')
    expect(first.length).toBeGreaterThan(0)
    cache1.flush()
    expect(cache1.stats().misses).toBeGreaterThanOrEqual(first.length)

    // 第二次扫描：磁盘未变 → 全部命中，found 集合与首次一致
    const cache2 = createScanCache({ filePath: cacheFile })
    const scanner2 = createResidualScanner({ dshHome: home, tempRoot, scanCache: cache2 })
    const second = (await collect(scanner2.scan(req))).filter(e => e.type === 'found')
    expect(second.length).toBe(first.length)
    const key = (e: ScanEvent) => (e as any).evidence.location as string
    expect(second.map(key).sort()).toEqual(first.map(key).sort())
    // 体积也必须一致（dirBytes 复用正确性）
    const sizeOf = (e: ScanEvent) => (e as any).evidence.sizeBytes as number
    expect(second.map(sizeOf).sort()).toEqual(first.map(sizeOf).sort())
    // 命中统计：第二次扫描的每个 checkpoint 指纹都命中
    expect(cache2.stats().hits).toBeGreaterThanOrEqual(first.length)
    expect(cache2.stats().misses).toBe(0)

    // 磁盘变化 → 指纹失效 → 重新计算
    const storageDir = path.join(home, 'storages', 'victim-plugin')
    fs.writeFileSync(path.join(storageDir, 'extra.json'), '{"new":true}')
    const cache3 = createScanCache({ filePath: cacheFile })
    const scanner3 = createResidualScanner({ dshHome: home, tempRoot, scanCache: cache3 })
    const third = (await collect(scanner3.scan(req))).filter(e => e.type === 'found')
    expect(third.length).toBe(first.length)
    // storages 目录体积变大（缓存失效后重算到新值）
    const storageEv = third.find(e => (e as any).evidence.kind === 'storage') as any
    const storageBefore = second.find(e => (e as any).evidence.kind === 'storage') as any
    expect(storageEv.evidence.sizeBytes).toBeGreaterThan(storageBefore.evidence.sizeBytes)
  })
})

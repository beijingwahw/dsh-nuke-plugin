import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createResidualScanner } from '../src/engine/residual-scanner'
import { createScanCache } from '../src/infra/scan-cache'
import type { PluginName, ProfileName } from '../src/contracts/base'
import type { ScanEvent } from '../src/contracts/scan'

let home: string
let tempRoot: string
const NOW_MS = Date.now()

async function collect(iter: AsyncIterable<ScanEvent>): Promise<ScanEvent[]> {
  const out: ScanEvent[] = []
  for await (const e of iter) out.push(e)
  return out
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
    // 单插件 6 检查点：progress 在 stat 之前发出，存在与否不影响计数
    expect(progress.length).toBe(6)
    expect(progress.map(e => (e as any).scannedPaths)).toEqual([1, 2, 3, 4, 5, 6])
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

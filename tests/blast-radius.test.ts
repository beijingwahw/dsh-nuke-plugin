// tests/blast-radius.test.ts — 爆炸半径分析器单测（stub 依赖图 + 真实磁盘 fixture）
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ok } from '../src/contracts/base'
import type { Result } from '../src/contracts/base'
import type { DependencyGraph, IDependencyAnalyzer } from '../src/contracts/scan'
import { createBlastRadiusAnalyzer } from '../src/engine/blast-radius'

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** stub 依赖图：edges 决定 dependentsOf/dependenciesOf（含传递闭包） */
function stubAnalyzer(edges: readonly [string, string][]): IDependencyAnalyzer {
  const direct = new Map<string, string[]>()
  for (const [from, to] of edges) {
    const list = direct.get(to) ?? []
    list.push(from)
    direct.set(to, list)
  }
  // BFS 传递闭包
  const closureOf = (name: string, next: (n: string) => string[]): string[] => {
    const seen = new Set<string>()
    const queue = [...next(name)]
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      queue.push(...next(cur))
    }
    return [...seen]
  }
  const graph = ((): DependencyGraph => ({
    nodes: new Map(),
    edges: edges.map(([from, to]) => ({ from: from as any, to: to as any, kind: 'dependencies', declaredIn: '' as any })),
    dependentsOf: (n) => closureOf(n, x => direct.get(x) ?? []).map(x => x as any),
    dependenciesOf: (n) => closureOf(n, x => (edges.filter(([f]) => f === x).map(([, t]) => t))).map(x => x as any),
    hasCycle: () => false,
    cycles: () => [],
  }))
  return {
    buildGraph: async (): Promise<Result<DependencyGraph>> => ok(graph()),
    blockersOf: async () => ok([]),
  }
}

function seedDisk(plugin: string, bytes: number) {
  const dir = path.join(tmp, '.dsh', 'storages', plugin)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'data.bin'), 'x'.repeat(bytes))
}

describe('爆炸半径仿真', () => {
  it('无依赖方 → broken 空、风险 low', async () => {
    const analyzer = createBlastRadiusAnalyzer({ dshHome: path.join(tmp, '.dsh'), analyzer: stubAnalyzer([]) })
    const r = await analyzer.simulate(['lonely' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.brokenDependents.length).toBe(0)
    expect(r.value.cascadeRemovable.length).toBe(0)
    expect(r.value.riskLevel).toBe('low')
    expect(r.value.riskScore).toBeLessThan(25)
  })

  it('直接依赖方不在删除集合 → broken 含它，风险升级', async () => {
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: path.join(tmp, '.dsh'),
      analyzer: stubAnalyzer([['consumer-a', 'victim'], ['consumer-b', 'victim']]),
    })
    const r = await analyzer.simulate(['victim' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.brokenDependents).toContain('consumer-a')
    expect(r.value.brokenDependents).toContain('consumer-b')
    expect(r.value.riskLevel).toBe('high')          // 2×25 = 50
    expect(r.value.advisories[0]).toContain('consumer-a')
  })

  it('传递闭包：孙依赖也算 broken', async () => {
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: path.join(tmp, '.dsh'),
      analyzer: stubAnalyzer([['child', 'victim'], ['grandchild', 'child']]),
    })
    const r = await analyzer.simulate(['victim' as any])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.brokenDependents).toContain('child')
      expect(r.value.brokenDependents).toContain('grandchild')
    }
  })

  it('依赖方同批删除 → 归入 cascade 而非 broken', async () => {
    const analyzer = createBlastRadiusAnalyzer({
      dshHome: path.join(tmp, '.dsh'),
      analyzer: stubAnalyzer([['child', 'victim']]),
    })
    const r = await analyzer.simulate(['victim' as any, 'child' as any])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.brokenDependents.length).toBe(0)
    expect(r.value.cascadeRemovable).toContain('child')
  })

  it('磁盘探测：storages 计入可回收；patch 引用被定位', async () => {
    seedDisk('probed', 2048)
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.dsh', 'cordis.patch.yml'), '- id: probed\n')
    const analyzer = createBlastRadiusAnalyzer({ dshHome: path.join(tmp, '.dsh'), analyzer: stubAnalyzer([]) })
    const r = await analyzer.simulate(['probed' as any], 'web' as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.estimatedBytesReclaimable).toBeGreaterThanOrEqual(2048)
    expect(r.value.configRefs.length).toBe(1)
    expect(r.value.configRefs[0]).toContain('cordis.patch.yml')
  })

  it('空目标列表 → E_VALIDATION', async () => {
    const analyzer = createBlastRadiusAnalyzer({ dshHome: tmp, analyzer: stubAnalyzer([]) })
    const r = await analyzer.simulate([])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_VALIDATION')
  })
})

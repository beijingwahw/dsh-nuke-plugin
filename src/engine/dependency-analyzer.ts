// src/engine/dependency-analyzer.ts — IDependencyAnalyzer 实现
// 图来源（三类边）：
//   1. profile package.json 的 dependencies/peer/optional → 边 kind 对应
//   2. node_modules/<bundle>/package.json 的依赖（bundle 间真实依赖）
//   3. cordis.patch.yml（home + profile）中的 `id: <plugin>` 条目 → patch-ref 边
// profile 本身作为合成节点（synthetic `<profile>`）加入图：dependentsOf 能直接
// 回答"删掉它哪个 profile 会坏"。
//
// 本轮升级（图构建文件指纹缓存 · 增量复用）：
//   每次 buildGraph 都要读+解析全部 package.json / cordis.patch.yml —— 大
//   node_modules（上千 bundle）下 JSON/YAML 解析是主要成本，而连续两次构建
//   （如 doctor → blockersOf → blast-radius 同轮巡检）之间文件几乎从未变过。
//   缓存以 (size, mtimeMs) 为指纹（与 make/esbuild 同口径）：指纹命中 →
//   直接复用上次解析产物，跳过 readFileSync + JSON.parse/yaml 解析；
//   未命中/新增 → 读盘解析并回填；文件消失 → 条目失效。
//   目录结构（profile/bundle 清单）仍每次真实列举 —— 文件内容缓存与目录
//   发现正交，组合后语义与全量重建逐位一致，只是省掉重复解析。
//   cacheStats() 暴露上次构建的命中/读盘计数（可观测性：增量是否生效）。
import * as fs from 'fs'
import * as path from 'path'
import { parse as parseYaml } from 'yaml'
import type {
  AbsolutePath, NukeError, PluginName, ProfileName, Result,
} from '../contracts/base'
import { err, errorToMessage, ioError, ok } from '../contracts/base'
import type {
  DependencyEdge, DependencyGraph, IDependencyAnalyzer, PluginNode,
} from '../contracts/scan'

/** IDependencyAnalyzer 的引擎层扩展：暴露指纹缓存统计（协变扩展） */
export interface IDependencyAnalyzerDetail extends IDependencyAnalyzer {
  /** 上次 buildGraph 的指纹缓存统计：
   *  filesRead = 实际读盘解析的文件数（新增/变更条目），
   *  cacheHits = 复用上次解析产物、跳过读盘解析的文件数 */
  cacheStats(): { readonly filesRead: number; readonly cacheHits: number }
}

export interface DependencyAnalyzerOptions {
  readonly dshHome: string
  readonly fs_?: typeof fs          // 测试可注入内存 fs（保留默认真实 fs）
  readonly yamlParse?: (s: string) => unknown
}

const DEP_KINDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

/** 指纹缓存条目：stat 指纹 + 上次解析产物（解析失败也缓存，坏文件不反复重试） */
interface FingerprintEntry<T> {
  readonly size: number
  readonly mtimeMs: number
  readonly value: T
}

export function createDependencyAnalyzer(options: DependencyAnalyzerOptions): IDependencyAnalyzerDetail {
  const fsys = options.fs_ ?? fs
  const yamlParse = options.yamlParse ?? parseYaml

  // 指纹缓存：绝对路径 → 解析产物。analyzer 生命周期内跨 buildGraph 复用
  const pkgCache = new Map<string, FingerprintEntry<Record<string, unknown> | null>>()
  const patchCache = new Map<string, FingerprintEntry<{ ids: string[]; parseError: string | null }>>()
  let cacheHits = 0
  let filesRead = 0

  function listProfiles(): ProfileName[] {
    const dir = path.join(options.dshHome, 'profiles')
    if (!fsys.existsSync(dir)) return []
    return fsys
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name as ProfileName)
  }

  /** 指纹缓存读取：stat (size, mtimeMs) 命中 → 复用解析产物；未命中 →
   *  读盘解析并回填。parse 自行兜底错误（不抛出，与旧版语义一致）。
   *  文件消失/不可读 → 失效条目并返回 null（缺省语义由调用方决定）。 */
  function fingerprinted<T>(
    cache: Map<string, FingerprintEntry<T>>,
    file: string,
    parse: (raw: string) => T,
  ): T | null {
    let st: fs.Stats
    try {
      st = fsys.statSync(file)
    } catch {
      cache.delete(file)
      return null
    }
    const hit = cache.get(file)
    if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      cacheHits++
      return hit.value
    }
    let raw: string
    try {
      raw = fsys.readFileSync(file, 'utf-8')
    } catch {
      cache.delete(file)
      return null
    }
    filesRead++
    const value = parse(raw)
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value })
    return value
  }

  function readJson(p: string): Record<string, unknown> | null {
    return fingerprinted(pkgCache, p, raw => {
      try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
    })
  }

  /** 从 package.json 抽出 (name → kind) 依赖表 */
  function depsOf(pkg: Record<string, unknown>): Map<string, (typeof DEP_KINDS)[number]> {
    const out = new Map<string, (typeof DEP_KINDS)[number]>()
    for (const kind of DEP_KINDS) {
      const sec = pkg[kind]
      if (sec && typeof sec === 'object') {
        for (const name of Object.keys(sec as Record<string, unknown>)) out.set(name, kind)
      }
    }
    return out
  }

  /** 解析 cordis.patch.yml（指纹缓存）：收集所有条目的 id
   *  （支持 {changes:[{id}]} 与 [{id}] 两种形态）；文件缺失 → 空结果 */
  function patchIds(file: string): { ids: string[]; parseError: string | null } {
    return fingerprinted(patchCache, file, raw => {
      try {
        const doc = yamlParse(raw)
        const ids: string[] = []
        const visit = (node: unknown) => {
          if (Array.isArray(node)) { node.forEach(visit); return }
          if (node && typeof node === 'object') {
            const rec = node as Record<string, unknown>
            if (typeof rec.id === 'string') ids.push(rec.id)
            for (const v of Object.values(rec)) {
              if (v && typeof v === 'object') visit(v)
            }
          }
        }
        visit(doc)
        return { ids: [...new Set(ids)], parseError: null }
      } catch (e) {
        return { ids: [], parseError: errorToMessage(e) }
      }
    }) ?? { ids: [], parseError: null }
  }

  /** node_modules 下的一级包名（含 @scope/name 两段） */
  function listBundleDirs(nmRoot: string): string[] {
    if (!fsys.existsSync(nmRoot)) return []
    const out: string[] = []
    for (const e of fsys.readdirSync(nmRoot, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      if (e.name.startsWith('@')) {
        const scopeDir = path.join(nmRoot, e.name)
        if (!fsys.existsSync(scopeDir)) continue
        for (const sub of fsys.readdirSync(scopeDir, { withFileTypes: true })) {
          if (sub.isDirectory()) out.push(`${e.name}/${sub.name}`)
        }
      } else if (e.isDirectory()) {
        out.push(e.name)
      }
    }
    return out
  }

  function buildGraph(profileFilter?: ProfileName): DependencyGraph {
    // 统计口径 = 单次构建：每次重置（blockersOf 内部触发 buildGraph 同样重置）
    cacheHits = 0
    filesRead = 0
    const nodes = new Map<PluginName, PluginNode>()
    const edges: DependencyEdge[] = []

    const upsert = (name: string, patch: Partial<Pick<PluginNode, 'declaredIn' | 'patchRefs'>> = {}) => {
      const key = name as PluginName
      const cur = nodes.get(key) ?? {
        name: key, declaredIn: [], patchRefs: [],
      }
      nodes.set(key, {
        name: key,
        declaredIn: dedupeJoin(cur.declaredIn, patch.declaredIn),
        patchRefs: dedupeJoin(cur.patchRefs, patch.patchRefs),
      })
    }

    const dedupeJoin = (
      a: readonly AbsolutePath[], b?: readonly AbsolutePath[],
    ): AbsolutePath[] => [...new Set([...a, ...(b ?? [])])] as AbsolutePath[]

    for (const profile of listProfiles()) {
      if (profileFilter && profile !== profileFilter) continue
      const profileDir = path.join(options.dshHome, 'profiles', profile)
      const pkgPath = path.join(profileDir, 'package.json')
      const synthetic = `profile:${profile}`

      // 1) profile 声明的依赖：synthetic 节点 → 插件
      const pkg = readJson(pkgPath)
      if (pkg) {
        upsert(synthetic, { declaredIn: [pkgPath as AbsolutePath] })
        for (const [dep, kind] of depsOf(pkg)) {
          upsert(dep)
          edges.push({
            from: synthetic as PluginName, to: dep as PluginName, kind,
            declaredIn: pkgPath as AbsolutePath,
          })
        }
      }

      // 2) node_modules 内 bundle 之间的依赖
      const nmRoot = path.join(profileDir, 'node_modules')
      for (const bundle of listBundleDirs(nmRoot)) {
        const bp = path.join(nmRoot, ...bundle.split('/'), 'package.json')
        const pkg = readJson(bp)
        if (!pkg) continue
        upsert(bundle)
        for (const [dep, kind] of depsOf(pkg)) {
          // 只记录指向图内已知/磁盘存在目标的边，避免把外部库(如 yaml)算成插件
          const targetExists = nodes.has(dep as PluginName)
            || fsys.existsSync(path.join(nmRoot, ...dep.split('/')))
          if (!targetExists) continue
          upsert(dep)
          edges.push({
            from: bundle as PluginName, to: dep as PluginName, kind,
            declaredIn: bp as AbsolutePath,
          })
        }
      }

      // 3) patch 引用（profile 级 + home 级）
      const patchFiles = [
        path.join(options.dshHome, 'cordis.patch.yml'),
        path.join(profileDir, 'cordis.patch.yml'),
      ]
      for (const pf of patchFiles) {
        const { ids } = patchIds(pf)
        for (const id of ids) {
          upsert(id, { patchRefs: [pf as AbsolutePath] })
          edges.push({
            from: synthetic as PluginName, to: id as PluginName, kind: 'patch-ref',
            declaredIn: pf as AbsolutePath,
          })
        }
      }
    }

    return makeGraph(nodes, edges)
  }

  function makeGraph(
    nodes: ReadonlyMap<PluginName, PluginNode>, edges: readonly DependencyEdge[],
  ): DependencyGraph {
    const forward = new Map<PluginName, Set<PluginName>>()
    const backward = new Map<PluginName, Set<PluginName>>()
    const touch = (m: Map<PluginName, Set<PluginName>>, k: PluginName) => {
      if (!m.has(k)) m.set(k, new Set())
    }
    for (const e of edges) {
      touch(forward, e.from); touch(forward, e.to)
      touch(backward, e.from); touch(backward, e.to)
      forward.get(e.from)!.add(e.to)
      backward.get(e.to)!.add(e.from)
    }
    for (const k of nodes.keys()) { touch(forward, k); touch(backward, k) }

    const closure = (
      start: PluginName, next: (n: PluginName) => readonly PluginName[],
    ): PluginName[] => {
      const seen = new Set<PluginName>()
      const queue: PluginName[] = [start]
      // 游标索引替代 shift()：shift 是 O(N) 数组搬移，大图上传递闭包退化为 O(N²)
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head]!
        for (const n of next(cur)) {
          if (n !== start && !seen.has(n)) { seen.add(n); queue.push(n) }
        }
      }
      return [...seen]
    }

    // 闭包记忆化：图的邻接结构在 buildGraph 后不可变（冻结快照），
    // 同一节点的闭包必恒定 —— 缓存于图生命周期内，重复查询 O(1)。
    // 典型受益：blockersOf(N 插件) + blastRadius(closure×目标数) 在同一图上
    // 反复查询同一批节点的 dependentsOf。
    const dependentsMemo = new Map<PluginName, readonly PluginName[]>()
    const dependenciesMemo = new Map<PluginName, readonly PluginName[]>()

    // Tarjan SCC：仅报告 size>1 的环与自环
    const cycles = tarjanCycles(nodes, forward)

    return {
      nodes, edges,
      dependentsOf: name => {
        let v = dependentsMemo.get(name)
        if (v === undefined) {
          v = closure(name, n => [...(backward.get(n) ?? [])])
          dependentsMemo.set(name, v)
        }
        return v
      },
      dependenciesOf: name => {
        let v = dependenciesMemo.get(name)
        if (v === undefined) {
          v = closure(name, n => [...(forward.get(n) ?? [])])
          dependenciesMemo.set(name, v)
        }
        return v
      },
      hasCycle: () => cycles.length > 0,
      cycles: () => cycles,
    }
  }

  function tarjanCycles(
    nodes: ReadonlyMap<PluginName, PluginNode>, forward: Map<PluginName, Set<PluginName>>,
  ): PluginName[][] {
    let index = 0
    const stack: PluginName[] = []
    const onStack = new Set<PluginName>()
    const indices = new Map<PluginName, number>()
    const lowlink = new Map<PluginName, number>()
    const out: PluginName[][] = []

    const strongconnect = (v: PluginName) => {
      indices.set(v, index); lowlink.set(v, index); index++
      stack.push(v); onStack.add(v)
      for (const w of forward.get(v) ?? []) {
        if (!indices.has(w)) {
          strongconnect(w)
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
        }
      }
      if (lowlink.get(v) === indices.get(v)) {
        const scc: PluginName[] = []
        let w: PluginName
        do {
          w = stack.pop()!
          onStack.delete(w)
          scc.push(w)
        } while (w !== v)
        if (scc.length > 1) out.push(scc)
        else if (scc.length === 1 && (forward.get(scc[0]!)?.has(scc[0]!) ?? false)) out.push(scc)
      }
    }

    for (const n of nodes.keys()) {
      if (!indices.has(n)) strongconnect(n)
    }
    return out
  }

  const analyzer: IDependencyAnalyzerDetail = {
    async buildGraph(profile?: ProfileName): Promise<Result<DependencyGraph, NukeError>> {
      try {
        return ok(buildGraph(profile))
      } catch (e) {
        return err(ioError('依赖图构建失败', e))
      }
    },

    async blockersOf(plugins) {
      const g = await analyzer.buildGraph()
      if (!g.ok) return g
      const removing = new Set<PluginName>(plugins)
      const out = []
      for (const target of plugins) {
        // 阻断 = 仍依赖它且不在本次删除集合内的【其他插件】。
        // profile 声明不算阻断：清理流程的标准步骤会同步移除声明。
        const blockedBy = g.value
          .dependentsOf(target)
          .filter(d => !removing.has(d) && !d.startsWith('profile:'))
        if (blockedBy.length > 0) {
          out.push({
            plugin: target,
            blockedBy,
            reason: `被其他插件依赖: ${blockedBy.join(', ')}`,
          })
        }
      }
      return ok(out)
    },

    cacheStats() {
      return { filesRead, cacheHits }
    },
  }
  return analyzer
}

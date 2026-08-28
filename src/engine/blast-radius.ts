// src/engine/blast-radius.ts — IBlastRadiusAnalyzer 实现：爆炸半径沙盘推演
// 算法（纯图仿真，零副作用）：
//   1. 闭包求 broken：dependentsOf(target) 为传递闭包，剔除删除集合内成员
//      → 剩下的都是"删了会坏"的意外受害者
//   2. 级联：闭包 ∩ 删除集合 = 有意同批删除
//   3. 风险分：broken 主因子（25/个）+ 级联规模（5/个）+ 体量（5/GB）
//   4. 顾问建议：如何降险（加入同批 / 先摘引用）
import * as fs from 'fs'
import * as path from 'path'
import type { AbsolutePath, PluginName } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { DependencyGraph, IDependencyAnalyzer } from '../contracts/scan'
import type { BlastRadiusReport, IBlastRadiusAnalyzer, RiskLevel } from '../contracts/blast-radius.contract'
import { dirSize } from '../infra/fs-utils'

export interface BlastRadiusOptions {
  readonly dshHome: string
  /** 单插件风险上限保护：broken 计分到 4 个即封顶 100 */
  readonly analyzer: IDependencyAnalyzer
}

// ─── V5 增量（仅新增可选字段，向后兼容） ─────────────────────

/** 分层影响分析：把"删了会坏"的依赖方按跳数分层。
 *  direct      直接依赖任一目标（1 跳）—— 摘掉引用即可解耦，修复成本低
 *  transitive  经由中间插件间接依赖（2+ 跳）—— 需要整链路评估 */
export interface TieredDependents {
  readonly direct: readonly PluginName[]
  readonly transitive: readonly PluginName[]
}

/** 按 profile 分组的影响计数：受波及插件（broken + cascade）在各 profile
 *  的声明分布 —— 回答"这次删除会砸到哪些环境、各砸几个" */
export interface ProfileImpactCount {
  readonly profile: string
  readonly affected: number
}

/** V5 报告形态：旧字段全部保留，新增字段可选（消费方不读取即无感知） */
export type BlastRadiusReportV5 = BlastRadiusReport & {
  readonly tieredDependents?: TieredDependents
  readonly impactByProfile?: readonly ProfileImpactCount[]
}

export function createBlastRadiusAnalyzer(options: BlastRadiusOptions): IBlastRadiusAnalyzer {
  /** V5 分层影响分析：以删除集合为起点沿反向边 BFS 分层。
   *  第 1 层 = 直接依赖方（1 跳），第 2+ 层 = 传递依赖方；同一节点取最短
   *  跳数（标准 BFS 语义），删除集合成员与 profile: 合成节点不计入。 */
  function tierDependents(graph: DependencyGraph, targets: readonly string[]): TieredDependents {
    const removal = new Set<string>(targets)
    // 反向邻接表：被依赖 → 依赖方们（from 依赖 to）
    const rev = new Map<string, string[]>()
    for (const e of graph.edges) {
      const list = rev.get(e.to as string) ?? []
      list.push(e.from as string)
      rev.set(e.to as string, list)
    }
    const direct: string[] = []
    const transitive: string[] = []
    const seen = new Set<string>()
    let frontier = [...targets]
    let depth = 0
    while (frontier.length > 0) {
      depth++
      const next: string[] = []
      for (const node of frontier) {
        for (const dep of rev.get(node) ?? []) {
          if (seen.has(dep) || removal.has(dep) || dep.startsWith('profile:')) continue
          seen.add(dep)
          if (depth === 1) direct.push(dep)
          else transitive.push(dep)
          next.push(dep)
        }
      }
      frontier = next
    }
    return { direct: direct as PluginName[], transitive: transitive as PluginName[] }
  }

  /** V5：从声明路径提取 profile 名（…/profiles/<name>/package.json → <name>）。
   *  跨平台路径分隔符统一处理；非 profile 声明位置返回 null（不计入分组）。 */
  function profileNameOf(declaredIn: string): string | null {
    const segs = declaredIn.split(/[\\/]/)
    const i = segs.indexOf('profiles')
    const next = i >= 0 ? segs[i + 1] : undefined
    return typeof next === 'string' && next !== '' ? next : null
  }

  /** V5：按 profile 分组的影响计数 —— 受波及插件（broken + cascade）的
   *  声明位置分布，按 profile 名稳定排序输出。 */
  function impactCountsByProfile(
    graph: DependencyGraph,
    affected: readonly string[],
  ): readonly ProfileImpactCount[] {
    const counts = new Map<string, number>()
    for (const plugin of affected) {
      const node = graph.nodes.get(plugin as PluginName)
      if (!node) continue
      // 一个插件声明于多个 profile 时各计一次（每个环境都实际受波及）
      const profiles = new Set<string>()
      for (const src of node.declaredIn) {
        const p = profileNameOf(src as string)
        if (p !== null) profiles.add(p)
      }
      for (const p of profiles) counts.set(p, (counts.get(p) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([profile, affectedCount]) => ({ profile, affected: affectedCount }))
      .sort((a, b) => a.profile.localeCompare(b.profile))
  }

  /** 轻量磁盘探测：目标的 node_modules/storages/attachments + 配置引用位置 */
  function probeOnDisk(plugin: string, profile: string): { bytes: number; refs: AbsolutePath[] } {
    const profileDir = path.join(options.dshHome, 'profiles', profile)
    let bytes = 0
    for (const dir of [
      path.join(profileDir, 'node_modules', plugin),
      path.join(options.dshHome, 'storages', plugin),
      path.join(options.dshHome, 'attachments', plugin),
    ]) {
      if (fs.existsSync(dir)) bytes += dirSize(dir)
    }
    const refs: AbsolutePath[] = []
    for (const f of [
      path.join(options.dshHome, 'cordis.patch.yml'),
      path.join(profileDir, 'cordis.patch.yml'),
      path.join(options.dshHome, 'pnpm-workspace.yaml'),
    ]) {
      try {
        if (fs.readFileSync(f, 'utf-8').includes(plugin)) refs.push(f as AbsolutePath)
      } catch { /* 不存在即跳过 */ }
    }
    return { bytes, refs }
  }

  return {
    async simulate(plugins, profile) {
      if (plugins.length === 0) {
        return err({ code: 'E_VALIDATION', message: '爆炸半径仿真需要至少一个插件' })
      }
      try {
        const g = await options.analyzer.buildGraph(profile)
        if (!g.ok) return g
        const graph = g.value

        const removal = new Set<string>(plugins)
        const closure = new Set<string>()     // 传递依赖目标的全部插件
        for (const target of plugins) {
          for (const dep of graph.dependentsOf(target)) closure.add(dep)
        }

        const broken = [...closure].filter(p => !removal.has(p) && !p.startsWith('profile:'))
        const cascade = [...closure].filter(p => removal.has(p))

        // 磁盘探测（多 profile 场景按首个 profile 轻量采样即可，精确值由 dry-run 给出）
        let bytes = 0
        const refSet = new Set<string>()
        for (const plugin of plugins) {
          const { bytes: b, refs } = probeOnDisk(plugin, profile ?? 'web')
          bytes += b
          for (const r of refs) refSet.add(r)
        }

        // 风险分：broken 主因子，级联与体量次因子
        const riskScore = Math.min(100,
          broken.length * 25
          + cascade.length * 5
          + Math.floor(bytes / (1024 ** 3)) * 5,
        )
        const riskLevel: RiskLevel =
          riskScore >= 75 ? 'extreme' : riskScore >= 50 ? 'high' : riskScore >= 25 ? 'medium' : 'low'

        const advisories: string[] = []
        if (broken.length > 0) {
          advisories.push(
            `删除将损坏 ${broken.length} 个插件: ${broken.join(', ')} —— 将它们加入同批删除清单（有意级联），或先解除其依赖`,
          )
        }
        if (cascade.length > 0) {
          advisories.push(`${cascade.length} 个插件随目标级联删除（同批），请确认这是预期行为`)
        }
        if (bytes > 1024 ** 3) {
          advisories.push(`预估回收超过 1GB，建议先 dry-run 核对操作清单`)
        }
        if (advisories.length === 0) advisories.push('无外部波及，可以安全进入 dry-run → commit 流程')

        const report: BlastRadiusReportV5 = {
          targets: plugins,
          cascadeRemovable: cascade as PluginName[],
          brokenDependents: broken as PluginName[],
          configRefs: [...refSet] as AbsolutePath[],
          estimatedBytesReclaimable: bytes,
          riskScore,
          riskLevel,
          advisories,
          // V5：分层影响分析（direct/transitive 与 broken 同源互补）
          tieredDependents: tierDependents(graph, plugins),
          // V5：受波及插件（broken + cascade）的 profile 声明分布
          impactByProfile: impactCountsByProfile(graph, [...broken, ...cascade]),
        }
        return ok(report)
      } catch (e) {
        return err(ioError('爆炸半径仿真失败', e))
      }
    },
  }
}

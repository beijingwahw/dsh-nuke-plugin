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
import type { IDependencyAnalyzer } from '../contracts/scan'
import type { BlastRadiusReport, IBlastRadiusAnalyzer, RiskLevel } from '../contracts/blast-radius.contract'
import { dirSize } from '../infra/fs-utils'

export interface BlastRadiusOptions {
  readonly dshHome: string
  /** 单插件风险上限保护：broken 计分到 4 个即封顶 100 */
  readonly analyzer: IDependencyAnalyzer
}

export function createBlastRadiusAnalyzer(options: BlastRadiusOptions): IBlastRadiusAnalyzer {
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

        const report: BlastRadiusReport = {
          targets: plugins,
          cascadeRemovable: cascade as PluginName[],
          brokenDependents: broken as PluginName[],
          configRefs: [...refSet] as AbsolutePath[],
          estimatedBytesReclaimable: bytes,
          riskScore,
          riskLevel,
          advisories,
        }
        return ok(report)
      } catch (e) {
        return err(ioError('爆炸半径仿真失败', e))
      }
    },
  }
}

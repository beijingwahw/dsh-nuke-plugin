// contracts/scan.ts — 子系统三：全局感知与依赖分析
// 三大能力：
//  1. IResidualScanner  流式残留扫描（AsyncIterable，支持进度与取消）
//  2. IDependencyAnalyzer  依赖图（package.json 依赖 + patch 引用，递归传递闭包）
//  3. IOrphanDetector  全局孤儿：全 profile 引用集合 vs 磁盘实存 + TEMP

import type {
  AbsolutePath, CleanStrategy, PluginName, ProfileName, Result,
} from './base'
import type { ResidualEvidence } from './scoring'

// ─── 残留扫描 ─────────────────────────────────────────────
export interface ScanRequest {
  /** 目标插件：缺省 = 全 profile 全插件（全局模式） */
  readonly plugin?: PluginName
  readonly profile?: ProfileName
  readonly strategy: CleanStrategy   // aggressive 才纳入 temp/unknown 类
  readonly includeTemp: boolean
  readonly signal?: AbortSignal
}

export type ScanEvent =
  | { readonly type: 'progress'; readonly scannedPaths: number; readonly currentRoot: string }
  | { readonly type: 'found'; readonly evidence: ResidualEvidence }
  | { readonly type: 'root-summary'; readonly root: string; readonly bytesScannable: number }
  | { readonly type: 'done'; readonly totalFound: number; readonly bytesReclaimable: number }

export interface IResidualScanner {
  /** 流式产出：UI 实时渲染进度条与逐条结果；取消经 AbortSignal */
  scan(request: ScanRequest): AsyncIterable<ScanEvent>
}

// ─── 依赖分析 ─────────────────────────────────────────────
export interface PluginNode {
  readonly name: PluginName
  readonly declaredIn: readonly AbsolutePath[]   // 声明处（各 profile package.json）
  readonly patchRefs: readonly AbsolutePath[]    // patch yaml 中被引用的位置
}

export interface DependencyEdge {
  readonly from: PluginName   // 依赖方
  readonly to: PluginName     // 被依赖
  readonly kind: 'dependencies' | 'peerDependencies' | 'optionalDependencies' | 'patch-ref'
  readonly declaredIn: AbsolutePath
}

export interface DependencyGraph {
  readonly nodes: ReadonlyMap<PluginName, PluginNode>
  readonly edges: readonly DependencyEdge[]
  /** 直接 + 传递依赖方（闭包），删除前 must-check */
  dependentsOf(name: PluginName): readonly PluginName[]
  dependenciesOf(name: PluginName): readonly PluginName[]
  hasCycle(): boolean
  cycles(): readonly PluginName[][]   // 环检测报告
}

export interface IDependencyAnalyzer {
  /** 构建全量图：跨所有 profile 的 package.json + cordis.patch.yml */
  buildGraph(profile?: ProfileName): Promise<Result<DependencyGraph>>
  /** 便捷查询：是否存在会被本次删除波及的插件 */
  blockersOf(plugins: readonly PluginName[]): Promise<Result<readonly {
    plugin: PluginName
    blockedBy: readonly PluginName[]
    reason: string
  }[]>>
}

// ─── 全局孤儿检测 ─────────────────────────────────────────
export interface OrphanReport {
  /** 磁盘存在但全 profile 引用集合中不存在的插件目录 */
  readonly orphanPluginDirs: readonly { path: AbsolutePath; sizeBytes: number }[]
  /** storages/attachments 中无主目录 */
  readonly orphanDataDirs: readonly { path: AbsolutePath; sizeBytes: number }[]
  /** TEMP 中疑似 dsh 的过期条目（>ttl 天） */
  readonly tempOrphans: readonly { path: AbsolutePath; sizeBytes: number; ageDays: number }[]
  readonly totalReclaimableBytes: number
}

export interface IOrphanDetector {
  detect(options: {
    tempMaxAgeDays: number
    signal?: AbortSignal
  }): Promise<Result<OrphanReport>>
}

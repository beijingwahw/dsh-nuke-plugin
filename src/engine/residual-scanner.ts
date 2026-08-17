// src/engine/residual-scanner.ts — IResidualScanner 实现：流式残留扫描
// AsyncIterable 事件流：progress / found / root-summary / done。
// 取消：每处理一个根目录检查一次 AbortSignal；触发即停止并补发 done。
// 增量模式：注入 IScanCache 后，checkpoint 结果按 mtime+size 指纹复用 ——
// 二次扫描跳过 contains 全文读取与 dirSize 递归（最贵的两类 IO）。
import * as fs from 'fs'
import * as path from 'path'
import type { AbsolutePath, PluginName, ProfileName } from '../contracts/base'
import type {
  IResidualScanner, ScanEvent, ScanRequest,
} from '../contracts/scan'
import type { ResidualEvidence, ResidualKind } from '../contracts/scoring'
import { dirSize, tempOrphanEntries } from '../infra/fs-utils'
import type { IScanCache } from '../infra/scan-cache'

export interface ResidualScannerOptions {
  readonly dshHome: string
  readonly tempRoot: string
  /** plugin name → 引用它的插件列表（由 DependencyAnalyzer 预先构建）；缺省空 = 全按孤儿处理 */
  readonly referenceIndex?: ReadonlyMap<string, readonly PluginName[]>
  /** 增量扫描缓存（强烈建议注入）：命中则零 IO 复用，未注入则每次全量计算 */
  readonly scanCache?: IScanCache
  readonly now?: () => Date
}

const TEMP_MARKER_RE = /dsh|deepseek|cordis/i

export function createResidualScanner(options: ResidualScannerOptions): IResidualScanner {
  const now = options.now ?? (() => new Date())
  const cache = options.scanCache

  function referencedBy(plugin: string): readonly PluginName[] {
    return options.referenceIndex?.get(plugin) ?? []
  }

  function makeEvidence(partial: {
    location: string; kind: ResidualKind; description: string
    sizeBytes: number; plugin: string
    suggestedAction: ResidualEvidence['suggestedAction']
    /** 主循环那次 stat 的 atime（复用，避免第二次 stat） */
    atime: Date | null
  }): ResidualEvidence {
    return {
      location: partial.location as AbsolutePath,
      kind: partial.kind,
      description: partial.description,
      sizeBytes: partial.sizeBytes,
      lastAccessedAt: partial.atime,
      referencedBy: referencedBy(partial.plugin),
      suggestedAction: partial.suggestedAction,
    }
  }

  /** 单插件 × 单 profile 的全部检查点 */
  function* checkPoints(plugin: string, profile: ProfileName) {
    const profileDir = path.join(options.dshHome, 'profiles', profile)
    yield {
      kind: 'config-ref' as ResidualKind, location: path.join(profileDir, 'pnpm-workspace.yaml'),
      description: `pnpm-workspace.yaml 中仍引用 ${plugin}`,
      isFile: true, contains: plugin, action: 'clean-workspace-yaml' as const,
    }
    yield {
      kind: 'config-ref' as ResidualKind, location: path.join(profileDir, 'cordis.patch.yml'),
      description: `profile patch 中仍引用 ${plugin}`,
      isFile: true, contains: plugin, action: 'clean-profile-patch' as const,
    }
    yield {
      kind: 'config-ref' as ResidualKind, location: path.join(options.dshHome, 'cordis.patch.yml'),
      description: `home patch 中仍引用 ${plugin}`,
      isFile: true, contains: plugin, action: 'clean-home-patch' as const,
    }
    yield {
      kind: 'node-modules' as ResidualKind, location: path.join(profileDir, 'node_modules', ...plugin.split('/')),
      description: `node_modules 包目录: ${plugin}`, isFile: false, action: 'remove-node-modules' as const,
    }
    yield {
      kind: 'storage' as ResidualKind, location: path.join(options.dshHome, 'storages', plugin),
      description: `storages 持久化数据: ${plugin}`, isFile: false, action: 'remove-storages' as const,
    }
    yield {
      kind: 'attachment' as ResidualKind, location: path.join(options.dshHome, 'attachments', 'v1', plugin),
      description: `attachments 会话附件: ${plugin}`, isFile: false, action: 'remove-attachments' as const,
    }
  }

  function listProfiles(): ProfileName[] {
    const dir = path.join(options.dshHome, 'profiles')
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name as ProfileName)
    } catch { return [] }
  }

  /** TEMP 孤儿（aggressive 专属）：共享实现（fs-utils.tempOrphanEntries） */
  const tempEntries = (maxAgeDays: number) =>
    tempOrphanEntries(options.tempRoot, maxAgeDays, now, TEMP_MARKER_RE)
      .map(e => ({ entry: e.path, size: e.sizeBytes, ageDays: e.ageDays }))

  async function* scan(request: ScanRequest): AsyncGenerator<ScanEvent> {
    let scannedPaths = 0
    let totalFound = 0
    let bytesReclaimable = 0
    const cancelled = () => request.signal?.aborted ?? false

    const profiles = request.profile ? [request.profile] : listProfiles()

    for (const profile of profiles) {
      if (cancelled()) break

      // 扫描目标集合：指定 plugin → 仅它；否则 = profile 依赖并集（全局模式）
      let plugins: string[]
      if (request.plugin) {
        plugins = [request.plugin]
      } else {
        plugins = globalPluginSet(profile)
      }

      for (const plugin of plugins) {
        if (cancelled()) break
        for (const cp of checkPoints(plugin, profile)) {
          if (cancelled()) break
          scannedPaths++
          yield { type: 'progress', scannedPaths, currentRoot: path.dirname(cp.location) }

          // 单次 stat 同时完成：存在性 + 体积 + atime + 缓存指纹校验
          let stat: fs.Stats | null = null
          try { stat = fs.statSync(cp.location) } catch {}
          if (stat === null) continue

          // 增量缓存命中判定：指纹（mtime+size）匹配才有资格复用
          const cached = cache?.get(cp.location, stat.mtimeMs, stat.size) ?? null

          // contains 检查：缓存命中直接用 containsHit；miss 才读全文并回写
          let containsHit = true
          if (cp.isFile && cp.contains !== undefined) {
            if (cached?.containsHit !== undefined) {
              containsHit = cached.containsHit
            } else {
              let content = ''
              try { content = fs.readFileSync(cp.location, 'utf-8') } catch {}
              containsHit = content.includes(cp.contains)
              cache?.set(cp.location, {
                mtimeMs: stat.mtimeMs, size: stat.size, containsHit,
              })
            }
            if (!containsHit) continue
          }

          // 体积：文件用 stat.size；目录优先复用缓存 dirBytes，miss 才递归并回写
          let size: number
          if (cp.isFile) {
            size = stat.size
          } else if (cached?.dirBytes !== undefined) {
            size = cached.dirBytes
          } else {
            size = dirSize(cp.location)
            cache?.set(cp.location, {
              mtimeMs: stat.mtimeMs, size: stat.size, dirBytes: size,
            })
          }

          bytesReclaimable += size
          totalFound++
          yield {
            type: 'found',
            evidence: makeEvidence({
              location: cp.location, kind: cp.kind, description: cp.description,
              sizeBytes: size, plugin, suggestedAction: cp.action,
              atime: stat.atime,
            }),
          }
        }
      }

      if (cancelled()) break
      const pd = path.join(options.dshHome, 'profiles', profile)
      yield {
        type: 'root-summary', root: pd,
        bytesScannable: dirSize(pd),
      }
    }

    // TEMP 孤儿：仅 aggressive + includeTemp 时纳入
    if (!cancelled() && request.includeTemp && request.strategy === 'aggressive') {
      for (const t of tempEntries(7)) {
        if (cancelled()) break
        scannedPaths++
        totalFound++
        bytesReclaimable += t.size
        // TEMP 条目一次性消费，无缓存价值；atime 不参与证据（ageDays 已含时间信息）
        yield {
          type: 'found',
          evidence: makeEvidence({
            location: t.entry, kind: 'temp-orphan',
            description: `TEMP 中 ${t.ageDays.toFixed(1)} 天未动的 dsh 残留`,
            sizeBytes: t.size, plugin: path.basename(t.entry),
            suggestedAction: 'purge-temp',
            atime: null,
          }),
        }
      }
      yield { type: 'root-summary', root: options.tempRoot, bytesScannable: dirSize(options.tempRoot) }
    }

    // 扫描收尾：增量缓存落盘（原子写；无变更零 IO）
    cache?.flush()
    yield { type: 'done', totalFound, bytesReclaimable }
  }

  /** 全局模式：profile package.json 依赖 + storages/attachments 目录名 并集 */
  function globalPluginSet(profile: ProfileName): string[] {
    const set = new Set<string>()
    const pkgPath = path.join(options.dshHome, 'profiles', profile, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, any>
      for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[k] ?? {})) set.add(name)
      }
      for (const b of pkg?.dsh?.profile?.bundles ?? []) set.add(b)
    } catch {}
    for (const root of [path.join(options.dshHome, 'storages'), path.join(options.dshHome, 'attachments', 'v1')]) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (e.isDirectory()) set.add(e.name)
        }
      } catch {}
    }
    set.delete('@deepseek-ai/dsh-base')
    return [...set]
  }

  return { scan }
}

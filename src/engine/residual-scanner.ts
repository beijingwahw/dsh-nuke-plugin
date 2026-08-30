// src/engine/residual-scanner.ts — IResidualScanner 实现：流式残留扫描
// AsyncIterable 事件流：progress / found / root-summary / done。
// 取消：每处理一个根目录检查一次 AbortSignal；触发即停止并补发 done。
// 增量模式：注入 IScanCache 后，checkpoint 结果按 mtime+size 指纹复用 ——
// 二次扫描跳过 contains 全文读取与 dirSize 递归（最贵的两类 IO）。
//
// 本轮升级（infra walk 迁移 + 进度事件限频）：
//   1. 目录体积全部迁移到 dirSizeAsync（统一遍历原语 walk 的流式实现）：
//      数值语义与旧 dirSize 逐位一致（symlink 计 0 / 读不到按 0 / 深度 64），
//      但体积计算中途可被 AbortSignal 立即中止 —— 旧同步递归一旦进入就
//      无法打断，取消后仍要跑完整棵树。
//   2. progress 事件限频：全局模式（N 插件 × 6 检查点）下逐路径 progress
//      是事件洪泛，会淹没 UI/IPC 通道。默认 100ms 窗口内合并 —— 窗口内
//      只发最后一个计数（scannedPaths 字段语义不变，事件变少而已）；
//      首事件必发；另有数量保底（每 1000 路径强制一发）防时钟停滞时
//      进度永久静默。progressIntervalMs=0 关闭限频（旧逐路径行为）。
//      found/root-summary/done 低频高价值，不受限频影响。
import * as fs from 'fs'
import * as path from 'path'

import type { AbsolutePath, PluginName, ProfileName } from '../contracts/base'
import type {
  IResidualScanner, ScanEvent, ScanRequest,
} from '../contracts/scan'
import type { ResidualEvidence, ResidualKind } from '../contracts/scoring'
import { dirSizeAsync, tempOrphanEntries } from '../infra/fs-utils'
import type { IScanCache } from '../infra/scan-cache'

export interface ResidualScannerOptions {
  readonly dshHome: string
  readonly tempRoot: string
  /** plugin name → 引用它的插件列表（由 DependencyAnalyzer 预先构建）；缺省空 = 全按孤儿处理 */
  readonly referenceIndex?: ReadonlyMap<string, readonly PluginName[]>
  /** 增量扫描缓存（强烈建议注入）：命中则零 IO 复用，未注入则每次全量计算 */
  readonly scanCache?: IScanCache
  readonly now?: () => Date
  /** progress 事件限频窗口（ms）：窗口内的事件合并为最后一个计数，默认 100；
   *  0 = 关闭限频（逐路径事件，旧行为）。首事件必发；时钟停滞时每
   *  PROGRESS_HARD_GAP 个路径强制发一次（进度永不永久静默） */
  readonly progressIntervalMs?: number
}

const TEMP_MARKER_RE = /dsh|deepseek|cordis/i

/** 数量保底：即使时钟完全停滞，积压这么多路径也强制发一次 progress */
const PROGRESS_HARD_GAP = 1000

/** JSON 值的安全对象视图：null / 非对象 → null（窄化辅助，不改变运行时取值） */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : null
}

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

  /** pnpm 虚拟存储目录名匹配：plugin → .pnpm 下的实体目录名前缀。
   *  普通包 `plugin@1.2.3`；scoped 包 `@scope+plugin@1.2.3`（`/`→`+`）；
   *  peer/完整性后缀（`(peer@..)`/`(sha512:..)`）跟在版本后，前缀匹配覆盖 */
  function pnpmStorePrefix(plugin: string): string {
    return plugin.startsWith('@') ? plugin.replace('/', '+') + '@' : plugin + '@'
  }

  function* checkPoints(plugin: string, profile: ProfileName) {
    const profileDir = path.join(options.dshHome, 'profiles', profile)
    // 悬空声明（V5.8.9 实测发现）：dependencies/bundles 已声明但
    // node_modules 缺失（--skip-standard 卸载 / pnpm remove 中途中断）。
    // 危害：下次任意 pnpm install 会自动重装该插件 ——「删除后复活」。
    // 判据必须含 node_modules 缺失：全局模式下插件集本身取自
    // package.json，无条件检查会把每个正常安装的插件都误报成残留。
    const pkgPath = path.join(profileDir, 'package.json')
    yield {
      kind: 'config-ref' as ResidualKind, location: pkgPath,
      description: `package.json 悬空声明: ${plugin}（已声明未安装，下次 install 将复活）`,
      isFile: true, action: 'clean-package-json' as const,
      predicate: (): boolean => {
        if (fs.existsSync(path.join(profileDir, 'node_modules', ...plugin.split('/')))) return false
        try {
          const pkg = asRecord(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as unknown)
          if (plugin in (asRecord(pkg?.dependencies) ?? {})) return true
          const bundles = asRecord(asRecord(pkg?.dsh)?.profile)?.bundles
          return Array.isArray(bundles) && (bundles as unknown[]).includes(plugin)
        } catch { return false }
      },
    }
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
    // V5.9.0 pnpm 虚拟存储残留（实测发现）：remove-node-modules 只删了
    // node_modules/<plugin> 链接层，实体全在 .pnpm/<plugin>@<ver>/ 下 ——
    // 这是卸载后最大的空间残留（pnpm store prune 也不回收：store 侧硬链接
    // 计数未清零）。判据：链接层已不存在才算残留，正常安装不误报。
    // scoped 包名 `/`→`+` 转义见 pnpmStorePrefix。
    const nmLink = path.join(profileDir, 'node_modules', ...plugin.split('/'))
    if (!fs.existsSync(nmLink)) {
      const pnpmDir = path.join(profileDir, 'node_modules', '.pnpm')
      let entries: string[] = []
      try { entries = fs.readdirSync(pnpmDir) } catch {}
      const prefix = pnpmStorePrefix(plugin)
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue
        yield {
          kind: 'node-modules' as ResidualKind,
          location: path.join(pnpmDir, entry),
          description: `pnpm 虚拟存储实体: ${entry}`,
          isFile: false, action: 'remove-pnpm-store' as const,
        }
      }
    }
    yield {
      kind: 'storage' as ResidualKind, location: path.join(options.dshHome, 'storages', plugin),
      description: `storages 持久化数据: ${plugin}`, isFile: false, action: 'remove-storages' as const,
    }
    yield {
      kind: 'attachment' as ResidualKind, location: path.join(options.dshHome, 'attachments', 'v1', plugin),
      description: `attachments 会话附件: ${plugin}`, isFile: false, action: 'remove-attachments' as const,
    }
    // V5.9.0 lockfile 残留（report-only）：importer dependencies 与 packages
    // 段的插件条目在卸载后仍留存。手改 lockfile 会破坏 integrity →
    // 只报告，由下次 pnpm install 自动重新解析收敛
    yield {
      kind: 'lockfile' as ResidualKind, location: path.join(profileDir, 'pnpm-lock.yaml'),
      description: `pnpm-lock.yaml 中仍引用 ${plugin}（仅报告，下次 install 自动收敛）`,
      isFile: true, contains: plugin, action: 'report-only' as const,
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
    const intervalMs = options.progressIntervalMs ?? 100

    // 限频状态：上次发射时刻（-∞ 保证首事件必发）与发射时的路径计数。
    // 窗口内的事件被合并 —— scannedPaths 字段始终携带最新真实计数
    const lastEmit = { atMs: Number.NEGATIVE_INFINITY, count: 0 }
    const progressDue = (): boolean => {
      if (intervalMs <= 0) return true
      return now().getTime() - lastEmit.atMs >= intervalMs
        || scannedPaths - lastEmit.count >= PROGRESS_HARD_GAP
    }
    const markEmitted = () => {
      lastEmit.atMs = now().getTime()
      lastEmit.count = scannedPaths
    }

    // dirSizeAsync 选项：signal 存在才透传（exactOptionalPropertyTypes）。
    // 体积计算中途 abort → walk 立即停止，不再跑完整棵树
    const walkOpts = request.signal !== undefined
      ? { signal: request.signal }
      : {}

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
          if (progressDue()) {
            markEmitted()
            yield { type: 'progress', scannedPaths, currentRoot: path.dirname(cp.location) }
          }

          // 单次 stat 同时完成：存在性 + 体积 + atime + 缓存指纹校验
          let stat: fs.Stats | null = null
          try { stat = fs.statSync(cp.location) } catch {}
          if (stat === null) continue

          // predicate 检查点（如悬空声明）：命中判定依赖外部状态
          // （node_modules 存在性），contains 缓存语义不适用 —— 每次实判
          if (cp.predicate !== undefined && !cp.predicate()) continue

          // 增量缓存命中判定：指纹（mtime+size）匹配才有资格复用
          const cached = cache?.get(cp.location, stat.mtimeMs, stat.size) ?? null

          // contains 检查：缓存命中直接用 containsHit；miss 才读全文并回写
          let containsHit: boolean
          if (cp.predicate === undefined && cp.isFile && cp.contains !== undefined) {
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
            size = await dirSizeAsync(cp.location, walkOpts)
            cache?.set(cp.location, {
              mtimeMs: stat.mtimeMs, size: stat.size, dirBytes: size,
            })
          }
          // V5.9.0 report-only 残留（lockfile）：不删不编辑 → 可回收恒 0。
          // 通用路径给的是文件体积，覆盖之，避免 bytesReclaimable 虚报
          if (cp.action === 'report-only') size = 0

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
        bytesScannable: await dirSizeAsync(pd, walkOpts),
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
      yield { type: 'root-summary', root: options.tempRoot, bytesScannable: await dirSizeAsync(options.tempRoot, walkOpts) }
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
      const pkg = asRecord(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as unknown)
      for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const sec = asRecord(pkg?.[k])
        if (sec !== null) for (const name of Object.keys(sec)) set.add(name)
      }
      const bundles = asRecord(asRecord(pkg?.dsh)?.profile)?.bundles ?? []
      for (const b of bundles as string[]) set.add(b)
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

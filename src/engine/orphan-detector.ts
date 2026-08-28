// src/engine/orphan-detector.ts — IOrphanDetector 实现：全局孤儿检测
// 三类孤儿：
//   1. orphanPluginDirs  node_modules 中存在、但所有 profile 声明集合中都没有的包
//   2. orphanDataDirs    storages/attachments 中无主目录（不被任何 profile 声明/patch 引用）
//   3. tempOrphans       TEMP 中带 dsh 痕迹且超过 ttl 的条目
// V5：多 profile 检测并行化（forEachPool 有界并发 + 异步 IO），
//     各 profile 的引用收集与 node_modules 清点互不阻塞；
//     输出按 profile 名稳定排序拼接（与 profile 发现顺序解耦）。
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import type { AbsolutePath, NukeError, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { IOrphanDetector, OrphanReport } from '../contracts/scan'
import { DEFAULT_IO_CONCURRENCY, dirSizeAsync, forEachPool, tempOrphanEntries } from '../infra/fs-utils'

export interface OrphanDetectorOptions {
  readonly dshHome: string
  readonly tempRoot: string
  readonly now?: () => Date
}

const TEMP_MARKER_RE = /dsh|deepseek|cordis/i
const PROTECTED = new Set(['@deepseek-ai/dsh-base', '.pnpm', '.bin', '.modules.yaml', 'node_modules'])

export function createOrphanDetector(options: OrphanDetectorOptions): IOrphanDetector {
  const now = options.now ?? (() => new Date())

  function listProfiles(): string[] {
    try {
      return fs
        .readdirSync(path.join(options.dshHome, 'profiles'), { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b))   // V5：稳定输出序（与目录发现顺序解耦）
    } catch { return [] }
  }

  /** patch yml 中出现的包 id（直接读文本，避免 yaml 解析依赖） */
  async function readPatchIds(patchFile: string): Promise<string[]> {
    try {
      const text = await fsp.readFile(patchFile, 'utf-8')
      const ids: string[] = []
      for (const m of text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)) ids.push(m[1]!)
      return ids
    } catch { return [] }
  }

  /** V5：单 profile 的引用集合 + node_modules 一级条目（全异步 IO，供并发池分发）。
   *  任何读取失败都按空结果降级（与旧串行实现的 fail-soft 语义一致）。 */
  async function collectProfile(profile: string): Promise<{
    refs: string[]
    installed: { name: string; dir: string }[]
  }> {
    const refs: string[] = []
    const installed: { name: string; dir: string }[] = []
    const profileDir = path.join(options.dshHome, 'profiles', profile)

    // package.json 依赖 + bundles
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf-8')) as Record<string, any>
      for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[k] ?? {})) refs.push(name)
      }
      for (const b of pkg?.dsh?.profile?.bundles ?? []) refs.push(b)
    } catch { /* 读不到/解析失败 → 该 profile 无声明引用 */ }
    // profile 级 patch 引用
    for (const id of await readPatchIds(path.join(profileDir, 'cordis.patch.yml'))) refs.push(id)

    // node_modules 一级条目（含 @scope 两段、.pnpm 展开到实际包名）
    const nm = path.join(profileDir, 'node_modules')
    let top: fs.Dirent[]
    try { top = await fsp.readdir(nm, { withFileTypes: true }) } catch { return { refs, installed } }
    for (const e of top) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      if (e.name.startsWith('@')) {
        try {
          for (const sub of await fsp.readdir(path.join(nm, e.name), { withFileTypes: true })) {
            if (sub.isDirectory()) installed.push({ name: `${e.name}/${sub.name}`, dir: path.join(nm, e.name, sub.name) })
          }
        } catch { /* scope 目录读取失败 → 跳过该 scope */ }
      } else if (e.isDirectory()) {
        installed.push({ name: e.name, dir: path.join(nm, e.name) })
      }
    }
    return { refs, installed }
  }

  return {
    async detect(opts: { tempMaxAgeDays: number; signal?: AbortSignal }): Promise<Result<OrphanReport, NukeError>> {
      try {
        const signal = opts.signal

        // V5：多 profile 检测并行化 —— 引用收集与 node_modules 清点经并发池
        // 分发到各 profile（有界并发，IO 互不阻塞）；home 级 patch 单独读一次。
        // forEachPool 结果槽按输入索引填充 + 输入已按 profile 名排序 → 输出稳定。
        const profiles = listProfiles()
        const [homePatchIds, perProfile] = await Promise.all([
          readPatchIds(path.join(options.dshHome, 'cordis.patch.yml')),
          forEachPool(profiles, DEFAULT_IO_CONCURRENCY, p => collectProfile(p)),
        ])
        const refs = new Set<string>(homePatchIds)
        const installed: { name: string; dir: string }[] = []
        for (const r of perProfile) {
          if (r.status !== 'fulfilled') continue   // 单 profile 异常不炸整批（fail-soft）
          for (const x of r.value.refs) refs.add(x)
          installed.push(...r.value.installed)
        }

        // 1) node_modules 孤儿（体积统计经并发池分发——串行 dirSize 是本函数的主要成本）
        const candidates = installed
          .filter(pkg =>
            !refs.has(pkg.name) && !PROTECTED.has(pkg.name) && !pkg.name.startsWith('@deepseek-ai/'))
        if (signal?.aborted) return err({ code: 'E_CANCELLED', message: '孤儿检测被取消' })
        const orphanPluginDirs: { path: AbsolutePath; sizeBytes: number }[] = []
        const sized1 = await forEachPool(candidates, DEFAULT_IO_CONCURRENCY,
          async pkg => ({
            path: pkg.dir as AbsolutePath,
            sizeBytes: await dirSizeAsync(pkg.dir, { ...(signal ? { signal } : {}) }),
          }))
        for (const r of sized1) if (r.status === 'fulfilled') orphanPluginDirs.push(r.value)
        orphanPluginDirs.sort((a, b) => b.sizeBytes - a.sizeBytes)

        // 2) storages / attachments 无主目录（并发池统计体积）
        const dataCandidates: string[] = []
        for (const root of [path.join(options.dshHome, 'storages'), path.join(options.dshHome, 'attachments', 'v1')]) {
          let entries: fs.Dirent[]
          try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
          for (const e of entries) {
            if (!e.isDirectory() || refs.has(e.name)) continue
            dataCandidates.push(path.join(root, e.name))
          }
        }
        if (signal?.aborted) return err({ code: 'E_CANCELLED', message: '孤儿检测被取消' })
        const orphanDataDirs: { path: AbsolutePath; sizeBytes: number }[] = []
        const sized2 = await forEachPool(dataCandidates, DEFAULT_IO_CONCURRENCY,
          async d => ({
            path: d as AbsolutePath,
            sizeBytes: await dirSizeAsync(d, { ...(signal ? { signal } : {}) }),
          }))
        for (const r of sized2) if (r.status === 'fulfilled') orphanDataDirs.push(r.value)
        orphanDataDirs.sort((a, b) => b.sizeBytes - a.sizeBytes)

        // 3) TEMP 孤儿（共享实现 fs-utils.tempOrphanEntries：标记 + 期限 + 体积 + 符号链接排除）
        if (signal?.aborted) return err({ code: 'E_CANCELLED', message: '孤儿检测被取消' })
        const tempOrphans: { path: AbsolutePath; sizeBytes: number; ageDays: number }[] =
          tempOrphanEntries(options.tempRoot, opts.tempMaxAgeDays, now, TEMP_MARKER_RE)
            .map(e => ({ path: e.path as AbsolutePath, sizeBytes: e.sizeBytes, ageDays: e.ageDays }))

        const totalReclaimableBytes =
          orphanPluginDirs.reduce((s, d) => s + d.sizeBytes, 0) +
          orphanDataDirs.reduce((s, d) => s + d.sizeBytes, 0) +
          tempOrphans.reduce((s, d) => s + d.sizeBytes, 0)

        return ok({ orphanPluginDirs, orphanDataDirs, tempOrphans, totalReclaimableBytes })
      } catch (e) {
        return err(ioError('孤儿检测失败', e))
      }
    },
  }
}

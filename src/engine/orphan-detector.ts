// src/engine/orphan-detector.ts — IOrphanDetector 实现：全局孤儿检测
// 三类孤儿：
//   1. orphanPluginDirs  node_modules 中存在、但所有 profile 声明集合中都没有的包
//   2. orphanDataDirs    storages/attachments 中无主目录（不被任何 profile 声明/patch 引用）
//   3. tempOrphans       TEMP 中带 dsh 痕迹且超过 ttl 的条目
import * as fs from 'fs'
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
    } catch { return [] }
  }

  /** 全 profile 引用集合：package.json 依赖 + bundles + patch yml 中出现的 id */
  function referencedNames(): Set<string> {
    const refs = new Set<string>()
    const collectPkg = (pkgPath: string) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, any>
        for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const name of Object.keys(pkg[k] ?? {})) refs.add(name)
        }
        for (const b of pkg?.dsh?.profile?.bundles ?? []) refs.add(b)
      } catch {}
    }
    for (const profile of listProfiles()) {
      const profileDir = path.join(options.dshHome, 'profiles', profile)
      collectPkg(path.join(profileDir, 'package.json'))
      // patch 引用：直接读文本，把 id: xxx 收进集合（避免 yaml 依赖循环）
      for (const pf of [path.join(options.dshHome, 'cordis.patch.yml'), path.join(profileDir, 'cordis.patch.yml')]) {
        try {
          const text = fs.readFileSync(pf, 'utf-8')
          for (const m of text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)) refs.add(m[1]!)
        } catch {}
      }
    }
    return refs
  }

  /** node_modules 一级条目名（含 @scope 两段、.pnpm 展开到实际包名） */
  function installedPackages(): { name: string; dir: string }[] {
    const out: { name: string; dir: string }[] = []
    for (const profile of listProfiles()) {
      const nm = path.join(options.dshHome, 'profiles', profile, 'node_modules')
      let top: fs.Dirent[]
      try { top = fs.readdirSync(nm, { withFileTypes: true }) } catch { continue }
      for (const e of top) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        if (e.name.startsWith('@')) {
          try {
            for (const sub of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
              if (sub.isDirectory()) out.push({ name: `${e.name}/${sub.name}`, dir: path.join(nm, e.name, sub.name) })
            }
          } catch {}
        } else if (e.isDirectory()) {
          out.push({ name: e.name, dir: path.join(nm, e.name) })
        }
      }
    }
    return out
  }

  return {
    async detect(opts: { tempMaxAgeDays: number; signal?: AbortSignal }): Promise<Result<OrphanReport, NukeError>> {
      try {
        const refs = referencedNames()
        const signal = opts.signal

        // 1) node_modules 孤儿（体积统计经并发池分发——串行 dirSize 是本函数的主要成本）
        const candidates = installedPackages()
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

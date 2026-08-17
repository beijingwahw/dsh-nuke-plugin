// src/engine/restore-point.ts — IRestorePointManager 实现：配置还原点
// 快照范围：home 级 + profile 级的关键配置文件（存在才快照，缺失跳过）。
// 安全属性：
//   1. 原子写：所有落盘走 tmp + rename，进程中断不留半写文件
//   2. 零配置点拒绝：一个文件都找不到 → E_VALIDATION（profile 疑似不存在）
//   3. 恢复同样原子：逐文件 tmp + rename 写回原位
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { AbsolutePath } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import { copyAtomic, writeJsonAtomic } from '../infra/fs-utils'
import type { IRestorePointManager, RestorePointFile, RestorePointMeta } from '../contracts/restore-point.contract'

export interface RestorePointOptions {
  readonly dshHome: string
  /** 还原点根目录，通常 <dshHome>/.nuke/restore-points */
  readonly nukeRoot: string
  readonly now?: () => Date
}

/** home 级关键配置（不含 profile 子目录） */
const HOME_FILES = ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml'] as const
/** profile 级关键配置（多一个 lockfile：依赖状态也是可恢复资产） */
const PROFILE_FILES = ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'pnpm-lock.yaml'] as const

export function createRestorePointManager(options: RestorePointOptions): IRestorePointManager {
  const now = options.now ?? (() => new Date())
  const rootDir = path.join(options.nukeRoot, 'restore-points')

  function metaPath(id: string): string {
    // id 白名单校验：只允许 rp- 时间戳-十六进制格式，杜绝路径穿越
    if (!/^rp-[0-9TZ -]+-[0-9a-f]+$/i.test(id)) return ''
    return path.join(rootDir, id, 'meta.json')
  }

  /** 子路径是否严格位于 parent 之内（防 meta 篡改后的任意路径读写） */
  function within(parent: string, child: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  function readMeta(id: string): RestorePointMeta | null {
    const p = metaPath(id)
    if (!p) return null
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf-8')) as RestorePointMeta
      // 防篡改三重闸：meta.id 必须与目录名一致（堵 prune 逃逸）；
      // 结构字段必须存在；files 数组内 source/snapshot 必须是字符串。
      if (m.id !== id) return null
      if (typeof m.createdAt !== 'string' || typeof m.actor !== 'string') return null
      if (!Array.isArray(m.files)) return null
      for (const f of m.files) {
        if (typeof f?.source !== 'string' || typeof f?.snapshot !== 'string') return null
      }
      return m
    } catch { return null }
  }

  return {
    async create(input) {
      try {
        // profile 是路径段：白名单校验，杜绝 "profiles/../../.." 式拼接
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.profile)) {
          return err({ code: 'E_VALIDATION', message: `profile 名非法: ${input.profile}` })
        }
        const ts = now().toISOString().replace(/[:.]/g, '')
        const id = `rp-${ts}-${crypto.randomBytes(4).toString('hex')}`
        const dir = path.join(rootDir, id)
        fs.mkdirSync(dir, { recursive: true })

        const files: RestorePointFile[] = []
        const trySnap = (source: string, rel: string) => {
          if (!fs.existsSync(source)) return
          try {
            const snapshot = path.join(dir, rel)
            const bytes = copyAtomic(source, snapshot)
            files.push({ source: source as AbsolutePath, snapshot: snapshot as AbsolutePath, bytes })
          } catch { /* 单文件失败不阻断整个还原点 */ }
        }

        for (const f of HOME_FILES) {
          trySnap(path.join(options.dshHome, f), path.join('home', f))
        }
        const profileDir = path.join(options.dshHome, 'profiles', input.profile)
        for (const f of PROFILE_FILES) {
          trySnap(path.join(profileDir, f), path.join(`profile-${input.profile}`, f))
        }

        if (files.length === 0) {
          fs.rmSync(dir, { recursive: true, force: true })
          return err({
            code: 'E_VALIDATION',
            message: `无可快照的配置文件（profile "${input.profile}" 不存在？）`,
          })
        }

        const meta: RestorePointMeta = {
          id, createdAt: now().toISOString(), actor: input.actor,
          reason: input.reason, profile: input.profile, files,
        }
        writeJsonAtomic(path.join(dir, 'meta.json'), meta)
        return ok(meta)
      } catch (e) {
        return err(ioError('创建还原点失败', e))
      }
    },

    list() {
      try {
        return fs
          .readdirSync(rootDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => readMeta(e.name))
          .filter((m): m is RestorePointMeta => m !== null)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      } catch { return [] }
    },

    async restore(id) {
      const meta = readMeta(id)
      if (!meta) return err({ code: 'E_VALIDATION', message: `还原点不存在或已损坏: ${id}` })
      // 路径Containment 复验：meta.json 是磁盘上可被篡改的数据，恢复前
      // 强制断言 source 在 dshHome 内、snapshot 在本还原点目录内 —— 堵死
      // "篡改 meta 获得 copyAtomic 任意文件写入原语"的攻击链。
      const rpDir = path.join(rootDir, id)
      for (const f of meta.files) {
        if (!path.isAbsolute(f.source) || !within(options.dshHome, f.source)) {
          return err({
            code: 'E_VALIDATION',
            message: `还原点元数据包含越界路径，拒绝恢复: ${f.source}`,
          })
        }
        if (!within(rpDir, f.snapshot)) {
          return err({
            code: 'E_VALIDATION',
            message: `还原点快照路径越界，拒绝恢复: ${f.snapshot}`,
          })
        }
      }
      try {
        for (const f of meta.files) {
          if (!fs.existsSync(f.snapshot)) continue
          copyAtomic(f.snapshot, f.source)
        }
        return ok(meta)
      } catch (e) {
        return err(ioError('恢复失败（部分文件可能已写回）', e))
      }
    },

    async prune(keep) {
      // keep 下限：0/负数/NaN 会清空全部还原点（安全网本身不容许无确认全删）
      if (!Number.isInteger(keep) || keep < 1) {
        return err({ code: 'E_VALIDATION', message: 'keep 必须为 ≥1 的整数（不允许清空全部还原点）' })
      }
      try {
        const all = this.list()
        const victims = all.slice(keep)
        for (const v of victims) {
          // 用白名单校验过的 id 构造目标；metaPath 返回空串说明 id 被篡改，跳过
          const target = metaPath(v.id)
          if (!target) continue
          fs.rmSync(path.dirname(target), { recursive: true, force: true })
        }
        return ok(victims.length)
      } catch (e) {
        return err(ioError('清理还原点失败', e))
      }
    },
  }
}

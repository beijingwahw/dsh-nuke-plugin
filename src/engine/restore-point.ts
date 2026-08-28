// src/engine/restore-point.ts — IRestorePointManager 实现：配置还原点
// 快照范围：home 级 + profile 级的关键配置文件（存在才快照，缺失跳过）。
// 安全属性：
//   1. 原子写：所有落盘走 tmp + rename，进程中断不留半写文件
//   2. 零配置点拒绝：一个文件都找不到 → E_VALIDATION（profile 疑似不存在）
//   3. 恢复同样原子：逐文件 tmp + rename 写回原位
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { AbsolutePath, NukeError, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import { copyAtomic, writeJsonAtomic } from '../infra/fs-utils'
import type { IRestorePointManager, RestorePointFile, RestorePointMeta } from '../contracts/restore-point.contract'

export interface RestorePointOptions {
  readonly dshHome: string
  /** 还原点根目录，通常 <dshHome>/.nuke/restore-points */
  readonly nukeRoot: string
  readonly now?: () => Date
  /** V5：保留策略上限 —— 还原点数超出时自动淘汰最旧者（缺省不限制）。
   *  无效配置（非整数 / < 1）视为未设置（与 prune 的 keep≥1 安全网同纪律）。
   *  淘汰生效的前提是能拿到事务信息（见 unfinishedTxPaths）。 */
  readonly maxPoints?: number
  /** V5：未终结事务的路径占用查询 —— 返回被任何未终结事务 manifest 引用的
   *  绝对路径（originalPath ∪ backupPath）。返回 null / 未注入 / 抛异常 =
   *  拿不到事务信息 → 保守跳过本轮全部淘汰（宁可多留不可误删）。 */
  readonly unfinishedTxPaths?: () => readonly string[] | null
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

  /** 内容指纹（sha256 前 16 hex，与事务备份的 FileFingerprint 同风格） */
  function digestOf(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16)
  }

  /** 全部还原点（createdAt 降序）；list() 方法与 evictOverflow 共用 */
  function listAll(): RestorePointMeta[] {
    try {
      return fs
        .readdirSync(rootDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => readMeta(e.name))
        .filter((m): m is RestorePointMeta => m !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch { return [] }
  }

  /** V5：保留策略淘汰 —— 超出 maxPoints 时从最旧端逐个淘汰。
   *  安全闸（按序）：
   *    1. maxPoints 无效（非整数 / <1）→ 不生效；
   *    2. 拿不到事务信息（未注入 / 查询抛异常 / 返回 null）→ 本轮全部跳过
   *       （宁可多留不可误删）；
   *    3. 候选还原点目录与任一未终结事务占用路径存在包含关系（任一方向）
   *       → 视为在用，跳过该候选，继续尝试更旧的；
   *    4. id 未过白名单（meta 被篡改）→ 跳过。
   *  返回实际淘汰数。 */
  function evictOverflow(): number {
    const maxPoints = options.maxPoints
    if (typeof maxPoints !== 'number' || !Number.isInteger(maxPoints) || maxPoints < 1) return 0
    let occupiedPaths: readonly string[] | null = null
    if (typeof options.unfinishedTxPaths === 'function') {
      try { occupiedPaths = options.unfinishedTxPaths() } catch { occupiedPaths = null }
    }
    if (occupiedPaths === null) return 0   // 拿不到事务信息：保守跳过全部淘汰
    const occupied = [...occupiedPaths].map(p => path.resolve(p))
    const all = listAll()   // createdAt 降序（最新在前）
    const excess = all.length - maxPoints
    if (excess <= 0) return 0
    let evicted = 0
    // 从最旧端（数组末尾）开始淘汰，跳过在用者
    for (let i = all.length - 1; i >= 0 && evicted < excess; i--) {
      const cand = all[i]!
      const dir = path.resolve(rootDir, cand.id)
      const inUse = occupied.some(p =>
        p === dir || p.startsWith(dir + path.sep) || dir.startsWith(p + path.sep))
      if (inUse) continue
      const target = metaPath(cand.id)
      if (!target) continue
      try { fs.rmSync(path.dirname(target), { recursive: true, force: true }) } catch { continue }
      evicted++
    }
    return evicted
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
        // V5 读回校验（fail-closed）：写入序列化内容 → 立即读回 → hash 比对。
        // 不一致说明磁盘/文件系统在落盘路径上出了问题（坏扇区、注入、序列化
        // 歧义）——这个还原点不可信，宁可当作创建失败也不交付伪快照。
        const metaFile = path.join(dir, 'meta.json')
        const expectedText = JSON.stringify(meta, null, 2)
        writeJsonAtomic(metaFile, meta)
        const abortPoint = (cause: string): Result<never, NukeError> => {
          try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ }
          return err(ioError(cause, new Error('读回内容与写入内容指纹不一致')))
        }
        let readBack: string
        try {
          readBack = fs.readFileSync(metaFile, 'utf-8')
        } catch (e) {
          return err(ioError('还原点读回校验失败（manifest 不可读）', e))
        }
        if (digestOf(readBack) !== digestOf(expectedText)) {
          return abortPoint('还原点读回校验失败（manifest 内容不一致）')
        }
        // V5 保留策略：超上限自动淘汰最旧（内部自带全部安全闸）
        evictOverflow()
        return ok(meta)
      } catch (e) {
        return err(ioError('创建还原点失败', e))
      }
    },

    list() {
      return listAll()
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

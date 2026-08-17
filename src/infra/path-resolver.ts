// src/infra/path-resolver.ts — IPathResolver 实现：跨平台归一 + 删除白名单闸门
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type {
  AbsolutePath, NukeError, ProfileName, Result,
} from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type {
  DeletableRoot, IPathResolver, PathPolicy, PlatformInfo,
} from '../contracts/paths'

export interface ResolverEnv {
  readonly HOME?: string
  readonly USERPROFILE?: string
  readonly APPDATA?: string
  readonly TEMP?: string
  readonly TMPDIR?: string
  readonly DSH_HOME?: string
}

export interface PathResolverOptions {
  readonly env?: ResolverEnv
  readonly platform?: NodeJS.Platform
}

/** 简化 glob → RegExp：支持 * ? **（仅用于 denyGlobs 匹配） */
export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ }
      else re += '[^/\\\\]*'
    } else if (ch === '?') re += '[^/\\\\]'
    else if ('\\^$.|+()[]{}'.includes(ch)) re += '\\' + ch
    else re += ch
  }
  return new RegExp(`^${re}$`, 'i')
}

export function createPathResolver(options: PathResolverOptions = {}): IPathResolver {
  const env = options.env ?? process.env
  const platform = options.platform ?? os.platform()
  const isWin = platform === 'win32'

  const homeAbs = (env.HOME || env.USERPROFILE || os.homedir()) as AbsolutePath
  const tempAbs = (isWin
    ? (env.TEMP || env.APPDATA)
    : (env.TMPDIR || '/tmp')) as AbsolutePath
  const dshHomeAbs = (env.DSH_HOME || path.join(homeAbs, '.dsh')) as AbsolutePath

  const info: PlatformInfo = {
    os: isWin ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
    home: homeAbs,
    tempRoot: tempAbs,
    dshHome: dshHomeAbs,
    pathSep: isWin ? '\\' : '/',
  }

  /** 归一化：win 反斜杠 → /，统一小写比较（win 大小写不敏感） */
  function normalizeForCompare(p: string): string {
    let s = p.replace(/\\/g, '/')
    if (isWin) s = s.toLowerCase()
    return s
  }

  const resolver: IPathResolver = {
    platform() { return info },

    async canonicalize(p: string): Promise<Result<AbsolutePath, NukeError>> {
      try {
        const resolved = path.resolve(p)
        const real = await fs.promises.realpath(resolved).catch(() => resolved)
        return ok(real as AbsolutePath)
      } catch (e) {
        return err(ioError(`路径解析失败: ${p}`, e))
      }
    },

    async isWithin(child: string, root: AbsolutePath): Promise<boolean> {
      // 双方先 canonicalize：symlink 解析后再判归属，防符号链接逃逸
      const c = await resolver.canonicalize(child)
      const r = await resolver.canonicalize(root)
      if (!c.ok || !r.ok) return false
      const cn = normalizeForCompare(c.value)
      const rn = normalizeForCompare(r.value)
      return cn === rn || cn.startsWith(rn + '/')
    },

    async assertDeletable(p: string, policy: PathPolicy): Promise<Result<AbsolutePath, NukeError>> {
      const canon = await resolver.canonicalize(p)
      if (!canon.ok) return canon

      // 1) 拒绝清单优先（尾部段匹配：@deepseek-ai/dsh-base* 命中任意位置的同尾路径）
      for (const glob of policy.denyGlobs) {
        if (matchesGlob(canon.value, glob)) {
          return err({
            code: 'E_PATH_POLICY',
            message: `路径命中拒绝清单 "${glob}": ${canon.value}`,
            details: { path: canon.value, glob },
          })
        }
      }

      // 2) 必须落在任一白名单根内
      for (const root of resolveAllowedRoots(policy.allowedRoots)) {
        if (await resolver.isWithin(canon.value, root)) {
          // 3) 双保险：插件自身状态目录（备份区/日志区）绝不可删
          if (normalizeForCompare(canon.value).startsWith(normalizeForCompare(resolver.nukeStateRoot()))) {
            return err({
              code: 'E_PATH_POLICY',
              message: `禁止删除 nuke 自身状态目录下的路径: ${canon.value}`,
              details: { path: canon.value },
            })
          }
          return ok(canon.value)
        }
      }
      return err({
        code: 'E_PATH_POLICY',
        message: `路径越出删除白名单根: ${canon.value}`,
        details: { path: canon.value, allowedRoots: policy.allowedRoots },
      })
    },

    profileDir(profile: ProfileName): AbsolutePath {
      return path.join(dshHomeAbs, 'profiles', profile) as AbsolutePath
    },
    storagesRoot(): AbsolutePath {
      return path.join(dshHomeAbs, 'storages') as AbsolutePath
    },
    attachmentsRoot(): AbsolutePath {
      return path.join(dshHomeAbs, 'attachments', 'v1') as AbsolutePath
    },
    dshHomePatchFile(): AbsolutePath {
      return path.join(dshHomeAbs, 'cordis.patch.yml') as AbsolutePath
    },
    nukeStateRoot(): AbsolutePath {
      return path.join(dshHomeAbs, '.nuke') as AbsolutePath
    },
  }

  /** denyGlob 匹配：全路径命中，或（多段 glob 时）路径尾部等长段命中，或（单段时）basename 命中 */
  function matchesGlob(canonPath: string, glob: string): boolean {
    const norm = normalizeForCompare(canonPath)
    const re = globToRegex(glob)
    if (re.test(norm)) return true
    const globSegs = glob.split('/').filter(Boolean)
    if (globSegs.length > 1) {
      const tail = norm.split('/').filter(Boolean).slice(-globSegs.length).join('/')
      return re.test(tail)
    }
    const base = norm.split('/').pop()!
    return re.test(base)
  }

  function resolveAllowedRoots(roots: readonly DeletableRoot[]): AbsolutePath[] {
    const out: AbsolutePath[] = []
    for (const root of roots) {
      switch (root.kind) {
        case 'profile-dir':
          out.push(path.join(dshHomeAbs, 'profiles', root.profile) as AbsolutePath); break
        case 'storages':
          out.push(path.join(dshHomeAbs, 'storages') as AbsolutePath); break
        case 'attachments':
          out.push(path.join(dshHomeAbs, 'attachments', 'v1') as AbsolutePath); break
        case 'dsh-home-patch':
          out.push(path.join(dshHomeAbs, 'cordis.patch.yml') as AbsolutePath); break
        case 'temp-orphan':
          out.push(tempAbs as AbsolutePath); break
      }
    }
    return out
  }

  return resolver
}

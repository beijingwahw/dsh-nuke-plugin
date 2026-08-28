// contracts/paths.ts — 子系统四：跨平台 Path Resolver
// 修正现有 getHome() 单行兜底的不足：
//  1. 三平台归一：Windows(APPDATA/USERPROFILE)、POSIX(HOME)、DSH_HOME 显式覆盖
//  2. 删除白名单：canonicalize 解析 symlink 后必须落在白名单根内才可删
//  3. 统一插件自身状态目录（.nuke-backups/.nuke-tx/.nuke-logs/.nuke-reports）

import type { AbsolutePath, ProfileName, Result } from './base'

export interface PlatformInfo {
  readonly os: 'windows' | 'macos' | 'linux'
  readonly home: AbsolutePath
  readonly tempRoot: AbsolutePath
  readonly dshHome: AbsolutePath      // $DSH_HOME || <home>/.dsh
  readonly pathSep: '/' | '\\'
}

export type DeletableRoot =
  | { readonly kind: 'profile-dir'; readonly profile: string }
  | { readonly kind: 'storages' }
  | { readonly kind: 'attachments' }
  | { readonly kind: 'dsh-home-patch' }   // 仅 <dshHome>/cordis.patch.yml 单文件
  | { readonly kind: 'temp-orphan' }      // 仅 TEMP 下经孤儿扫描确认的条目

/** 白名单策略：任何物理删除/移动动作的目标必须通过此校验 */
export interface PathPolicy {
  readonly allowedRoots: readonly DeletableRoot[]
  /** 拒绝清单：绝不可动的路径模式（如 dsh-base、系统目录、.nuke-backups 自身） */
  readonly denyGlobs: readonly string[]
  /** Windows 下是否拒绝 UNC/长路径等易绕过形态 */
  readonly strictWindows: boolean
}

export interface IPathResolver {
  platform(): PlatformInfo

  /** realpath + 分隔符/大小写归一；解析 symlink，防符号链接逃逸 */
  canonicalize(p: string): Promise<Result<AbsolutePath>>

  /** 解析后判定 child 是否位于 root 内（含 symlink 解析后重判） */
  isWithin(child: string, root: AbsolutePath): Promise<boolean>

  /** 删除前置闸门：策略校验 + 穿越检测。返回违规明细 */
  assertDeletable(p: string, policy: PathPolicy): Promise<Result<AbsolutePath>>

  // ─── 已知根（全部为绝对路径，构造时一次性解析） ─────────────
  profileDir(profile: ProfileName): AbsolutePath
  storagesRoot(): AbsolutePath
  attachmentsRoot(): AbsolutePath
  dshHomePatchFile(): AbsolutePath
  /** 插件自身状态根：<dshHome>/.nuke/（backups/tx/logs/reports 子目录由此派生） */
  nukeStateRoot(): AbsolutePath
}

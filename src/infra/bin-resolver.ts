// src/infra/bin-resolver.ts — 命令解析器：宿主进程 PATH 与用户 shell PATH 不一致时的救援探测
//
// 问题场景（真实故障）：dsh 经 nvm/npm 全局安装。用户交互 shell 由 rc 文件
// （~/.bashrc / ~/.zshrc）加载 nvm 并把版本 bin 目录注入 PATH，所以
// `which dsh` 一切正常；但 DSH 宿主进程（GUI/守护态/IDE 拉起）不加载 rc 文件，
// 其 process.env.PATH 缺少该目录 → spawnSync('dsh') 得到 ENOENT →
// 健康检查误报"dsh CLI 不可用"并以 critical 阻断全部清理。
//
// 解法：spawn ENOENT 时扫描常见全局 bin 候选目录（nvm 版本目录、npm 全局
// 前缀、系统路径、Windows %APPDATA%\npm 等），命中则返回绝对路径供调用方
// 直接执行（绝对路径不依赖 PATH）。全目录 fail-soft：读不到即跳过。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** 解析注入点：全部可测（默认走真实环境） */
export interface BinResolveOptions {
  readonly env?: NodeJS.ProcessEnv
  /** 文件存在性探测注入（缺省 fs.existsSync） */
  readonly exists?: (p: string) => boolean
  readonly platform?: NodeJS.Platform
  /** home 目录注入（缺省 os.homedir） */
  readonly homedir?: () => string
}

/** 命中结果：path = 可直接执行的绝对路径；fromPath = 是否 PATH 直命中（false = 候选目录救援） */
export interface ResolvedBin {
  readonly path: string
  readonly dir: string
  readonly fromPath: boolean
}

/** Windows 下 npm 全局安装的 shim 形态（.cmd 优先 —— npm 默认生成 .cmd 包装） */
const WIN_EXT_ORDER: readonly string[] = ['.cmd', '.exe', '.bat']

/** 候选文件名：win 平台补全扩展名（无扩展名原始名兜底），unix 直名 */
function candidateNames(cmd: string, platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32') {
    return [...WIN_EXT_ORDER.map(ext => cmd + ext), cmd]
  }
  return [cmd]
}

/** 在指定目录列表中查找命令（目录序即优先序），返回第一个命中 */
export function resolveInDirs(
  cmd: string, dirs: readonly string[], options: BinResolveOptions = {}, fromPath = false,
): ResolvedBin | null {
  const exists = options.exists ?? ((p: string) => { try { return fs.existsSync(p) } catch { return false } })
  const platform = options.platform ?? process.platform
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of candidateNames(cmd, platform)) {
      const full = path.join(dir, name)
      if (exists(full)) return { path: full, dir, fromPath }
    }
  }
  return null
}

/** 沿 env.PATH 解析命令（模拟 shell 的命令查找；PATH 直命中不构成"救援"语义） */
export function resolveOnPath(cmd: string, options: BinResolveOptions = {}): ResolvedBin | null {
  const env = options.env ?? process.env
  const pathVar = env.PATH ?? env.Path ?? ''
  const dirs = pathVar.split(path.delimiter).filter(d => d.length > 0)
  return resolveInDirs(cmd, dirs, options, true)
}

/** 常见全局 bin 候选目录（宿主 PATH 缺失时的救援扫描范围）。
 *  覆盖主流 Node 版本管理器（nvm / volta / asdf）与包管理器全局前缀。 */
export function globalBinCandidates(options: BinResolveOptions = {}): string[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = (options.homedir ?? os.homedir)()
  const dirs: string[] = []
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'))   // npm 默认全局 bin
    if (env.NVM_HOME) dirs.push(env.NVM_HOME)                    // nvm-windows
    if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK)
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin'))
    dirs.push(path.join(home, '.volta', 'bin'))                  // volta
    dirs.push(path.join(home, '.asdf', 'shims'))                 // asdf
    if (env.npm_config_prefix) dirs.push(path.join(env.npm_config_prefix, 'bin'))
    // nvm 版本目录（~/.nvm/versions/node/<ver>/bin）—— 逐版本枚举，fail-soft
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node')
    try {
      for (const v of fs.readdirSync(nvmVersions)) {
        dirs.push(path.join(nvmVersions, v, 'bin'))
      }
    } catch { /* nvm 未安装或不可读 → 跳过 */ }
  }
  return dirs
}

/** PATH 救援总入口：先沿 PATH 找（shell 语义），找不到再扫候选目录（救援语义） */
export function resolveCommand(cmd: string, options: BinResolveOptions = {}): ResolvedBin | null {
  return resolveOnPath(cmd, options)
    ?? resolveInDirs(cmd, globalBinCandidates(options), options)
}

// src/infra/cmd-shim.ts — Windows 批处理 shim（.cmd/.bat）的 spawn 适配器
//
// 问题场景（真实故障，Windows）：dsh 经 npm 全局安装时生成的是 dsh.cmd
// 包装器而非 dsh.exe。Node.js 修复 CVE-2024-27980 后（18.20+/20.12+/21.7+，
// 本插件要求 Node ≥ 24.11 必然包含），spawn/spawnSync 直接执行 .cmd/.bat
// 必须显式 shell: true，否则直接抛 EINVAL —— 于是救援链"找到了
// D:\...\dsh.cmd，却因 spawn EINVAL 无法执行"，standard-remove 整步失败。
//
// 解法：检测到 .cmd/.bat 目标时改经 %ComSpec% /d /s /c 执行：
//   - 参数仍走 argv 数组（libuv 负责含空格参数的引号转义），
//     不做字符串拼接 shell 命令 —— 防注入纪律与"无 shell"基线一致
//   - /d 禁用 AutoRun、/s 带引号安全解析（与 Node 文档 shell 模式同款旗标）
//   - 非 Windows / 非 .cmd/.bat 目标原样返回（零行为变化）
import * as path from 'path'

/** spawn 直接执行会抛 EINVAL 的 Windows 批处理扩展名（小写比较） */
const BATCH_EXTENSIONS: ReadonlySet<string> = new Set(['.cmd', '.bat'])

/** 目标是否为 Windows 批处理 shim（决定是否需要 ComSpec 包装） */
export function isBatchShim(
  cmd: string, platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false
  return BATCH_EXTENSIONS.has(path.extname(cmd).toLowerCase())
}

/** spawn 调用的适配形态：批处理 → ComSpec 包装；其余原样 */
export interface SpawnInvocation {
  readonly file: string
  readonly args: readonly string[]
}

/**
 * 适配一次 spawn/spawnSync 调用：Windows .cmd/.bat 目标经 %ComSpec% 执行，
 * 其余平台与目标保持原样。纯函数、无 IO、无副作用（comspec/platform
 * 可注入，测试零环境依赖）。
 */
export function adaptSpawnInvocation(
  cmd: string,
  args: readonly string[],
  comspec: string | undefined = process.env.ComSpec,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  if (!isBatchShim(cmd, platform)) return { file: cmd, args }
  return { file: comspec ?? 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] }
}

// src/infra/tool-registry.ts — 工具注册表：外部工具解析的单一事实源（V5.2）
//
// 解析链（顺序固定，全系统只此一份实现）：
//   ① 显式环境变量（DSH_BIN/PNPM_BIN）→ 直接探测该路径
//      用户显式指定的路径失效 → 响亮报错，绝不静默降级到后续链路
//   ② 裸名探测（PATH 语义）→ exit 0 = ok；exit 非 0 但进程已执行 = ok（旗标差异）
//   ③ spawn ENOENT → 全局 bin 候选目录救援（nvm/volta/asdf/npm 前缀，见 bin-resolver）
//      救援命中 → rescued（附 PATH 修复提示）；全落空 → missing
//
// 消费方（健康检查/standard-remove/pnpm-prune/doctor）一律委托本注册表，
// 不再各自探测 —— 语义漂移在结构上不可能发生。
import { spawnSync } from 'child_process'

import type {
  IToolRegistry, ToolDescriptor, ToolMethod, ToolResolution, ToolStatus,
} from '../contracts/tool.contract'

import { resolveCommand } from './bin-resolver'
import { adaptSpawnInvocation } from './cmd-shim'

/** 探测返回形态（与 health-inspector 的 CommandProbe 同构） */
export interface ToolProbeResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly errorCode?: string
}

export interface ToolRegistryOptions {
  readonly env?: NodeJS.ProcessEnv
  /** 路径解析注入（缺省 = bin-resolver 的 PATH+救援实现） */
  readonly resolveCommand?: (cmd: string) => { readonly path: string; readonly dir: string } | null
  /** 版本探测注入（缺省 = 真实 spawnSync --version，5s 超时） */
  readonly probe?: (cmdOrPath: string) => ToolProbeResult | Promise<ToolProbeResult>
  /** 解析结果缓存 TTL（缺省 60s；0 = 不缓存） */
  readonly ttlMs?: number
  readonly now?: () => number
}

/** 已注册工具档案：能力映射是治理核心 —— 缺失时只降级 affects 声明的动作 */
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: 'dsh',
    envVar: 'DSH_BIN',
    purpose: '宿主 CLI（标准卸载 dsh plugin remove）',
    affects: ['standard-remove'],
    fixHint: 'standard-remove 步骤将不可用: 安装 dsh、修复宿主进程 PATH，或用 skip_standard 跳过标准卸载',
  },
  {
    name: 'pnpm',
    envVar: 'PNPM_BIN',
    purpose: '包管理器（aggressive 策略的 store prune）',
    affects: ['pnpm-store-prune'],
    fixHint: '安装 pnpm: npm i -g pnpm',
  },
]

/** 未注册工具的临时描述符（泛化：任意命令可查，affects 未知） */
function ephemeralDescriptor(name: string): ToolDescriptor {
  return {
    name,
    envVar: null,
    purpose: '未注册工具（临时解析）',
    affects: [],
    fixHint: `安装 ${name} 或将其所在目录加入 PATH`,
  }
}

/** 版本串提取：stdout 首行，≤60 字符 */
function extractVersion(stdout: string): string | null {
  const first = stdout.trim().split('\n')[0]?.trim() ?? ''
  return first.length > 0 ? first.slice(0, 60) : null
}

/** 旗标差异场景的可读附注（stdout 优先，stderr 兜底） */
function flagNote(r: ToolProbeResult): string {
  return (r.stdout.trim() || r.stderr.trim()).slice(0, 60)
}

/** 默认探测：真实 spawnSync（注册表可独立构造，宿主入口直接用）。
 *  Windows .cmd/.bat shim 经 ComSpec 适配（直接 spawn 会抛 EINVAL，见 cmd-shim） */
function defaultProbe(cmdOrPath: string): ToolProbeResult {
  const t = adaptSpawnInvocation(cmdOrPath, ['--version'])
  const r = spawnSync(t.file, t.args, { encoding: 'utf-8', timeout: 5000 })
  return {
    status: r.status,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- spawn 失败（如 ENOENT）时 stdout 实际为 undefined（SpawnSyncReturns 类型未建模），?? '' 是必需的运行时防御
    stdout: r.stdout ?? '',
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上：stderr 在 spawn 失败时为 undefined
    stderr: r.stderr ?? '',
    ...(typeof (r.error as unknown as { code?: unknown } | null | undefined)?.code === 'string'
      ? { errorCode: (r.error as unknown as { code: string }).code }
      : {}),
  }
}

export function createToolRegistry(options: ToolRegistryOptions = {}): IToolRegistry {
  const env = options.env ?? process.env
  const probe = options.probe ?? defaultProbe
  const resolve = options.resolveCommand ?? resolveCommand
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now

  const cache = new Map<string, ToolResolution>()

  /** 探测 + 语义判定（三段式的②③段；①段由调用方处理 env 覆盖） */
  async function probeAndClassify(
    desc: ToolDescriptor, cmdOrPath: string, method: ToolMethod,
  ): Promise<ToolResolution> {
    const r = await probe(cmdOrPath)
    // 进程已执行（status 非 null 且无 spawn 错误）= 二进制存在
    const executed = r.status !== null && r.errorCode === undefined
    if (r.status === 0) {
      return resolution(desc, 'ok', method, cmdOrPath, null, extractVersion(r.stdout),
        method === 'explicit-env'
          ? `版本: ${extractVersion(r.stdout) ?? '(无版本输出)'}（由 ${desc.envVar} 显式指定: ${cmdOrPath}）`
          : `版本: ${extractVersion(r.stdout) ?? '(无版本输出)'}`)
    }
    if (executed) {
      // 旗标差异：二进制在但 --version 退出码非 0（如不认识该旗标）→ 可用
      const note = flagNote(r)
      return resolution(desc, 'ok', method, cmdOrPath, null, null,
        `可用（--version 退出码 ${r.status}${note ? `: ${note}` : ''}）`)
    }
    // spawn 未找到（status null / ENOENT）
    if (method === 'explicit-env') {
      // 显式指定失效：响亮报错，不静默降级
      return resolution(desc, 'missing', 'explicit-env', cmdOrPath, null, null,
        `${desc.envVar} 指定的路径无法执行: ${cmdOrPath}（spawn ${r.errorCode ?? '失败'}）—— 请修正该环境变量`)
    }
    if (method === 'path') {
      // PATH 落空 → 救援：全局 bin 候选目录（宿主 PATH 缺口的补丁）
      const resolved = resolve(desc.name)
      if (resolved) {
        const rescue = await probe(resolved.path)
        const rescueExecuted = rescue.status !== null && rescue.errorCode === undefined
        if (rescueExecuted) {
          const ver = rescue.status === 0
            ? extractVersion(rescue.stdout)
            : `--version 退出码 ${rescue.status}`
          return resolution(desc, 'rescued', 'rescue', resolved.path, resolved.dir,
            rescue.status === 0 ? extractVersion(rescue.stdout) : null,
            `可用: ${ver}（救援路径 ${resolved.path}；宿主 PATH 未含 ${resolved.dir}，建议修复宿主环境 PATH）`)
        }
        return resolution(desc, 'missing', 'rescue', resolved.path, resolved.dir, null,
          `救援路径无法执行（${resolved.path}，spawn ${rescue.errorCode ?? '失败'}）`)
      }
      return resolution(desc, 'missing', null, null, null, null,
        `${desc.name} 命令未找到（宿主 PATH 与常见全局 bin 目录均无 ${desc.name}）`)
    }
    // rescue 探测失败（method === 'rescue' 不会到这里 —— 上面已处理）；
    // 防御性兜底：按未找到处理
    return resolution(desc, 'missing', method, null, null, null,
      `${desc.name} 命令未找到（宿主 PATH 与常见全局 bin 目录均无 ${desc.name}）`)
  }

  function resolution(
    desc: ToolDescriptor, status: ToolStatus, method: ToolMethod,
    path: string | null, dir: string | null, version: string | null, detail: string,
  ): ToolResolution {
    return {
      tool: desc.name, status, method, path, dir, version, detail,
      affects: desc.affects, fixHint: desc.fixHint, envVar: desc.envVar,
      probedAt: now(),
    }
  }

  async function resolveTool(tool: string): Promise<ToolResolution> {
    const desc = TOOL_DESCRIPTORS.find(d => d.name === tool) ?? ephemeralDescriptor(tool)
    // ① 显式环境变量优先（用户意图最强；失效要响亮报告）
    if (desc.envVar && env[desc.envVar] && env[desc.envVar]!.length > 0) {
      return probeAndClassify(desc, env[desc.envVar]!, 'explicit-env')
    }
    // ②③ 裸名 PATH 探测 → ENOENT 时内部走救援
    return probeAndClassify(desc, desc.name, 'path')
  }

  return {
    async resolve(tool: string): Promise<ToolResolution> {
      const cached = cache.get(tool)
      if (cached && ttlMs > 0 && now() - cached.probedAt < ttlMs) return cached
      const fresh = await resolveTool(tool)
      cache.set(tool, fresh)
      return fresh
    },

    async resolveAll(): Promise<readonly ToolResolution[]> {
      return Promise.all(TOOL_DESCRIPTORS.map(d => this.resolve(d.name)))
    },

    invalidate(tool?: string): void {
      if (tool === undefined) cache.clear()
      else cache.delete(tool)
    },
  }
}

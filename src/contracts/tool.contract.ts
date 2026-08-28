// src/contracts/tool.contract.ts — 外部工具契约（V5.2 长期方案：依赖治理一等公民）
//
// 设计动机（真实故障复盘）：dsh CLI 经 nvm 安装，用户 shell 的 rc 文件注入
// PATH 而宿主进程不加载 rc → 三处独立探测（健康检查/standard-remove/CLI）
// 各自解释"什么算可用"，一处误报 critical 即阻断全部清理。
// 治理原则：解析语义只允许存在一份实现（ToolRegistry），所有消费方从同一
// 事实源取数；工具缺失只降级声明依赖它的能力，永不全局阻断。

/** 工具描述符：注册表中的静态档案 —— 声明"谁依赖我"（能力映射） */
export interface ToolDescriptor {
  /** 命令名（如 'dsh' / 'pnpm'） */
  readonly name: string
  /** 显式路径覆盖的环境变量（如 'DSH_BIN'）；null = 不支持覆盖 */
  readonly envVar: string | null
  /** 用途（人类可读） */
  readonly purpose: string
  /** 依赖此工具的动作清单（能力映射：缺失时只降级这些动作） */
  readonly affects: readonly string[]
  /** 缺失时的修复建议（人类可读，含具体命令） */
  readonly fixHint: string
}

/** 解析状态：ok=直接可用；rescued=PATH 救援命中（宿主 PATH 有缺口）；missing=未找到 */
export type ToolStatus = 'ok' | 'rescued' | 'missing'

/** 解析来源（溯源：结果是怎么得出的） */
export type ToolMethod = 'explicit-env' | 'path' | 'rescue' | null

/** 单工具解析结果：状态 + 来源 + 路径 + 版本 + 人类可读明细 */
export interface ToolResolution {
  readonly tool: string
  readonly status: ToolStatus
  readonly method: ToolMethod
  /** 可执行文件的绝对路径（missing 时为 null；explicit-env 时为用户指定值） */
  readonly path: string | null
  /** 命中目录（rescue 诊断用：提示用户把它加入宿主 PATH） */
  readonly dir: string | null
  /** --version 输出的版本串（首行，≤60 字符；探测不出为 null） */
  readonly version: string | null
  /** 人类可读明细（含来源解释，doctor/健康检查直接渲染） */
  readonly detail: string
  /** 影响面（来自描述符的能力映射） */
  readonly affects: readonly string[]
  /** 修复建议（来自描述符） */
  readonly fixHint: string
  /** 显式覆盖变量名（提示用户可设 DSH_BIN 之类逃生） */
  readonly envVar: string | null
  /** 解析时间戳（缓存 TTL 判定） */
  readonly probedAt: number
}

/** 工具注册表：外部工具解析的单一事实源 */
export interface IToolRegistry {
  /** 解析单个工具（TTL 缓存；未注册的工具用临时描述符泛化解析） */
  resolve(tool: string): Promise<ToolResolution>
  /** 解析全部已注册工具（doctor 环境矩阵） */
  resolveAll(): Promise<readonly ToolResolution[]>
  /** 失效缓存（环境变化后强制重解析；缺省 = 全部） */
  invalidate(tool?: string): void
}

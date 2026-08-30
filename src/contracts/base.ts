// contracts/base.ts — 契约层公共类型（零依赖，环境无关）
// 本文件是全插件唯一的事实来源：所有子系统只依赖此处与各自的契约模块。

// ─── 品牌类型：编译期防混用 ─────────────────────────────────
// 例：把 ProfileName 误传给 PluginName 参数将直接编译失败。
export type Brand<T, B extends string> = T & { readonly __brand: B }

export type TxId = Brand<string, 'TxId'>
export type PluginName = Brand<string, 'PluginName'>
export type ProfileName = Brand<string, 'ProfileName'>
export type AbsolutePath = Brand<string, 'AbsolutePath'>
export type LockId = Brand<string, 'LockId'>

// ─── Result 类型：消灭异常驱动的控制流 ──────────────────────
// 所有可失败操作返回 Result 而非 throw，调用方被迫处理失败分支。
export type Result<T, E = NukeError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

// ─── 统一错误模型 ───────────────────────────────────────────
export type ErrorCode =
  | 'E_LOCK_HELD'          // 锁被他人持有
  | 'E_LOCK_STALE'         // 锁疑似残留（需安全破锁流程）
  | 'E_LOCK_STATE'         // 锁句柄已被释放/非法操作
  | 'E_TX_NOT_FOUND'
  | 'E_TX_STATE'           // 事务状态机非法迁移
  | 'E_VALIDATION'         // 输入校验失败
  | 'E_PATH_POLICY'        // 路径越出白名单根
  | 'E_DEPENDENCY'         // 存在依赖方，禁止删除
  | 'E_HOOK_VETO'          // pre 钩子否决
  | 'E_IO'
  | 'E_CANCELLED'

export interface NukeError {
  readonly code: ErrorCode
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

// ─── 错误归一化：catch 边界的单一事实来源 ──────────────────
// JS 世界任何值都能被 throw（string/对象/undefined…），
// 直接读 e.message 在非 Error 抛出时会得到 "undefined" 丢失根因。
export function errorToMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null) {
    const maybe = e as { message?: unknown; code?: unknown }
    if (typeof maybe.message === 'string') {
      // 已是 NukeError 形态 → 带码呈现，保留可追溯性
      return typeof maybe.code === 'string' ? `[${maybe.code}] ${maybe.message}` : maybe.message
    }
  }
  return String(e)
}

/** 统一 IO 类错误构造：message 形如 "<context>: <root cause>" */
export function ioError(context: string, e: unknown): NukeError {
  return { code: 'E_IO', message: `${context}: ${errorToMessage(e)}` }
}

// ─── 混沌演习：受控崩溃信号 ─────────────────────────────────
// 事务引擎的 crashAfterStep 注入点抛出本异常时，commit 的所有 catch
// 都必须原样 re-throw —— 不回滚、不释放锁、不写终结审计，
// 语义上等价于进程在第 stepIndex 步成功落盘后立刻断电死亡。
// 仅沙箱演习（nuke_drill）与测试使用，生产组装永不注入。
export class SimulatedCrashError extends Error {
  constructor(
    public readonly txId: string,
    public readonly stepIndex: number,
  ) {
    super(`SIMULATED_CRASH: 事务 ${txId} 第 ${stepIndex} 步成功落盘后模拟进程死亡（跳过回滚与锁释放）`)
    this.name = 'SimulatedCrashError'
  }
}

// ─── 从旧 types.ts 提升的领域枚举 ───────────────────────────
export type CleanStrategy = 'safe' | 'balanced' | 'aggressive'

export type CleanAction =
  | 'standard-remove'
  | 'clean-workspace-yaml'
  | 'clean-profile-patch'
  | 'clean-home-patch'
  | 'remove-node-modules'
  | 'remove-storages'
  | 'remove-attachments'
  | 'pnpm-store-prune'
  | 'purge-temp'           // V4 新增：TEMP 目录孤儿清理

/** CleanAction 的运行时白名单 —— 类型联合的值级伴随。
 *  磁盘数据（WAL/审计链）中的 action 字段名义上是 CleanAction，
 *  实际可能被篡改或来自旧版本；读侧窄化必须经此守卫而非 as 断言。 */
export const CLEAN_ACTIONS: readonly CleanAction[] = [
  'standard-remove',
  'clean-workspace-yaml',
  'clean-profile-patch',
  'clean-home-patch',
  'remove-node-modules',
  'remove-storages',
  'remove-attachments',
  'pnpm-store-prune',
  'purge-temp',
]

export function isCleanAction(v: unknown): v is CleanAction {
  return typeof v === 'string' && (CLEAN_ACTIONS as readonly string[]).includes(v)
}

// ─── 可注入时钟：单元测试的时间可控性 ────────────────────────
export interface Clock {
  now(): Date
}

export type Unsubscribe = () => void

/** 全项目唯一的字节数人性化格式化（B/KB/MB/GB/TB）。
 *  此前 severity-scorer 与 reporter 各持一份相同实现 —— 统一到契约层。
 *  与 fmtDuration 同一防御口径：非有限数/负数 → 'n/a'（NaN 会输出 "NaNGB"）。 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'n/a'
  if (n < 1024) return `${n}B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)}GB`
  return `${(n / 1024 ** 4).toFixed(2)}TB`
}

/** V5.4：耗时格式化（ms → 人类可读）。与 fmtBytes 同层：
 *  全项目唯一实现，先知渲染 / 战绩对账 / 引擎日志共用。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

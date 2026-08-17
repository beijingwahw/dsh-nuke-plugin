// contracts/hooks.ts — 子系统二：生命周期钩子注册表
// 修正现有 hooks.ts 的缺陷：
//  1. 只有 pre/post → 增加 error 时点，失败时外部可介入（请求回滚/降级）
//  2. sh -c 字符串命令 → 强制 argv 数组，经 IInputValidator.validateCommandArgv
//  3. 失败静默 → verdict 机制：pre 钩子可否决（veto）整个事务
//  4. 全同步 spawn → 异步并发执行 + 超时熔断

import type {
  CleanAction, CleanStrategy, NukeError, PluginName, ProfileName,
  Result, TxId, Unsubscribe,
} from './base'
import type { BackupRecord } from './transaction'

export type HookTiming = 'pre' | 'post' | 'error'

export interface HookContext {
  readonly txId: TxId
  readonly actor: string
  readonly plugin: PluginName
  readonly profile: ProfileName
  readonly strategy: CleanStrategy
  readonly action: CleanAction
  /** post/error 时点可用的备份记录 */
  readonly backup?: BackupRecord
  /** error 时点的失败原因 */
  readonly error?: NukeError
}

/** 钩子裁决：pre 钩子对流程的控制权 */
export type HookVerdict =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'proceed-with-warning'; readonly message: string }
  | { readonly kind: 'veto'; readonly reason: string }

/** error 钩子对失败处置的建议（引擎最终裁决） */
export type ErrorDirective = 'rollback' | 'skip-and-continue' | 'abort'

export type HookHandler =
  | { readonly type: 'inline'; run(ctx: HookContext): Promise<HookVerdict | ErrorDirective | void> }
  | {
      readonly type: 'command'
      /** 必须通过 validateCommandArgv，禁止 shell 字符串 */
      readonly argv: readonly string[]
      readonly envWhitelist: readonly string[]   // 仅白名单变量注入子进程
      readonly timeoutMs: number
      /** 非零退出码在 pre 时点 = veto */
      readonly nonzeroExitIsVeto: boolean
    }

export interface HookDefinition {
  readonly id: string
  readonly timing: HookTiming
  /** 订阅的动作集；'*' = 全部 */
  readonly actions: readonly CleanAction[] | '*'
  readonly handler: HookHandler
  /** 同 timing 内的执行优先级，小者先 */
  readonly priority: number
  /** 失败策略：fail-fast 使整个 emit 视为失败；best-effort 仅记录 */
  readonly onFailure: 'fail-fast' | 'best-effort'
}

export interface HookEmitResult {
  readonly executed: number
  readonly failed: number
  /** 合并后的最终裁决（多个 veto 时取第一个，其余记录为 warning） */
  readonly verdict: HookVerdict
  readonly errorDirective: ErrorDirective | null
  readonly messages: readonly string[]
}

export interface IHookRegistry {
  register(def: HookDefinition): Unsubscribe
  /** pre：聚合 verdict；error：聚合 directive；全部并发执行受 timeoutMs 约束 */
  emit(timing: HookTiming, ctx: HookContext): Promise<Result<HookEmitResult, NukeError>>
  /** 持久化到 <dshHome>/.nuke/hooks/{pre,post,error}.json（schema 升级版） */
  loadFromDisk(): Promise<Result<void, NukeError>>
  list(): readonly HookDefinition[]
}

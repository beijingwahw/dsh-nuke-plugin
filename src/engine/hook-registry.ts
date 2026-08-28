// src/engine/hook-registry.ts — IHookRegistry 实现
// 安全要点：command 型钩子强制 argv 数组 + execFile（不经 shell），
// 子进程环境变量仅注入白名单；pre 钩子非零退出可按配置视为 veto。
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import type { NukeError, Result, Unsubscribe } from '../contracts/base'
import { err, errorToMessage, ioError, ok } from '../contracts/base'
import type {
  ErrorDirective, HookContext, HookDefinition, HookEmitResult,
  HookTiming, HookVerdict, IHookRegistry,
} from '../contracts/hooks'

export interface HookRegistryOptions {
  readonly dir: string               // <dshHome>/.nuke/hooks
  readonly allowBins?: readonly string[]
}

/** V5：注册输入形态 —— priority/timeoutMs/id 均可选（契约 HookDefinition 的宽松超集）。
 *  priority 缺省 0；同优先级严格保持注册顺序（后注册者后执行）。 */
export type HookRegistrationInput = Omit<HookDefinition, 'priority' | 'id'> & {
  readonly id?: string
  /** 同 timing 内的执行优先级，小者先；缺省 0 */
  readonly priority?: number
  /** 钩子执行超时（毫秒）：超时视为该钩子失败（走错误隔离路径，不中断整批）。
   *  仅对 inline 钩子生效；command 钩子使用 handler.timeoutMs 的 execFile 内建超时。 */
  readonly timeoutMs?: number
}

/** 注册表内部形态：附加注册序号（同优先级稳定次键）与归一化后的超时 */
interface RegisteredHook extends HookRegistrationInput {
  readonly id: string
  readonly priority: number
  /** 注册序号：永不复用，同优先级时按它稳定排序 */
  readonly seq: number
}

/** V5：注册表实例 —— register 接受宽松的 HookRegistrationInput（priority/timeoutMs/id
 *  均可选），同时完整保留 IHookRegistry 契约。参数比契约更宽松 → 旧消费方传
 *  HookDefinition 依然合法（只增不改）。 */
export interface HookRegistryInstance extends IHookRegistry {
  register(def: HookRegistrationInput): Unsubscribe
}

const DEFAULT_ALLOW_BINS = ['node', 'python', 'python3', 'dsh', 'pnpm', 'npm', 'git']

export function createHookRegistry(options: HookRegistryOptions): HookRegistryInstance {
  const allowBins = options.allowBins ?? DEFAULT_ALLOW_BINS
  const defs: RegisteredHook[] = []
  let seq = 0
  /** 磁盘钩子的注销句柄：loadFromDisk 幂等的关键 —— 重载前先注销上一轮，
   *  否则多次调用（如配置热重载）会叠加注册同一批钩子导致重复执行。 */
  let diskUnsubscribers: Unsubscribe[] = []

  function runCommand(
    handler: Extract<HookDefinition['handler'], { type: 'command' }>,
    ctx: HookContext,
  ): Promise<{ ok: boolean; message: string }> {
    return new Promise(resolve => {
      const bin = handler.argv[0] ?? ''
      const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
      for (const key of handler.envWhitelist) {
        const v = process.env[key]
        if (v !== undefined) env[key] = v
      }
      // 钩子上下文经 NUKE_* 注入
      env.NUKE_PLUGIN = ctx.plugin
      env.NUKE_PROFILE = ctx.profile
      env.NUKE_ACTION = ctx.action
      env.NUKE_TX = ctx.txId
      execFile(bin, handler.argv.slice(1), {
        env, timeout: handler.timeoutMs, maxBuffer: 1024 * 64,
      }, (error, stdout, stderr) => {
        if (error) {
          // error.message 含退出码/被信号杀死/spawn 失败的根因，与 stderr 一并保留
          const detail = (stderr || stdout || '').trim().slice(0, 200)
          resolve({ ok: false, message: `钩子命令失败(${bin}): ${error.message}${detail ? ` | ${detail}` : ''}` })
        } else {
          resolve({ ok: true, message: stdout.trim().slice(0, 200) })
        }
      })
    })
  }

  /** V5：inline 钩子带可选超时执行 —— 超时以 reject 形态抛出，
   *  由 emit 的错误隔离路径统一收编（failed 计数 + 消息收集 + fail-fast 延迟统一上报）。
   *  Promise.race 对每个输入都注册了 settlement handler，迟到的 rejection 不会成为
   *  unhandledRejection。 */
  function runInlineWithTimeout(def: RegisteredHook, ctx: HookContext): Promise<unknown> {
    const handler = def.handler
    if (handler.type !== 'inline') {
      return Promise.reject(new Error(`内部错误: 钩子 ${def.id} 的 handler 不是 inline`))
    }
    const timeoutMs = def.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return handler.run(ctx)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error(`钩子 ${def.id} 执行超时(${timeoutMs}ms)`)); }, timeoutMs)
    })
    return Promise.race([Promise.resolve(handler.run(ctx)), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  function register(def: HookRegistrationInput): Unsubscribe {
    const registrationSeq = seq++
    const withId: RegisteredHook = {
      ...def,
      id: def.id ?? `hook-${registrationSeq}`,
      // V5：priority 归一化 —— 缺省 0，非数字防御为 0（磁盘数据不可信纪律的运行时延伸）
      priority: typeof def.priority === 'number' && Number.isFinite(def.priority) ? def.priority : 0,
      seq: registrationSeq,
    }
    defs.push(withId)
    return () => {
      const i = defs.indexOf(withId)
      if (i >= 0) defs.splice(i, 1)
    }
  }

  return {
    register,

    async emit(timing: HookTiming, ctx: HookContext): Promise<Result<HookEmitResult>> {
      // V5 稳定排序：priority 为主键（小者先），注册序号为次键（同优先级保持注册序）
      const matching = defs
        .filter(d => d.timing === timing)
        .filter(d => d.actions === '*' || d.actions.includes(ctx.action))
        .sort((a, b) => a.priority - b.priority || a.seq - b.seq)

      let executed = 0, failed = 0
      let verdict: HookVerdict = { kind: 'proceed' }
      let errorDirective: ErrorDirective | null = null
      // V5 错误隔离：fail-fast 不再立即中断整批 —— 先执行完全部钩子，
      // 收集到的首个 fail-fast 错误在循环结束后统一上报（对调用方语义不变）。
      let failFastError: NukeError | null = null
      const messages: string[] = []

      for (const def of matching) {
        executed++
        if (def.handler.type === 'inline') {
          try {
            const r = await runInlineWithTimeout(def, ctx)
            if (timing === 'pre' && r && typeof r === 'object' && 'kind' in r) {
              const v = r as HookVerdict
              if (v.kind === 'veto') {
                if (verdict.kind !== 'veto') verdict = v
                break   // veto 立即短路：后续钩子不再执行
              }
              if (v.kind === 'proceed-with-warning') {
                messages.push(`⚠️ ${v.message}`)
                // 聚合升级：veto > proceed-with-warning > proceed。
                // 已是 veto 时不动（veto 最强）；proceed 时升级为警告裁决，
                // 调用方能从 verdict 直接读到"带警告放行"而非翻检 messages。
                if (verdict.kind === 'proceed') verdict = v
              }
            }
            if (timing === 'error' && typeof r === 'string') {
              errorDirective = errorDirective ?? (r as ErrorDirective)
            }
          } catch (e) {
            failed++
            messages.push(`❌ 钩子 ${def.id} 异常: ${errorToMessage(e)}`)
            if (def.onFailure === 'fail-fast' && failFastError === null) {
              failFastError = { code: 'E_HOOK_VETO', message: `钩子 ${def.id} fail-fast: ${errorToMessage(e)}` }
            }
          }
        } else {
          // 白名单绕过防御：argv[0] 必须是裸命令名（禁止任何路径分隔符）。
          // 否则 "/tmp/evil/node" 的 basename 是 "node" → 过白名单但执行恶意绝对路径。
          const argv0 = def.handler.argv[0] ?? ''
          if (argv0 === '' || /[\\/]/.test(argv0)) {
            failed++
            messages.push(`❌ 钩子 ${def.id} argv[0] 必须为裸命令名（禁止路径）: "${argv0}"`)
            if (def.onFailure === 'fail-fast' && failFastError === null) {
              failFastError = { code: 'E_HOOK_VETO', message: `钩子 ${def.id} argv[0] 含路径，拒绝执行` }
            }
            continue
          }
          const bin = argv0.replace(/\.exe$/i, '')
          if (!allowBins.includes(bin)) {
            failed++
            messages.push(`❌ 钩子 ${def.id} 命令不在白名单: ${bin}`)
            if (def.onFailure === 'fail-fast' && failFastError === null) {
              failFastError = { code: 'E_HOOK_VETO', message: `钩子命令白名单外: ${bin}` }
            }
            continue
          }
          const r = await runCommand(def.handler, ctx)
          if (r.ok) { if (r.message) messages.push(`✅ [${def.id}] ${r.message}`) }
          else {
            failed++
            messages.push(`❌ [${def.id}] ${r.message}`)
            if (timing === 'pre' && def.handler.nonzeroExitIsVeto) {
              if (verdict.kind !== 'veto') verdict = { kind: 'veto', reason: r.message }
              break   // veto 立即短路：后续钩子不再执行
            }
            if (def.onFailure === 'fail-fast' && failFastError === null) {
              failFastError = { code: 'E_HOOK_VETO', message: `钩子 ${def.id} fail-fast` }
            }
          }
        }
      }
      // 统一报告：存在 fail-fast 失败 → 整个 emit 失败（与旧语义一致，只是不再提前中断）
      if (failFastError !== null) return err(failFastError)
      return ok({ executed, failed, verdict, errorDirective, messages })
    },

    async loadFromDisk(): Promise<Result<void>> {
      // 幂等重载：先注销上一轮磁盘钩子，再按当前磁盘状态重建
      for (const off of diskUnsubscribers) off()
      diskUnsubscribers = []
      for (const timing of ['pre', 'post', 'error'] as const) {
        const p = path.join(options.dir, `${timing}.json`)
        if (!fs.existsSync(p)) continue
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown
          if (!Array.isArray(parsed)) {
            return err({ code: 'E_VALIDATION', message: `钩子文件必须是数组: ${p}` })
          }
          for (const d of parsed) {
            // 磁盘数据不可信：逐项结构校验后才允许注册
            if (typeof d !== 'object' || d === null) continue
            const def = d as Partial<HookDefinition> & { timeoutMs?: unknown }
            if (typeof def.timing !== 'string' || typeof def.onFailure !== 'string') continue
            if (def.handler?.type === 'command') {
              const argv = def.handler.argv
              if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string')) continue
              if (/[\\/]/.test(argv[0] ?? '')) continue   // 路径形式一律拒绝
              if (!Array.isArray(def.handler.envWhitelist)) continue
              if (typeof def.handler.timeoutMs !== 'number') continue
            } else if (def.handler?.type !== 'inline') {
              continue   // inline 函数无法从 JSON 反序列化，跳过
            }
            // V5：注册级超时（若存在）必须是正有限数，否则整条丢弃（磁盘数据不可信）
            if (def.timeoutMs !== undefined && (typeof def.timeoutMs !== 'number' || !Number.isFinite(def.timeoutMs) || def.timeoutMs <= 0)) continue
            diskUnsubscribers.push(register({ ...d, timing } as HookDefinition))
          }
        } catch (e) {
          return err(ioError(`钩子文件解析失败 ${p}`, e))
        }
      }
      return ok(undefined)
    },

    list(): readonly HookDefinition[] { return [...defs] },
  }
}

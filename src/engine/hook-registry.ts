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

const DEFAULT_ALLOW_BINS = ['node', 'python', 'python3', 'dsh', 'pnpm', 'npm', 'git']

export function createHookRegistry(options: HookRegistryOptions): IHookRegistry {
  const allowBins = options.allowBins ?? DEFAULT_ALLOW_BINS
  const defs: HookDefinition[] = []
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
          const detail = String(stderr || stdout || '').trim().slice(0, 200)
          resolve({ ok: false, message: `钩子命令失败(${bin}): ${error.message}${detail ? ` | ${detail}` : ''}` })
        } else {
          resolve({ ok: true, message: String(stdout).trim().slice(0, 200) })
        }
      })
    })
  }

  function register(def: HookDefinition): Unsubscribe {
    const id = def.id ?? `hook-${seq++}`
    const withId = { ...def, id }
    defs.push(withId)
    return () => {
      const i = defs.indexOf(withId)
      if (i >= 0) defs.splice(i, 1)
    }
  }

  return {
    register,

    async emit(timing: HookTiming, ctx: HookContext): Promise<Result<HookEmitResult, NukeError>> {
      const matching = defs
        .filter(d => d.timing === timing)
        .filter(d => d.actions === '*' || d.actions.includes(ctx.action))
        .sort((a, b) => a.priority - b.priority)

      let executed = 0, failed = 0
      let verdict: HookVerdict = { kind: 'proceed' }
      let errorDirective: ErrorDirective | null = null
      const messages: string[] = []

      for (const def of matching) {
        executed++
        if (def.handler.type === 'inline') {
          try {
            const r = await def.handler.run(ctx)
            if (timing === 'pre' && r && typeof r === 'object' && 'kind' in r) {
              const v = r as HookVerdict
              if (v.kind === 'veto' && verdict.kind !== 'veto') verdict = v
              if (v.kind === 'proceed-with-warning') messages.push(`⚠️ ${v.message}`)
            }
            if (timing === 'error' && typeof r === 'string') {
              errorDirective = errorDirective ?? (r as ErrorDirective)
            }
          } catch (e) {
            failed++
            messages.push(`❌ 钩子 ${def.id} 异常: ${errorToMessage(e)}`)
            if (def.onFailure === 'fail-fast') {
              return err({ code: 'E_HOOK_VETO', message: `钩子 ${def.id} fail-fast: ${errorToMessage(e)}` })
            }
          }
        } else {
          // 白名单绕过防御：argv[0] 必须是裸命令名（禁止任何路径分隔符）。
          // 否则 "/tmp/evil/node" 的 basename 是 "node" → 过白名单但执行恶意绝对路径。
          const argv0 = def.handler.argv[0] ?? ''
          if (argv0 === '' || /[\\/]/.test(argv0)) {
            failed++
            messages.push(`❌ 钩子 ${def.id} argv[0] 必须为裸命令名（禁止路径）: "${argv0}"`)
            if (def.onFailure === 'fail-fast') {
              return err({ code: 'E_HOOK_VETO', message: `钩子 ${def.id} argv[0] 含路径，拒绝执行` })
            }
            continue
          }
          const bin = argv0.replace(/\.exe$/i, '')
          if (!allowBins.includes(bin)) {
            failed++
            messages.push(`❌ 钩子 ${def.id} 命令不在白名单: ${bin}`)
            if (def.onFailure === 'fail-fast') {
              return err({ code: 'E_HOOK_VETO', message: `钩子命令白名单外: ${bin}` })
            }
            continue
          }
          const r = await runCommand(def.handler, ctx)
          if (r.ok) { if (r.message) messages.push(`✅ [${def.id}] ${r.message}`) }
          else {
            failed++
            messages.push(`❌ [${def.id}] ${r.message}`)
            if (timing === 'pre' && def.handler.nonzeroExitIsVeto) {
              verdict = { kind: 'veto', reason: r.message }
            }
            if (def.onFailure === 'fail-fast') {
              return err({ code: 'E_HOOK_VETO', message: `钩子 ${def.id} fail-fast` })
            }
          }
        }
      }
      return ok({ executed, failed, verdict, errorDirective, messages })
    },

    async loadFromDisk(): Promise<Result<void, NukeError>> {
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
            const def = d as Partial<HookDefinition>
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

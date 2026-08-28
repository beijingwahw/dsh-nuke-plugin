// src/infra/logger.ts — ILogger 实现：分级彩色输出 + 子 logger + 进度条
// V5：新增 structured JSONL 输出模式（构造选项 structured: true）—— 每行一个
// JSON 对象（ts/level/msg/ctx），供机器采集与日志管道消费；人类彩色模式不变。
import type { ILogger, LogFields, LogLevel } from '../contracts/logging'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const ANSI = {
  debug: '\x1b[2m',   // dim
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
} as const
const RESET = '\x1b[0m'
const LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR',
}

/** 写出函数可注入：单测时捕获断言，不污染控制台 */
export type LogWriter = (line: string) => void

export interface LoggerOptions {
  readonly sink?: 'tty' | 'plain'
  readonly minLevel?: LogLevel
  readonly bindings?: LogFields
  readonly writer?: LogWriter
  readonly errWriter?: LogWriter
  /** V5 增量：结构化 JSONL 模式 —— 每行一个 JSON 对象 {ts, level, msg, ctx?}，
   *  ctx 自动合并构造 bindings 与当次 fields（child 子日志器上下文随之携带） */
  readonly structured?: boolean
}

export function createLogger(options: LoggerOptions = {}): ILogger {
  const structured = options.structured ?? false
  const sink = options.sink ?? (process.stdout.isTTY ? 'tty' : 'plain')
  const minOrder = LEVEL_ORDER[options.minLevel ?? 'info']
  const write = options.writer ?? ((l: string) => process.stdout.write(l + '\n'))
  const writeErr = options.errWriter ?? options.writer ?? ((l: string) => process.stderr.write(l + '\n'))
  let inProgress = false
  /** 非 TTY 刻度去重：同一 10% 刻度只输出一行（旧实现 0.91~0.99 会刷出 9 行 "90%"） */
  let lastEmittedTick = -1

  function render(level: LogLevel, message: string, fields?: LogFields): string {
    const ts = new Date().toISOString().slice(11, 23)
    const color = sink === 'tty' ? ANSI[level] : ''
    const reset = sink === 'tty' ? RESET : ''
    let line = `${color}[${ts}] ${LABEL[level]}${reset} ${message}`
    const merged = mergeBindings(fields)
    const keys = Object.keys(merged)
    if (keys.length > 0) {
      const pairs = keys.map(k => `${k}=${fmtVal(merged[k])}`).join(' ')
      line += `  ${sink === 'tty' ? '\x1b[2m' + pairs + RESET : pairs}`
    }
    return line
  }

  /** 结构化 JSONL 行：完整 ISO 时间戳 + 级别 + 消息 + 合并后的上下文 */
  function renderStructured(level: LogLevel, message: string, fields?: LogFields): string {
    const entry: { ts: string; level: LogLevel; msg: string; ctx?: LogFields } = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    }
    const merged = mergeBindings(fields)
    if (Object.keys(merged).length > 0) entry.ctx = merged
    return JSON.stringify(entry)
  }

  /** 构造 bindings 与当次 fields 的合并视图（child 的上下文在构造时已并入 bindings） */
  function mergeBindings(fields?: LogFields): LogFields {
    return { ...options.bindings, ...fields }
  }

  function fmtVal(v: unknown): string {
    if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v
    try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
  }

  const logger: ILogger = {
    sink,
    log(level, message, fields) {
      if (LEVEL_ORDER[level] < minOrder) return
      if (inProgress && sink === 'tty') { write('\n'); inProgress = false }
      const line = structured
        ? renderStructured(level, message, fields)
        : render(level, message, fields)
      if (level === 'error') writeErr(line)
      else if (level === 'warn') write(line) // warn 走 stdout 便于管道合并；error 走 stderr
      else write(line)
    },
    debug(m, f) { logger.log('debug', m, f) },
    info(m, f) { logger.log('info', m, f) },
    warn(m, f) { logger.log('warn', m, f) },
    error(m, f) { logger.log('error', m, f) },
    child(bindings: LogFields): ILogger {
      // 子日志器：合并 bindings（txId/profile 等上下文）—— 人类模式输出为
      // 附加字段、结构化模式自动进入每行 ctx
      return createLogger({
        ...options,
        bindings: { ...options.bindings, ...bindings },
      })
    },
    progress(ratio, label) {
      // 结构化模式与 plain 同路径：不渲染 ANSI 进度条，走刻度去重的 JSON 行
      if (sink !== 'tty' || structured) {
        if (ratio === null) { lastEmittedTick = -1; return }
        // 非 TTY：只在整 10% 刻度输出一行，且同刻度不重复
        const pct = Math.round(ratio * 100)
        const tick = Math.floor(pct / 10) * 10
        if (pct % 10 === 0 && tick !== lastEmittedTick) {
          lastEmittedTick = tick
          write(structured
            ? renderStructured('debug', `[progress] ${label} ${pct}%`)
            : render('debug', `[progress] ${label} ${pct}%`))
        }
        return
      }
      const width = 24
      const filled = Math.round(width * Math.max(0, Math.min(1, ratio ?? 0)))
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
      const pct = ratio === null ? ' -- ' : String(Math.round(ratio * 100)).padStart(3) + '%'
      write(`\r\x1b[2m  ${bar} ${pct} ${label}\x1b[0m`)
      inProgress = ratio !== null && ratio < 1
      if (ratio === null || ratio >= 1) write('\n')
    },
  }
  return logger
}

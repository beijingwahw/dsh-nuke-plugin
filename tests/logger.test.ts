// tests/logger.test.ts — 日志器单测（V5：结构化 JSONL / 子日志器 / 人类模式保持）
import { describe, expect, it } from 'vitest'

import { createLogger } from '../src/infra/logger'
import type { LogWriter } from '../src/infra/logger'

/** 可注入写出捕获：不污染控制台 */
function capture() {
  const out: string[] = []
  const err: string[] = []
  const writer: LogWriter = l => out.push(l)
  const errWriter: LogWriter = l => err.push(l)
  return { out, err, writer, errWriter }
}

describe('人类模式（默认）保持不变', () => {
  it('输出带时间戳前缀的人类可读行（非 JSON）', () => {
    const { out, writer } = capture()
    const log = createLogger({ sink: 'plain', writer, errWriter: writer })
    log.info('hello', { k: 'v' })
    expect(out.length).toBe(1)
    expect(out[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO {2}hello/)
    expect(out[0]).toContain('k=v')
    expect(() => JSON.parse(out[0]!)).toThrow()   // 人类模式不是 JSON
  })

  it('error 走 errWriter，info 走 writer', () => {
    const { out, err, writer, errWriter } = capture()
    const log = createLogger({ sink: 'plain', writer, errWriter })
    log.error('boom')
    log.info('fine')
    expect(err.length).toBe(1)
    expect(out.length).toBe(1)
  })

  it('minLevel 过滤 debug', () => {
    const { out, writer } = capture()
    const log = createLogger({ sink: 'plain', minLevel: 'info', writer, errWriter: writer })
    log.debug('hidden')
    expect(out.length).toBe(0)
  })
})

describe('V5 结构化 JSONL 模式（structured: true）', () => {
  it('每行一个 JSON 对象：ts/level/msg；fields 进入 ctx', () => {
    const { out, writer } = capture()
    const log = createLogger({ structured: true, sink: 'plain', writer, errWriter: writer })
    log.info('hello', { file: 'a.txt' })
    log.warn('careful')
    const a = JSON.parse(out[0]!) as Record<string, unknown>
    const b = JSON.parse(out[1]!) as Record<string, unknown>
    expect(a.level).toBe('info')
    expect(a.msg).toBe('hello')
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(a.ctx).toEqual({ file: 'a.txt' })
    expect(b.level).toBe('warn')
    expect('ctx' in b).toBe(false)   // 无上下文时省略 ctx 键
  })

  it('结构化模式 error 行走 errWriter 且为合法 JSON', () => {
    const { err, writer, errWriter } = capture()
    const log = createLogger({ structured: true, sink: 'plain', writer, errWriter })
    log.error('boom', { code: 'E_IO' })
    const e = JSON.parse(err[0]!) as Record<string, unknown>
    expect(e.level).toBe('error')
    expect(e.msg).toBe('boom')
    expect(e.ctx).toEqual({ code: 'E_IO' })
  })

  it('构造 bindings 自动进入每行 ctx', () => {
    const { out, writer } = capture()
    const log = createLogger({
      structured: true, sink: 'plain', bindings: { txId: 't1' }, writer, errWriter: writer,
    })
    log.info('step')
    expect((JSON.parse(out[0]!) as Record<string, unknown>).ctx).toEqual({ txId: 't1' })
  })

  it('progress 结构化模式：非 TTY 整刻度输出 JSON 行', () => {
    const { out, writer } = capture()
    const log = createLogger({
      structured: true, sink: 'plain', minLevel: 'debug', writer, errWriter: writer,
    })
    log.progress(0.5, '清理中')   // 50% 整刻度
    const line = JSON.parse(out[0]!) as Record<string, unknown>
    expect(line.level).toBe('debug')
    expect(line.msg).toContain('50%')
    expect(line.msg).toContain('清理中')
  })
})

describe('V5 子日志器 child(bindings)', () => {
  it('人类模式：上下文作为附加字段随行输出', () => {
    const { out, writer } = capture()
    const log = createLogger({ sink: 'plain', writer, errWriter: writer })
    const child = log.child({ txId: 'tx-9', profile: 'web' })
    child.info('step done')
    expect(out[0]).toContain('txId=tx-9')
    expect(out[0]).toContain('profile=web')
  })

  it('结构化模式：child 上下文合并进 ctx，当次 fields 覆盖同名键', () => {
    const { out, writer } = capture()
    const log = createLogger({ structured: true, sink: 'plain', writer, errWriter: writer })
    const child = log.child({ txId: 'tx-9' })
    child.info('step done', { step: 2, txId: 'tx-override' })
    const line = JSON.parse(out[0]!) as Record<string, unknown>
    expect(line.ctx).toEqual({ txId: 'tx-override', step: 2 })
  })

  it('child 与父日志器上下文隔离（child 不污染父输出）', () => {
    const { out, writer } = capture()
    const log = createLogger({ structured: true, sink: 'plain', writer, errWriter: writer })
    const child = log.child({ txId: 'tx-9' })
    child.info('child line')
    log.info('parent line')
    const parent = JSON.parse(out[1]!) as Record<string, unknown>
    expect(parent.ctx).toBeUndefined()
  })
})

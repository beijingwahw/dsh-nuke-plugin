// tests/cli-traversal.test.ts — CLI 路径穿越回归测试
//
// 背景：assertSafe 旧版只有字符白名单 [a-z0-9@/-_.]，而 "../.." 恰由
// 白名单字符构成 → path.join(DSH_HOME, 'storages', '../..') 逃逸出
// DSH_HOME，clean 真跑会递归删除白名单外目录（删除工具的致命漏洞）。
// 本测试 spawn 真实 CLI，锁死所有穿越向量被拒 + 合法名放行。
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = path.resolve(__dirname, '../cli/dsh-nuke.cjs')

let dshHome: string

beforeAll(() => {
  dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-traversal-'))
  fs.mkdirSync(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(
    path.join(dshHome, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['lodash'] } } }),
  )
})

afterAll(() => fs.rmSync(dshHome, { recursive: true, force: true }))

interface RunResult {
  readonly code: number
  readonly stderr: string
}

/** spawn 真实 CLI（非 import —— 校验发生在进程入口，必须端到端验证） */
function runCli(args: readonly string[]): RunResult {
  try {
    const stderr = execFileSync('node', [CLI, ...args], {
      env: { ...process.env, DSH_HOME: dshHome },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stderr }
  } catch (e) {
    const err = e as { status?: number; stderr?: string }
    return { code: err.status ?? -1, stderr: err.stderr ?? '' }
  }
}

describe('CLI 路径穿越防御', () => {
  const traversalVectors = [
    '../../../etc',   // 经典上跳
    '../..',          // 上跳到 DSH_HOME 之外
    '/etc',           // 绝对路径
    '..',             // 单段上跳
    'a/../b',         // 中段上跳
    'a/../../c',      // 多段上跳
    '@scope/x/y',     // 超过 @scope/name 层级
    'name/',          // 尾随斜杠（非 scope 却多段）
    'a\\b',           // 反斜杠（Windows 分隔符）
    '.',              // 当前目录
  ]

  for (const evil of traversalVectors) {
    it(`scan 拒绝穿越向量 "${evil}"`, () => {
      const r = runCli(['scan', evil])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('非法')
    })

    it(`clean 拒绝穿越向量 "${evil}"（删除路径，更致命）`, () => {
      const r = runCli(['clean', evil, '--dry-run'])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('非法')
    })
  }

  it('snapshot 拒绝穿越插件名（拼入快照文件路径）', () => {
    const r = runCli(['snapshot', '../../evil', 'dead00ff'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('非法')
  })

  it('logs 拒绝非日期形态注入（拼入日志文件路径）', () => {
    const r = runCli(['logs', '../../etc/passwd'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('日期格式非法')
  })

  it('reports 拒绝含路径分隔符的事务 ID（拼入报告文件路径）', () => {
    const r = runCli(['reports', 'x/../../../etc/passwd', ''])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('事务 ID 非法')
  })

  it('reports 拒绝非白名单报告格式', () => {
    const r = runCli(['reports', 'abc123', '../../../etc/passwd'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('报告格式非法')
  })

  it('restore 拒绝含路径分隔符的备份文件名', () => {
    const r = runCli(['restore', '../../etc/passwd'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('非法')
  })

  it('合法名（普通 / @scope）仍放行', () => {
    // lodash 在 bundles 中 → scan 正常执行（可能报"无残留"，但不是校验拒绝）
    const r1 = runCli(['scan', 'lodash'])
    expect(r1.stderr).not.toContain('非法')

    const r2 = runCli(['scan', '@scope/pkg-name', '--profile', 'web'])
    expect(r2.stderr).not.toContain('非法')
  })
})

// tests/cli.test.ts — 独立 CLI 的 smoke 测试（子进程执行，验证协议而非内部实现）
// 覆盖：--version / --help 环境无关性、--json 机器可读输出、V4 锁互斥与安全破锁
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '..')
const CLI = path.join(REPO_ROOT, 'cli', 'dsh-nuke.cjs')

let tmp: string
let dshHome: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'))
  dshHome = path.join(tmp, 'dsh-home')
  fs.mkdirSync(dshHome, { recursive: true })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** 以指定 DSH_HOME 运行 CLI，返回 { status, stdout, stderr } */
function runCli(args: string[], home = dshHome) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,                      // CLI 以 require('./package.json') 读版本，cwd 必须在仓库根
    encoding: 'utf-8',
    env: { ...process.env, DSH_HOME: home },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** 构造 V4 协议锁文件（与插件版 lock-manager 同格式） */
function writeV4Lock(name: string, pid: number, expiresAt: number, purpose = 'test', startTime?: number) {
  const lockDir = path.join(dshHome, '.nuke', 'locks')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, name), JSON.stringify({
    version: 1, scope: 'global', mode: 'exclusive',
    owners: [{
      owner: {
        pid, hostname: os.hostname(), bootToken: `test-${name}`, purpose,
        ...(startTime !== undefined ? { startTime } : {}),
      },
      acquiredAt: new Date().toISOString(), expiresAt,
    }],
  }, null, 2))
}

describe('CLI 基础协议', () => {
  it('--version 输出版本号，且不依赖 DSH_HOME 存在', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
    const missing = path.join(tmp, 'no-such-home')   // 不存在的环境
    const r = runCli(['--version'], missing)
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  it('--help 在 DSH_HOME 缺失时仍可用（排障优先）', () => {
    const missing = path.join(tmp, 'no-such-home')
    const r = runCli(['--help'], missing)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('子命令')
    expect(r.stdout).toContain('--json')
  })

  it('strategies 在空环境正常输出', () => {
    const r = runCli(['strategies'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('safe')
  })
})

describe('CLI --json 机器可读输出', () => {
  it('scan --json 输出合法 JSON（空环境 → 零残留）', () => {
    const r = runCli(['scan', 'some-plugin', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.command).toBe('scan')
    expect(parsed.plugin).toBe('some-plugin')
    expect(parsed.residuals).toEqual([])
    expect(parsed.totalResiduals).toBe(0)
  })

  it('deps --json 输出合法 JSON（空环境 → 无依赖方）', () => {
    const r = runCli(['deps', 'some-plugin', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.command).toBe('deps')
    expect(parsed.blocked).toBe(false)
  })

  it('health --json 输出合法 JSON', () => {
    const r = runCli(['health', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.command).toBe('health')
    expect(typeof parsed.total).toBe('number')
  })

  it('sweep --json 输出合法 JSON（空环境）', () => {
    const r = runCli(['sweep', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.command).toBe('sweep')
    expect(parsed.total).toBe(0)
  })
})

describe('CLI V4 锁互斥（与插件版共享 .nuke/locks/ 协议）', () => {
  it('活跃 V4 锁（持有者存活且未过期）→ clean 拒绝执行', () => {
    writeV4Lock('global.lock', process.pid, Date.now() + 60_000, 'plugin-clean')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('🔒')
    // 互斥拒绝时不得破坏他人锁文件
    expect(fs.existsSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))).toBe(true)
    fs.rmSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))
  })

  it('其他作用域的活跃锁（插件并发清理中）→ CLI 让路', () => {
    writeV4Lock('profile_web.lock', process.pid, Date.now() + 60_000, 'clean')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('并发清理')
    fs.rmSync(path.join(dshHome, '.nuke', 'locks', 'profile_web.lock'))
  })

  it('陈旧锁（进程死亡 + TTL 过期）→ 安全破锁后继续执行', () => {
    writeV4Lock('global.lock', 999_999_999, Date.now() - 60_000, 'dead-process')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(0)
    // 破锁后 CLI 自己的锁在结束时也应清理干净
    expect(fs.existsSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))).toBe(false)
  })

  it('v5.6.2 持有者存活但 TTL 过期 → 不破锁拒绝执行（双条件纪律，防并发清理）', () => {
    // 旧实现 hasActiveOwner=some(未过期&&存活)：存活+过期 → 判非活跃 → 破锁
    // → 与仍在工作的持有者并发清理。修复后必须双条件（死&&过期）才破。
    writeV4Lock('global.lock', process.pid, Date.now() - 60_000, 'slow-but-alive')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('🔒')
    // 不得破坏活持有者的锁文件
    expect(fs.existsSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))).toBe(true)
    fs.rmSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))
  })

  it('v5.6.2 持有者已死但 TTL 未过期 → 不破锁拒绝执行（等 TTL 到期）', () => {
    writeV4Lock('global.lock', 999_999_999, Date.now() + 60_000, 'dead-not-expired')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(1)
    expect(fs.existsSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))).toBe(true)
    fs.rmSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))
  })

  it('V3 遗留锁未超时 → 拒绝（升级窗口期保护）；超时 → 清除后继续', () => {
    // 未超时：拒绝
    fs.writeFileSync(path.join(dshHome, '.nuke.lock'), JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), operation: 'legacy', timeout: 300000,
    }))
    const r1 = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r1.status).toBe(1)
    expect(r1.stderr).toContain('V3 遗留锁')
    // 超时：清除后放行
    fs.writeFileSync(path.join(dshHome, '.nuke.lock'), JSON.stringify({
      pid: process.pid, startedAt: new Date(Date.now() - 400_000).toISOString(), operation: 'legacy', timeout: 300000,
    }))
    const r2 = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r2.status).toBe(0)
    expect(fs.existsSync(path.join(dshHome, '.nuke.lock'))).toBe(false)
  })

  it('clean 结束后不留自己的锁（bootToken 归属自清理）', () => {
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(0)
    const locksDir = path.join(dshHome, '.nuke', 'locks')
    const leftover = fs.existsSync(locksDir)
      ? fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'))
      : []
    expect(leftover).toEqual([])
  })
})

describe('CLI 崩溃兜底', () => {
  it('未捕获异常以 fail-closed 姿态退出（exit 1 + 提示），不裸抛栈', () => {
    // 制造未捕获异常：DSH_HOME 指向一个文件而非目录 → acquireLock 的 mkdirSync 抛 ENOTDIR
    const notADir = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(notADir, 'x')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'], notADir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('未捕获异常')
    expect(r.stderr).toContain('issues')
  })
})

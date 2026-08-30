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
function writeV4Lock(name: string, pid: number, expiresAt: number, purpose = 'test', startTime?: number, hostname = os.hostname()) {
  const lockDir = path.join(dshHome, '.nuke', 'locks')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, name), JSON.stringify({
    version: 1, scope: 'global', mode: 'exclusive',
    owners: [{
      owner: {
        pid, hostname, bootToken: `test-${name}`, purpose,
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

  it('V5.8.8 同机持有者已死但 TTL 未过期 → 立即回收继续执行（内核 ESRCH 权威证明，不等 TTL）', () => {
    // 旧纪律（死+TTL 双条件）下崩溃的 CLI 会阻塞后续清理 5 分钟；
    // V5.8.8 与插件版 slotReapable 对齐：同机死亡即终局，立即回收。
    writeV4Lock('global.lock', 999_999_999, Date.now() + 60_000, 'dead-not-expired')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(0)
    // 回收后 CLI 自己的锁在结束时也应清理干净
    expect(fs.existsSync(path.join(dshHome, '.nuke', 'locks', 'global.lock'))).toBe(false)
  })

  it('V5.8.8 跨机持有者已死且 TTL 未过期 → 维持双条件拒绝（共享存储防误删远程存活者）', () => {
    writeV4Lock('global.lock', 999_999_999, Date.now() + 60_000, 'remote-dead', undefined, 'other-host')
    const r = runCli(['clean', 'foo-plugin', '--dry-run'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('跨机')
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

describe('CLI V5.8.9 残留清理回归（实测发现的两个漏清）', () => {
  /** 独立迷你 DSH 环境（避免与其他用例共享 dshHome 的锁目录） */
  function makeEnv() {
    const home = path.join(tmp, `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
    return home
  }

  it('悬空声明（已声明未安装）→ clean 移除 dependencies/bundles 声明，防删除后复活', () => {
    const home = makeEnv()
    const pkg = path.join(home, 'profiles', 'web', 'package.json')
    fs.writeFileSync(pkg, JSON.stringify({
      dependencies: { 'zombie-plugin': '^1', 'keep-me': '^1' },
      dsh: { profile: { bundles: ['zombie-plugin', 'keep-me'] } },
    }))
    const r = runCli(['clean', 'zombie-plugin', '--profile', 'web', '--skip-standard'], home)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('验证通过')
    const after = JSON.parse(fs.readFileSync(pkg, 'utf-8'))
    expect(after.dependencies).toEqual({ 'keep-me': '^1' })
    expect(after.dsh.profile.bundles).toEqual(['keep-me'])
  })

  it('allowBuilds 列表项（- plugin）→ clean 从 pnpm-workspace.yaml 摘除该行（旧行过滤只匹配映射键）', () => {
    const home = makeEnv()
    const ws = path.join(home, 'profiles', 'web', 'pnpm-workspace.yaml')
    fs.writeFileSync(ws, 'allowBuilds:\n  - victim-plugin\n  - keep-me\n')
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({}))
    const r = runCli(['clean', 'victim-plugin', '--profile', 'web', '--skip-standard'], home)
    expect(r.status).toBe(0)
    const after = fs.readFileSync(ws, 'utf-8')
    expect(after).not.toContain('victim-plugin')
    expect(after).toContain('keep-me')
  })

  it('正常安装（node_modules 存在）→ 不误报悬空声明', () => {
    const home = makeEnv()
    fs.mkdirSync(path.join(home, 'profiles', 'web', 'node_modules', 'alive-plugin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { 'alive-plugin': '^1' },
      dsh: { profile: { bundles: ['alive-plugin'] } },
    }))
    const r = runCli(['scan', 'alive-plugin', '--profile', 'web', '--json'], home)
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { residuals: { description?: string }[] }
    expect(parsed.residuals.filter(x => x.description?.includes('悬空声明'))).toEqual([])
  })
})

describe('CLI V5.9.0 深度优化回归（pnpm 实体 / 依赖阻断 / lockfile）', () => {
  function makeEnv() {
    const home = path.join(tmp, `env9-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
    return home
  }

  /** 构造 pnpm 结构：链接层 + .pnpm 实体（victim 两版本 + other-lib）+ lockfile */
  function seedPnpm(home: string) {
    const pd = path.join(home, 'profiles', 'web')
    const nm = path.join(pd, 'node_modules')
    fs.mkdirSync(path.join(nm, 'victim-plugin'), { recursive: true })
    fs.writeFileSync(path.join(nm, 'victim-plugin', 'package.json'), '{"name":"victim-plugin"}')
    for (const ent of ['victim-plugin@1.0.0', 'victim-plugin@2.0.0', 'other-lib@9.9.9']) {
      const d = path.join(nm, '.pnpm', ent, 'node_modules', ent.split('@')[0]!)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'index.js'), 'x'.repeat(300))
    }
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
      dependencies: { 'victim-plugin': '^1' },
      dsh: { profile: { bundles: ['victim-plugin'] } },
    }))
    fs.writeFileSync(path.join(pd, 'pnpm-lock.yaml'), 'packages:\n\n  victim-plugin@1.0.0:\n    resolution: {integrity: sha512-x}\n')
    return pd
  }

  it('pnpm 实体清理：clean 删链接层 + .pnpm 实体（含多版本），other-lib 不碰，lockfile 保留', () => {
    const home = makeEnv()
    const pd = seedPnpm(home)
    const r = runCli(['clean', 'victim-plugin', '--profile', 'web', '--skip-standard'], home)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('pnpm 虚拟存储实体 ×2')
    // 链接层与实体已清，他人实体保留
    expect(fs.existsSync(path.join(pd, 'node_modules', '.pnpm', 'victim-plugin@1.0.0'))).toBe(false)
    expect(fs.existsSync(path.join(pd, 'node_modules', '.pnpm', 'victim-plugin@2.0.0'))).toBe(false)
    expect(fs.existsSync(path.join(pd, 'node_modules', '.pnpm', 'other-lib@9.9.9'))).toBe(true)
    // lockfile report-only：文件保留，残留输出为 ℹ️ 提示
    expect(fs.existsSync(path.join(pd, 'pnpm-lock.yaml'))).toBe(true)
    expect(r.stdout).toContain('仅报告')
  })

  it('依赖方存在 → clean 阻断（exit 1，零副作用）；--force 越过执行', () => {
    const home = makeEnv()
    const pd = path.join(home, 'profiles', 'web')
    fs.mkdirSync(path.join(pd, 'node_modules', 'victim-plugin'), { recursive: true })
    fs.mkdirSync(path.join(pd, 'node_modules', 'keeper-plugin'), { recursive: true })
    fs.writeFileSync(path.join(pd, 'node_modules', 'keeper-plugin', 'package.json'),
      JSON.stringify({ name: 'keeper-plugin', dependencies: { 'victim-plugin': '^1' } }))
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({
      dependencies: { 'victim-plugin': '^1', 'keeper-plugin': '^1' },
      dsh: { profile: { bundles: ['victim-plugin', 'keeper-plugin'] } },
    }))
    // 阻断：exit 1 + 目录原封不动
    const blocked = runCli(['clean', 'victim-plugin', '--profile', 'web', '--skip-standard'], home)
    expect(blocked.status).toBe(1)
    expect(blocked.stderr).toContain('--force')
    expect(fs.existsSync(path.join(pd, 'node_modules', 'victim-plugin'))).toBe(true)
    // --force：越过并真正清理
    const forced = runCli(['clean', 'victim-plugin', '--profile', 'web', '--skip-standard', '--force'], home)
    expect(forced.status).toBe(0)
    expect(forced.stdout).toContain('--force')
    expect(fs.existsSync(path.join(pd, 'node_modules', 'victim-plugin'))).toBe(false)
  })

  it('lockfile 残留：scan --json 输出 report-only 条目（sizeBytes=0，不虚报可回收空间）', () => {
    const home = makeEnv()
    seedPnpm(home)
    const r = runCli(['scan', 'victim-plugin', '--profile', 'web', '--json'], home)
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { residuals: { description?: string; sizeBytes?: number; action?: string }[] }
    const lock = parsed.residuals.find(x => x.action === 'report-only' && x.description?.includes('pnpm-lock.yaml'))
    expect(lock).toBeDefined()
    expect(lock!.sizeBytes).toBe(0)
  })
})

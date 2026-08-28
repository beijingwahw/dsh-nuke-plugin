// tests/bin-resolver.test.ts — 命令解析器（PATH 救援）单元测试
// 场景原型：dsh 经 nvm 安装，用户 shell 的 rc 文件注入 PATH，宿主进程不加载 rc
// → 宿主 PATH 缺失 → spawnSync ENOENT → 旧健康检查误报 critical 阻断清理
import { describe, expect, it } from 'vitest'
import * as path from 'path'
import {
  globalBinCandidates, resolveCommand, resolveInDirs, resolveOnPath,
} from '../src/infra/bin-resolver'

const SEP = path.sep
const join = (...p: readonly string[]) => p.join(SEP)

describe('resolveInDirs：候选目录扫描', () => {
  it('按目录序返回第一个命中；未命中返回 null', () => {
    const exists = (p: string) => p === join('/usr', 'local', 'bin', 'dsh')
    expect(resolveInDirs('dsh', ['/nope', '/usr/local/bin', '/opt/homebrew/bin'], { exists })?.path)
      .toBe(join('/usr', 'local', 'bin', 'dsh'))
    expect(resolveInDirs('dsh', ['/nope'], { exists })).toBeNull()
  })

  it('win32 平台补全 .cmd/.exe/.bat 扩展名（.cmd 优先）', () => {
    const exists = (p: string) => p.endsWith('dsh.cmd')
    const hit = resolveInDirs('dsh', ['C:\\npm'], { exists, platform: 'win32' })
    expect(hit?.path).toBe(path.join('C:\\npm', 'dsh.cmd'))
  })

  it('unix 平台不补扩展名', () => {
    const exists = (p: string) => p === join('/bin', 'dsh')
    expect(resolveInDirs('dsh', ['/bin'], { exists, platform: 'linux' })?.path)
      .toBe(join('/bin', 'dsh'))
  })
})

describe('resolveOnPath：沿 PATH 解析（shell 语义）', () => {
  it('PATH 命中 → fromPath=true', () => {
    const exists = (p: string) => p === join('/usr', 'local', 'bin', 'pnpm')
    const hit = resolveOnPath('pnpm', { exists, env: { PATH: '/a:/usr/local/bin' } })
    expect(hit?.fromPath).toBe(true)
    expect(hit?.dir).toBe('/usr/local/bin')
  })

  it('PATH 缺失 → null（交给候选目录救援）', () => {
    expect(resolveOnPath('dsh', { exists: () => false, env: { PATH: '/a:/b' } })).toBeNull()
  })
})

describe('globalBinCandidates：宿主 PATH 缺失时的救援目录', () => {
  it('linux：包含系统路径与 nvm 版本目录（home 注入可测）', () => {
    const home = join('/home', 'tester')
    const dirs = globalBinCandidates({
      platform: 'linux', homedir: () => home, env: { PATH: '' },
    })
    expect(dirs).toContain('/usr/local/bin')
    expect(dirs).toContain(join(home, '.local', 'bin'))
    expect(dirs).toContain(join(home, '.volta', 'bin'))
    expect(dirs).toContain(join(home, '.asdf', 'shims'))
    // nvm 版本目录（readdirSync 真实探测，沙箱可能无 nvm —— 只验证不炸且有固定前缀）
    for (const d of dirs) {
      if (d.includes('.nvm')) expect(d.endsWith(join('bin'))).toBe(true)
    }
  })

  it('win32：包含 %APPDATA%\\npm 与 NVM_HOME', () => {
    const dirs = globalBinCandidates({
      platform: 'win32', homedir: () => 'C:\\Users\\t',
      env: { PATH: '', APPDATA: 'C:\\Users\\t\\AppData\\Roaming', NVM_HOME: 'C:\\nvm' },
    })
    // 语义断言（跨平台：测试可能在非 win 平台运行，路径分隔符随平台）
    expect(dirs.some(d => d.includes('AppData') && d.endsWith('npm'))).toBe(true)
    expect(dirs).toContain('C:\\nvm')
  })
})

describe('resolveCommand：PATH 救援总入口', () => {
  it('PATH 直命中优先于候选目录', () => {
    const exists = (p: string) => p === join('/on', 'path', 'dsh')
    const hit = resolveCommand('dsh', { exists, env: { PATH: '/on/path' }, platform: 'linux', homedir: () => '/nowhere' })
    expect(hit?.fromPath).toBe(true)
    expect(hit?.path).toBe(join('/on', 'path', 'dsh'))
  })

  it('PATH 未命中 → 候选目录救援（fromPath=false）—— nvm 场景', () => {
    const nvmBin = join('/home', 't', '.nvm', 'versions', 'node', 'v24.1.0', 'bin')
    // 模拟：PATH 里没有 dsh，但救援候选中 /usr/local/bin 有
    const exists = (p: string) => p === join('/usr', 'local', 'bin', 'dsh')
    const hit = resolveCommand('dsh', {
      exists, env: { PATH: '/only/other' }, platform: 'linux', homedir: () => '/home/t',
    })
    expect(hit).not.toBeNull()
    expect(hit!.fromPath).toBe(false)
    expect(hit!.path).toBe(join('/usr', 'local', 'bin', 'dsh'))
    void nvmBin
  })

  it('全落空 → null', () => {
    expect(resolveCommand('no-such-cmd-xyz', {
      exists: () => false, env: { PATH: '/a' }, platform: 'linux', homedir: () => '/nowhere',
    })).toBeNull()
  })
})

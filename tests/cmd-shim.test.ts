// tests/cmd-shim.test.ts — Windows 批处理 shim（.cmd/.bat）spawn 适配器
//
// 回归背景：Node.js 修复 CVE-2024-27980 后，Windows 上 spawn/spawnSync 直接
// 执行 .cmd/.bat 必须显式 shell: true，否则抛 EINVAL —— 救援链找到
// D:\...\dsh.cmd 却无法执行，standard-remove 整步失败（E_IO）。
import { describe, expect, it } from 'vitest'

import { adaptSpawnInvocation, isBatchShim } from '../src/infra/cmd-shim'

describe('isBatchShim（判定是否需要 ComSpec 包装）', () => {
  it('Windows + .cmd/.bat（含大小写混合）→ true', () => {
    expect(isBatchShim('D:\\DeepSeekHarness\\dsh.cmd', 'win32')).toBe(true)
    expect(isBatchShim('C:\\tools\\dsh.CMD', 'win32')).toBe(true)
    expect(isBatchShim('C:\\tools\\run.BAT', 'win32')).toBe(true)
  })

  it('Windows + 其他扩展名/裸名/.exe → false', () => {
    expect(isBatchShim('D:\\dsh.exe', 'win32')).toBe(false)
    expect(isBatchShim('D:\\dsh', 'win32')).toBe(false)
    expect(isBatchShim('/usr/local/bin/dsh', 'win32')).toBe(false)
  })

  it('非 Windows 平台一律 false（.cmd 也不包装）', () => {
    expect(isBatchShim('/opt/dsh.cmd', 'linux')).toBe(false)
    expect(isBatchShim('/opt/dsh.cmd', 'darwin')).toBe(false)
  })
})

describe('adaptSpawnInvocation（spawn 调用适配）', () => {
  it('Windows .cmd → ComSpec /d /s /c 包装，参数保持 argv 形态', () => {
    const t = adaptSpawnInvocation(
      'D:\\DeepSeekHarness\\dsh.cmd',
      ['plugin', '--profile', 'web', 'remove', 'demo-plugin'],
      'C:\\Windows\\system32\\cmd.exe',
      'win32',
    )
    expect(t.file).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(t.args).toEqual([
      '/d', '/s', '/c',
      'D:\\DeepSeekHarness\\dsh.cmd',
      'plugin', '--profile', 'web', 'remove', 'demo-plugin',
    ])
  })

  it('Windows .bat 同样包装', () => {
    const t = adaptSpawnInvocation('C:\\x\\pnpm.bat', ['--version'], 'cmd.exe', 'win32')
    expect(t.file).toBe('cmd.exe')
    expect(t.args).toEqual(['/d', '/s', '/c', 'C:\\x\\pnpm.bat', '--version'])
  })

  it('ComSpec 未定义 → cmd.exe 兜底', () => {
    const t = adaptSpawnInvocation('C:\\x\\dsh.cmd', [], undefined, 'win32')
    expect(t.file).toBe('cmd.exe')
  })

  it('Windows .exe / 裸名 → 原样（零行为变化）', () => {
    expect(adaptSpawnInvocation('D:\\dsh.exe', ['--version'], 'cmd.exe', 'win32'))
      .toEqual({ file: 'D:\\dsh.exe', args: ['--version'] })
    expect(adaptSpawnInvocation('dsh', ['--version'], 'cmd.exe', 'win32'))
      .toEqual({ file: 'dsh', args: ['--version'] })
  })

  it('非 Windows 平台 → 原样（unix 路径不受影响）', () => {
    expect(adaptSpawnInvocation('/usr/local/bin/dsh', ['--version'], 'cmd.exe', 'linux'))
      .toEqual({ file: '/usr/local/bin/dsh', args: ['--version'] })
    expect(adaptSpawnInvocation('/opt/dsh.cmd', ['--version'], 'cmd.exe', 'darwin'))
      .toEqual({ file: '/opt/dsh.cmd', args: ['--version'] })
  })
})

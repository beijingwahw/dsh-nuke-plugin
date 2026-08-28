import { describe, expect, it } from 'vitest'

import { createValidator } from '../src/infra/validator'

const lin = createValidator('linux')
const win = createValidator('windows')

describe('validatePluginName', () => {
  it.each(['dsh-nuke-plugin', '@deepseek-ai/dsh-tools', 'a', 'pkg.name_v1.2'])(
    '接受合法包名 %s', (name) => {
      const r = lin.validatePluginName(name)
      expect(r.ok).toBe(true)
    })

  it.each([
    '', 'pkg;rm -rf', 'pkg$(cmd)', '../escape', 'UPPER', 'pkg name', 'pkg|cat',
    '@scope', 'a'.repeat(215),
  ])('拒绝非法包名 %s', (name) => {
    const r = lin.validatePluginName(name)
    expect(r.ok).toBe(false)
  })

  it('NUL 字节被拦截', () => {
    const r = lin.validatePluginName('pkg\0evil')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.some(v => v.kind === 'nul-byte' || v.kind === 'charset')).toBe(true)
  })
})

describe('validateProfileName', () => {
  it('接受合法 profile', () => {
    expect(lin.validateProfileName('web').ok).toBe(true)
    expect(lin.validateProfileName('profile-1').ok).toBe(true)
  })
  it.each(['', 'profiles', 'storages', 'Web', 'has space', 'a'.repeat(65), '../x'])(
    '拒绝非法 profile %s', (name) => {
      expect(lin.validateProfileName(name).ok).toBe(false)
    })
})

describe('validatePath', () => {
  it('拒绝路径穿越', () => {
    const r = lin.validatePath('/tmp/safe/../../etc/passwd', { mustBeAbsolute: true, strictWindows: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.some(v => v.kind === 'traversal')).toBe(true)
  })
  it('拒绝相对路径（mustBeAbsolute）', () => {
    expect(lin.validatePath('relative/path', { mustBeAbsolute: true, strictWindows: false }).ok).toBe(false)
  })
  it('拒绝 NUL', () => {
    expect(lin.validatePath('/tmp/x\0y', { mustBeAbsolute: true, strictWindows: false }).ok).toBe(false)
  })
  it('Windows 严格模式拒绝 UNC', () => {
    const r = win.validatePath('\\\\server\\share\\f', { mustBeAbsolute: true, strictWindows: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.some(v => v.kind === 'unc-path')).toBe(true)
  })
  it('Windows 严格模式拒绝保留设备名', () => {
    const r = win.validatePath('C:\\temp\\CON.log', { mustBeAbsolute: true, strictWindows: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.some(v => v.kind === 'syntax')).toBe(true)
  })
  it('接受普通绝对路径', () => {
    expect(lin.validatePath('/tmp/ok/file.txt', { mustBeAbsolute: true, strictWindows: false }).ok).toBe(true)
  })
})

describe('validateRegex', () => {
  it('接受简单正则', () => {
    expect(lin.validateRegex('^dsh-.*$').ok).toBe(true)
  })
  it('拒绝嵌套量词（ReDoS）', () => {
    const r = lin.validateRegex('(a+)+')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.some(v => v.kind === 'regex-unsafe')).toBe(true)
  })
  it('拒绝语法错误', () => {
    expect(lin.validateRegex('[unclosed').ok).toBe(false)
  })
})

describe('validateCommandArgv', () => {
  const allow = ['node', 'pnpm', 'dsh', 'python']
  it('接受白名单命令', () => {
    expect(lin.validateCommandArgv(['node', '-e', 'console.log(1)'], allow).ok).toBe(true)
    expect(lin.validateCommandArgv(['pnpm', 'store', 'prune'], allow).ok).toBe(true)
  })
  it('拒绝白名单外二进制', () => {
    expect(lin.validateCommandArgv(['sh', '-c', 'rm -rf /'], allow).ok).toBe(false)
    expect(lin.validateCommandArgv(['/bin/bash', '-c', 'x'], allow).ok).toBe(false)
  })
  it('拒绝 shell 元字符', () => {
    expect(lin.validateCommandArgv(['node', '-e', 'x;rm'], allow).ok).toBe(false)
    expect(lin.validateCommandArgv(['node', '`cmd`'], allow).ok).toBe(false)
    expect(lin.validateCommandArgv(['node', '$(x)'], allow).ok).toBe(false)
  })
  it('Windows exe 后缀归一后命中白名单（但含路径分隔符，安全语义下拒绝）', () => {
    // argv[0] 带路径 = 白名单绕过面（basename 命中但执行任意路径），一律拒绝
    expect(win.validateCommandArgv(['C:\\Program Files\\nodejs\\node.exe', '-v'], allow).ok).toBe(false)
    // 裸命令名 + exe 后缀仍可归一命中白名单
    expect(win.validateCommandArgv(['node.exe', '-v'], allow).ok).toBe(true)
  })
})

describe('sanitizeForDisplay', () => {
  it('剥离 ANSI 转义序列', () => {
    expect(lin.sanitizeForDisplay('\x1b[31mred\x1b[0m')).toBe('red')
  })
  it('剥离 OSC 序列与控制字符', () => {
    expect(lin.sanitizeForDisplay('\x1b]0;title\x07text\x07')).toBe('text\x07'.replace('\x07', ''))
    expect(lin.sanitizeForDisplay('a\x00b\x07c')).toBe('abc')
  })
})

// ─── V5：profile 名字符集与插件名白名单对齐 ──

describe('V5 profile 名字符集（与插件名同等白名单 [a-z0-9-._~]）', () => {
  it.each(['web.profile_1', 'a~b', 'x-y.z'])('接受对齐字符集 profile %s', (name) => {
    expect(lin.validateProfileName(name).ok).toBe(true)
  })
  it.each(['@scope/x', 'web profile', '.hidden', '_under', 'UPPER'])(
    '仍拒绝非法 profile %s', (name) => {
      expect(lin.validateProfileName(name).ok).toBe(false)
    })
})

// ─── V5：批量校验（validateAll 汇总全部错误） ──

describe('V5 validateAll 批量校验', () => {
  it('多字段同时非法 → 一次性汇总全部字段错误', () => {
    const r = lin.validateAll({
      pluginName: 'BAD NAME',
      profileName: 'profiles',
      path: 'rel/../x',
      regex: '(a+)+',
      commandArgv: ['sh', '-c'],
      allowBin: ['node'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const fields = new Set(r.error.map(v => v.field))
      expect(fields.has('pluginName')).toBe(true)
      expect(fields.has('profileName')).toBe(true)
      expect(fields.has('path')).toBe(true)
      expect(fields.has('regex')).toBe(true)
      expect(fields.has('command')).toBe(true)
      expect(r.error.length).toBeGreaterThanOrEqual(5)
    }
  })

  it('全部字段合法 → ok', () => {
    const r = lin.validateAll({
      pluginName: 'dsh-nuke-plugin',
      profileName: 'web',
      path: '/tmp/ok/file.txt',
      pathOptions: { mustBeAbsolute: true, strictWindows: false },
      regex: '^dsh-.*$',
      commandArgv: ['node', '-v'],
      allowBin: ['node'],
    })
    expect(r.ok).toBe(true)
  })

  it('缺省字段跳过（仅校验提供的字段）', () => {
    expect(lin.validateAll({ pluginName: 'pkg' }).ok).toBe(true)
    const r = lin.validateAll({ profileName: 'PROFILES' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.every(v => v.field === 'profileName')).toBe(true)
  })
})

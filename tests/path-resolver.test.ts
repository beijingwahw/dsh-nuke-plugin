import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createPathResolver } from '../src/infra/path-resolver'
import type { PathPolicy } from '../src/contracts/paths'

let tmp: string
let fakeDshHome: string
let resolver: ReturnType<typeof createPathResolver>

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'))
  fakeDshHome = path.join(tmp, '.dsh')
  fs.mkdirSync(path.join(fakeDshHome, 'profiles', 'web'), { recursive: true })
  fs.mkdirSync(path.join(fakeDshHome, 'storages'), { recursive: true })
  fs.mkdirSync(path.join(fakeDshHome, '.nuke', 'backups'), { recursive: true })
  fs.writeFileSync(path.join(fakeDshHome, 'cordis.patch.yml'), '- id: x\n')
  resolver = createPathResolver({
    env: {
      HOME: tmp,
      TEMP: path.join(tmp, 'tmp'),
      TMPDIR: path.join(tmp, 'tmp'),
      DSH_HOME: fakeDshHome,
    },
  })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const policy: PathPolicy = {
  allowedRoots: [
    { kind: 'profile-dir', profile: 'web' },
    { kind: 'storages' },
    { kind: 'dsh-home-patch' },
  ],
  denyGlobs: ['@deepseek-ai/dsh-base*', 'node_modules/.pnpm', '*.lock'],
  strictWindows: false,
}

describe('platform', () => {
  it('解析三平台信息与 DSH_HOME 覆盖', () => {
    const info = resolver.platform()
    expect(info.dshHome).toBe(fakeDshHome)
    expect(info.os).toBe(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')
  })
})

describe('canonicalize / isWithin', () => {
  it('canonicalize 解析 symlink', async () => {
    const real = path.join(fakeDshHome, 'profiles', 'web')
    const link = path.join(tmp, 'web-link')
    fs.symlinkSync(real, link)
    const c = await resolver.canonicalize(link)
    expect(c.ok).toBe(true)
    if (c.ok) expect(c.value).toBe(real)
  })

  it('isWithin 拒绝前缀伪装（/a/bc 不在 /a/b 内）', async () => {
    expect(await resolver.isWithin('/x/a/bc', '/x/a/b' as any)).toBe(false)
    expect(await resolver.isWithin('/x/a/b/c', '/x/a/b' as any)).toBe(true)
  })

  it('isWithin 经 symlink 解析后判定（防符号链接逃逸）', async () => {
    const outsideDir = path.join(tmp, 'outside')
    fs.mkdirSync(outsideDir, { recursive: true })
    const link = path.join(fakeDshHome, 'profiles', 'web', 'escape-link')
    if (fs.existsSync(link)) fs.rmSync(link)
    fs.symlinkSync(outsideDir, link)
    expect(await resolver.isWithin(link, outsideDir as any)).toBe(true)
    expect(await resolver.isWithin(link, path.join(fakeDshHome, 'profiles') as any)).toBe(false)
    fs.unlinkSync(link)
  })
})

describe('assertDeletable', () => {
  it('放行白名单根内路径', async () => {
    const target = path.join(fakeDshHome, 'storages', 'some-plugin')
    fs.mkdirSync(target, { recursive: true })
    const r = await resolver.assertDeletable(target, policy)
    expect(r.ok).toBe(true)
  })

  it('拦截白名单外路径（E_PATH_POLICY）', async () => {
    const outside = path.join(tmp, 'outside', 'file.txt')
    fs.writeFileSync(outside, 'x')
    const r = await resolver.assertDeletable(outside, policy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_PATH_POLICY')
  })

  it('denyGlobs 拒绝 dsh-base 样式', async () => {
    const target = path.join(fakeDshHome, 'storages', '@deepseek-ai')
    fs.mkdirSync(path.join(target, 'dsh-base'), { recursive: true })
    const r = await resolver.assertDeletable(path.join(target, 'dsh-base'), policy)
    expect(r.ok).toBe(false)
  })

  it('nuke 自身状态目录永不可删（双保险）', async () => {
    const target = path.join(fakeDshHome, '.nuke', 'backups', 'tx1')
    fs.mkdirSync(target, { recursive: true })
    const r = await resolver.assertDeletable(target, policy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_PATH_POLICY')
  })

  it('symlink 指向白名单外 → 拦截', async () => {
    const outsideDir = path.join(tmp, 'outside2')
    fs.mkdirSync(outsideDir, { recursive: true })
    const link = path.join(fakeDshHome, 'storages', 'evil-link')
    if (fs.existsSync(link)) fs.rmSync(link)
    fs.symlinkSync(outsideDir, link)
    const r = await resolver.assertDeletable(link, policy)
    expect(r.ok).toBe(false)
    fs.unlinkSync(link)
  })
})

describe('根路径派生', () => {
  it('nukeStateRoot / dshHomePatchFile', () => {
    expect(resolver.nukeStateRoot()).toBe(path.join(fakeDshHome, '.nuke'))
    expect(resolver.dshHomePatchFile()).toBe(path.join(fakeDshHome, 'cordis.patch.yml'))
  })
})

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

// ─── V5：路径规范化加固（控制字符 / NFC 归一 / 平台感知 casefold） ──

describe('V5 控制字符路径拒绝', () => {
  it('含 C0 控制字符（\\x01）→ E_PATH_POLICY 拒绝', async () => {
    const r = await resolver.assertDeletable(path.join(fakeDshHome, 'storages', 'a\x01b'), policy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_PATH_POLICY')
  })
  it('含 NUL 字节 → 拒绝', async () => {
    const r = await resolver.assertDeletable(path.join(fakeDshHome, 'storages', 'a\0b'), policy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_PATH_POLICY')
  })
  it('含 DEL（\\x7f）→ 拒绝', async () => {
    const r = await resolver.assertDeletable(path.join(fakeDshHome, 'storages', 'a\x7fb'), policy)
    expect(r.ok).toBe(false)
  })
})

describe('V5 NFC Unicode 归一（防同形异码绕过白名单）', () => {
  // 'é' 的两种 Unicode 表示：NFC 预组合（U+00E9）与 NFD 组合（e + U+0301）
  const nfcPath = `${tmp}/café`
  const nfdPath = `${tmp}/cafe\u0301`

  it('NFD 与 NFC 字节不同但归一后判同一路径（isWithin 双向）', async () => {
    expect(nfcPath === nfdPath).toBe(false)   // 前提：原始字节确实不同
    expect(await resolver.isWithin(nfdPath, nfcPath as any)).toBe(true)
    expect(await resolver.isWithin(nfcPath, nfdPath as any)).toBe(true)
  })

  it('denyGlob 的 NFD 变体仍能拦截 NFC 路径（两侧同归一域）', async () => {
    const target = path.join(fakeDshHome, 'storages', 'café')   // NFC 形式
    fs.mkdirSync(target, { recursive: true })
    const nfdGlobPolicy: PathPolicy = { ...policy, denyGlobs: ['cafe\u0301*'] }   // NFD 形式
    const r = await resolver.assertDeletable(target, nfdGlobPolicy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_PATH_POLICY')
  })
})

describe('V5 大小写不敏感文件系统感知（darwin/win32 casefold）', () => {
  /** env 须在 beforeAll 之后构造（tmp 已就绪），故逐 it 内创建 */
  function makeEnv() {
    return {
      HOME: tmp,
      TEMP: path.join(tmp, 'tmp'),
      TMPDIR: path.join(tmp, 'tmp'),
      DSH_HOME: fakeDshHome,
    }
  }

  it('darwin：白名单根匹配大小写不敏感（注入 platform 可测）', async () => {
    const mac = createPathResolver({ env: makeEnv(), platform: 'darwin' })
    // 目标无需真实存在：canonicalize realpath 失败回退 resolve，归一比较后 casefold
    const target = path.join(fakeDshHome, 'Storages', 'Some-Plugin')
    const r = await mac.assertDeletable(target, policy)
    expect(r.ok).toBe(true)
  })

  it('linux：保持大小写敏感（大小写不同判白名单外）', async () => {
    const lnx = createPathResolver({ env: makeEnv(), platform: 'linux' })
    const target = path.join(fakeDshHome, 'Storages', 'Some-Plugin')
    const r = await lnx.assertDeletable(target, policy)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('E_PATH_POLICY')
  })

  it('darwin：isWithin 大小写不敏感；linux：敏感', async () => {
    const mac = createPathResolver({ env: makeEnv(), platform: 'darwin' })
    const lnx = createPathResolver({ env: makeEnv(), platform: 'linux' })
    expect(await mac.isWithin('/x/A/b', '/x/a' as any)).toBe(true)
    expect(await lnx.isWithin('/x/A/b', '/x/a' as any)).toBe(false)
  })
})

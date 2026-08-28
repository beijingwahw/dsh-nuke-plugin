// tests/preflight-filecount.test.ts — V5 预飞闸门链路测试
// 验证 maxFilesPerTx 的完整数据供给链：
//   dirStats（infra）→ fs-ops/edit-ops preview 填充 OperationPlan.fileCount
//   → policy-guard.check({ fileCount }) 执行 TOO_MANY_FILES 规则
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PluginName, ProfileName, TxId } from '../src/contracts/base'
import type { TxContext } from '../src/contracts/transaction'
import { dirStats } from '../src/infra/fs-utils'
import { createPathResolver } from '../src/infra/path-resolver'
import { createPolicyGuard } from '../src/infra/policy-guard'
import { configEditOps } from '../src/operations/edit-ops'
import { dirRemoveOps, makePurgeTempOp } from '../src/operations/fs-ops'

let home: string
let dshHome: string
let tempRoot: string
let ctx: TxContext

const PROFILE = 'default' as ProfileName
const VICTIM = 'victim-plugin' as PluginName

function seed() {
  const pd = path.join(dshHome, 'profiles', PROFILE)
  // node_modules/victim-plugin：3 个文件（嵌套 1 层）
  fs.mkdirSync(path.join(pd, 'node_modules', VICTIM, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pd, 'node_modules', VICTIM, 'index.js'), 'x'.repeat(100))
  fs.writeFileSync(path.join(pd, 'node_modules', VICTIM, 'lib', 'a.js'), 'y'.repeat(50))
  fs.writeFileSync(path.join(pd, 'node_modules', VICTIM, 'lib', 'b.js'), 'z'.repeat(30))
  // 配置引用存在
  fs.writeFileSync(path.join(pd, 'cordis.patch.yml'),
    'changes:\n  - id: victim-plugin\n    path: patches/victim.patch\n')
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-home-'))
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-temp-'))
  dshHome = path.join(home, '.dsh')
  seed()

  ctx = {
    txId: 'tx-preflight-1' as TxId,
    request: {
      plugins: [VICTIM], profile: PROFILE, strategy: 'balanced', dryRun: true, actor: 'tester',
    },
    resolver: createPathResolver({ env: { HOME: home, DSH_HOME: dshHome, TMPDIR: tempRoot } }),
    backups: null as never,   // preview 零副作用，不触备份区
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- 测试桩：preview 零副作用路径上不应有任何输出
    logger: { log: () => {}, progress: () => {} } as never,
    clock: { now: () => new Date() },
  }
})
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('dirStats：一次遍历产出字节与文件数', () => {
  it('嵌套目录的 fileCount 与 bytes 均正确，符号链接不跟随', () => {
    const dir = path.join(dshHome, 'profiles', PROFILE, 'node_modules', VICTIM)
    // 制造一个 symlink 干扰项（不应被计入）
    try { fs.symlinkSync('/etc/hostname', path.join(dir, 'link-out')) } catch { /* 平台不支持则跳过 */ }
    const stats = dirStats(dir)
    expect(stats.fileCount).toBe(3)
    expect(stats.bytes).toBe(180)
  })
})

describe('preview 填充 fileCount（守卫数据源）', () => {
  it('fs-ops 目录清理 preview 报告实际文件数', async () => {
    const ops = dirRemoveOps(VICTIM, PROFILE, () => dshHome)
    const nmOp = ops.find(o => o.id.includes('node-modules'))!
    const plan = await nmOp.preview(ctx)
    expect(plan.fileCount).toBe(3)
    expect(plan.estimatedBytesReclaimable).toBe(180)
  })

  it('目录不存在 → skipped 且 fileCount 缺省', async () => {
    const ops = dirRemoveOps(VICTIM, PROFILE, () => dshHome)
    const stOp = ops.find(o => o.id.includes('storages'))!
    const plan = await stOp.preview(ctx)
    expect(plan.skipped).toBe(true)
  })

  it('edit-ops 引用存在 → fileCount=1；引用不存在 → fileCount=0 + skipped', async () => {
    const ops = configEditOps(VICTIM, PROFILE, () => dshHome)
    const patchOp = ops.find(o => o.id.includes('profile-patch'))!
    const hit = await patchOp.preview(ctx)
    expect(hit.fileCount).toBe(1)

    // 构造引用不存在的场景：换一个不存在的插件名（文件存在但无引用）
    const missOps = configEditOps('no-such-plugin' as PluginName, PROFILE, () => dshHome)
    const missOp = missOps.find(o => o.id.includes('profile-patch'))!
    const miss = await missOp.preview(ctx)
    expect(miss.skipped).toBe(true)
    expect(miss.fileCount).toBe(0)
  })

  it('purge-temp preview fileCount = 过期条目数', async () => {
    // 制造 2 个过期条目
    for (const name of ['dsh-old-a', 'dsh-old-b']) {
      fs.writeFileSync(path.join(tempRoot, name), 'x')
      const t = new Date(Date.now() - 30 * 86_400_000)
      fs.utimesSync(path.join(tempRoot, name), t, t)
    }
    const op = makePurgeTempOp({ tempRoot, ttlDays: 7 })
    const plan = await op.preview(ctx)
    expect(plan.fileCount).toBeGreaterThanOrEqual(2)
  })
})

describe('预飞闸门端到端：fileCount → TOO_MANY_FILES', () => {
  it('fileCount 超过 maxFilesPerTx → 守卫拦截', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-policy-'))
    const policyFile = path.join(tmp, 'policy.json')
    fs.writeFileSync(policyFile, JSON.stringify({ maxFilesPerTx: 2 }))   // 上限 2
    const guard = createPolicyGuard({ policyFile, diskRoot: tmp })
    try {
      const r = guard.check({ plugins: [VICTIM], estimatedBytes: 0, fileCount: 3 })
      if (!r.ok) throw new Error(r.error.message)
      const violations = r.value.filter(v => v.rule === 'TOO_MANY_FILES')
      expect(violations.length).toBe(1)
      expect(violations[0]!.blocking).toBe(true)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  it('fileCount 缺省 → 规则跳过（向后兼容）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-policy-'))
    const policyFile = path.join(tmp, 'policy.json')
    fs.writeFileSync(policyFile, JSON.stringify({ maxFilesPerTx: 2 }))
    const guard = createPolicyGuard({ policyFile, diskRoot: tmp })
    try {
      const r = guard.check({ plugins: [VICTIM], estimatedBytes: 0 })   // 无 fileCount
      if (!r.ok) throw new Error(r.error.message)
      expect(r.value.filter(v => v.rule === 'TOO_MANY_FILES')).toHaveLength(0)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  it('链路一致性：preview 的 fileCount 之和喂给守卫即拦截（模拟 index.ts 预飞逻辑）', async () => {
    // 与 src/index.ts 预飞复查同构：sum(preview.fileCount) → check({ fileCount })
    const ops = [
      ...dirRemoveOps(VICTIM, PROFILE, () => dshHome),
      ...configEditOps(VICTIM, PROFILE, () => dshHome),
    ]
    const plans = await Promise.all(ops.map(o => o.preview(ctx)))
    const fileCount = plans.reduce((s, p) => s + (p.fileCount ?? 0), 0)
    expect(fileCount).toBe(4)   // 3（node_modules）+ 1（profile patch 引用存在）

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-policy-'))
    const policyFile = path.join(tmp, 'policy.json')
    fs.writeFileSync(policyFile, JSON.stringify({ maxFilesPerTx: 3 }))   // 上限 3 < 4
    const guard = createPolicyGuard({ policyFile, diskRoot: tmp })
    try {
      const r = guard.check({ plugins: [VICTIM], estimatedBytes: 0, fileCount })
      if (!r.ok) throw new Error(r.error.message)
      expect(r.value.some(v => v.rule === 'TOO_MANY_FILES')).toBe(true)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

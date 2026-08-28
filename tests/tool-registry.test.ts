// tests/tool-registry.test.ts — 工具注册表（外部工具解析单一事实源）单测
// 场景原型：dsh 经 nvm 安装，宿主进程 PATH 缺口 → 三处独立探测语义漂移。
// 注册表解析链：① 显式 env（DSH_BIN/PNPM_BIN）→ ② 裸名 PATH → ③ bin 救援。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, expect, it } from 'vitest'

import { ok } from '../src/contracts/base'
import type { ToolResolution } from '../src/contracts/tool.contract'
import { createDoctor } from '../src/engine/doctor'
import { createHealthInspector } from '../src/engine/health-inspector'
import { createSeverityScorer } from '../src/engine/severity-scorer'
import { createToolRegistry, TOOL_DESCRIPTORS, type ToolProbeResult } from '../src/infra/tool-registry'

/** 探测桩：按命令名/路径路由，记录调用序（缓存断言用） */
function makeProbe(routes: Record<string, ToolProbeResult | Error>) {
  const calls: string[] = []
  const probe = (cmdOrPath: string): ToolProbeResult => {
    calls.push(cmdOrPath)
    const hit = routes[cmdOrPath]
    if (hit instanceof Error) throw hit
    if (hit) return hit
    return { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }
  }
  return { probe, calls }
}

const OK_VERSION: ToolProbeResult = { status: 0, stdout: '0.1.0-rc.6\n', stderr: '' }

function registry(over: {
  probe: (cmdOrPath: string) => ToolProbeResult
  env?: Record<string, string>
  resolveCommand?: (cmd: string) => { readonly path: string; readonly dir: string } | null
  ttlMs?: number
  now?: () => number
}) {
  return createToolRegistry({
    probe: over.probe,
    env: over.env ?? {},
    ...(over.resolveCommand ? { resolveCommand: over.resolveCommand } : {}),
    ...(over.ttlMs !== undefined ? { ttlMs: over.ttlMs } : {}),
    ...(over.now ? { now: over.now } : {}),
  })
}

describe('解析链 ①：显式环境变量', () => {
  it('DSH_BIN 指向可执行路径 → ok + method=explicit-env + 版本提取', async () => {
    const p = makeProbe({ '/opt/dsh/bin/dsh': OK_VERSION })
    const r = await registry({ probe: p.probe, env: { DSH_BIN: '/opt/dsh/bin/dsh' } }).resolve('dsh')
    expect(r.status).toBe('ok')
    expect(r.method).toBe('explicit-env')
    expect(r.path).toBe('/opt/dsh/bin/dsh')
    expect(r.version).toBe('0.1.0-rc.6')
    expect(r.detail).toContain('DSH_BIN')
    expect(r.envVar).toBe('DSH_BIN')
  })

  it('显式路径失效 → 响亮报错 missing，绝不静默降级到 PATH/救援', async () => {
    const p = makeProbe({}) // 所有探测均 ENOENT
    const r = await registry({
      probe: p.probe, env: { DSH_BIN: '/broken/dsh' },
      resolveCommand: () => ({ path: '/usr/local/bin/dsh', dir: '/usr/local/bin' }), // 救援本可命中
    }).resolve('dsh')
    expect(r.status).toBe('missing')
    expect(r.method).toBe('explicit-env')
    expect(r.detail).toContain('DSH_BIN')
    expect(p.calls).toEqual(['/broken/dsh']) // 只探测了显式路径，未走后续链路
  })

  it('空字符串 env 视为未设置 → 走裸名链路', async () => {
    const p = makeProbe({ dsh: OK_VERSION })
    const r = await registry({ probe: p.probe, env: { DSH_BIN: '' } }).resolve('dsh')
    expect(r.status).toBe('ok')
    expect(r.method).toBe('path')
    expect(p.calls).toEqual(['dsh'])
  })
})

describe('解析链 ②：裸名 PATH 探测', () => {
  it('exit 0 → ok + 版本串', async () => {
    const p = makeProbe({ pnpm: { status: 0, stdout: '9.12.0\n', stderr: '' } })
    const r = await registry({ probe: p.probe }).resolve('pnpm')
    expect(r.status).toBe('ok')
    expect(r.method).toBe('path')
    expect(r.version).toBe('9.12.0')
  })

  it('exit 非 0 但进程已执行（旗标差异）→ ok 而非误报缺失', async () => {
    const p = makeProbe({ dsh: { status: 1, stdout: 'unknown flag: --version', stderr: '' } })
    const r = await registry({ probe: p.probe }).resolve('dsh')
    expect(r.status).toBe('ok')
    expect(r.detail).toContain('退出码 1')
  })

  it('status=null 无 errorCode（自定义运行器/信号击杀）→ 按未找到处理', async () => {
    const p = makeProbe({})
    p.probe = (cmd: string) => {
      p.calls.push(cmd)
      return cmd === 'dsh' ? { status: null, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    }
    const r = await registry({ probe: p.probe, resolveCommand: () => null }).resolve('dsh')
    expect(r.status).toBe('missing')
  })
})

describe('解析链 ③：PATH 落空 → 全局 bin 救援', () => {
  it('救援命中 → rescued + 附 PATH 修复提示（nvm 场景）', async () => {
    const p = makeProbe({ '/home/t/.nvm/versions/node/v24/bin/dsh': OK_VERSION })
    const r = await registry({
      probe: p.probe,
      resolveCommand: () => ({
        path: '/home/t/.nvm/versions/node/v24/bin/dsh',
        dir: '/home/t/.nvm/versions/node/v24/bin',
      }),
    }).resolve('dsh')
    expect(r.status).toBe('rescued')
    expect(r.method).toBe('rescue')
    expect(r.path).toBe('/home/t/.nvm/versions/node/v24/bin/dsh')
    expect(r.dir).toBe('/home/t/.nvm/versions/node/v24/bin')
    expect(r.detail).toContain('宿主 PATH')
    expect(p.calls).toEqual(['dsh', '/home/t/.nvm/versions/node/v24/bin/dsh'])
  })

  it('救援路径存在但无法执行 → missing + 救援失败明细', async () => {
    const p = makeProbe({})
    const r = await registry({
      probe: p.probe,
      resolveCommand: () => ({ path: '/usr/local/bin/dsh', dir: '/usr/local/bin' }),
    }).resolve('dsh')
    expect(r.status).toBe('missing')
    expect(r.method).toBe('rescue')
    expect(r.detail).toContain('救援路径无法执行')
  })

  it('救援候选也落空 → missing（明确说 PATH 与常见目录均无）', async () => {
    const p = makeProbe({})
    const r = await registry({ probe: p.probe, resolveCommand: () => null }).resolve('dsh')
    expect(r.status).toBe('missing')
    expect(r.method).toBeNull()
    expect(r.path).toBeNull()
    expect(r.detail).toContain('未找到')
  })
})

describe('能力映射（治理核心：缺失只降级 affects 声明的动作）', () => {
  it('dsh 描述符：affects=standard-remove，fixHint 含 skip_standard 逃生', async () => {
    const p = makeProbe({})
    const r = await registry({ probe: p.probe, resolveCommand: () => null }).resolve('dsh')
    expect(r.affects).toEqual(['standard-remove'])
    expect(r.fixHint).toContain('skip_standard')
  })

  it('pnpm 描述符：affects=pnpm-store-prune', async () => {
    const p = makeProbe({})
    const r = await registry({ probe: p.probe, resolveCommand: () => null }).resolve('pnpm')
    expect(r.affects).toEqual(['pnpm-store-prune'])
    expect(r.fixHint).toContain('pnpm')
  })

  it('未注册工具 → 临时描述符泛化解析（affects 空）', async () => {
    const p = makeProbe({ git: OK_VERSION })
    const r = await registry({ probe: p.probe }).resolve('git')
    expect(r.status).toBe('ok')
    expect(r.affects).toEqual([])
    expect(r.envVar).toBeNull()
  })
})

describe('TTL 缓存', () => {
  it('TTL 内二次 resolve 不再探测（命中缓存）', async () => {
    const p = makeProbe({ dsh: OK_VERSION })
    let tick = 1_000
    const reg = registry({ probe: p.probe, ttlMs: 60_000, now: () => tick })
    await reg.resolve('dsh')
    tick += 1_000
    await reg.resolve('dsh')
    expect(p.calls).toEqual(['dsh']) // 只探测一次
  })

  it('TTL 过期 → 重新探测', async () => {
    const p = makeProbe({ dsh: OK_VERSION })
    let tick = 1_000
    const reg = registry({ probe: p.probe, ttlMs: 60_000, now: () => tick })
    await reg.resolve('dsh')
    tick += 61_000
    await reg.resolve('dsh')
    expect(p.calls).toEqual(['dsh', 'dsh'])
  })

  it('ttlMs=0 → 不缓存，每次都探测', async () => {
    const p = makeProbe({ dsh: OK_VERSION })
    const reg = registry({ probe: p.probe, ttlMs: 0 })
    await reg.resolve('dsh')
    await reg.resolve('dsh')
    expect(p.calls).toEqual(['dsh', 'dsh'])
  })

  it('invalidate(tool) 精确失效单个工具缓存', async () => {
    const p = makeProbe({ dsh: OK_VERSION, pnpm: OK_VERSION })
    const reg = registry({ probe: p.probe })
    await reg.resolve('dsh')
    await reg.resolve('pnpm')
    reg.invalidate('dsh')
    await reg.resolve('dsh')   // 重探测
    await reg.resolve('pnpm')  // 仍缓存
    expect(p.calls).toEqual(['dsh', 'pnpm', 'dsh'])
  })

  it('invalidate() 全量失效', async () => {
    const p = makeProbe({ dsh: OK_VERSION, pnpm: OK_VERSION })
    const reg = registry({ probe: p.probe })
    await reg.resolve('dsh')
    await reg.resolve('pnpm')
    reg.invalidate()
    await reg.resolve('dsh')
    await reg.resolve('pnpm')
    expect(p.calls).toEqual(['dsh', 'pnpm', 'dsh', 'pnpm'])
  })
})

describe('resolveAll：doctor 环境矩阵', () => {
  it('返回全部已注册工具的解析结果', async () => {
    const p = makeProbe({ dsh: OK_VERSION, pnpm: { status: 0, stdout: '9.0.0\n', stderr: '' } })
    const all = await registry({ probe: p.probe }).resolveAll()
    expect(all.length).toBe(TOOL_DESCRIPTORS.length)
    expect(all.map(r => r.tool)).toEqual(TOOL_DESCRIPTORS.map(d => d.name))
    for (const r of all) expect(r.status).toBe('ok')
  })

  it('混合环境：ok/rescued/missing 并存，各自携带影响面与修复建议', async () => {
    const p = makeProbe({
      dsh: OK_VERSION,
      '/usr/local/bin/pnpm': { status: 0, stdout: '9.0.0\n', stderr: '' },
    })
    const all = await registry({
      probe: p.probe,
      resolveCommand: (cmd: string) => cmd === 'pnpm' ? { path: '/usr/local/bin/pnpm', dir: '/usr/local/bin' } : null,
    }).resolveAll()
    const byName = new Map(all.map(r => [r.tool, r]))
    expect(byName.get('dsh')?.status).toBe('ok')
    expect(byName.get('pnpm')?.status).toBe('rescued')
  })
})

describe('接线注入：消费方委托共享注册表', () => {
  it('health-inspector 注入 toolRegistry → CLI 检查委托注册表（同一事实源）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-registry-h-'))
    let resolved = 0
    const reg = {
      resolve: async (tool: string): Promise<ToolResolution> => {
        resolved += 1
        return {
          tool, status: 'ok', method: 'path', path: `/bin/${tool}`, dir: '/bin',
          version: '1.0.0', detail: `版本: 1.0.0（stub 注册表）`,
          affects: [], fixHint: '', envVar: null, probedAt: Date.now(),
        }
      },
      resolveAll: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- 测试桩：注册表失效回调与本测试无关
      invalidate: () => {},
    }
    const inspector = createHealthInspector({
      dshHome: home, toolRegistry: reg as any, walUnfinished: () => [],
    })
    const r = await inspector.inspect('web' as never)
    expect(r.ok).toBe(true)
    expect(resolved).toBe(2) // dsh + pnpm 各一次，全部走注册表
    if (r.ok) {
      const dsh = r.value.results.find(x => x.check === 'dsh CLI')
      expect(dsh?.passed).toBe(true)
      expect(dsh?.message).toContain('stub 注册表')
    }
  })

  it('doctor 注入 toolRegistry → 报告附带环境矩阵（tools 字段）', async () => {
    const matrix: ToolResolution[] = [
      {
        tool: 'dsh', status: 'ok', method: 'path', path: '/bin/dsh', dir: '/bin',
        version: '0.1.0-rc.6', detail: '版本: 0.1.0-rc.6',
        affects: ['standard-remove'], fixHint: '安装 dsh', envVar: 'DSH_BIN', probedAt: 1,
      },
      {
        tool: 'pnpm', status: 'missing', method: null, path: null, dir: null,
        version: null, detail: 'pnpm 命令未找到',
        affects: ['pnpm-store-prune'], fixHint: 'npm i -g pnpm', envVar: 'PNPM_BIN', probedAt: 1,
      },
    ]
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- 测试桩：注册表失效回调与本测试无关
    const reg = { resolve: async () => matrix[0], resolveAll: async () => matrix, invalidate: () => {} }
    const doctor = createDoctor({
      health: { inspect: async () => ok({ profile: 'web' as never, checkedAt: '', results: [], blocking: false, score: 95 }) } as any,
      scanner: { async *scan () { yield { type: 'done', totalFound: 0, bytesReclaimable: 0 } } } as any,
      orphans: { detect: async () => ok({ orphanPluginDirs: [], orphanDataDirs: [], tempOrphans: [], totalReclaimableBytes: 0 }) } as any,
      scorer: createSeverityScorer(),
      clock: { now: () => new Date('2026-01-01T00:00:00Z') },
      toolRegistry: reg as any,
    })
    const r = await doctor.diagnose('web' as never)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.tools).toEqual(matrix) // 环境矩阵原样进入报告
  })

  it('doctor 未注入 toolRegistry → 报告不含 tools 字段（旧装配兼容）', async () => {
    const doctor = createDoctor({
      health: { inspect: async () => ok({ profile: 'web' as never, checkedAt: '', results: [], blocking: false, score: 95 }) } as any,
      scanner: { async *scan () { yield { type: 'done', totalFound: 0, bytesReclaimable: 0 } } } as any,
      orphans: { detect: async () => ok({ orphanPluginDirs: [], orphanDataDirs: [], tempOrphans: [], totalReclaimableBytes: 0 }) } as any,
      scorer: createSeverityScorer(),
      clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    })
    const r = await doctor.diagnose('web' as never)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.tools).toBeUndefined()
  })
})

// tests/tools.test.ts — 工具注册层（tools/ 四域 23 工具）全量契约测试
//
// 测试策略：
//   1. mock ctx.tools.register 捕获 defineTool 产物，直接调用其 execute ——
//      走完整真实注册路径：defineTextTool 注入的 output 契约 + dsh-tools
//      编译的 JSON Schema 参数校验（类型/enum/required）+ 工具体领域校验。
//   2. Runtime 用"ok-空"默认值的部分桩：各引擎已有自己的单测，这里只验证
//      注册层的编排语义（健康闸门 / 策略守卫 / 回滚释放 / 令牌 / 输出契约）。
//   3. validator 使用真实实现（纯函数零 IO）—— 白名单校验本身是工具层契约。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { err, ok } from '../src/contracts/base'
import type { AbsolutePath, NukeError, PluginName, ProfileName, Result, TxId } from '../src/contracts/base'
import type { BlastRadiusReport } from '../src/contracts/blast-radius.contract'
import type { DedupReport } from '../src/contracts/dedup.contract'
import type { DiskForecast } from '../src/contracts/disk-forecast.contract'
import type { DoctorReport } from '../src/contracts/doctor.contract'
import type { HealthReport } from '../src/contracts/health.contract'
import type { LedgerSummary } from '../src/contracts/ledger.contract'
import type { CleanPolicy } from '../src/contracts/policy.contract'
import type { OrphanReport } from '../src/contracts/scan'
import type { ResidualEvidence } from '../src/contracts/scoring'
import type { DrillMatrixReport } from '../src/engine/drill'
import type { MonteCarloSummary, OracleReportDetail } from '../src/engine/oracle'
import type { TrendReportDetail } from '../src/engine/trend-tracker'
import { createValidator } from '../src/infra/validator'
import type { Runtime } from '../src/runtime'
import { registerDecisionTools } from '../src/tools/decision'
import { registerExecutionTools } from '../src/tools/execution'
import { registerPerceptionTools } from '../src/tools/perception'
import { registerRecoveryTools } from '../src/tools/recovery'

// ─── 测试基建 ───────────────────────────────────────────────

/** 品牌类型的测试侧构造器（生产代码的品牌只能经各工厂构造） */
const plugin = (s: string) => s as PluginName
const profile = (s: string) => s as ProfileName
const absPath = (s: string) => s as AbsolutePath

/** 本插件 24 个工具均不消费 exec（无取消/嵌套分发），空对象即可满足契约 */
const EXEC = {} as ToolRunContext

/** skipLibCheck 下 ToolDefinition 的基类（来自未安装的 dsh-llm）成员
 *  退化 —— 按运行时真实形态补齐注册捕获所需的字段 */
type RegisteredTool = ToolDefinition & {
  readonly name: string
  readonly description: string
}

interface ToolHarness {
  readonly ctx: Context
  /** name → ToolDefinition（捕获 defineTool 产物） */
  readonly defs: Map<string, RegisteredTool>
}

function makeCtx(): ToolHarness {
  const defs = new Map<string, RegisteredTool>()
  const ctx = {
    tools: { register: (d: RegisteredTool) => { defs.set(d.name, d) } },
  } as unknown as Context
  return { ctx, defs }
}

/** 调用工具并取回文本输出（output 契约：{ content: string }） */
async function runTool(def: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const value = await def.execute(args, EXEC) as { content: string }
  return value.content
}

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-tools-test-')) })
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ─── Runtime 桩（ok-空默认值 + per-test 覆盖） ───────────────

const TX_ID = 'a1b2c3d4e5f60718' as TxId

const HEALTHY: HealthReport = {
  profile: profile('web'), checkedAt: '', results: [], blocking: false, score: 100,
}

const ioErr = (message: string): NukeError => ({ code: 'E_IO', message })

function makeRestorePoint() {
  return {
    id: 'rp-20260101-000000-abc', createdAt: '2026-01-01T00:00:00Z',
    actor: 'nuke-tool', reason: 'manual', profile: profile('web'), files: [],
  }
}

function makeTrendReport(overrides: Partial<TrendReportDetail> = {}): TrendReportDetail {
  return {
    snapshotCount: 0, firstAt: null, lastAt: null, bytesPerDay: 0,
    projected30dBytes: null, anomaly: { detected: false, detail: null }, latest: null,
    changepoints: [], bytesPerDayLow: null, bytesPerDayHigh: null,
    projected30dBytesLow: null, projected30dBytesHigh: null,
    ...overrides,
  }
}

function makeOracleReport(overrides: Partial<OracleReportDetail> = {}): OracleReportDetail {
  const mc: MonteCarloSummary = {
    trials: 0, seed: 1, p10: 0, p50: 0, p90: 0, cvar10: 0, mean: 0, successRate: 1,
  }
  return {
    request: { plugins: [plugin('demo-plugin')], profile: profile('web'), strategy: 'balanced' },
    steps: [],
    totalEstimatedBytes: 0,
    transactionSuccessProbability: 1,
    expectedReclaimBytes: 0,
    reclaimP10IfSuccess: 0,
    reclaimP90IfSuccess: 0,
    weakestStep: null,
    expectedRollbackDepth: 0,
    brokenDependents: null,
    diskExtensionDays: null,
    confidence: 'low',
    narrative: '推演完成',
    evidence: { stepSamples: 0, globalSuccessProbability: 0.95 },
    monteCarlo: mc,
    optimizedPlan: null,
    exploration: null,
    retryAdjustedSuccessProbability: 1,
    predictedDurationMs: null,
    pessimisticDurationMs: null,
    trackRecord: null,
    calibration: null,
    calibratedSuccessProbability: null,
    ...overrides,
  }
}

/** 组装 Runtime 桩。defaults 全部为"ok-空"；测试按需覆盖并可用 vi.fn 断言调用 */
function makeRt(overrides: Record<string, unknown> = {}): Runtime {
  const defaults: Record<string, unknown> = {
    // 真实校验器（纯函数）：白名单语义属于工具层契约
    validator: createValidator('linux'),
    nukeRoot: path.join(tmp, 'nuke'),
    resolver: { profileDir: () => path.join(tmp, 'profiles', 'web') },
    health: { inspect: vi.fn(async (): Promise<Result<HealthReport>> => ok(HEALTHY)) },
    scanner: {
      async *scan () { /* 默认零残留 */ },
    },
    scorer: { rank: (es: readonly ResidualEvidence[]) => es },
    trend: {
      record: vi.fn(async () => ok(undefined)),
      analyze: vi.fn(async () => ok(makeTrendReport())),
    },
    analyzer: {
      buildGraph: vi.fn(async () => ok({
        nodes: new Map(),
        edges: [],
        dependentsOf: () => [],
        dependenciesOf: () => [],
        hasCycle: () => false,
        cycles: () => [],
      })),
      blockersOf: vi.fn(async () => ok([])),
    },
    orphans: {
      detect: vi.fn(async (): Promise<Result<OrphanReport>> => ok({
        orphanPluginDirs: [], orphanDataDirs: [], tempOrphans: [],
        totalReclaimableBytes: 0,
      })),
    },
    oracle: { divine: vi.fn(async () => ok(makeOracleReport())) },
    blastRadius: {
      simulate: vi.fn(async (): Promise<Result<BlastRadiusReport>> => ok({
        targets: [plugin('demo-plugin')], cascadeRemovable: [], brokenDependents: [],
        configRefs: [], estimatedBytesReclaimable: 0,
        riskScore: 5, riskLevel: 'low', advisories: [],
      })),
    },
    forecaster: {
      forecast: vi.fn(async (): Promise<Result<DiskForecast>> => ok({
        sampledAt: '2026-01-01T00:00:00Z', totalBytes: 100, freeBytes: 50,
        usedPct: 50, growthBytesPerDay: null, daysUntilFull: null,
        projectedFullAt: null, severity: 'ok', recommendation: '无需行动',
        trendBasis: null,
      })),
    },
    guardian: {
      patrol: vi.fn(async () => ok({
        patrolledAt: '2026-01-01T00:00:00Z', profile: profile('web'), alerts: [],
        disk: null, trend: null, doctor: null, partialFailures: [],
        suppressedAlertKeys: [],
      })),
    },
    policy: {
      load: vi.fn((): CleanPolicy => ({
        version: 1, protectedPlugins: [], maxPluginsPerTx: null,
        maxReclaimBytesPerTx: null, minFreeDiskBytes: null, blackout: null,
      })),
      check: vi.fn(() => ok([])),
    },
    engine: {
      begin: vi.fn(async () => ok({ txId: TX_ID, lockId: 'lock', request: {} })),
      plan: vi.fn(async () => ok({
        txId: TX_ID, operations: [], estimatedBytesReclaimable: 0,
        warnings: [], requiresConfirmationToken: false,
      })),
      dryRun: vi.fn(async () => ok({
        txId: TX_ID, plans: [], estimatedBytesReclaimable: 0, warnings: [], actions: [],
      })),
      commit: vi.fn(async () => ok({
        txId: TX_ID, state: 'committed' as const, steps: [],
        bytesFreedTotal: 0, startedAt: '', finishedAt: '',
      })),
      rollback: vi.fn(async () => ok({
        txId: TX_ID, state: 'rolled-back' as const, steps: [],
        bytesFreedTotal: 0, startedAt: '',
      })),
      recover: vi.fn(async () => ok([])),
      status: vi.fn(async () => null),
      list: vi.fn(async () => []),
    },
    lockManager: {
      inspect: vi.fn((): readonly unknown[] => []),
      holders: vi.fn(() => []),
    },
    restorePoints: {
      create: vi.fn(async () => ok(makeRestorePoint())),
      list: vi.fn(() => []),
      restore: vi.fn(async () => ok(makeRestorePoint())),
      prune: vi.fn(async () => ok(0)),
    },
    doctor: {
      diagnose: vi.fn(async (): Promise<Result<DoctorReport>> => ok({
        generatedAt: '', profile: profile('web'), verdict: 'healthy', healthScore: 100,
        blocking: false, recommendations: [], totalReclaimableBytes: 0, tools: [],
      })),
    },
    drill: {
      run: vi.fn(async () => ok({
        runId: 'drill-1', crashedAtStep: 1, checks: [{ name: '数据还原', passed: true, detail: 'ok' }],
        passed: true, restoredFiles: 2, auditChainValid: true, durationMs: 10,
      })),
      runMatrix: vi.fn(async (): Promise<Result<DrillMatrixReport>> => ok({
        runId: 'drill-m', crashedAtStep: -1, checks: [], passed: true,
        restoredFiles: 6, auditChainValid: true, durationMs: 30,
        matrix: [], pointsVerified: 3,
      })),
    },
    ledger: {
      record: vi.fn(async () => ok(undefined)),
      query: vi.fn(async (): Promise<Result<LedgerSummary>> => ok({
        totalFreed: 0, totalPending: 0, entryCount: 0,
        byAction: [], byProfile: [], byDay: [],
      })),
      entries: vi.fn(() => []),
    },
    audit: {
      query: vi.fn(async () => []),
      verify: vi.fn(async () => ({ valid: true, totalEntries: 0 })),
      append: vi.fn(async () => { throw new Error('测试不应写审计链') }),
    },
    reporter: { export: vi.fn(async () => ok({ path: '/tmp/report.md' })) },
    dedup: {
      analyze: vi.fn(async (): Promise<Result<DedupReport>> => ok({
        groups: [], totalReclaimableBytes: 0, filesScanned: 0,
        bytesScanned: 0, durationMs: 0,
      })),
    },
    dedupExec: {
      apply: vi.fn(async () => ok({
        linkedFiles: 0, bytesSaved: 0, journal: [], skipped: [], cancelled: false,
      })),
    },
  }
  return { ...defaults, ...overrides } as unknown as Runtime
}

/** 注册四域工具并返回 defs（含可选 rt 覆盖） */
function registerAll(rtOverrides: Record<string, unknown> = {}): ToolHarness {
  const h = makeCtx()
  const rt = makeRt(rtOverrides)
  registerPerceptionTools(h.ctx, rt)
  registerDecisionTools(h.ctx, rt)
  registerExecutionTools(h.ctx, rt)
  registerRecoveryTools(h.ctx, rt)
  return h
}

// ─── 1. 注册完整性 ──────────────────────────────────────────

describe('注册完整性', () => {
  it('24 个工具全部注册且名称唯一', () => {
    const { defs } = registerAll()
    const names = [...defs.keys()]
    // 5 感知 + 10 决策 + 3 执行 + 7 恢复保障
    expect(names).toHaveLength(24)
    expect(new Set(names).size).toBe(24)
    for (const n of names) expect(n).toMatch(/^nuke_[a-z]+$/)
  })

  it('每个工具都有描述与参数契约（模型可见面）', () => {
    const { defs } = registerAll()
    for (const d of defs.values()) {
      expect(d.description.length).toBeGreaterThan(10)
      expect(d.output).toBeDefined()
    }
  })
})

// ─── 2. 感知域 ──────────────────────────────────────────────

describe('感知域', () => {
  describe('nuke_list', () => {
    it('列出第三方插件并过滤官方 @deepseek-ai/dsh-* 包', async () => {
      const profileDir = path.join(tmp, 'p-list')
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-tools', 'demo-plugin', 'another-plugin'] } },
      }))
      const { defs } = registerAll({ resolver: { profileDir: () => profileDir } })
      const out = await runTool(defs.get('nuke_list')!, { profile: 'web' })
      expect(out).toContain('2 个第三方插件')
      expect(out).toContain('demo-plugin')
      expect(out).toContain('another-plugin')
      expect(out).not.toContain('dsh-tools')
    })

    it('package.json 缺失 → 明确报错', async () => {
      const { defs } = registerAll({
        resolver: { profileDir: () => path.join(tmp, 'p-missing') },
      })
      const out = await runTool(defs.get('nuke_list')!, {})
      expect(out).toContain('❌')
      expect(out).toContain('无法读取')
    })

    it('非法 profile → 白名单拒绝', async () => {
      const { defs } = registerAll()
      const out = await runTool(defs.get('nuke_list')!, { profile: '../evil' })
      expect(out).toContain('❌')
    })
  })

  describe('nuke_scan', () => {
    it('发现残留 → 输出评分与可回收统计，并记录趋势快照', async () => {
      const evidence: ResidualEvidence = {
        location: absPath('/x/y'),
        kind: 'node-modules', description: '孤儿 node_modules',
        sizeBytes: 2048, lastAccessedAt: null, referencedBy: [],
        suggestedAction: 'remove-node-modules',
      }
      const rt = makeRt({
        scanner: { async *scan () { yield { type: 'found', evidence } } },
        scorer: { rank: () => [{ ...evidence, score: { total: 72, band: 'high', breakdown: [], safeToAutoClean: false } }] },
      })
      const h = makeCtx()
      registerPerceptionTools(h.ctx, rt)
      const out = await runTool(h.defs.get('nuke_scan')!, { plugin_name: 'demo-plugin' })
      expect(out).toContain('1 处残留')
      expect(out).toContain('72')
      expect(out).toContain('孤儿')
      expect(rt.trend.record).toHaveBeenCalled()
    })

    it('零残留 → ✅ 且仍记录快照（空态也进趋势线）', async () => {
      const rt = makeRt()
      const h = makeCtx()
      registerPerceptionTools(h.ctx, rt)
      const out = await runTool(h.defs.get('nuke_scan')!, {})
      expect(out).toContain('✅')
      expect(rt.trend.record).toHaveBeenCalled()
    })

    it('非法插件名 → 领域白名单拒绝', async () => {
      const { defs } = registerAll()
      const out = await runTool(defs.get('nuke_scan')!, { plugin_name: 'not a name!' })
      expect(out).toContain('❌')
    })
  })

  describe('nuke_deps', () => {
    it('输出被依赖/依赖/阻断警告/依赖环', async () => {
      const rt = makeRt({
        analyzer: {
          buildGraph: vi.fn(async () => ok({
            nodes: new Map(),
            edges: [],
            dependentsOf: () => ['user-plugin'],
            dependenciesOf: () => ['dep-plugin'],
            hasCycle: () => true,
            cycles: () => [['a-plugin', 'b-plugin', 'a-plugin']],
          })),
          blockersOf: vi.fn(async () => ok([{
            plugin: 'demo-plugin', blockedBy: ['keeper'], reason: '被外部依赖',
          }])),
        },
      })
      const h = makeCtx()
      registerPerceptionTools(h.ctx, rt)
      const out = await runTool(h.defs.get('nuke_deps')!, { plugin_names: ['demo-plugin'] })
      expect(out).toContain('被依赖')
      expect(out).toContain('user-plugin')
      expect(out).toContain('dep-plugin')
      expect(out).toContain('阻断警告')
      expect(out).toContain('依赖环')
    })

    it('空 plugin_names → ❌', async () => {
      const { defs } = registerAll()
      const out = await runTool(defs.get('nuke_deps')!, { plugin_names: [] })
      expect(out).toContain('❌')
    })
  })

  describe('nuke_orphans', () => {
    it('temp_max_age_days < 1 → 拒绝（防误判刚写入的临时文件）', async () => {
      const { defs } = registerAll()
      const out = await runTool(defs.get('nuke_orphans')!, { temp_max_age_days: 0 })
      expect(out).toContain('❌')
      expect(out).toContain('≥1')
    })

    it('发现孤儿 → 分类展示与合计可回收', async () => {
      const rt = makeRt({
        orphans: { detect: vi.fn(async () => ok({
          orphanPluginDirs: [{ path: '/nm/x', sizeBytes: 100 }],
          orphanDataDirs: [{ path: '/st/y', sizeBytes: 200 }],
          tempOrphans: [{ path: '/t/z', sizeBytes: 300, ageDays: 9.5 }],
          totalReclaimableBytes: 600,
        })) },
      })
      const h = makeCtx()
      registerPerceptionTools(h.ctx, rt)
      const out = await runTool(h.defs.get('nuke_orphans')!, {})
      expect(out).toContain('孤儿总计可回收')
      expect(out).toContain('/nm/x')
      expect(out).toContain('/st/y')
      expect(out).toContain('/t/z')
      expect(out).toContain('9.5 天')
    })
  })

  describe('nuke_health', () => {
    it('健康报告 → 健康度/阻断项/修复建议', async () => {
      const rt = makeRt({
        health: { inspect: vi.fn(async () => ok({
          profile: 'web', checkedAt: '', blocking: true, score: 40,
          results: [{
            check: 'dsh-cli', passed: false, severity: 'critical',
            message: '不可用', group: 'runtime', fix: '重装 dsh',
          }],
        })) },
      })
      const h = makeCtx()
      registerPerceptionTools(h.ctx, rt)
      const out = await runTool(h.defs.get('nuke_health')!, {})
      expect(out).toContain('40/100')
      expect(out).toContain('🔴 存在阻断项')
      expect(out).toContain('💡')
      expect(out).toContain('重装 dsh')
    })

    it('检查本身失败 → ❌', async () => {
      const rt = makeRt({ health: { inspect: vi.fn(async () => err(ioErr('boom'))) } })
      const h = makeCtx()
      registerPerceptionTools(h.ctx, rt)
      const out = await runTool(h.defs.get('nuke_health')!, {})
      expect(out).toContain('❌')
    })
  })
})

// ─── 3. 决策域 ──────────────────────────────────────────────

describe('决策域', () => {
  it('nuke_strategies：三策略 + 令牌格式说明', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_strategies')!, {})
    expect(out).toContain('safe')
    expect(out).toContain('balanced')
    expect(out).toContain('aggressive')
    expect(out).toContain('CONFIRM:')
  })

  it('nuke_oracle：空插件列表 → ❌', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_oracle')!, {})
    expect(out).toContain('❌')
  })

  it('nuke_oracle：推演报告核心口径全部呈现', async () => {
    const rt = makeRt({
      oracle: { divine: vi.fn(async () => ok(makeOracleReport({
        transactionSuccessProbability: 0.82,
        retryAdjustedSuccessProbability: 0.91,
        expectedReclaimBytes: 4096,
        steps: [{
          index: 1, action: 'remove-node-modules', operationId: 'op-1',
          summary: '回收目录', estimatedBytes: 4096,
          successProbability: 0.9, exposureBytes: 4096, calibration: null,
          selfWeight: 0.5, failureModes: [], transientShare: 0,
          retryAdjustedProbability: 0.95, predictedDurationMs: null,
          calibratedProbability: null,
        }],
        monteCarlo: {
          trials: 100, seed: 7, p10: 0, p50: 4096, p90: 4096,
          cvar10: 0, mean: 3400, successRate: 0.83,
        },
        trackRecord: {
          scoredTx: 4, scoredSteps: 9, brierTx: 0.12, brierBaseline: 0.2,
          brierSteps: null, skillScore: 0.4, calibration: null,
          durationRatio: null, recent: [],
        },
      }))) },
    })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_oracle')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('事务成功率')
    expect(out).toContain('82.0%')
    expect(out).toContain('重试感知成功率')
    expect(out).toContain('91.0%')
    expect(out).toContain('蒙特卡洛 100 次抽样')
    expect(out).toContain('CVaR₁₀')
    expect(out).toContain('先知战绩')
    expect(out).toContain('推演完成')
    expect(out).toContain('决策链建议')
  })

  it('nuke_oracle：推演失败 → 带错误码 ❌', async () => {
    const rt = makeRt({
      oracle: { divine: vi.fn(async () => err({ code: 'E_DEPENDENCY', message: '存在依赖方' })) },
    })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_oracle')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('❌')
    expect(out).toContain('E_DEPENDENCY')
  })

  it('nuke_failures：零历史 → 冷启动引导文案', async () => {
    const rt = makeRt({ audit: { query: vi.fn(async () => []), verify: vi.fn(async () => ({ valid: true, totalEntries: 0 })) } })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_failures')!, {})
    expect(out).toContain('尚无历史执行样本')
  })

  it('nuke_scorecard：零对账 → 诚实空态（不冒充战绩）', async () => {
    const rt = makeRt({ audit: { query: vi.fn(async () => []), verify: vi.fn(async () => ({ valid: true, totalEntries: 0 })) } })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_scorecard')!, {})
    expect(out).toContain('尚无可对账的预测')
  })

  it('nuke_blastradius：风险分级与无波及结论', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_blastradius')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('爆炸半径推演')
    expect(out).toContain('LOW')
    expect(out).toContain('无意外波及')
  })

  it('nuke_blastradius：非法 profile → 路径白名单拒绝', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_blastradius')!, {
      plugin_names: ['demo-plugin'], profile: '../evil',
    })
    expect(out).toContain('❌')
  })

  it('nuke_trend：零快照 → 引导文案', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_trend')!, {})
    expect(out).toContain('暂无历史快照')
  })

  it('nuke_trend：有数据 → 变化率/置信区间/变点/异常', async () => {
    const rt = makeRt({
      trend: {
        record: vi.fn(async () => ok(undefined)),
        analyze: vi.fn(async (): Promise<Result<TrendReportDetail>> => ok(makeTrendReport({
          snapshotCount: 5, firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-05T00:00:00Z',
          bytesPerDay: 1024, bytesPerDayLow: 512, bytesPerDayHigh: 2048,
          projected30dBytes: 30720,
          changepoints: [{ at: '2026-01-03T00:00:00Z', direction: 'up', bytesPerDayBefore: 512, bytesPerDayAfter: 2048 }],
          anomaly: { detected: true, detail: '突增 3σ' },
          latest: {
            at: '2026-01-05T00:00:00Z', trigger: 'scan', profile: profile('web'),
            bytesReclaimable: 5120, bytesFreed: 0, residualCount: 3, healthScore: -1,
          },
        }))),
      },
    })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_trend')!, {})
    expect(out).toContain('趋势分析')
    expect(out).toContain('1.0KB/天')
    expect(out).toContain('置信区间')
    expect(out).toContain('变点')
    expect(out).toContain('异常')
  })

  it('nuke_forecast：倒计时与分级建议', async () => {
    const rt = makeRt({
      forecaster: { forecast: vi.fn(async () => ok({
        sampledAt: '2026-01-01T00:00:00Z', totalBytes: 1000, freeBytes: 100,
        usedPct: 90, growthBytesPerDay: 10, daysUntilFull: 10,
        projectedFullAt: '2026-01-11T00:00:00Z', severity: 'warning',
        recommendation: '尽快清理', trendBasis: null,
        daysUntilFullLow: 8, daysUntilFullHigh: null,
        projectedFullAtLow: '2026-01-09T00:00:00Z', projectedFullAtHigh: null,
      })) },
    })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_forecast')!, {})
    expect(out).toContain('磁盘预测')
    expect(out).toContain('写满倒计时')
    expect(out).toContain('10.0 天')
    expect(out).toContain('🟠')
    expect(out).toContain('尽快清理')
  })

  it('nuke_policy：展示策略守卫全字段', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_policy')!, {})
    expect(out).toContain('保护名单')
    expect(out).toContain('单事务插件上限')
    expect(out).toContain('单事务回收上限')
    expect(out).toContain('磁盘余量下限')
    expect(out).toContain('时间黑窗')
  })

  it('nuke_guardian：告警 + 建议行动 + 抑制窗口可见', async () => {
    const rt = makeRt({
      guardian: { patrol: vi.fn(async () => ok({
        patrolledAt: '2026-01-01T00:00:00Z', profile: 'web',
        alerts: [{
          kind: 'DISK_CRITICAL', severity: 'critical',
          message: '3 天内写满', suggestedTool: 'nuke_clean',
        }],
        disk: null, trend: null, doctor: null, partialFailures: ['趋势采集降级'],
        suppressedAlertKeys: ['TREND_ANOMALY:web'],
      })) },
    })
    const h = makeCtx()
    registerDecisionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_guardian')!, {})
    expect(out).toContain('1 条告警')
    expect(out).toContain('DISK_CRITICAL')
    expect(out).toContain('建议调用 nuke_clean')
    expect(out).toContain('抑制窗口内去重 1 条')
    expect(out).toContain('TREND_ANOMALY:web')
  })

  it('nuke_guardian：零告警零抑制 → 一切正常（不谎报）', async () => {
    const { defs } = registerAll()
    const out = await runTool(defs.get('nuke_guardian')!, {})
    expect(out).toContain('✅ 一切正常')
  })
})

// ─── 4. 执行域（编排语义 —— 最高风险区） ────────────────────

describe('执行域 nuke_clean', () => {
  /** 注册并返回工具 + rt（engine 等以 vi.fn 暴露供断言） */
  function setup(overrides: Record<string, unknown> = {}) {
    const rt = makeRt(overrides)
    const h = makeCtx()
    registerExecutionTools(h.ctx, rt)
    return { defs: h.defs, rt }
  }

  it('空插件列表 → ❌（plugin_names 与 plugin_name 均缺省）', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_clean')!, {})
    expect(out).toContain('❌')
    expect(out).toContain('plugin_names')
  })

  it('plugin_name 单数简写被接受', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_clean')!, {
      plugin_name: 'demo-plugin', dry_run: true,
    })
    expect(out).toContain('预演')
    expect(rt.engine.begin).toHaveBeenCalled()
  })

  it('非法插件名 → 白名单拒绝，事务不开启', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['bad name!'] })
    expect(out).toContain('❌')
    expect(rt.engine.begin).not.toHaveBeenCalled()
  })

  it('非法 profile → 白名单拒绝（防路径穿越）', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_clean')!, {
      plugin_names: ['demo-plugin'], profile: '../evil',
    })
    expect(out).toContain('❌')
  })

  it('strategy 非法枚举 → DSL 层 ToolArgsError（未到工具体）', async () => {
    const { defs } = setup()
    await expect(
      runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'], strategy: 'yolo' }),
    ).rejects.toThrow(ToolArgsError)
  })

  it('健康检查失败 → fail-closed 拒绝且不开事务', async () => {
    const { defs, rt } = setup({ health: { inspect: vi.fn(async () => err(ioErr('探测失败'))) } })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('🚫')
    expect(out).toContain('健康检查本身失败')
    expect(rt.engine.begin).not.toHaveBeenCalled()
  })

  it('健康检查存在 critical 失败 → 阻断并列出失败项', async () => {
    const rt = makeRt({
      health: { inspect: vi.fn(async () => ok({
        profile: 'web', checkedAt: '', blocking: true, score: 30,
        results: [{
          check: 'wal-unfinished', passed: false, severity: 'critical',
          message: '存在未终结事务', group: 'runtime',
        }],
      })) },
    })
    const h = makeCtx()
    registerExecutionTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('🚫')
    expect(out).toContain('critical 失败')
    expect(out).toContain('wal-unfinished')
    expect(rt.engine.begin).not.toHaveBeenCalled()
  })

  it('skip_health=true → 跳过闸门直接进事务', async () => {
    const { defs, rt } = setup({ health: { inspect: vi.fn(async () => err(ioErr('boom'))) } })
    const out = await runTool(defs.get('nuke_clean')!, {
      plugin_names: ['demo-plugin'], dry_run: true, skip_health: true,
    })
    expect(out).toContain('预演')
    expect(rt.engine.begin).toHaveBeenCalled()
  })

  it('dry-run：预演输出 + rollback 释放锁 + 不建还原点', async () => {
    const { defs, rt } = setup({
      engine: {
        ...makeRt().engine as object,
        begin: vi.fn(async () => ok({ txId: TX_ID, lockId: 'l', request: {} })),
        plan: vi.fn(async () => ok({
          txId: TX_ID, operations: [], estimatedBytesReclaimable: 2048,
          warnings: [], requiresConfirmationToken: false,
        })),
        dryRun: vi.fn(async () => ok({
          txId: TX_ID, plans: [], estimatedBytesReclaimable: 2048,
          warnings: [], actions: [{
            action: 'remove-node-modules' as const, target: 'demo-plugin' as never,
            riskLevel: 'medium' as const, description: '回收 node_modules',
            estimatedBytes: 2048, skipped: false,
          }],
        })),
        rollback: vi.fn(async () => ok({ txId: TX_ID, state: 'rolled-back' as const, steps: [], bytesFreedTotal: 0, startedAt: '' })),
      },
    })
    const out = await runTool(defs.get('nuke_clean')!, {
      plugin_names: ['demo-plugin'], dry_run: true,
    })
    expect(out).toContain('预演（dry-run）')
    expect(out).toContain('动作清单')
    expect(out).toContain('回收 node_modules')
    expect(out).toContain('确认后去掉 dry_run')
    expect(rt.engine.rollback).toHaveBeenCalledWith(TX_ID)
    expect(rt.engine.commit).not.toHaveBeenCalled()
    expect(rt.restorePoints.create).not.toHaveBeenCalled()  // dry-run 零副作用
  })

  it('plan 失败 → 回滚释放 + ❌', async () => {
    const { defs, rt } = setup({
      engine: {
        ...makeRt().engine as object,
        plan: vi.fn(async () => err({ code: 'E_DEPENDENCY', message: '存在依赖方' })),
        rollback: vi.fn(async () => ok({ txId: TX_ID, state: 'rolled-back' as const, steps: [], bytesFreedTotal: 0, startedAt: '' })),
      },
    })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('❌')
    expect(out).toContain('计划编译失败')
    expect(rt.engine.rollback).toHaveBeenCalledWith(TX_ID)
  })

  it('策略守卫返回违规 → 拦截并回滚释放锁', async () => {
    const { defs, rt } = setup({
      policy: {
        load: vi.fn(),
        check: vi.fn(() => ok([{
          rule: 'PROTECTED_PLUGIN' as const, message: 'demo-plugin 在保护名单',
          blocking: true as const,
        }])),
      },
    })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('🛡️ 策略守卫拦截')
    expect(out).toContain('PROTECTED_PLUGIN')
    expect(out).toContain('事务已回滚释放')
    expect(rt.engine.rollback).toHaveBeenCalledWith(TX_ID)
    expect(rt.engine.commit).not.toHaveBeenCalled()
  })

  it('策略检查本身失败 → 拒绝并回滚释放锁', async () => {
    const { defs, rt } = setup({
      policy: { load: vi.fn(), check: vi.fn(() => err(ioErr('策略文件损坏'))) },
    })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('❌')
    expect(out).toContain('策略检查失败')
    expect(rt.engine.rollback).toHaveBeenCalled()
  })

  it('commit 成功 → 步骤明细/趋势/台账/报告全链路收尾', async () => {
    const { defs, rt } = setup({
      engine: {
        ...makeRt().engine as object,
        commit: vi.fn(async () => ok({
          txId: TX_ID, state: 'committed' as const,
          steps: [{
            index: 1, operationId: 'op-1', action: 'remove-node-modules' as const,
            status: 'done' as const, bytesFreed: 4096, backup: null,
          }],
          bytesFreedTotal: 4096, startedAt: '', finishedAt: '',
        })),
      },
    })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('执行结果')
    expect(out).toContain('✅')
    expect(out).toContain('实际回收: 4.0KB')
    expect(rt.restorePoints.create).toHaveBeenCalled()       // 二级保护
    expect(rt.engine.rollback).not.toHaveBeenCalled()       // 成功无需回滚
    expect(rt.trend.record).toHaveBeenCalled()               // 趋势快照
    expect(rt.ledger.record).toHaveBeenCalled()              // 空间台账
    expect(rt.reporter.export).toHaveBeenCalledTimes(1)      // 默认 markdown
  })

  it('commit 失败 → 已自动回滚文案（引擎内部 Saga 已补偿）', async () => {
    const { defs } = setup({
      engine: {
        ...makeRt().engine as object,
        commit: vi.fn(async () => err(ioErr('步骤失败'))),
      },
    })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('❌')
    expect(out).toContain('执行失败已自动回滚')
  })

  it('收尾异常 → 尽力回滚释放；回滚也失败 → 提示 nuke_recover', async () => {
    const { defs, rt } = setup({
      engine: {
        ...makeRt().engine as object,
        commit: vi.fn(async () => { throw new Error('ENOSPC') }),
        rollback: vi.fn(async () => { throw new Error('锁已释放') }),
      },
    })
    const out = await runTool(defs.get('nuke_clean')!, { plugin_names: ['demo-plugin'] })
    expect(out).toContain('❌')
    expect(out).toContain('未预期异常且回滚失败')
    expect(out).toContain('nuke_recover')
    expect(rt.engine.rollback).toHaveBeenCalled()
  })

  it('report_format=none → 不导出报告（零文件副作用）', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_clean')!, {
      plugin_names: ['demo-plugin'], report_format: 'none',
    })
    expect(out).not.toContain('报告:')
    expect(rt.reporter.export).not.toHaveBeenCalled()
  })
})

describe('执行域 nuke_dedup', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const rt = makeRt(overrides)
    const h = makeCtx()
    registerExecutionTools(h.ctx, rt)
    return { defs: h.defs, rt }
  }

  it('min_size_bytes < 1 → 拒绝（全盘哈希 DoS 防护）', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_dedup')!, { min_size_bytes: 0 })
    expect(out).toContain('❌')
    expect(out).toContain('≥1')
  })

  it('apply=true 缺确认令牌 → 拒绝（破坏性动作纪律）', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_dedup')!, { apply: true })
    expect(out).toContain('❌')
    expect(out).toContain('LINK-DEDUP')
  })

  it('零重复 → ✅ 且不记台账', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_dedup')!, {})
    expect(out).toContain('✅ 未发现重复文件')
    expect(rt.ledger.record).not.toHaveBeenCalled()
  })

  it('分析模式 → 展示重复组 + pending 潜力入台账（双轨记账）', async () => {
    const { defs, rt } = setup({
      dedup: { analyze: vi.fn(async (): Promise<Result<DedupReport>> => ok({
        groups: [{
          hash: 'ab12', sizeBytes: 4096,
          copies: [
            { path: '/a/f.bin' as never, profile: 'web' as never },
            { path: '/b/f.bin' as never, profile: null },
          ],
          reclaimableBytes: 4096,
        }],
        totalReclaimableBytes: 4096, filesScanned: 10, bytesScanned: 8192,
        durationMs: 5,
        stages: { sizeEliminated: 4, sampleEliminated: 3, fullHashed: 3, bytesSavedBySampling: 1024 },
      })) },
    })
    const out = await runTool(defs.get('nuke_dedup')!, {})
    expect(out).toContain('发现 1 组重复')
    expect(out).toContain('f.bin')
    expect(out).toContain('三级瀑布')
    expect(rt.ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pending', bytes: 4096 }),
    )
    expect(rt.dedupExec.apply).not.toHaveBeenCalled()
  })

  it('apply + 令牌 → 硬链接实收 + freed 台账', async () => {
    const { defs, rt } = setup({
      dedup: { analyze: vi.fn(async (): Promise<Result<DedupReport>> => ok({
        groups: [{
          hash: 'ab12', sizeBytes: 4096,
          copies: [
            { path: '/a/f.bin' as never, profile: 'web' as never },
            { path: '/b/f.bin' as never, profile: null },
          ],
          reclaimableBytes: 4096,
        }],
        totalReclaimableBytes: 4096, filesScanned: 10, bytesScanned: 8192, durationMs: 5,
      })) },
      dedupExec: { apply: vi.fn(async () => ok({
        linkedFiles: 1, bytesSaved: 4096,
        journal: [{ victim: '/b/f.bin' as never, canonical: '/a/f.bin' as never, sizeBytes: 4096 }],
        skipped: [], cancelled: false,
      })) },
    })
    const out = await runTool(defs.get('nuke_dedup')!, { apply: true, confirm_token: 'LINK-DEDUP' })
    expect(out).toContain('硬链接去重完成')
    expect(out).toContain('4.0KB')
    expect(rt.dedupExec.apply).toHaveBeenCalled()
    const kinds = (rt.ledger.record as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].kind)
    expect(kinds).toContain('pending')
    expect(kinds).toContain('freed')
  })
})

describe('执行域 nuke_restorepoint', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const rt = makeRt(overrides)
    const h = makeCtx()
    registerExecutionTools(h.ctx, rt)
    return { defs: h.defs, rt }
  }

  it('create → 创建成功文案', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_restorepoint')!, { action: 'create', profile: 'web' })
    expect(out).toContain('🛡️ 还原点已创建')
    expect(out).toContain('rp-20260101')
    expect(rt.restorePoints.create).toHaveBeenCalled()
  })

  it('create 非法 profile → ❌', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_restorepoint')!, {
      action: 'create', profile: '../evil',
    })
    expect(out).toContain('❌')
  })

  it('restore 缺 id → ❌', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_restorepoint')!, { action: 'restore' })
    expect(out).toContain('❌')
  })

  it('restore → 恢复成功文案', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_restorepoint')!, {
      action: 'restore', id: 'rp-1',
    })
    expect(out).toContain('↩️')
  })

  it('prune keep=0 → 拒绝清空全部（安全网）', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_restorepoint')!, { action: 'prune', keep: 0 })
    expect(out).toContain('❌')
  })

  it('prune → 删除旧还原点', async () => {
    const { defs } = setup({
      restorePoints: {
        create: vi.fn(async () => ok(makeRestorePoint())),
        list: vi.fn(() => []),
        restore: vi.fn(async () => ok(makeRestorePoint())),
        prune: vi.fn(async () => ok(3)),
      },
    })
    const out = await runTool(defs.get('nuke_restorepoint')!, { action: 'prune', keep: 2 })
    expect(out).toContain('已删除 3 个旧还原点')
  })

  it('list → 空态与列表两种形态', async () => {
    const { defs } = setup()
    expect(await runTool(defs.get('nuke_restorepoint')!, {})).toContain('暂无还原点')

    const h2 = makeCtx()
    const rt2 = makeRt({ restorePoints: {
      create: vi.fn(async () => ok(makeRestorePoint())),
      list: vi.fn(() => [makeRestorePoint(), makeRestorePoint()]),
      restore: vi.fn(async () => ok(makeRestorePoint())),
      prune: vi.fn(async () => ok(0)),
    } })
    registerExecutionTools(h2.ctx, rt2)
    const out2 = await runTool(h2.defs.get('nuke_restorepoint')!, {})
    expect(out2).toContain('2 个还原点')
  })
})

// ─── 5. 恢复保障域 ──────────────────────────────────────────

describe('恢复保障域', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const rt = makeRt(overrides)
    const h = makeCtx()
    registerRecoveryTools(h.ctx, rt)
    return { defs: h.defs, rt }
  }

  it('nuke_status：非法 tx_id（路径穿越载体）→ 拒绝', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_status')!, { tx_id: '../../etc' })
    expect(out).toContain('❌')
    expect(out).toContain('16 位十六进制')
  })

  it('nuke_status：事务不存在 / 存在两种形态', async () => {
    const { defs } = setup()
    const missing = await runTool(defs.get('nuke_status')!, { tx_id: 'a1b2c3d4e5f60718' })
    expect(missing).toContain('事务不存在')

    const h2 = makeCtx()
    const rt2 = makeRt({ engine: {
      ...makeRt().engine as object,
      status: vi.fn(async () => ({
        txId: TX_ID, state: 'committed', steps: [{
          index: 1, operationId: 'op-1', action: 'remove-node-modules',
          status: 'done', bytesFreed: 100, backup: null,
        }],
        bytesFreedTotal: 100, startedAt: 't0', finishedAt: 't1',
      })),
    } })
    registerRecoveryTools(h2.ctx, rt2)
    const found = await runTool(h2.defs.get('nuke_status')!, { tx_id: 'a1b2c3d4e5f60718' })
    expect(found).toContain('committed')
    expect(found).toContain('remove-node-modules')
  })

  it('nuke_status：无参清单模式 —— 活跃 + 崩溃残留合并视图，残留时提示 recover', async () => {
    const { defs } = setup()
    const empty = await runTool(defs.get('nuke_status')!, {})
    expect(empty).toContain('没有活跃事务')

    const h2 = makeCtx()
    const rt2 = makeRt({ engine: {
      ...makeRt().engine as object,
      list: vi.fn(async () => ([
        { txId: 'a1b2c3d4e5f60718', state: 'executing', startedAt: 't0', origin: 'active', steps: 2 },
        { txId: 'deadbeefdeadbeef', state: 'failed', startedAt: 't1', origin: 'unfinished', steps: 1 },
      ])),
    } })
    registerRecoveryTools(h2.ctx, rt2)
    const out = await runTool(h2.defs.get('nuke_status')!, {})
    expect(out).toContain('事务清单（2 个）')
    expect(out).toContain('本进程活跃')
    expect(out).toContain('崩溃残留')
    expect(out).toContain('nuke_recover')
  })

  it('nuke_locks：空现场 / 陈旧残留 / 全部存活三种形态（零副作用诊断）', async () => {
    const { defs } = setup()
    expect(await runTool(defs.get('nuke_locks')!, {})).toContain('没有任何锁文件')

    const mkSlots = (over: Partial<Record<string, unknown>>) => ({
      pid: 25288, hostname: 'h', purpose: 'clean', acquiredAt: 't0',
      expiresAt: Date.now() + 60_000, alive: true, expired: false,
      pidReused: null, autoReapInSec: null, ...over,
    })
    const stale = makeRt({ lockManager: { inspect: vi.fn(() => ([{
      file: 'global.lock', scope: 'global', mode: 'exclusive' as const,
      slots: [mkSlots({ alive: false, expired: true, autoReapInSec: 0 })],
    }])) } })
    const h2 = makeCtx()
    registerRecoveryTools(h2.ctx, stale)
    const out2 = await runTool(h2.defs.get('nuke_locks')!, {})
    expect(out2).toContain('global.lock')
    expect(out2).toContain('陈旧残留')
    expect(out2).toContain('自动回收')

    const alive = makeRt({ lockManager: { inspect: vi.fn(() => ([{
      file: 'global.lock', scope: 'global', mode: 'exclusive' as const,
      slots: [mkSlots({ pidReused: true, alive: false })],
    }])) } })
    const h3 = makeCtx()
    registerRecoveryTools(h3.ctx, alive)
    const out3 = await runTool(h3.defs.get('nuke_locks')!, {})
    expect(out3).toContain('PID 已被无关进程复用')
  })

  it('nuke_recover：无需恢复 / 已恢复两种形态', async () => {
    const { defs } = setup()
    expect(await runTool(defs.get('nuke_recover')!, {})).toContain('无需恢复')

    const h2 = makeCtx()
    const rt2 = makeRt({ engine: {
      ...makeRt().engine as object,
      recover: vi.fn(async () => ok([{
        txId: TX_ID, state: 'rolled-back', steps: [], bytesFreedTotal: 0, startedAt: '',
      }])),
    } })
    registerRecoveryTools(h2.ctx, rt2)
    const out = await runTool(h2.defs.get('nuke_recover')!, {})
    expect(out).toContain('已恢复 1 个未终结事务')
  })

  it('nuke_verify：完整 / 篡改两种形态', async () => {
    const { defs } = setup()
    expect(await runTool(defs.get('nuke_verify')!, {})).toContain('审计链完整')

    const h2 = makeCtx()
    const rt2 = makeRt({ audit: {
      query: vi.fn(async () => []),
      verify: vi.fn(async () => ({ valid: false, totalEntries: 9, firstBrokenSeq: 4 })),
    } })
    registerRecoveryTools(h2.ctx, rt2)
    const out = await runTool(h2.defs.get('nuke_verify')!, {})
    expect(out).toContain('🚨')
    expect(out).toContain('seq=4')
  })

  it('nuke_doctor：处方 + 环境矩阵', async () => {
    const evidence = {
      location: absPath('/x'), kind: 'node-modules' as const,
      description: '孤儿目录', sizeBytes: 1024, lastAccessedAt: null,
      referencedBy: [] as PluginName[], suggestedAction: 'remove-node-modules' as const,
      score: { total: 75, band: 'high' as const, breakdown: [], safeToAutoClean: false },
    }
    const rt = makeRt({
      doctor: { diagnose: vi.fn(async (): Promise<Result<DoctorReport>> => ok({
        generatedAt: '', profile: profile('web'), verdict: 'attention', healthScore: 70,
        blocking: false,
        recommendations: [{
          priority: 2 as const, evidence,
          suggestedStrategy: 'balanced' as const, reason: '高分孤儿',
        }],
        totalReclaimableBytes: 1024,
        tools: [
          { tool: 'dsh', status: 'ok', method: 'path', path: '/usr/bin/dsh', dir: '/usr/bin',
            version: '0.1.0', detail: '0.1.0', affects: [], fixHint: '', envVar: 'DSH_BIN', probedAt: 0 },
          { tool: 'pnpm', status: 'missing', method: null, path: null, dir: null,
            version: null, detail: '未找到', affects: [], fixHint: '安装 pnpm', envVar: null, probedAt: 0 },
        ],
      })) },
    })
    const h = makeCtx()
    registerRecoveryTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_doctor')!, {})
    expect(out).toContain('体检报告')
    expect(out).toContain('🟡')
    expect(out).toContain('P2 建议')
    expect(out).toContain('孤儿目录')
    expect(out).toContain('环境矩阵')
    expect(out).toContain('安装 pnpm')
  })

  it('nuke_doctor：环境干净', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_doctor')!, {})
    expect(out).toContain('环境干净')
  })

  it('nuke_drill：单点演习报告', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_drill')!, {})
    expect(out).toContain('崩溃安全证书已签发')
    expect(out).toContain('第 1 步成功落盘后模拟进程死亡')
    expect(rt.drill.run).toHaveBeenCalledWith({ afterStep: 1 })
    expect(rt.drill.runMatrix).not.toHaveBeenCalled()
  })

  it('nuke_drill：matrix=true → 证书矩阵（三断电位）', async () => {
    const { defs, rt } = setup()
    const out = await runTool(defs.get('nuke_drill')!, { matrix: true })
    expect(out).toContain('注入点矩阵')
    expect(out).toContain('证书矩阵')
    expect(rt.drill.runMatrix).toHaveBeenCalled()
    expect(rt.drill.run).not.toHaveBeenCalled()
  })

  it('nuke_drill：演习失败 → 证书作废 + 人工核查指引', async () => {
    const rt = makeRt({ drill: {
      run: vi.fn(async () => ok({
        runId: 'drill-9', crashedAtStep: 1,
        checks: [{ name: '审计链', passed: false, detail: '断裂' }],
        passed: false, restoredFiles: 0, auditChainValid: false, durationMs: 1,
      })),
      runMatrix: vi.fn(),
    } })
    const h = makeCtx()
    registerRecoveryTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_drill')!, {})
    expect(out).toContain('⚠️ 演习未通过')
    expect(out).toContain('请勿在生产依赖自动恢复')
  })

  it('nuke_ledger：days < 0 → 拒绝', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_ledger')!, { days: -1 })
    expect(out).toContain('❌')
  })

  it('nuke_ledger：空台账 → 引导文案', async () => {
    const { defs } = setup()
    const out = await runTool(defs.get('nuke_ledger')!, {})
    expect(out).toContain('暂无台账记录')
  })

  it('nuke_ledger：双轨统计 + 按日趋势 + 最近记录', async () => {
    const rt = makeRt({
      ledger: {
        record: vi.fn(async () => ok(undefined)),
        query: vi.fn(async () => ok({
          totalFreed: 4096, totalPending: 8192, entryCount: 3,
          byAction: [{ key: 'remove-node-modules', bytes: 4096, count: 2 }],
          byProfile: [{ key: 'web', bytes: 4096, count: 2 }],
          byDay: [{ key: '2026-01-01', bytes: 2048, count: 1 }, { key: '2026-01-02', bytes: 2048, count: 1 }],
        })),
        entries: vi.fn(() => [{
          at: '2026-01-02T00:00:00Z', kind: 'freed' as const, txId: TX_ID,
          profile: 'web' as never, plugin: null, action: 'remove-node-modules' as const,
          bytes: 2048, note: '',
        }]),
      },
    })
    const h = makeCtx()
    registerRecoveryTools(h.ctx, rt)
    const out = await runTool(h.defs.get('nuke_ledger')!, {})
    expect(out).toContain('空间台账（3 条）')
    expect(out).toContain('已回收: 4.0KB')
    expect(out).toContain('待回收潜力: 8.0KB')
    expect(out).toContain('按日（回收趋势）')
    expect(out).toContain('最近记录')
  })
})

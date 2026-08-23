// src/index.ts — dsh-nuke-plugin V4（契约驱动重构）
// 架构：contracts/（接口） → infra/（基建）+ engine/（引擎）+ operations/（命令）
// 本文件只做两件事：
//   1. 组装运行时（依赖注入，全部组件可替换、可测试）
//   2. 注册 21 个工具（薄适配层：校验入参 → 调用组件 → 格式化出参）
import * as fs from 'fs'
import * as path from 'path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ParameterSchemaSpec, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { createLogger } from './infra/logger'
import { createValidator } from './infra/validator'
import { createPathResolver } from './infra/path-resolver'
import { createLockManager } from './infra/lock-manager'
import { createWal } from './infra/wal'
import { createBackupStore } from './infra/backup-store'
import { createAuditLog } from './infra/audit-log'
import { createHookRegistry } from './engine/hook-registry'
import { createScanCache } from './infra/scan-cache'
import { createTransactionEngine } from './engine/transaction-engine'
import { createSeverityScorer } from './engine/severity-scorer'
import { createDependencyAnalyzer } from './engine/dependency-analyzer'
import { createResidualScanner } from './engine/residual-scanner'
import { createOrphanDetector } from './engine/orphan-detector'
import { createHealthInspector } from './engine/health-inspector'
import { createReporter } from './infra/reporter'
import { createDoctor } from './engine/doctor'
import { createDedupAnalyzer } from './engine/dedup-analyzer'
import { createDedupExecutor } from './engine/dedup-executor'
import { createRestorePointManager } from './engine/restore-point'
import { createBlastRadiusAnalyzer } from './engine/blast-radius'
import { createTrendTracker } from './engine/trend-tracker'
import { createPolicyGuard } from './infra/policy-guard'
import { createDiskForecaster } from './engine/disk-forecaster'
import { createGuardian } from './engine/guardian'
import { createLedger } from './infra/ledger'
import { createReliabilityModel } from './infra/reliability'
import { createOracle } from './engine/oracle'
import { createDrill } from './engine/drill'
import { makeOperationFactory, STRATEGY_ACTIONS } from './operations'
import type { CleanStrategy, PluginName, ProfileName, TxId } from './contracts/base'
import { errorToMessage, fmtBytes } from './contracts/base'
import type { ResidualEvidence, SeverityBand } from './contracts/scoring'
import type { ITransactionEngine } from './contracts/transaction'
import type { DoctorPriority, DoctorVerdict } from './contracts/doctor.contract'
import type { OracleConfidence } from './contracts/oracle.contract'
import type { RiskLevel } from './contracts/blast-radius.contract'
import type { ForecastSeverity } from './contracts/disk-forecast.contract'
import type { AlertSeverity } from './contracts/guardian.contract'
import type { TrendTrigger } from './contracts/trend.contract'
import { LEDGER_GLOBAL } from './contracts/ledger.contract'

export const name = 'dsh-nuke-plugin'
export const inject = ['tools']

// ─── 运行时组装（依赖注入） ─────────────────────────────────

function buildRuntime() {
  const resolver = createPathResolver()
  const platform = resolver.platform()
  const nukeRoot = path.join(platform.dshHome, '.nuke')

  const logger = createLogger({ minLevel: process.env.NUKE_LOG_LEVEL === 'debug' ? 'debug' : 'info' })
  const validator = createValidator(platform.os === 'windows' ? 'windows' : 'linux')

  const lockManager = createLockManager({ lockRoot: nukeRoot })
  const wal = createWal({ walRoot: path.join(nukeRoot, 'tx') })
  const backups = createBackupStore({ backupRoot: path.join(nukeRoot, 'backups') })
  const audit = createAuditLog({ filePath: path.join(nukeRoot, 'audit', 'chain.jsonl') })
  const hooks = createHookRegistry({ dir: path.join(nukeRoot, 'hooks') })

  /** aggressive 二次确认令牌：显式拼出 profile 与插件清单，防止误触 */
  const confirmationTokenOf = (profile: string, plugins: readonly string[]) =>
    `CONFIRM:${profile}:${[...plugins].sort().join(',')}`

  // 操作集编译器：引擎与先知共享同一份（推演与执行严格同构）
  const operationFactory = makeOperationFactory({
    validator,
    tempRoot: platform.tempRoot,
    tempTtlDays: 7,
  })

  const engine: ITransactionEngine = createTransactionEngine(
    {
      lockManager, wal, backups, audit, resolver, logger, hooks,
      clock: { now: () => new Date() },
      verifyConfirmationToken: (token, req) =>
        token === confirmationTokenOf(req.profile, req.plugins),
    },
    operationFactory,
  )

  const scorer = createSeverityScorer()
  const analyzer = createDependencyAnalyzer({ dshHome: platform.dshHome })
  // 增量扫描缓存：mtime+size 指纹校验，二次扫描跳过 contains 全读与 dirSize 递归
  const scanCache = createScanCache({ filePath: path.join(nukeRoot, 'cache', 'scan-cache.json') })
  const scanner = createResidualScanner({
    dshHome: platform.dshHome, tempRoot: platform.tempRoot, scanCache,
  })
  const orphans = createOrphanDetector({ dshHome: platform.dshHome, tempRoot: platform.tempRoot })
  const health = createHealthInspector({
    dshHome: platform.dshHome,
    walUnfinished: () => wal.unfinishedTxIds(),
  })
  const doctor = createDoctor({ health, scanner, orphans, scorer, clock: { now: () => new Date() } })
  const dedup = createDedupAnalyzer({ dshHome: platform.dshHome })
  const dedupExec = createDedupExecutor()
  const restorePoints = createRestorePointManager({ dshHome: platform.dshHome, nukeRoot })
  const reporter = createReporter({ reportsRoot: path.join(nukeRoot, 'reports') })

  const blastRadius = createBlastRadiusAnalyzer({ dshHome: platform.dshHome, analyzer })
  const trend = createTrendTracker({ historyDir: path.join(nukeRoot, 'history') })
  const ledger = createLedger({ historyDir: path.join(nukeRoot, 'history') })
  const forecaster = createDiskForecaster({
    diskRoot: platform.dshHome, trend, clock: { now: () => new Date() },
  })
  const guardian = createGuardian({
    forecaster, trend, doctor,
    unfinishedTxIds: () => wal.unfinishedTxIds(),
    clock: { now: () => new Date() },
  })
  const policy = createPolicyGuard({
    policyFile: path.join(nukeRoot, 'policy.json'),
    diskRoot: platform.dshHome,
    now: () => new Date(),
  })
  // 策略守卫第二层：pre-hook veto（绕过工具层直连引擎也逃不掉保护名单）
  hooks.register(policy.asPreHook())

  // 先知引擎：每次推演从审计链重建可靠性模型（数据飞轮 —— 上一次
  // 清理刚积累的样本立即参与下一次预测）
  const oracle = createOracle({
    reliability: () => createReliabilityModel({ audit }),
    operationFactory,
    resolver, logger, clock: { now: () => new Date() },
    blastRadius, forecaster,
  })

  // 混沌演习：沙箱内注入真实崩溃，持续证明崩溃可恢复性
  const drill = createDrill({ nukeRoot })

  return {
    resolver, platform, nukeRoot, logger, validator,
    engine, wal, audit,
    scorer, analyzer, scanner, orphans, health,
    doctor, dedup, dedupExec, restorePoints, reporter,
    blastRadius, trend, policy,
    forecaster, guardian, ledger,
    oracle, drill,
    confirmationTokenOf,
  }
}

type Runtime = ReturnType<typeof buildRuntime>

// ─── 出参格式化 ─────────────────────────────────────────────
// fmtBytes 统一导入自契约层（全项目唯一实现，见 contracts/base.ts）

/** 图标映射键一律用契约联合类型：拼错键或缺键在编译期即失败 */
const BAND_ICON: Record<SeverityBand, string> = {
  info: '·', low: '🟢', medium: '🟡', high: '🟠', critical: '🔴',
}

// ─── 工具注册（薄适配层，官方 defineTool DSL） ──────────────

/** dsh-tools 契约：execute 返回 canonical value，先经 output.schema 校验，
 *  再由 render(args, value) 投影为 ContentBlock 数组。
 *  本插件 21 个工具统一 shape：{ content: string }（纯文本）→ 单个 text 块，
 *  契约集中声明一次，由 defineTextTool 注入 —— 避免逐个注册重复 21 份。 */
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { content: { type: 'string', required: true } },
} as const

/** 统一定义入口：注入共享 output 契约后交给官方 defineTool。
 *  参数用 ParameterSchemaSpec DSL 声明 —— 框架完成 JSON Schema 编译、
 *  运行时参数校验（类型/enum/required）与 InferArgs 类型推导；DSL 表达
 *  不了的领域约束（插件名白名单、txId 格式、数值下限）仍在 execute 内
 *  手工检查（fail loudly，返回 ❌ 文本或抛 ToolArgsError 由宿主物化）。 */
function defineTextTool<const S extends ParameterSchemaSpec>(tool: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  execute(args: InferArgs<S>): Promise<{ content: string }>
}): ToolDefinition {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args) {
      return tool.execute(args)
    },
  })
}

export function apply(ctx: Context) {
  const rt: Runtime = buildRuntime()

  /** 入参校验：插件名列表（元素类型已由 defineTool 保证为 string，这里做领域白名单） */
  function checkPlugins(names: readonly string[]): { ok: true; plugins: PluginName[] } | { ok: false; error: string } {
    if (names.length === 0) return { ok: false, error: '请提供 plugin_names 数组（至少一个）' }
    for (const n of names) {
      const r = rt.validator.validatePluginName(n)
      if (!r.ok) return { ok: false, error: `插件名 "${n}" 非法: ${r.error.map(v => v.detail).join('; ')}` }
    }
    return { ok: true, plugins: names as PluginName[] }
  }

  function checkProfile(p: string): { ok: true; profile: ProfileName } | { ok: false; error: string } {
    const r = rt.validator.validateProfileName(p)
    if (!r.ok) return { ok: false, error: `profile "${p}" 非法: ${r.error.map(v => v.detail).join('; ')}` }
    return { ok: true, profile: p as ProfileName }
  }

  // ── nuke_list ────────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_list',
    description: '列出指定 profile 下所有已安装的第三方插件',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const pkgPath = path.join(rt.resolver.profileDir(cp.profile), 'package.json')
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        const bundles: string[] = (pkg?.dsh?.profile?.bundles ?? [])
          .filter((b: string) => !b.startsWith('@deepseek-ai/dsh-'))
        if (bundles.length === 0) return { content: `profile "${cp.profile}" 下没有第三方插件。` }
        return { content: `profile "${cp.profile}" 已安装 ${bundles.length} 个第三方插件：\n${bundles.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}` }
      } catch {
        return { content: `❌ 无法读取 ${pkgPath}（profile 不存在？）` }
      }
    },
  }))

  // ── nuke_scan ────────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_scan',
    description: '扫描插件残留（配置引用/目录/TEMP），带五因子严重程度评分与可回收空间统计。省略 plugin_name 进入全局模式',
    parameters: {
      plugin_name: { type: 'string', description: '插件名（省略 = 全 profile 全插件全局扫描）' },
      profile: { type: 'string', description: '默认 "web"' },
      include_temp: { type: 'boolean', description: '是否扫描 TEMP（仅 aggressive 生效），默认 false' },
    },
    execute: async ({ plugin_name, profile = 'web', include_temp = false }) => {
      const cp = checkProfile(profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      // 领域校验：npm 包名规范（DSL 只保证 string 类型，保证不了格式）
      let plugin: PluginName | undefined
      if (plugin_name !== undefined) {
        const cn = rt.validator.validatePluginName(plugin_name)
        if (!cn.ok) return { content: `❌ 插件名非法: ${cn.error.map(v => v.detail).join('; ')}` }
        plugin = plugin_name as PluginName
      }
      const evidences: ResidualEvidence[] = []
      let bytesReclaimable = 0
      for await (const ev of rt.scanner.scan({
        ...(plugin !== undefined ? { plugin } : {}),
        profile: cp.profile,
        strategy: include_temp ? 'aggressive' : 'safe',
        includeTemp: include_temp,
      })) {
        if (ev.type === 'found') { evidences.push(ev.evidence); bytesReclaimable += ev.evidence.sizeBytes }
      }
      if (evidences.length === 0) {
        await rt.trend.record({
          at: new Date().toISOString(), trigger: 'scan', profile: cp.profile,
          bytesReclaimable: 0, bytesFreed: 0, residualCount: 0, healthScore: -1,
        })
        return { content: `✅ ${plugin_name ?? '全局扫描'} 无残留。` }
      }
      const ranked = rt.scorer.rank(evidences)
      await rt.trend.record({
        at: new Date().toISOString(), trigger: 'scan', profile: cp.profile,
        bytesReclaimable: bytesReclaimable, bytesFreed: 0,
        residualCount: evidences.length, healthScore: -1,
      })
      const lines = ranked.map((e, i) =>
        `  ${i + 1}. ${BAND_ICON[e.score.band] ?? '·'} [${e.score.total}分/${e.score.band}] ${e.description}\n` +
        `     📍 ${e.location}  💾 ${fmtBytes(e.sizeBytes)}` +
        (e.referencedBy.length > 0 ? `  ⚠️ 仍被引用: ${e.referencedBy.join(', ')}` : '  ✅ 孤儿（无引用）'))
      return {
        content: `⚠️ 发现 ${evidences.length} 处残留，可回收 ${fmtBytes(bytesReclaimable)}：\n${lines.join('\n')}\n\n评分说明: 五因子加权（类型×访问衰减×层级×引用态×体量），≥60 需人工确认后再清理。`,
      }
    },
  }))

  // ── nuke_deps ────────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_deps',
    description: '依赖关系检测：哪些插件/profile 声明引用了目标插件（删除前必查）',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, required: true, description: '要检测的插件名列表' },
      profile: { type: 'string', description: '限定单 profile 分析（省略 = 全 profile）' },
    },
    execute: async ({ plugin_names, profile }) => {
      const cp = checkPlugins(plugin_names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      // profile 是路径段：白名单校验后才能进入依赖图构建（防路径穿越）
      let prof: ProfileName | undefined
      if (profile !== undefined) {
        const c = checkProfile(profile)
        if (!c.ok) return { content: `❌ ${c.error}` }
        prof = c.profile
      }
      const g = await rt.analyzer.buildGraph(prof)
      if (!g.ok) return { content: `❌ ${g.error.message}` }
      const lines: string[] = []
      for (const p of cp.plugins) {
        const deps = g.value.dependenciesOf(p)
        const dependents = g.value.dependentsOf(p)
        lines.push(`📦 ${p}`)
        lines.push(`   被依赖（删除会波及）: ${dependents.length > 0 ? dependents.join(', ') : '无'}`)
        lines.push(`   依赖（需要一起处理）: ${deps.length > 0 ? deps.join(', ') : '无'}`)
      }
      const blockers = await rt.analyzer.blockersOf(cp.plugins)
      if (blockers.ok && blockers.value.length > 0) {
        lines.push('', `🚨 阻断警告（同批删除后仍存在的外部依赖方）:`)
        for (const b of blockers.value) lines.push(`   ${b.plugin}: ${b.reason}`)
      }
      if (g.value.hasCycle()) lines.push('', `⚠️ 检测到依赖环: ${g.value.cycles().map(c => c.join(' → ')).join('; ')}`)
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_orphans ─────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_orphans',
    description: '全局孤儿扫描：node_modules 未声明包 / 无主 storages-attachments / TEMP 过期条目',
    parameters: {
      temp_max_age_days: { type: 'number', description: 'TEMP 条目过期天数，默认 7（须 ≥1）' },
    },
    execute: async ({ temp_max_age_days = 7 }) => {
      // 下限校验（领域规则，DSL 无数值下限）：0/负数会让全部 TEMP 条目
      //（含刚写入的）被判为孤儿；number 类型已由 DSL 保证
      if (temp_max_age_days < 1) {
        return { content: '❌ temp_max_age_days 必须为 ≥1 的数字（防止把刚写入的临时文件判为孤儿）' }
      }
      const ageDays = temp_max_age_days
      const r = await rt.orphans.detect({ tempMaxAgeDays: ageDays })
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const { orphanPluginDirs, orphanDataDirs, tempOrphans, totalReclaimableBytes } = r.value
      if (orphanPluginDirs.length + orphanDataDirs.length + tempOrphans.length === 0) {
        return { content: '✅ 未发现孤儿残留。' }
      }
      const lines = [`🗑️ 孤儿总计可回收 ${fmtBytes(totalReclaimableBytes)}`]
      if (orphanPluginDirs.length > 0) {
        lines.push('', `node_modules 孤儿包 (${orphanPluginDirs.length}):`)
        for (const d of orphanPluginDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`)
      }
      if (orphanDataDirs.length > 0) {
        lines.push('', `storages/attachments 无主目录 (${orphanDataDirs.length}):`)
        for (const d of orphanDataDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`)
      }
      if (tempOrphans.length > 0) {
        lines.push('', `TEMP 过期条目 (${tempOrphans.length}):`)
        for (const t of tempOrphans.slice(0, 20)) lines.push(`  ${t.path}  ${fmtBytes(t.sizeBytes)}  ${t.ageDays.toFixed(1)} 天`)
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_health ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_health',
    description: '系统健康检查：config/dependency/runtime/residue 四组检查，输出健康度评分与阻断项',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const r = await rt.health.inspect(cp.profile)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const icon = (passed: boolean, severity: 'info' | 'warning' | 'critical') =>
        passed ? '✅' : severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '❌'
      const lines = [
        `🏥 健康度 ${r.value.score}/100  ${r.value.blocking ? '🔴 存在阻断项（critical 失败，清理事务将被拒绝）' : '🟢 无阻断'}`,
        '',
        ...r.value.results.map(x =>
          `  ${icon(x.passed, x.severity)} [${x.group}/${x.severity}] ${x.check}: ${x.message}${x.fix ? `\n     💡 ${x.fix}` : ''}`),
      ]
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_strategies ──────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_strategies',
    description: '查看三级清理策略（safe/balanced/aggressive）及其动作集',
    parameters: {},
    execute: async () => {
      const desc: Record<CleanStrategy, string> = {
        safe: '仅标准卸载 + 配置引用摘除，不动任何目录（生产安全）',
        balanced: 'safe + 物理回收 node_modules/storages/attachments（推荐）',
        aggressive: 'balanced + pnpm store prune + TEMP 孤儿清理（需确认令牌）',
      }
      const lines = (Object.keys(STRATEGY_ACTIONS) as CleanStrategy[]).map(s =>
        `🛡️ ${s}\n  ${desc[s]}\n  动作: ${STRATEGY_ACTIONS[s].join(', ')}`)
      return { content: `可用清理策略：\n\n${lines.join('\n\n')}\n\naggressive 二次确认令牌格式: CONFIRM:<profile>:<逗号排序插件清单>` }
    },
  }))

  // ── nuke_oracle（先知引擎：后果推演） ─────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_oracle',
    description: '先知推演：dry-run 说"我打算做什么"，先知说"做了会怎样"——事务成功率、期望回收（校准分布修正）、最脆弱步骤、爆炸半径、磁盘倒计时延长。基于历史执行数据（贝叶斯学习），零副作用不拿锁。建议清理前先问先知',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, description: '要推演的插件名列表' },
      plugin_name: { type: 'string', description: '单个插件名（plugin_names 简写）' },
      profile: { type: 'string', description: '默认 "web"' },
      strategy: { type: 'string', enum: ['safe', 'balanced', 'aggressive'], description: '推演所用策略，默认 balanced' },
    },
    execute: async (args) => {
      const { profile = 'web', strategy = 'balanced', plugin_names, plugin_name } = args
      const names: string[] = plugin_names ?? (plugin_name ? [plugin_name] : [])
      const cp = checkPlugins(names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const cprof = checkProfile(profile)
      if (!cprof.ok) return { content: `❌ ${cprof.error}` }

      const r = await rt.oracle.divine({
        plugins: cp.plugins, profile: cprof.profile, strategy,
      })
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const o = r.value

      const pct = (n: number) => `${(n * 100).toFixed(1)}%`
      const confIcon: Record<OracleConfidence, string> = { high: '🟢', medium: '🟡', low: '🔴' }
      const lines = [
        `🔮 先知推演 @ ${new Date().toISOString()}`,
        `   插件: ${cp.plugins.join(', ')}  |  profile: ${cprof.profile}  |  策略: ${strategy}`,
        `   事务成功率: ${pct(o.transactionSuccessProbability)}  ${confIcon[o.confidence]} 置信 ${o.confidence}（${o.evidence.stepSamples} 个历史步骤样本）`,
        `   期望回收: ${fmtBytes(o.expectedReclaimBytes)}（已折算失败回滚；若成功: ${fmtBytes(o.reclaimP10IfSuccess)} ~ ${fmtBytes(o.reclaimP90IfSuccess)}）`,
        `   预估总量: ${fmtBytes(o.totalEstimatedBytes)}  |  失败期望回滚深度: ${o.expectedRollbackDepth.toFixed(1)} 步`,
      ]
      if (o.weakestStep) {
        lines.push(`   ⚠️ 最脆弱: 第 ${o.weakestStep.index} 步 ${o.weakestStep.action}（成功率 ${pct(o.weakestStep.successProbability)}，失败作废 ${fmtBytes(o.weakestStep.exposureBytes)}）`)
      }
      if (o.brokenDependents !== null) {
        lines.push(o.brokenDependents.length > 0
          ? `   💥 爆炸半径: 将损坏 ${o.brokenDependents.length} 个外部依赖方（${o.brokenDependents.join(', ')}）`
          : '   💥 爆炸半径: 无外部波及')
      }
      if (o.diskExtensionDays !== null) {
        lines.push(`   ⏳ 磁盘写满倒计时预计延长 +${o.diskExtensionDays.toFixed(1)} 天`)
      }
      lines.push('', '─ 逐步推演 ─')
      for (const s of o.steps) {
        const cal = s.calibration
          ? `  校准 ${(s.calibration.p50 * 100).toFixed(0)}%（${s.calibration.samples} 样本）`
          : '  校准 n/a'
        lines.push(`  [${s.index}] ${s.action}  ${fmtBytes(s.estimatedBytes)}  成功率 ${pct(s.successProbability)}${cal}`)
      }
      lines.push('', `💡 ${o.narrative}`)
      lines.push('', '决策链建议: nuke_oracle（后果推演）→ nuke_clean dry_run（计划预演）→ nuke_clean（执行）')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_drill（混沌演习：崩溃安全自检） ──────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_drill',
    description: '混沌演习：在沙箱中执行真实事务并在第 N 步后模拟进程崩溃（不回滚、锁悬挂），再走真实崩溃恢复路径，逐项验证数据字节级还原/审计链完整/WAL 终结，签发崩溃安全证书。不触碰真实环境，随时可跑',
    parameters: {
      crash_after_step: { type: 'number', description: '第几步成功后"断电"（1-2，默认 1）' },
    },
    execute: async ({ crash_after_step = 1 }) => {
      const r = await rt.drill.run({ afterStep: crash_after_step })
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const d = r.value
      const lines = [
        `${d.passed ? '🎖️ 崩溃安全证书已签发' : '⚠️ 演习未通过'}  演习 ${d.runId}`,
        `   注入点: 第 ${d.crashedAtStep} 步成功落盘后模拟进程死亡  |  恢复备份 ${d.restoredFiles} 项  |  耗时 ${d.durationMs}ms`,
        '',
        '─ 逐项验证 ─',
        ...d.checks.map(c => `  ${c.passed ? '✅' : '❌'} ${c.name}: ${c.detail}`),
        '',
        d.passed
          ? '本次演习证明：崩溃后 recover() 能完整还原环境，审计链无断裂，后续事务不受阻塞。建议定期演习（尤其升级后）。'
          : '存在失败项：崩溃恢复能力存疑，请勿在生产依赖自动恢复，优先人工核查。演习现场保留在 .nuke/drill/ 供取证。',
      ]
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_clean（核心） ───────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_clean',
    description: '事务化强力卸载：健康检查闸门 → 健康度阻断拒绝 → begin(独占锁) → plan(依赖/令牌校验) → [dry_run 预演 | commit 原子执行]。失败自动 Saga 回滚，全程审计',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, description: '要卸载的插件名列表' },
      plugin_name: { type: 'string', description: '单个插件名（plugin_names 简写）' },
      profile: { type: 'string', description: '默认 "web"' },
      strategy: { type: 'string', enum: ['safe', 'balanced', 'aggressive'], description: 'safe / balanced / aggressive，默认 balanced' },
      dry_run: { type: 'boolean', description: '仅预演，默认 false' },
      confirmation_token: { type: 'string', description: 'aggressive 必填：CONFIRM:<profile>:<插件清单>' },
      skip_health: { type: 'boolean', description: '跳过健康检查闸门，默认 false' },
      report_format: { type: 'string', enum: ['json', 'markdown', 'both', 'none'], description: '报告格式，默认 markdown' },
      actor: { type: 'string', description: '操作人标识（写入审计日志），默认 nuke-tool' },
    },
    execute: async (args) => {
      const {
        profile = 'web', strategy = 'balanced', dry_run = false,
        skip_health = false, report_format = 'markdown', actor = 'nuke-tool',
        plugin_names, plugin_name, confirmation_token,
      } = args
      // 类型与枚举（strategy/report_format）已由 defineTool 编译进 JSON Schema
      // 并在 execute 前校验；此处只做领域白名单（插件名/profile）
      const names: string[] = plugin_names ?? (plugin_name ? [plugin_name] : [])
      const cp = checkPlugins(names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const cprof = checkProfile(profile)
      if (!cprof.ok) return { content: `❌ ${cprof.error}` }
      const strat = strategy
      const fmt = report_format

      // 1) 健康检查闸门（critical 失败 → 拒绝）。fail-closed：检查本身失败
      //    （IO/解析异常）时同样拒绝 —— 安全闸门绝不能"查不到就放行"。
      if (!skip_health) {
        const h = await rt.health.inspect(cprof.profile)
        if (!h.ok) {
          return { content: `🚫 健康检查本身失败，清理被拒绝（可用 skip_health 强制跳过，不建议）: ${h.error.message}` }
        }
        if (h.value.blocking) {
          const critical = h.value.results.filter(x => !x.passed && x.severity === 'critical')
          return { content: `🚫 健康检查存在 critical 失败，清理被拒绝（可用 skip_health 强制跳过，不建议）:\n${critical.map(x => `  🔴 ${x.check}: ${x.message}`).join('\n')}` }
        }
      }

      // 2) 二级保护：配置还原点（dry-run 零副作用，跳过）
      const rpLines: string[] = []
      if (!dry_run) {
        const rp = await rt.restorePoints.create({
          actor, reason: `pre-clean:${strat}`, profile: cprof.profile,
        })
        rpLines.push(rp.ok
          ? `🛡️ 配置还原点 ${rp.value.id}（${rp.value.files.length} 文件，nuke_restorepoint 可恢复）`
          : `⚠️ 还原点创建失败: ${rp.error.message}（事务级备份仍生效）`)
      }

      // 3) 事务：begin → plan →（dryRun | commit）
      const begin = await rt.engine.begin({
        plugins: cp.plugins, profile: cprof.profile, strategy: strat,
        dryRun: dry_run, actor,
        ...(confirmation_token !== undefined ? { confirmationToken: confirmation_token } : {}),
      })
      if (!begin.ok) {
        return { content: `❌ 事务开启失败 [${begin.error.code}]: ${begin.error.message}` }
      }
      const session = begin.value
      const planR = await rt.engine.plan(session)
      if (!planR.ok) {
        await rt.engine.rollback(session.txId)
        return { content: `❌ 计划编译失败 [${planR.error.code}]: ${planR.error.message}` }
      }
      const plan = planR.value

      // 策略守卫第一层：plan 后全量规则检查（保护名单/数量/回收上限/磁盘/黑窗）。
      // 两个失败分支都必须回滚释放事务 —— begin 已持有独占锁，任何 return
      // 而不回滚都会让锁悬挂到 TTL，阻塞后续所有清理。
      const policyCheck = rt.policy.check({
        plugins: cp.plugins, estimatedBytes: plan.estimatedBytesReclaimable,
      })
      if (!policyCheck.ok) {
        await rt.engine.rollback(session.txId)
        return { content: `❌ 策略检查失败（事务已回滚释放）: ${policyCheck.error.message}` }
      }
      if (policyCheck.value.length > 0) {
        await rt.engine.rollback(session.txId)
        return {
          content: [
            `🛡️ 策略守卫拦截（事务已回滚释放）:`,
            ...policyCheck.value.map(v => `  ⛔ [${v.rule}] ${v.message}`),
            `策略文件: ${path.join(rt.nukeRoot, 'policy.json')}（nuke_policy 可查看）`,
          ].join('\n'),
        }
      }

      const out: string[] = [
        ...rpLines,
        `🔧 事务 [${session.txId}]  ${dry_run ? '预演（dry-run）' : '执行'}`,
        `   插件: ${cp.plugins.join(', ')}  |  profile: ${cprof.profile}  |  策略: ${strat}`,
        `   预计可回收: ${fmtBytes(plan.estimatedBytesReclaimable)}  |  步骤数: ${plan.operations.length}`,
      ]
      for (const w of plan.warnings) out.push(`  ${w.blocking ? '⛔' : '⚠️'} ${w.message}`)

      let txCommitted = false
      try {
        if (dry_run) {
          const dr = await rt.engine.dryRun(plan)
          if (dr.ok) {
            out.push('', '─ 预演明细 ─')
            for (const p of dr.value.plans) out.push(`  • ${p.summary}`)
            out.push('', `预计回收 ${fmtBytes(dr.value.estimatedBytesReclaimable)}。确认后去掉 dry_run 执行。`)
          } else {
            // 预演失败不能静默：用户必须能看到失败原因，否则输出形同成功
            out.push('', `❌ 预演失败 [${dr.error.code}]: ${dr.error.message}`)
          }
          await rt.engine.rollback(session.txId)   // 释放锁
          return { content: out.join('\n') }
        }

        const commit = await rt.engine.commit(plan)
        if (!commit.ok) {
          out.push('', `❌ 执行失败已自动回滚 [${commit.error.code}]: ${commit.error.message}`)
          return { content: out.join('\n') }
        }
        txCommitted = true
        const tx = commit.value
        out.push('', '─ 执行结果 ─')
        for (const s of tx.steps) {
          const mark = s.status === 'done' ? '✅' : s.status === 'skipped' ? '⏭️' : s.status === 'undone' ? '↩️' : '❌'
          out.push(`  ${mark} [${s.index}] ${s.action} (${s.operationId})  ${s.status}${s.bytesFreed > 0 ? `  回收 ${fmtBytes(s.bytesFreed)}` : ''}`)
        }
        out.push('', `状态: ${tx.state}  |  实际回收: ${fmtBytes(tx.bytesFreedTotal)}`)

        // 趋势快照 + 空间台账：数据驱动决策的原料
        await rt.trend.record({
          at: new Date().toISOString(), trigger: 'clean', profile: cprof.profile,
          bytesReclaimable: 0, bytesFreed: tx.bytesFreedTotal,
          residualCount: 0, healthScore: -1,
        })
        for (const s of tx.steps) {
          if (s.status !== 'done' || s.bytesFreed <= 0) continue
          await rt.ledger.record({
            at: new Date().toISOString(), kind: 'freed', txId: session.txId,
            profile: cprof.profile, plugin: null, action: s.action,
            bytes: s.bytesFreed, note: `事务 ${session.txId} 步骤 ${s.index}`,
          })
        }

        // 3) 报告导出
        if (fmt !== 'none') {
          const healthR = await rt.health.inspect(cprof.profile)
          const trail = await rt.audit.query({ txId: session.txId })
          const chain = await rt.audit.verify()
          const payload = {
            tx, health: healthR.ok ? healthR.value.results : [],
            auditTrail: trail, generatedAt: new Date().toISOString(), chainValid: chain.valid,
          }
          const formats = fmt === 'both' ? ['json', 'markdown'] as const
            : [fmt === 'json' ? 'json' : 'markdown'] as const
          for (const f of formats) {
            const r = await rt.reporter.export(f, payload)
            if (r.ok) out.push(`📄 ${f} 报告: ${r.value.path}`)
          }
        }
        return { content: out.join('\n') }
      } catch (e) {
        // 逃逸异常必须尽力回滚释放事务（独占锁不悬挂）；commit 已成功的事务
        // 不可回滚（此时异常只可能来自报告/台账等收尾，事务本身无恙）。
        if (txCommitted) {
          return { content: `⚠️ 事务已提交，但收尾阶段异常: ${errorToMessage(e)}` }
        }
        try {
          await rt.engine.rollback(session.txId)
          return { content: `❌ 未预期异常（事务已回滚释放）: ${errorToMessage(e)}` }
        } catch (e2) {
          return { content: `❌ 未预期异常且回滚失败: ${errorToMessage(e)} / ${errorToMessage(e2)}（请立即运行 nuke_recover）` }
        }
      }
    },
  }))

  // ── nuke_status ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_status',
    description: '查询事务状态（活跃/已终结，含步骤明细与回收统计）',
    parameters: {
      tx_id: { type: 'string', required: true, description: '16 位十六进制事务 ID' },
    },
    execute: async ({ tx_id }) => {
      // tx_id 直接拼入 WAL 文件路径：白名单校验堵死 "../" 式路径穿越
      //（格式约束超出 DSL 表达力，属领域校验）
      if (!/^[0-9a-f]{16}$/.test(tx_id)) {
        return { content: `❌ tx_id 非法（应为 16 位十六进制事务 ID）` }
      }
      const s = await rt.engine.status(tx_id as TxId)
      if (!s) return { content: `❌ 事务不存在: ${tx_id}` }
      const lines = [
        `事务 ${s.txId}: ${s.state}`,
        `  开始: ${s.startedAt}${s.finishedAt ? `  完成: ${s.finishedAt}` : ''}`,
        `  回收总计: ${fmtBytes(s.bytesFreedTotal)}  步骤: ${s.steps.length}`,
        ...s.steps.map(x => `    [${x.index}] ${x.action} → ${x.status} (${fmtBytes(x.bytesFreed)})`),
      ]
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_recover ─────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_recover',
    description: '崩溃恢复：扫描未终结事务的 WAL，反向补偿恢复到执行前状态',
    parameters: {},
    execute: async () => {
      const r = await rt.engine.recover()
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      if (r.value.length === 0) return { content: '✅ 无需恢复：没有未终结事务。' }
      const lines = [`↩️ 已恢复 ${r.value.length} 个未终结事务:`]
      for (const s of r.value) lines.push(`  ${s.txId}: ${s.steps.length} 步已反向补偿`)
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_verify ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_verify',
    description: '审计链完整性校验（hash chain 任何篡改均可定位）',
    parameters: {},
    execute: async () => {
      const v = await rt.audit.verify()
      if (v.valid) return { content: `✅ 审计链完整：${v.totalEntries} 条记录，hash 链校验通过。` }
      return { content: `🚨 审计链被篡改！共 ${v.totalEntries} 条，首个损坏点: seq=${v.firstBrokenSeq}` }
    },
  }))

  // ── nuke_doctor ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_doctor',
    description: '一键全科体检：健康检查+残留扫描+孤儿检测+五因子评分 → 优先级处方（P1 立即/P2 建议/P3 可选）与建议清理策略',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const r = await rt.doctor.diagnose(cp.profile)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const d = r.value
      const verdictIcon: Record<DoctorVerdict, string> = { healthy: '✅', attention: '🟡', critical: '🔴' }
      const priorityLabel: Record<DoctorPriority, string> = { 1: '🔴 P1 立即', 2: '🟠 P2 建议', 3: '🟢 P3 可选' }
      const lines = [
        `🩺 体检报告 [${cp.profile}]  ${verdictIcon[d.verdict] ?? '·'} ${d.verdict}`,
        `   健康度 ${d.healthScore}/100${d.blocking ? '  ⛔ 存在阻断项（清理事务将被拒绝）' : ''}`,
        `   潜在可回收: ${fmtBytes(d.totalReclaimableBytes)}  处方条目: ${d.recommendations.length}`,
      ]
      if (d.recommendations.length === 0) {
        lines.push('', '✅ 环境干净，无需清理。')
      } else {
        lines.push('', '─ 处方（按优先级）─')
        for (const rec of d.recommendations) {
          lines.push(
            `  ${priorityLabel[rec.priority]} [${rec.evidence.score.total}分/${rec.evidence.score.band}] ${rec.evidence.description}`,
            `     💡 ${rec.reason} → 建议 ${rec.suggestedStrategy}`,
            `     📍 ${rec.evidence.location}  💾 ${fmtBytes(rec.evidence.sizeBytes)}`,
          )
        }
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_dedup ───────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_dedup',
    description: '内容寻址去重：三级瀑布（尺寸分桶→头尾采样→全量 SHA-256）定位重复文件群；apply=true 时以硬链接实收（verify-then-link，需确认令牌）',
    parameters: {
      min_size_bytes: { type: 'integer', description: '参与分析的最小文件尺寸，默认 4096（须 ≥1）' },
      apply: { type: 'boolean', description: '将重复副本替换为硬链接实收空间（默认 false 只分析）' },
      confirm_token: { type: 'string', description: 'apply=true 时必填：LINK-DEDUP' },
    },
    execute: async ({ min_size_bytes, apply, confirm_token }) => {
      // 下限校验（领域规则）：0/负数会使全部文件进入哈希阶段 → 全盘 IO/CPU DoS；
      // integer 类型已由 DSL 保证
      if (min_size_bytes !== undefined && min_size_bytes < 1) {
        return { content: '❌ min_size_bytes 必须为 ≥1 的整数' }
      }
      const minSize = min_size_bytes
      // apply 属破坏性动作：显式令牌确认（与 aggressive 清理同纪律）
      if (apply === true && confirm_token !== 'LINK-DEDUP') {
        return { content: '❌ apply=true 需要确认令牌 confirm_token="LINK-DEDUP"（硬链接替换不可逆于权限语义）' }
      }
      const r = await rt.dedup.analyze(minSize !== undefined ? { minSizeBytes: minSize } : undefined)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const d = r.value
      if (d.groups.length === 0) {
        return { content: `✅ 未发现重复文件（扫描 ${d.filesScanned} 个 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms）。` }
      }

      // 记 pending：去重潜力基线先入台账（双轨记账）。apply 路径随后记
      // 实际 freed，两者对照可得"潜力兑现率"；此前 pending 位于 apply 分支
      // 的 return 之后，apply=true 时永远不会被记录，双轨断裂。
      await rt.ledger.record({
        at: new Date().toISOString(), kind: 'pending', txId: null,
        profile: LEDGER_GLOBAL, plugin: null, action: 'dedup-potential',
        bytes: d.totalReclaimableBytes, note: `${d.groups.length} 组重复内容`,
      })

      // apply 模式：分析 → 复验 → 硬链接实收
      if (apply === true) {
        const ex = await rt.dedupExec.apply(d)
        if (!ex.ok) return { content: `❌ ${ex.error.message}` }
        const e = ex.value
        // 台账：此处记实际 freed（诚实值：仅独占 inode 的副本）
        await rt.ledger.record({
          at: new Date().toISOString(), kind: 'freed', txId: null,
          profile: LEDGER_GLOBAL, plugin: null, action: 'dedup-hardlink',
          bytes: e.bytesSaved, note: `${e.linkedFiles} 个副本硬链接化 / ${e.skipped.length} 跳过`,
        })
        const lines = [
          `${e.cancelled ? '⏹️ 去重执行被中途取消（已完成部分已记 journal，可 undo）' : '♻️ 硬链接去重完成'}：${e.linkedFiles} 个副本已链接，实际回收 ${fmtBytes(e.bytesSaved)}`,
          `   （跳过 ${e.skipped.length} 项：复验失败/跨设备/已链接等）`,
          '',
          '  已链接样本：',
        ]
        for (const j of e.journal.slice(0, 8)) {
          lines.push(`    • ${path.basename(j.victim)} → ${path.basename(j.canonical)} (${fmtBytes(j.sizeBytes)})`)
        }
        if (e.skipped.length > 0) {
          lines.push('', '  跳过样本：')
          for (const s of e.skipped.slice(0, 5)) lines.push(`    • ${path.basename(s.path)}: ${s.reason}`)
        }
        return { content: lines.join('\n') }
      }

      const lines = [
        `♻️ 发现 ${d.groups.length} 组重复，合计可回收 ${fmtBytes(d.totalReclaimableBytes)}`,
        `   扫描 ${d.filesScanned} 文件 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms`,
        `   三级瀑布：尺寸淘汰 ${d.stages?.sizeEliminated ?? '—'} / 采样淘汰 ${d.stages?.sampleEliminated ?? '—'} / 全量哈希 ${d.stages?.fullHashed ?? '—'}（省读 ${fmtBytes(d.stages?.bytesSavedBySampling ?? 0)}）`,
        '',
      ]
      for (const g of d.groups.slice(0, 10)) {
        lines.push(`  • ${fmtBytes(g.sizeBytes)} × ${g.copies.length} 份`)
        for (const c of g.copies) {
          lines.push(`      ${c.profile ?? '—'}/${path.basename(c.path)}`)
        }
      }
      if (d.groups.length > 10) lines.push('', `  … 及另外 ${d.groups.length - 10} 组`)
      lines.push('', '💡 确认后可执行硬链接实收：apply=true + confirm_token="LINK-DEDUP"')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_restorepoint ────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_restorepoint',
    description: '配置还原点管理：清理前自动快照关键配置，事故后一键恢复（list / create / restore / prune）',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'restore', 'prune'], description: 'list / create / restore / prune，默认 list' },
      id: { type: 'string', description: 'restore 目标还原点 id' },
      profile: { type: 'string', description: 'create 用，默认 "web"' },
      reason: { type: 'string', description: 'create 用，默认 manual' },
      keep: { type: 'integer', description: 'prune 用：保留最近几个，默认 5（须 ≥1）' },
      actor: { type: 'string', description: 'create 用，默认 nuke-tool' },
    },
    execute: async ({ action = 'list', id, profile = 'web', reason = 'manual', keep = 5, actor = 'nuke-tool' }) => {
      if (action === 'create') {
        const cp = checkProfile(profile)
        if (!cp.ok) return { content: `❌ ${cp.error}` }
        const r = await rt.restorePoints.create({ actor, reason, profile: cp.profile })
        if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
        return {
          content: `🛡️ 还原点已创建: ${r.value.id}\n   文件 ${r.value.files.length} 个，快照于 ${r.value.createdAt}。`,
        }
      }
      if (action === 'restore') {
        if (!id) return { content: '❌ 请提供 id' }
        const r = await rt.restorePoints.restore(id)
        if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
        return { content: `↩️ 已恢复 ${r.value.files.length} 个配置文件到 ${r.value.createdAt} 时点（${r.value.id}）。` }
      }
      if (action === 'prune') {
        // keep 下限校验（领域规则）：0/负数 = 清空全部还原点（安全网不容许
        // 无确认全删）；integer 类型已由 DSL 保证
        if (keep < 1) {
          return { content: '❌ keep 必须为 ≥1 的整数（不允许清空全部还原点）' }
        }
        const r = await rt.restorePoints.prune(keep)
        if (!r.ok) return { content: `❌ ${r.error.message}` }
        return { content: `🧹 已删除 ${r.value} 个旧还原点。` }
      }
      // list
      const all = rt.restorePoints.list()
      if (all.length === 0) return { content: '暂无还原点。' }
      const lines = [`🛡️ ${all.length} 个还原点（最新在前）:`]
      for (const m of all) {
        lines.push(`  ${m.id}  ${m.createdAt}  ${m.files.length} 文件  by ${m.actor}  (${m.reason})`)
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_blastradius ─────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_blastradius',
    description: '爆炸半径沙盘推演（what-if）：删除前预测传递闭包波及面 —— 谁会损坏、谁可级联、风险几级、如何降险。零副作用',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, required: true, description: '要推演的插件名列表' },
      profile: { type: 'string', description: '限定单 profile 图（省略 = 全 profile）' },
    },
    execute: async ({ plugin_names, profile }) => {
      const cp = checkPlugins(plugin_names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      // profile 是路径段：白名单校验（防路径穿越）
      let prof: ProfileName | undefined
      if (profile !== undefined) {
        const c = checkProfile(profile)
        if (!c.ok) return { content: `❌ ${c.error}` }
        prof = c.profile
      }
      const r = await rt.blastRadius.simulate(cp.plugins, prof)
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const b = r.value
      const levelIcon: Record<RiskLevel, string> = { low: '🟢', medium: '🟡', high: '🟠', extreme: '🔴' }
      const lines = [
        `💥 爆炸半径推演  ${levelIcon[b.riskLevel]} ${b.riskLevel.toUpperCase()}（风险分 ${b.riskScore}/100）`,
        `   目标: ${b.targets.join(', ')}`,
        `   预估可回收: ${fmtBytes(b.estimatedBytesReclaimable)}  |  配置引用: ${b.configRefs.length} 处`,
      ]
      if (b.brokenDependents.length > 0) {
        lines.push('', `🚨 将损坏的插件 (${b.brokenDependents.length}): ${b.brokenDependents.join(', ')}`)
      } else {
        lines.push('', '✅ 无意外波及（删除集合外无依赖方）')
      }
      if (b.cascadeRemovable.length > 0) {
        lines.push(`📦 级联同删 (${b.cascadeRemovable.length}): ${b.cascadeRemovable.join(', ')}`)
      }
      lines.push('', '─ 顾问建议 ─')
      for (const a of b.advisories) lines.push(`  💡 ${a}`)
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_trend ───────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_trend',
    description: '历史趋势分析：可回收空间变化率（字节/天）、30 天线性外推、3σ 异常检测（插件失控写盘早期信号）',
    parameters: {
      profile: { type: 'string', description: '限定 profile（省略 = 全部）' },
    },
    execute: async ({ profile }) => {
      let prof: ProfileName | undefined
      if (profile !== undefined) {
        const cp = checkProfile(profile)
        if (!cp.ok) return { content: `❌ ${cp.error}` }
        prof = cp.profile
      }
      const r = await rt.trend.analyze(prof)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const t = r.value
      if (t.snapshotCount === 0) {
        return { content: '暂无历史快照 —— 运行 nuke_scan / nuke_clean / nuke_doctor 后自动积累。' }
      }
      const lines = [
        `📈 趋势分析（${t.snapshotCount} 个快照，${t.firstAt} → ${t.lastAt}）`,
        `   变化率: ${t.bytesPerDay >= 0 ? '+' : ''}${fmtBytes(Math.abs(t.bytesPerDay))}/天${t.bytesPerDay > 0 ? '（残留净增长）' : t.bytesPerDay < 0 ? '（净回收，趋势向好）' : ''}`,
      ]
      if (t.projected30dBytes !== null) {
        lines.push(`   30 天外推: ${fmtBytes(t.projected30dBytes)} 可回收`)
      }
      if (t.anomaly.detected) {
        lines.push('', `🚨 异常: ${t.anomaly.detail}`)
      } else if (t.snapshotCount >= 3) {
        lines.push('   ✅ 无异常突变')
      }
      if (t.latest) {
        const trig: Record<TrendTrigger, string> = { scan: '扫描', clean: '清理', doctor: '体检' }
        lines.push(`   最新快照: ${trig[t.latest.trigger] ?? t.latest.trigger} @ ${t.latest.at}，可回收 ${fmtBytes(t.latest.bytesReclaimable)}`)
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_policy ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_policy',
    description: '查看当前清理策略守卫配置（保护名单/批量上限/回收上限/磁盘下限/时间黑窗）。策略文件: <dshHome>/.nuke/policy.json',
    parameters: {},
    execute: async () => {
      const p = rt.policy.load()
      const lines = ['🛡️ 当前清理策略（policy.json）:',]
      lines.push(`  保护名单: ${p.protectedPlugins.length > 0 ? p.protectedPlugins.join(', ') : '（空）'}`)
      lines.push(`  单事务插件上限: ${p.maxPluginsPerTx ?? '无限制'}`)
      lines.push(`  单事务回收上限: ${p.maxReclaimBytesPerTx !== null ? fmtBytes(p.maxReclaimBytesPerTx) : '无限制'}`)
      lines.push(`  磁盘余量下限: ${p.minFreeDiskBytes !== null ? fmtBytes(p.minFreeDiskBytes) : '不检查'}`)
      lines.push(`  时间黑窗: ${p.blackout ? `${p.blackout.startHour}:00 - ${p.blackout.endHour}:00` : '无'}`)
      lines.push('', '说明: 策略文件缺失或损坏时默认全放行；保护名单同时以引擎 pre-hook 形式强制执行（纵深防御）。')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_guardian ────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_guardian',
    description: '守卫者巡检：一键主动运维 —— 磁盘写满倒计时/趋势异常/健康阻断/可回收积压/崩溃残留事务，输出带行动建议的分级告警',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const r = await rt.guardian.patrol({ profile: cp.profile })
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const g = r.value
      const sevIcon: Record<AlertSeverity, string> = { critical: '🔴', warning: '🟡', info: 'ℹ️' }
      const lines = [`🛡️ 守卫者巡检 @ ${g.patrolledAt}`]
      if (g.disk && g.disk.usedPct !== null) {
        lines.push(`   磁盘: 已用 ${g.disk.usedPct}%` +
          (g.disk.daysUntilFull !== null ? `，按当前增速约 ${g.disk.daysUntilFull.toFixed(1)} 天后写满` : ''))
      }
      if (g.partialFailures.length > 0) {
        lines.push(`   ⚠️ 部分采集降级: ${g.partialFailures.join('; ')}`)
      }
      if (g.alerts.length === 0) {
        lines.push('', '✅ 一切正常，无需行动。')
      } else {
        lines.push('', `发现 ${g.alerts.length} 条告警:`)
        for (const a of g.alerts) {
          lines.push(`  ${sevIcon[a.severity]} [${a.kind}] ${a.message}`)
          lines.push(`     → 建议调用 ${a.suggestedTool}`)
        }
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_forecast ────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_forecast',
    description: '磁盘写满预测：趋势回归 × 实时余量 → 写满倒计时（daysUntilFull）、30 天走势与分级建议',
    parameters: {},
    execute: async () => {
      const r = await rt.forecaster.forecast()
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const f = r.value
      const sevIcon: Record<ForecastSeverity, string> = { ok: '🟢', watch: '🟡', warning: '🟠', critical: '🔴' }
      const lines = [`🔮 磁盘预测 @ ${f.sampledAt}  ${sevIcon[f.severity]} ${f.severity}`]
      if (f.totalBytes !== null && f.freeBytes !== null) {
        lines.push(`   容量 ${fmtBytes(f.totalBytes)} | 余量 ${fmtBytes(f.freeBytes)} | 已用 ${f.usedPct}%`)
      } else {
        lines.push('   磁盘采样不可用（statfs 无权限），仅输出趋势侧结论')
      }
      if (f.growthBytesPerDay !== null) {
        lines.push(`   残留增速: ${fmtBytes(f.growthBytesPerDay)}/天（依据 ${f.trendBasis?.snapshotCount ?? 0} 个快照）`)
      } else {
        lines.push('   残留增速: 尚不可测（趋势样本不足或正在净回收）')
      }
      if (f.daysUntilFull !== null && f.projectedFullAt !== null) {
        lines.push(`   ⏳ 写满倒计时: ${f.daysUntilFull.toFixed(1)} 天（预计 ${f.projectedFullAt}）`)
      }
      lines.push('', `💡 ${f.recommendation}`)
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_ledger ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_ledger',
    description: '空间台账：每字节回收可溯源 —— 按动作/profile/日聚合，已回收(freed)与待回收(pending)双轨统计',
    parameters: {
      kind: { type: 'string', enum: ['freed', 'pending'], description: 'freed / pending（省略 = 全部）' },
      profile: { type: 'string', description: '限定 profile（省略 = 全部）' },
      days: { type: 'number', description: '只统计最近 N 天（省略 = 全部）' },
    },
    execute: async ({ kind, profile, days }) => {
      const filter: { kind?: 'freed' | 'pending'; profile?: ProfileName; since?: string } = {}
      if (kind !== undefined) filter.kind = kind
      if (profile !== undefined) {
        const cp = checkProfile(profile)
        if (!cp.ok) return { content: `❌ ${cp.error}` }
        filter.profile = cp.profile
      }
      if (days !== undefined) {
        // 下限校验（领域规则，DSL 无数值下限）：负数时间窗无意义；
        // number 类型已由 DSL 保证（JSON 不携带 NaN）
        if (days < 0) {
          return { content: '❌ days 必须为 ≥0 的数字' }
        }
        filter.since = new Date(Date.now() - days * 86_400_000).toISOString()
      }
      const r = await rt.ledger.query(filter)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const s = r.value
      if (s.entryCount === 0) return { content: '暂无台账记录 —— nuke_clean 执行后自动记账。' }
      const lines = [
        `📒 空间台账（${s.entryCount} 条）`,
        `   已回收: ${fmtBytes(s.totalFreed)}  |  待回收潜力: ${fmtBytes(s.totalPending)}`,
        '',
        '─ 按动作 ─',
        ...s.byAction.slice(0, 8).map(b => `  ${b.key}: ${fmtBytes(b.bytes)} × ${b.count} 次`),
        '',
        '─ 按 profile ─',
        ...s.byProfile.map(b => `  ${b.key}: ${fmtBytes(b.bytes)}`),
      ]
      if (s.byDay.length > 1) {
        lines.push('', '─ 按日（回收趋势）─')
        for (const d of s.byDay.slice(-14)) lines.push(`  ${d.key}: ${fmtBytes(d.bytes)}`)
      }
      const recent = rt.ledger.entries(filter, 3)
      if (recent.length > 0) {
        lines.push('', '─ 最近记录 ─')
        for (const e of recent) {
          lines.push(`  ${e.at}  ${e.kind === 'freed' ? '✅' : '⏳'} ${e.action} ${fmtBytes(e.bytes)}${e.txId ? ` (${e.txId})` : ''}`)
        }
      }
      return { content: lines.join('\n') }
    },
  }))
}

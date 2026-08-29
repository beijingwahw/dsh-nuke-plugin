// src/runtime.ts — 运行时组装（依赖注入的唯一事实源）
//
// 全部引擎/基础设施在此按依赖顺序实例化并互相接线；tools/* 各域
// 模块只消费 Runtime 类型，不自行构造任何依赖 —— 接线语义全局唯一。
import * as path from 'path'

import type { IToolRegistry } from './contracts/tool.contract'
import type { ITransactionEngine } from './contracts/transaction'
import { createBlastRadiusAnalyzer } from './engine/blast-radius'
import { createDedupAnalyzer } from './engine/dedup-analyzer'
import { createDedupExecutor } from './engine/dedup-executor'
import { createDependencyAnalyzer } from './engine/dependency-analyzer'
import { createDiskForecaster } from './engine/disk-forecaster'
import { createDoctor } from './engine/doctor'
import { createDrill } from './engine/drill'
import { createGuardian } from './engine/guardian'
import { createHealthInspector } from './engine/health-inspector'
import { createHookRegistry } from './engine/hook-registry'
import { createOracle } from './engine/oracle'
import { createOrphanDetector } from './engine/orphan-detector'
import { createResidualScanner } from './engine/residual-scanner'
import { createRestorePointManager } from './engine/restore-point'
import { createSeverityScorer } from './engine/severity-scorer'
import { createTransactionEngine } from './engine/transaction-engine'
import { createTrendTracker } from './engine/trend-tracker'
import { createAuditLog } from './infra/audit-log'
import { createBackupStore } from './infra/backup-store'
import { createLedger } from './infra/ledger'
import { createLockManager } from './infra/lock-manager'
import { createLogger } from './infra/logger'
import { createPathResolver } from './infra/path-resolver'
import { createPolicyGuard } from './infra/policy-guard'
import { createPredictionScorer } from './infra/prediction-score'
import { createReliabilityModel } from './infra/reliability'
import { createReporter } from './infra/reporter'
import { createScanCache } from './infra/scan-cache'
import { createToolRegistry } from './infra/tool-registry'
import { createValidator } from './infra/validator'
import { createWal } from './infra/wal'
import { makeOperationFactory } from './operations'

// ─── 运行时组装（依赖注入） ─────────────────────────────────

export function buildRuntime() {
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

  // V5.2 共享工具注册表：外部工具解析的单一事实源（dsh/pnpm 探测语义
  // 全系统只此一份）。支持 env 覆盖变量 DSH_BIN/PNPM_BIN（用户显式
  // 指定路径 → 响亮校验，不静默降级）。健康检查 / standard-remove /
  // pnpm-prune / doctor 全部委托此注册表 —— 语义漂移在结构上不可能。
  const toolRegistry: IToolRegistry = createToolRegistry()

  // 操作集编译器：引擎与先知共享同一份（推演与执行严格同构）
  const operationFactory = makeOperationFactory({
    validator,
    tempRoot: platform.tempRoot,
    tempTtlDays: 7,
    toolRegistry,
  })

  const engine: ITransactionEngine = createTransactionEngine(
    {
      lockManager, wal, backups, audit, resolver, logger, hooks,
      clock: { now: () => new Date() },
      verifyConfirmationToken: (token, req) =>
        token === confirmationTokenOf(req.profile, req.plugins),
      // V5.7 纵深防御：引擎自身的 profile/插件名白名单（工具层之外的第二道闸）。
      // 不注入 = 引擎校验分支永久休眠，直连引擎的调用方仍可传恶意 profile
      // 让"白名单根与目标同源逃逸"。装配层必须注入 —— fail-closed。
      validateProfile: p => validator.validateProfileName(p).ok,
      validatePlugin: n => validator.validatePluginName(n).ok,
      // V5.4 预测存证：commit 执行前把逐步预测写进 hash chain ——
      // 预测先于结局、事后不可篡改，先知从此可被问责（nuke_scorecard）
      predictor: () => createReliabilityModel({ audit }),
      // V5.5 自我校准：存证前应用战绩学到的偏差修正（收敛闭环写侧）
      calibrator: async () =>
        (await (await createPredictionScorer({ audit })).scorecard()).calibration,
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
    toolRegistry,
  })
  const doctor = createDoctor({
    health, scanner, orphans, scorer,
    clock: { now: () => new Date() },
    toolRegistry,
  })
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
    // V5.4 先知战绩：推演时一并公开历史预测成绩单（问责制）
    scorecard: async () => (await createPredictionScorer({ audit })).scorecard(),
  })

  // 混沌演习：沙箱内注入真实崩溃，持续证明崩溃可恢复性
  const drill = createDrill({ nukeRoot })

  return {
    resolver, platform, nukeRoot, logger, validator,
    engine, wal, audit, toolRegistry, lockManager,
    scorer, analyzer, scanner, orphans, health,
    doctor, dedup, dedupExec, restorePoints, reporter,
    blastRadius, trend, policy,
    forecaster, guardian, ledger,
    oracle, drill,
    confirmationTokenOf,
  }
}

export type Runtime = ReturnType<typeof buildRuntime>

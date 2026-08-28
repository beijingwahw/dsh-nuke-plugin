// src/engine/drill.ts — IDrill 实现：混沌演习（崩溃安全自检）
// Netflix Chaos Monkey 的磁盘卫生版：安全性不靠"相信"，靠"证明"。
//
// 演习剧本（全程沙箱，不触碰真实环境）：
//   1. 沙箱里造一个"受害者"：storages 目录 + patch 引用（真实文件）
//   2. 真实事务引擎 begin → plan → commit，在第 afterStep 步成功落盘后
//      注入 SimulatedCrashError —— 不回滚、不释放锁（进程死亡的忠实语义）
//   3. 走真实崩溃恢复路径 recover()（新引擎实例 = 新进程）
//   4. 逐项断言：数据字节级还原 / 配置还原 / 审计链完整 / WAL 终结 /
//      新事务畅通
//   5. 全部通过 → 签发崩溃安全证书；任一失败 → 证书作废并列出失败项
//
// 本轮升级（崩溃注入点矩阵 + 证书矩阵）：
//   单点演习只能证明"这一个断电位安全"；事务生命周期的崩溃谱系有三段：
//     · plan 后（零步骤执行 —— 计划完成即被 kill）
//     · 第 1 步后（半执行 —— 最经典的断电位）
//     · 第 2 步后（全执行未提交 —— 最阴险：做完了一切却没落 tx-commit）
//   runMatrix() 一次跑完三点，各自独立沙箱、独立完整验证，产出证书矩阵
//   （每点一张证书 + 聚合裁决）。任一点失败 → 整体证书作废 ——
//   崩溃安全的证明不能挑最有利的断电位。
//
// 锁清理说明：真实崩溃后锁由 stale-break 协议处理（需进程死亡 + TTL）。
// 沙箱无法伪造"本进程已死"（pid 活着），故用"模拟重启运维清锁"替代，
// 这也是现实中管理员处理沙箱的标准动作。
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import type { AbsolutePath, Result, TxId } from '../contracts/base'
import { err, ioError, ok, SimulatedCrashError } from '../contracts/base'
import type { IDrill, DrillCheck, DrillReport } from '../contracts/drill.contract'
import type { ILogger } from '../contracts/logging'
import type { IPathResolver } from '../contracts/paths'
import type { CleanOperation, CleanRequest, TxContext } from '../contracts/transaction'
import { createAuditLog } from '../infra/audit-log'
import { createBackupStore } from '../infra/backup-store'
import { createLockManager } from '../infra/lock-manager'
import { createLogger } from '../infra/logger'
import { createWal } from '../infra/wal'

import { createHookRegistry } from './hook-registry'
import { createTransactionEngine } from './transaction-engine'

// ─── 引擎层扩展类型（contracts 只读；新输出经协变子类型暴露） ──

/** 单个注入点的证书：矩阵的一行 */
export interface DrillPointCertificate {
  /** 注入点标识：'plan' = 计划完成后断电（零步骤执行）；
   *  数字 = 第 N 步成功落盘后断电（1-based） */
  readonly point: 'plan' | number
  /** 该点独立沙箱的 runId（现场取证入口） */
  readonly runId: string
  /** 该点全部检查通过（证书签发条件） */
  readonly passed: boolean
  readonly checks: readonly DrillCheck[]
  readonly restoredFiles: number
  readonly durationMs: number
}

/** 证书矩阵报告：多点独立验证的聚合（DrillReport 字段语义向后兼容；
 *  crashedAtStep = -1 哨兵表示矩阵模式 —— 真实注入点在 matrix 里） */
export interface DrillMatrixReport extends DrillReport {
  /** 各注入点证书（矩阵定义序：plan → 第 1 步 → 第 2 步） */
  readonly matrix: readonly DrillPointCertificate[]
  /** 独立验证的注入点数（完整矩阵 = 3） */
  readonly pointsVerified: number
}

/** IDrill 的引擎层扩展：新增矩阵演习（协变返回类型） */
export interface IDrillDetail extends IDrill {
  /** 崩溃注入点矩阵：一次调用覆盖 plan 后 / 第 1 步后 / 第 2 步后三个
   *  注入点（各自独立沙箱、独立完整验证），返回证书矩阵 */
  runMatrix(): Promise<Result<DrillMatrixReport>>
}

/** 运行时判别：报告是否为证书矩阵（携带注入点矩阵字段）。
 *  类型层面 DrillMatrixReport 会被联合类型子类型归约吞掉（extends
 *  DrillReport），消费者需要本判别器做类型安全分流 —— 与
 *  trend-tracker 的 isTrendReportDetail 同一模式。 */
export function isDrillMatrixReport(report: DrillReport): report is DrillMatrixReport {
  return 'matrix' in report && 'pointsVerified' in report
}

export interface DrillOptions {
  /** 演习沙箱根：<nukeRoot>/drill/<runId>/ */
  readonly nukeRoot: string
  readonly logger?: ILogger
  /** 保留最近 N 次演习现场（默认 5，更早的自动清理） */
  readonly keepRuns?: number
}

const VICTIM = 'drill-victim'
const DATA_BYTES = 256 * 1024

/** 完整注入点矩阵：事务生命周期三段崩溃谱系（runMatrix 的执行序） */
const MATRIX_POINTS: readonly ('plan' | 1 | 2)[] = ['plan', 1, 2]

export function createDrill(options: DrillOptions): IDrillDetail {
  const logger = options.logger ?? createLogger({ sink: 'plain', minLevel: 'error' })
  const keepRuns = options.keepRuns ?? 5

  /** 单注入点演习：point = 'plan'（计划后死亡，零步骤执行）或 1..2（第 N
   *  步成功落盘后注入 SimulatedCrashError）。每点独立沙箱独立验证。 */
  async function runPoint(point: 'plan' | 1 | 2): Promise<Result<DrillReport>> {
    const startedMs = Date.now()
    const afterStep = point === 'plan' ? 0 : point
    const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
    const sandbox = path.join(options.nukeRoot, 'drill', runId)
    const home = path.join(sandbox, 'home')
    const state = path.join(sandbox, 'state')
    const victimDir = path.join(home, 'storages', VICTIM)
    const patchFile = path.join(home, 'cordis.patch.yml')

    const checks: DrillCheck[] = []
    const check = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail })
    }

    try {
      // ── 1. 沙箱现场：真实文件、真实字节 ──────────────────────
      fs.mkdirSync(victimDir, { recursive: true })
      fs.mkdirSync(state, { recursive: true })
      const payload = crypto.randomBytes(DATA_BYTES)
      fs.writeFileSync(path.join(victimDir, 'data.bin'), payload)
      const dataSha = crypto.createHash('sha256').update(payload).digest('hex')
      const patchOriginal = `- id: keep\n- id: ${VICTIM}\n`
      fs.writeFileSync(patchFile, patchOriginal)

      // 沙箱 resolver：让引擎拿到一个类型完整、指向沙箱的路径解析器
      const sandboxResolver: IPathResolver = {
        platform: () => ({
          os: 'linux', home: home as AbsolutePath,
          tempRoot: path.join(sandbox, 'tmp') as AbsolutePath,
          dshHome: home as AbsolutePath, pathSep: '/',
        }),
        canonicalize: async p => ok(p as AbsolutePath),
        isWithin: async () => true,
        assertDeletable: async p => ok(p as AbsolutePath),
        profileDir: () => path.join(home, 'profiles', 'web') as AbsolutePath,
        storagesRoot: () => path.join(home, 'storages') as AbsolutePath,
        attachmentsRoot: () => path.join(home, 'attachments') as AbsolutePath,
        dshHomePatchFile: () => patchFile as AbsolutePath,
        nukeStateRoot: () => state as AbsolutePath,
      }

      // 沙箱操作集（两步剧本）
      const ops = (): CleanOperation[] => [
        {
          id: 'drill-stage-dir',
          action: 'remove-storages',
          target: VICTIM as never,
          async preview() {
            return {
              summary: `移除 storages/${VICTIM}`,
              touchedPaths: [victimDir as AbsolutePath],
              estimatedBytesReclaimable: DATA_BYTES,
              requiresExclusiveLock: true,
            }
          },
          async validate() { return ok(undefined) },
          async execute(ctx: TxContext) {
            if (!fs.existsSync(victimDir)) {
              return ok({ outcome: { bytesFreed: 0, message: '跳过（不存在）' }, backup: null })
            }
            const backup = await ctx.backups.stageDir(victimDir as AbsolutePath)
            return ok({ outcome: { bytesFreed: DATA_BYTES, message: '已移入回收区' }, backup })
          },
          async undo() { return ok(undefined) },
        },
        {
          id: 'drill-edit-patch',
          action: 'clean-home-patch',
          target: VICTIM as never,
          async preview() {
            return {
              summary: '摘除 cordis.patch.yml 引用',
              touchedPaths: [patchFile as AbsolutePath],
              estimatedBytesReclaimable: 5,
              requiresExclusiveLock: true,
            }
          },
          async validate() { return ok(undefined) },
          async execute(ctx: TxContext) {
            const original = fs.readFileSync(patchFile, 'utf-8')
            const next = original.split('\n').filter(l => !l.includes(VICTIM)).join('\n')
            if (next === original) {
              return ok({ outcome: { bytesFreed: 0, message: '无需变更' }, backup: null })
            }
            const backup = await ctx.backups.stageEdit(patchFile as AbsolutePath, next)
            return ok({ outcome: { bytesFreed: 5, message: '已清理引用' }, backup })
          },
          async undo() { return ok(undefined) },
        },
      ]

      // ── 2. 第一幕：真实事务 + 注入崩溃 ────────────────────────
      const backups1 = createBackupStore({ backupRoot: path.join(state, 'backups') })
      const wal1 = createWal({ walRoot: path.join(state, 'tx') })
      const engine1 = createTransactionEngine(
        {
          lockManager: createLockManager({ lockRoot: state }),
          wal: wal1,
          backups: backups1,
          audit: createAuditLog({ filePath: path.join(state, 'audit', 'chain.jsonl') }),
          resolver: sandboxResolver,
          logger,
          hooks: createHookRegistry({ dir: path.join(state, 'hooks') }),
          clock: { now: () => new Date() },
          // plan 点 = 计划完成即死亡（零步骤执行），无需步骤注入钩子
          ...(point !== 'plan' ? { crashAfterStep: afterStep - 1 } : {}),
        },
        ops,
      )

      const request: CleanRequest = {
        plugins: [VICTIM as never], profile: 'web' as never,
        strategy: 'safe', dryRun: false, actor: 'chaos-drill',
      }
      let crashed = false
      let crashMessage = ''
      let txId = ''
      try {
        const session = await engine1.begin(request)
        if (!session.ok) return err(session.error)
        txId = session.value.txId
        const plan = await engine1.plan(session.value)
        if (!plan.ok) return err(plan.error)
        if (point === 'plan') {
          // plan 后"断电"：不调 commit、不 rollback —— 进程在计划完成后
          // 被 kill 的忠实语义（事务挂起，零步骤执行，独占锁仍持有）
          crashed = wal1.unfinishedTxIds().includes(txId as TxId)
          crashMessage = `plan 完成后进程死亡（事务挂起未终结，零步骤执行）`
        } else {
          await engine1.commit(plan.value)   // 预期在此抛 SimulatedCrashError
        }
      } catch (e) {
        if (e instanceof SimulatedCrashError) {
          crashed = true
          crashMessage = e.message
        } else {
          return err(ioError('演习事务异常（非预期）', e))
        }
      }
      check('崩溃注入生效', crashed, crashed ? crashMessage : 'commit 未抛出 SimulatedCrashError')

      // 崩溃现场取证：注入点语义决定期望状态 ——
      //   step 点：目录已被 stage 走（半执行状态真实存在）
      //   plan 点：目录仍在原位（零步骤执行，一步都没动过）
      const stagedAway = !fs.existsSync(victimDir)
      const faithful = point === 'plan' ? !stagedAway : stagedAway
      check(
        point === 'plan' ? '崩溃现场保真（零执行状态）' : '崩溃现场保真（半执行状态）',
        faithful,
        point === 'plan'
          ? (faithful
            ? `storages/${VICTIM} 原位未动，事务确实挂起于 plan 后（零步骤执行）`
            : '受害者目录意外消失 —— plan 点不应有任何执行')
          : (stagedAway
            ? `storages/${VICTIM} 已移入回收区，事务确实中断于第 ${afterStep} 步后`
            : '受害者目录仍在原位，崩溃未发生在执行中途'),
      )

      // 锁悬挂：真实崩溃不释放锁（这正是 recover 后需要处理的状态）
      const lockDir = path.join(state, 'locks')
      const lockFile = path.join(lockDir, 'global.lock')
      const lockDangling = fs.existsSync(lockFile)
      check('独占锁悬挂（真实崩溃语义）', lockDangling,
        lockDangling ? '崩溃后锁未释放（进程死亡语义正确）' : '锁意外消失 —— 崩溃模拟不忠实')

      // 崩溃前备份清单（恢复期望值）
      const manifestLen = (await backups1.reserve(txId as TxId)).manifest().length

      // ── 3. 第二幕：模拟重启（清锁）→ 新进程恢复 ────────────────
      if (lockDangling) fs.rmSync(lockDir, { recursive: true, force: true })
      check('锁清理（模拟重启运维）', !fs.existsSync(lockFile),
        '真实环境由 stale-break 协议处理（需进程死亡+TTL）；沙箱以清锁模拟重启')

      const wal2 = createWal({ walRoot: path.join(state, 'tx') })
      const audit2 = createAuditLog({ filePath: path.join(state, 'audit', 'chain.jsonl') })
      const engine2 = createTransactionEngine(
        {
          lockManager: createLockManager({ lockRoot: state }),
          wal: wal2,
          backups: createBackupStore({ backupRoot: path.join(state, 'backups') }),
          audit: audit2,
          resolver: sandboxResolver,
          logger,
          hooks: createHookRegistry({ dir: path.join(state, 'hooks') }),
          clock: { now: () => new Date() },
        },
        ops,
      )

      const recovery = await engine2.recover()
      const recovered = recovery.ok ? recovery.value : []
      check('崩溃恢复：事务回滚', recovery.ok && recovered.length === 1 && recovered[0]!.state === 'rolled-back',
        recovery.ok
          ? `recover() 恢复 ${recovered.length} 个事务（state=${recovered[0]?.state ?? 'n/a'}）`
          : `recover() 失败: ${recovery.error.message}`)

      // ── 4. 第三幕：逐项断言环境还原 ──────────────────────────
      const dataPath = path.join(victimDir, 'data.bin')
      let dataRestored = false
      let dataDetail = '数据文件未还原'
      try {
        const back = fs.readFileSync(dataPath)
        dataRestored = crypto.createHash('sha256').update(back).digest('hex') === dataSha
        dataDetail = dataRestored ? `${DATA_BYTES / 1024}KB 数据字节级一致（sha256 匹配）` : '内容与崩溃前不一致'
      } catch { /* 已由 dataRestored=false 覆盖 */ }
      check('数据字节级还原', dataRestored, dataDetail)

      let patchRestored = false
      let patchDetail = '配置未还原'
      try {
        const cur = fs.readFileSync(patchFile, 'utf-8')
        patchRestored = cur === patchOriginal
        patchDetail = patchRestored ? 'cordis.patch.yml 恢复为崩溃前内容' : 'patch 内容与崩溃前不一致'
      } catch { /* 已由 patchRestored=false 覆盖 */ }
      check('配置引用还原', patchRestored, patchDetail)

      const chain = await audit2.verify()
      check('审计链完整（hash chain）', chain.valid,
        chain.valid ? `${chain.totalEntries} 条审计记录链式校验通过` : `链在 seq=${chain.firstBrokenSeq} 处断裂`)

      const unfinished = wal2.unfinishedTxIds()
      check('WAL 无未终结事务', unfinished.length === 0,
        unfinished.length === 0 ? '全部事务已终结（tx-commit/tx-rollback）' : `残留未终结: ${unfinished.join(', ')}`)

      // 新事务畅通：证明崩溃不会永久阻塞后续清理
      const again = await engine2.begin(request)
      let unblocked = false
      let unblockDetail = 'begin 失败'
      if (again.ok) {
        const rb = await engine2.rollback(again.value.txId)
        if (rb.ok) {
          unblocked = true
          unblockDetail = '崩溃恢复后新事务可正常开启与终结'
        } else {
          unblockDetail = `新事务回滚失败: ${rb.error.message}`
        }
      } else {
        unblockDetail = `begin 失败: ${again.error.message}`
      }
      check('新事务畅通（无永久阻塞）', unblocked, unblockDetail)

      // ── 5. 收尾：历史演习现场修剪 ────────────────────────────
      pruneOldRuns(path.join(options.nukeRoot, 'drill'), keepRuns)

      const passed = checks.every(c => c.passed)
      const report: DrillReport = {
        runId,
        crashedAtStep: afterStep,
        checks,
        passed,
        restoredFiles: manifestLen,
        auditChainValid: chain.valid,
        durationMs: Date.now() - startedMs,
      }
      return ok(report)
    } catch (e) {
      return err(ioError('混沌演习执行异常', e))
    }
  }

  return {
    async run(runOptions) {
      const TOTAL_STEPS = 2   // 沙箱剧本固定两步：目录回收 + patch 摘除
      const afterStep = runOptions?.afterStep ?? 1
      if (!Number.isInteger(afterStep) || afterStep < 1 || afterStep > TOTAL_STEPS) {
        return err({
          code: 'E_VALIDATION',
          message: `afterStep 必须为 1..${TOTAL_STEPS} 的整数（沙箱剧本共 ${TOTAL_STEPS} 步）`,
        })
      }
      return await runPoint(afterStep as 1 | 2)
    },

    async runMatrix() {
      // 逐点独立演习（每点独立沙箱独立验证）；某点执行异常 → 整矩阵失败
      const certificates: DrillPointCertificate[] = []
      const pointLabel = (p: 'plan' | 1 | 2): string =>
        p === 'plan' ? 'plan 后' : `第 ${p} 步后`
      for (const point of MATRIX_POINTS) {
        const r = await runPoint(point)
        if (!r.ok) return r
        const rep = r.value
        certificates.push({
          point,
          runId: rep.runId,
          passed: rep.passed,
          checks: rep.checks,
          restoredFiles: rep.restoredFiles,
          durationMs: rep.durationMs,
        })
      }

      // 聚合裁决：任一点失败 → 整体证书作废（崩溃安全的证明不能挑断电位）
      const passed = certificates.every(c => c.passed)
      const checks = certificates.flatMap(c =>
        c.checks.map(k => ({ ...k, name: `[${pointLabel(c.point as 'plan' | 1 | 2)}] ${k.name}` })))
      const report: DrillMatrixReport = {
        runId: certificates[0]?.runId ?? '',
        crashedAtStep: -1,   // 哨兵：矩阵模式无单一注入点，真实注入点在 matrix
        checks,
        passed,
        restoredFiles: certificates.reduce((s, c) => s + c.restoredFiles, 0),
        auditChainValid: passed,
        durationMs: certificates.reduce((s, c) => s + c.durationMs, 0),
        matrix: certificates,
        pointsVerified: certificates.length,
      }
      return ok(report)
    },
  }
}

/** 保留最近 keepRuns 次演习现场（runId 前缀时间戳 → 字典序即时间序） */
function pruneOldRuns(drillRoot: string, keepRuns: number): void {
  try {
    const dirs = fs.readdirSync(drillRoot)
      .filter(d => fs.statSync(path.join(drillRoot, d)).isDirectory())
      .sort()
    for (const d of dirs.slice(0, Math.max(0, dirs.length - keepRuns))) {
      fs.rmSync(path.join(drillRoot, d), { recursive: true, force: true })
    }
  } catch { /* 修剪失败不影响演习报告 */ }
}

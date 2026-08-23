// src/engine/oracle.ts — IOracle 实现：先知引擎（后果推演）
// 与 dry-run 的本质区别：dry-run 是确定性计划投影（"我会做这些"），
// 先知是概率化后果推演（"做了会怎样、多大把握、哪里最脆弱"）。
//
// 数据融合（五个来源，全部零副作用）：
//   1. operationFactory + preview      → 每步动作与预估回收量
//   2. 贝叶斯可靠性模型                 → 每类动作成功率（收缩后验）
//   3. 校准分布                        → 预估 → 实际的换算（分位数）
//   4. 爆炸半径分析器（可选）            → broken dependents
//   5. 磁盘预测器（可选）                → 清理对写满倒计时的延长量
//
// 影子上下文纪律：TxContext.backups 是"炸弹桩"——任何操作若胆敢在
// preview 阶段触碰备份区（副作用逃逸），立即爆炸失败，防患于未然。
import type { CleanOperation, CleanRequest, TxContext } from '../contracts/transaction'
import type { TxId, PluginName } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { IReliabilityModel } from '../contracts/reliability.contract'
import type {
  IOracle, OracleConfidence, OracleReport, OracleStep, OracleWeakestStep,
} from '../contracts/oracle.contract'
import type { ILogger } from '../contracts/logging'
import type { Clock } from '../contracts/base'
import type { IPathResolver } from '../contracts/paths'
import type { IBlastRadiusAnalyzer } from '../contracts/blast-radius.contract'
import type { IDiskForecaster } from '../contracts/disk-forecast.contract'
import { fmtBytes } from '../contracts/base'

export interface OracleDeps {
  /** 工厂而非实例：每次推演都从审计链重建模型 —— 预测永远基于
   *  最新的历史数据（上一次清理刚积累的样本立即参与下一次预测） */
  readonly reliability: () => Promise<IReliabilityModel>
  readonly operationFactory: (request: CleanRequest) => CleanOperation[]
  readonly resolver: IPathResolver
  readonly logger: ILogger
  readonly clock: Clock
  readonly blastRadius?: IBlastRadiusAnalyzer
  readonly forecaster?: IDiskForecaster
}

/** preview 阶段触碰备份区 = 副作用逃逸，立即引爆（防御性纪律） */
const BOMB_BACKUPS = {
  stageFile: () => { throw new Error('ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
  stageDir: () => { throw new Error('ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
  stageEdit: () => { throw new Error('ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
} as never

export function createOracle(deps: OracleDeps): IOracle {
  return {
    async divine(request) {
      try {
        const shadowCtx: TxContext = {
          txId: 'oracle-shadow' as TxId,
          request: request as CleanRequest,
          resolver: deps.resolver,
          logger: deps.logger.child({ oracle: true }),
          clock: deps.clock,
          backups: BOMB_BACKUPS,
        }

        const ops = deps.operationFactory(request as CleanRequest)

        // ── 逐步 preview（零副作用）→ 预估量 ────────────────────
        const previews: { op: CleanOperation; summary: string; estimated: number }[] = []
        for (const op of ops) {
          const p = await op.preview(shadowCtx)
          previews.push({ op, summary: p.summary, estimated: p.estimatedBytesReclaimable })
        }

        // ── 可靠性融合 ──────────────────────────────────────────
        const rel = await deps.reliability()
        const steps: OracleStep[] = []
        // 后缀和：exposure_i = Σ_{j≥i} b_j（第 i 步失败作废的总量）
        const suffix = new Array<number>(previews.length + 1).fill(0)
        for (let i = previews.length - 1; i >= 0; i--) {
          suffix[i] = suffix[i + 1]! + previews[i]!.estimated
        }
        for (const [i, pv] of previews.entries()) {
          const r = rel.reliabilityOf(pv.op.action)
          steps.push({
            index: i,
            action: pv.op.action,
            operationId: pv.op.id,
            summary: pv.summary,
            estimatedBytes: pv.estimated,
            successProbability: r.successProbability,
            exposureBytes: suffix[i]!,
            calibration: r.calibration,
          })
        }

        // 事务成功率：Saga 全成或全无 → 连乘
        const pSuccess = steps.reduce((acc, s) => acc * s.successProbability, 1)

        // 期望回收与区间：成功前提下的校准分位 × 各步预估
        const calOf = (s: OracleStep, q: 'p10' | 'p50' | 'p90') => {
          // 无校准数据 → 比率 1（诚实：不假装知道偏差）
          const c = s.calibration
          return c ? c[q] : 1
        }
        const q10 = steps.reduce((acc, s) => acc + s.estimatedBytes * calOf(s, 'p10'), 0)
        const q50 = steps.reduce((acc, s) => acc + s.estimatedBytes * calOf(s, 'p50'), 0)
        const q90 = steps.reduce((acc, s) => acc + s.estimatedBytes * calOf(s, 'p90'), 0)
        const expectedReclaim = pSuccess * q50

        // 最脆弱步骤：失败概率 × 敞口（作废的预估量）最大者
        let weakest: OracleWeakestStep | null = null
        for (const s of steps) {
          const vuln = (1 - s.successProbability) * s.exposureBytes
          const cur = weakest ? (1 - weakest.successProbability) * weakest.exposureBytes : -1
          if (vuln > cur && vuln > 0) {
            weakest = {
              index: s.index, action: s.action,
              successProbability: s.successProbability, exposureBytes: s.exposureBytes,
            }
          }
        }

        // 期望回滚深度：Σ i·P(首败于 i)
        let rollbackDepth = 0
        let reach = 1   // 到达第 i 步的概率
        for (const s of steps) {
          rollbackDepth += reach * (1 - s.successProbability) * s.index
          reach *= s.successProbability
        }

        // ── 爆炸半径（可选；分析失败不阻断推演） ──────────────────
        let broken: readonly PluginName[] | null = null
        if (deps.blastRadius && request.plugins.length > 0) {
          try {
            const b = await deps.blastRadius.simulate(request.plugins, request.profile)
            if (b.ok) broken = b.value.brokenDependents
          } catch { broken = null }
        }

        // ── 磁盘倒计时延长（可选） ───────────────────────────────
        let diskExtensionDays: number | null = null
        if (deps.forecaster && expectedReclaim > 0) {
          try {
            const f = await deps.forecaster.forecast()
            if (f.ok
              && f.value.daysUntilFull !== null
              && f.value.growthBytesPerDay !== null
              && f.value.growthBytesPerDay > 0) {
              diskExtensionDays = expectedReclaim / f.value.growthBytesPerDay
            }
          } catch { diskExtensionDays = null }
        }

        // 置信度：样本量驱动（统计的诚实——数据不够就说不够）
        const confidence: OracleConfidence =
          rel.sampleCount >= 30 ? 'high' : rel.sampleCount >= 5 ? 'medium' : 'low'

        const report: OracleReport = {
          request,
          steps,
          totalEstimatedBytes: suffix[0] ?? 0,
          transactionSuccessProbability: pSuccess,
          expectedReclaimBytes: expectedReclaim,
          reclaimP10IfSuccess: q10,
          reclaimP90IfSuccess: q90,
          weakestStep: weakest,
          expectedRollbackDepth: rollbackDepth,
          brokenDependents: broken,
          diskExtensionDays,
          confidence,
          narrative: narrate(pSuccess, expectedReclaim, weakest, broken, confidence),
          evidence: {
            stepSamples: rel.sampleCount,
            globalSuccessProbability: rel.globalSuccessProbability,
          },
        }
        return ok(report)
      } catch (e) {
        return err(ioError('先知推演失败', e))
      }
    },
  }
}

function narrate(
  p: number, expected: number,
  weakest: OracleWeakestStep | null,
  broken: readonly PluginName[] | null,
  confidence: OracleConfidence,
): string {
  const pct = (p * 100).toFixed(1)
  const parts: string[] = []
  parts.push(`事务成功率 ${pct}%，期望回收 ${fmtBytes(expected)}`)
  if (weakest && (1 - weakest.successProbability) * weakest.exposureBytes > 0) {
    parts.push(`最脆弱环节是第 ${weakest.index} 步 ${weakest.action}（成功率 ${(weakest.successProbability * 100).toFixed(0)}%，失败将作废 ${fmtBytes(weakest.exposureBytes)} 潜在回收）`)
  }
  if (broken && broken.length > 0) {
    parts.push(`⚠️ 将损坏 ${broken.length} 个外部依赖方（${broken.join(', ')}），建议先解除依赖或同批删除`)
  } else if (p >= 0.85) {
    parts.push('各环节可靠，可放心进入 dry-run → commit')
  }
  if (confidence === 'low') {
    parts.push('历史样本不足，预测以保守先验为主 —— 执行越多，先知越准')
  }
  return parts.join('；') + '。'
}

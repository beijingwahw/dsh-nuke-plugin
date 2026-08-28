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
import type { CleanStrategy, PluginName, ProfileName, TxId } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { IReliabilityModel } from '../contracts/reliability.contract'
import type { IOracle, OracleConfidence, OracleReport, OracleStep, OracleWeakestStep,
} from '../contracts/oracle.contract'
import type { ILogger } from '../contracts/logging'
import type { Clock } from '../contracts/base'
import type { IPathResolver } from '../contracts/paths'
import type { IBlastRadiusAnalyzer } from '../contracts/blast-radius.contract'
import type { IDiskForecaster } from '../contracts/disk-forecast.contract'
import { fmtBytes } from '../contracts/base'

// ─── 引擎层扩展类型（contracts 只读；新输出字段在此定义并导出） ──

/** 蒙特卡洛回收分布摘要：对步骤成败做 N 次抽样（种子可复现），
 *  输出期望回收的无条件口径分位数 —— 解析式连乘的补充与互证。
 *  无条件 = 已把 Saga 失败回滚（回收 0）折算进分布。 */
export interface MonteCarloSummary {
  /** 抽样次数 */
  readonly trials: number
  /** 随机种子（同种子 + 同步骤序列 → 逐位可复现） */
  readonly seed: number
  /** 回收分布 P10（至少 10% 的抽样结果不高于该值） */
  readonly p10: number
  /** 回收分布 P50（中位数） */
  readonly p50: number
  /** 回收分布 P90 */
  readonly p90: number
  /** 蒙特卡洛均值（与解析期望 expectedReclaimBytes 互证） */
  readonly mean: number
  /** 抽样中事务全成的频率（与解析连乘 transactionSuccessProbability 互证） */
  readonly successRate: number
}

/** 最脆弱步骤详情：附带"修复它对整体成功率的提升幅度"（可行动性） */
export interface OracleWeakestStepDetail extends OracleWeakestStep {
  /** 将该步成功率视作 1（完全修复）后的整体成功率 */
  readonly repairedSuccessProbability: number
  /** 修复带来的整体成功率绝对提升（repaired − current） */
  readonly repairUplift: number
}

/** 先知报告详情：契约字段语义不变，新增蒙特卡洛分布与修复建议 */
export interface OracleReportDetail extends OracleReport {
  readonly weakestStep: OracleWeakestStepDetail | null
  /** 蒙特卡洛模拟结果（trials=0 时各分位数与均值退化为 0） */
  readonly monteCarlo: MonteCarloSummary
}

/** IOracle 的引擎层扩展：divine 返回详情报告（协变返回类型） */
export interface IOracleDetail extends IOracle {
  divine(request: {
    readonly plugins: readonly PluginName[]
    readonly profile: ProfileName
    readonly strategy: CleanStrategy
  }): Promise<import('../contracts/base').Result<OracleReportDetail, import('../contracts/base').NukeError>>
}

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
  /** 蒙特卡洛抽样次数（默认 2000；0 = 关闭模拟） */
  readonly monteCarloTrials?: number
  /** 蒙特卡洛随机种子（默认固定常量：跨调用可复现） */
  readonly monteCarloSeed?: number
}

/** preview 阶段触碰备份区 = 副作用逃逸，立即引爆（防御性纪律） */
const BOMB_BACKUPS = {
  stageFile: () => { throw new Error('ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
  stageDir: () => { throw new Error('ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
  stageEdit: () => { throw new Error('ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）') },
} as never

/** 蒙特卡洛默认抽样次数：2000 次下分位数估计已稳定（SE(均值) ≈ σ/45），
 *  耗时在毫秒级（纯算术，零 IO） */
const DEFAULT_MC_TRIALS = 2000
/** 默认种子：固定常量 → 同输入跨调用逐位可复现（确定性测试的基石） */
const DEFAULT_MC_SEED = 0x0ddba11

// ─── 种子化伪随机（LCG）：零依赖自带，可复现 ─────────────────
// 数值取自 Numerical Recipes 的经典 LCG 参数（m=2^32, a=1664525, c=1013904223），
// 周期 2^32，低比特独立性足以支撑伯努利抽样与分位逆推。
/** 线性同余发生器：闭包持有状态，next() → [0,1) 均匀分布 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** 样本分位数（线性插值），空样本 → 0 */
function sampleQuantile(sorted: readonly number[], q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const pos = (n - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/** 校准比分位逆推：u ∈ [0,1) → 比率值。分位数 (p10,p50,p90) 定义分段
 *  线性近似 CDF：u≤0.1 → p10（下截断）、u≥0.9 → p90（上截断）、
 *  中间两段线性插值。无校准数据 → 恒 1（诚实：不假装知道偏差）。
 *  线性插值可能给出负比率（p10<0 不可能——校准比恒非负，截断天然安全） */
function calibrationRatio(
  u: number,
  cal: { readonly p10: number; readonly p50: number; readonly p90: number } | null,
): number {
  if (cal === null) return 1
  if (u <= 0.1) return cal.p10
  if (u >= 0.9) return cal.p90
  if (u <= 0.5) {
    const t = (u - 0.1) / 0.4
    return cal.p10 + (cal.p50 - cal.p10) * t
  }
  const t = (u - 0.5) / 0.4
  return cal.p50 + (cal.p90 - cal.p50) * t
}

/** 蒙特卡洛推演：逐次抽样步骤成败（伯努利）与校准比（分位逆推），
 *  Saga 语义 —— 任一步失败该次回收记 0。返回回收样本的无条件分位分布。 */
function monteCarlo(
  steps: readonly { p: number; bytes: number; cal: OracleStep['calibration'] }[],
  trials: number,
  seed: number,
): MonteCarloSummary {
  if (trials <= 0 || steps.length === 0) {
    return { trials: Math.max(0, trials), seed, p10: 0, p50: 0, p90: 0, mean: 0, successRate: steps.length === 0 ? 1 : 0 }
  }
  const rand = lcg(seed)
  const samples: number[] = new Array(trials)
  let successes = 0
  for (let t = 0; t < trials; t++) {
    let reclaim = 0
    let allDone = true
    for (const s of steps) {
      if (rand() >= s.p) { allDone = false; break }   // 首败即回滚（Saga）
      reclaim += s.bytes * calibrationRatio(rand(), s.cal)
    }
    if (allDone) successes++
    samples[t] = allDone ? reclaim : 0
  }
  samples.sort((a, b) => a - b)
  const mean = samples.reduce((s, v) => s + v, 0) / trials
  return {
    trials,
    seed,
    p10: sampleQuantile(samples, 0.10),
    p50: sampleQuantile(samples, 0.50),
    p90: sampleQuantile(samples, 0.90),
    mean,
    successRate: successes / trials,
  }
}

export function createOracle(deps: OracleDeps): IOracleDetail {
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

        // 最脆弱步骤：失败概率 × 敞口（作废的预估量）最大者；
        // 附带修复收益 —— 把该步成功率视作 1 后整体成功率提升多少
        // （"先修哪里"的可行动性排序依据，而非只报忧）
        let weakest: OracleWeakestStepDetail | null = null
        for (const s of steps) {
          const vuln = (1 - s.successProbability) * s.exposureBytes
          const cur = weakest ? (1 - weakest.successProbability) * weakest.exposureBytes : -1
          if (vuln > cur && vuln > 0) {
            const repaired = pSuccess / s.successProbability
            weakest = {
              index: s.index, action: s.action,
              successProbability: s.successProbability, exposureBytes: s.exposureBytes,
              repairedSuccessProbability: Math.min(1, repaired),
              repairUplift: Math.min(1, repaired) - pSuccess,
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

        // ── 蒙特卡洛模拟：解析式连乘的补充与互证 ──────────────
        // 解析式假设"每步独立、校准分位可加"，蒙特卡洛则直接对联合分布
        // 抽样 —— 输出期望回收的 P10/P50/P90 分布（无条件口径，失败=0）。
        // 同种子 + 同步骤序列 → 逐位可复现（测试与审计的可重复性）。
        const mcTrials = deps.monteCarloTrials ?? DEFAULT_MC_TRIALS
        const mcSeed = deps.monteCarloSeed ?? DEFAULT_MC_SEED
        const mc = monteCarlo(
          steps.map(s => ({ p: s.successProbability, bytes: s.estimatedBytes, cal: s.calibration })),
          mcTrials,
          mcSeed,
        )

        // 置信度：样本量驱动（统计的诚实——数据不够就说不够）
        const confidence: OracleConfidence =
          rel.sampleCount >= 30 ? 'high' : rel.sampleCount >= 5 ? 'medium' : 'low'

        const report: OracleReportDetail = {
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
          monteCarlo: mc,
          narrative: narrate(pSuccess, expectedReclaim, weakest, broken, confidence, mc),
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
  weakest: OracleWeakestStepDetail | null,
  broken: readonly PluginName[] | null,
  confidence: OracleConfidence,
  mc: MonteCarloSummary,
): string {
  const pct = (p: number) => `${(p * 100).toFixed(1)}%`
  const parts: string[] = []
  parts.push(`事务成功率 ${pct(p)}，期望回收 ${fmtBytes(expected)}`)
  if (mc.trials > 0) {
    // 蒙特卡洛互证口径：P10/P90 是含失败回滚的分布分位（悲观-乐观带）
    parts.push(`蒙特卡洛 ${mc.trials} 次抽样：回收 P10 ${fmtBytes(mc.p10)} ~ P90 ${fmtBytes(mc.p90)}（抽样成功率 ${pct(mc.successRate)}）`)
  }
  if (weakest && (1 - weakest.successProbability) * weakest.exposureBytes > 0) {
    parts.push(`最脆弱环节是第 ${weakest.index} 步 ${weakest.action}（成功率 ${(weakest.successProbability * 100).toFixed(0)}%，失败将作废 ${fmtBytes(weakest.exposureBytes)} 潜在回收；修复它可将整体成功率提升至 ${pct(weakest.repairedSuccessProbability)}（+${(weakest.repairUplift * 100).toFixed(1)} 个百分点））`)
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

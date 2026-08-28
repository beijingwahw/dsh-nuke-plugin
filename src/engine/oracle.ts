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
import type { CleanStrategy, Clock, PluginName, ProfileName, Result, TxId } from '../contracts/base'
import { err, fmtDuration, ioError, ok, fmtBytes  } from '../contracts/base'
import type { IBlastRadiusAnalyzer } from '../contracts/blast-radius.contract'
import type { IDiskForecaster } from '../contracts/disk-forecast.contract'
import type { ExplorationStepInput, ThompsonExploration } from '../contracts/exploration.contract'
import { thompsonExplore } from '../contracts/exploration.contract'
import { MODE_PRESCRIPTIONS } from '../contracts/failure.contract'
import type { FailureMode, FailureModeStat } from '../contracts/failure.contract'
import type { ILogger } from '../contracts/logging'
import type { OptimizedPlan, OptimizerGoal } from '../contracts/optimizer.contract'
import type { IOracle, OracleConfidence, OracleReport, OracleStep, OracleWeakestStep,
} from '../contracts/oracle.contract'
import type { IPathResolver } from '../contracts/paths'
import { applyCalibrationShift, applyDurationCorrection } from '../contracts/prediction.contract'
import type { CalibrationShift, PredictionScorecard } from '../contracts/prediction.contract'
import type { IReliabilityModel } from '../contracts/reliability.contract'
import type { CleanOperation, CleanRequest, TxContext } from '../contracts/transaction'

import { optimize } from './optimizer'

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
  /** V5.6：CVaR₁₀ 下行风险 —— 最差 10% 抽样的条件均值。
   *  Saga 全或无语义下成功率 > 10% 时该值为 0（最差尾部全是
   *  失败回滚）：诚实回答"最坏情形能剩多少"。 */
  readonly cvar10: number
  /** 蒙特卡洛均值（与解析期望 expectedReclaimBytes 互证） */
  readonly mean: number
  /** 抽样中事务全成的频率（与解析连乘 transactionSuccessProbability 互证） */
  readonly successRate: number
}

/** 最脆弱步骤详情：附带"修复它对整体成功率的提升幅度"（可行动性）
 *  V5.3：附失败模式诊断与处方 —— 从"哪里最弱"升级为"为什么弱、怎么办" */
export interface OracleWeakestStepDetail extends OracleWeakestStep {
  /** 将该步成功率视作 1（完全修复）后的整体成功率 */
  readonly repairedSuccessProbability: number
  /** 修复带来的整体成功率绝对提升（repaired − current） */
  readonly repairUplift: number
  /** V5.3：该步历史失败的主导模式（零失败历史 = null） */
  readonly dominantFailureMode: FailureMode | null
  /** V5.3：主导模式的失败份额 0-1（dominantFailureMode 为 null 时 = 0） */
  readonly dominantFailureShare: number
  /** V5.3：按模式给出的处方（人类可读，来自失败分类学单一事实源） */
  readonly prescription: string | null
}

/** V5.3 步骤详情：契约字段语义不变，附失败模式分布与重试调整成功率 */
export interface OracleStepDetail extends OracleStep {
  /** 历史失败模式分布（share 降序；零失败 = 空数组） */
  readonly failureModes: readonly FailureModeStat[]
  /** 瞬态失败份额（引擎自动重试只对这部分有效） */
  readonly transientShare: number
  /** 引擎自动重试瞬态失败前提下的有效成功率 */
  readonly retryAdjustedProbability: number
  /** V5.4：该步预计耗时（ms，动作历史时间加权中位；零历史 = null） */
  readonly predictedDurationMs: number | null
  /** V5.5：自我校准后的预测成功率（重试感知口径 × 历史偏差修正）；
   *  无对账证据（校准缺席）= null —— 未修正与"修正后恰好不变"可区分 */
  readonly calibratedProbability: number | null
}

/** 先知报告详情：契约字段语义不变，新增蒙特卡洛分布与修复建议 */
export interface OracleReportDetail extends OracleReport {
  readonly steps: readonly OracleStepDetail[]
  readonly weakestStep: OracleWeakestStepDetail | null
  /** 蒙特卡洛模拟结果（trials=0 时各分位数与均值退化为 0） */
  readonly monteCarlo: MonteCarloSummary
  /** V5.2 决策智能：帕累托最优计划合成（优化失败不阻断推演 → null） */
  readonly optimizedPlan: OptimizedPlan | null
  /** V5.6：Thompson 受控探索 —— 后验采样口径 + 信息价值排序。
   *  纯利用的死锁（富者愈富）由探索打破：数据少的动作被乐观抽样
   *  获得执行机会，执行即学习。零步骤 = null。 */
  readonly exploration: ThompsonExploration | null
  /** V5.3：重试感知事务成功率 = ∏ retryAdjusted p_i。
   *  引擎将自动重试瞬态失败（有界次数）前提下的整体成功率 ——
   *  与 transactionSuccessProbability（裸连乘）并列，口径透明。 */
  readonly retryAdjustedSuccessProbability: number
  /** V5.4：预计耗时（ms）= 各步 p50 之和；任一步零历史 = null
   *  （诚实留白 —— 不用先验冒充耗时证据）。墙钟口径含重试退避。 */
  readonly predictedDurationMs: number | null
  /** V5.4：悲观耗时上界（ms）= 各步 p90 之和（"每步都跑在最慢 10%"） */
  readonly pessimisticDurationMs: number | null
  /** V5.4：先知战绩（预测存证 vs 实际结局的对账）；未注入评分级或
   *  零可对账样本 = null —— 预测若不可证伪就与巫术无异，先知公开成绩单 */
  readonly trackRecord: PredictionScorecard | null
  /** V5.5：自我校准位移（从战绩学习的系统性偏差修正）；证据不足 = null */
  readonly calibration: CalibrationShift | null
  /** V5.5：自我校准后的事务成功率 = ∏ 校准后逐步 p；校准缺席 = null */
  readonly calibratedSuccessProbability: number | null
}

/** IOracle 的引擎层扩展：divine 返回详情报告（协变返回类型） */
export interface IOracleDetail extends IOracle {
  divine(request: {
    readonly plugins: readonly PluginName[]
    readonly profile: ProfileName
    readonly strategy: CleanStrategy
  }): Promise<Result<OracleReportDetail>>
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
  /** V5.2 优化器目标（默认 { kind: 'pareto' }：前沿 + 拐点推荐） */
  readonly optimizerGoal?: OptimizerGoal
  /** V5.4：预测战绩工厂（先知问责制）。可选 —— 未注入时 trackRecord=null；
   *  工厂抛错同样降级为 null（战绩展示是增强，不阻断推演）。 */
  readonly scorecard?: () => Promise<PredictionScorecard | null>
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
    return {
      trials: Math.max(0, trials), seed, p10: 0, p50: 0, p90: 0, cvar10: 0, mean: 0,
      successRate: steps.length === 0 ? 1 : 0,
    }
  }
  const rand = lcg(seed)
  const samples: number[] = new Array<number>(trials)
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
  // CVaR₁₀：最差 10% 抽样的条件均值（样本升序取头部平均）。
  // Saga 全或无 + 成功率 > 10% 时头部全是 0 → CVaR=0（最坏尾部
  // 就是失败回滚，什么都没有 —— 这正是要诚实说出的下行）
  const tail = Math.max(1, Math.floor(trials * 0.10))
  const cvar10 = samples.slice(0, tail).reduce((s, v) => s + v, 0) / tail
  return {
    trials,
    seed,
    p10: sampleQuantile(samples, 0.10),
    p50: sampleQuantile(samples, 0.50),
    p90: sampleQuantile(samples, 0.90),
    cvar10,
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
        // V5.4/V5.5 战绩与自我校准提前获取：校准位移要在逐步融合时应用
        //（存证 → 对账 → 学习 δ → 修正未来预测 —— 收敛闭环的读侧）。
        // 评分级失败/未注入 → trackRecord=null 且不校准：增强不阻断推演
        let trackRecord: PredictionScorecard | null = null
        if (deps.scorecard) {
          try {
            trackRecord = await deps.scorecard()
          } catch { trackRecord = null }
        }
        const calibration = trackRecord?.calibration ?? null
        const steps: OracleStepDetail[] = []
        // V5.6 探索智能输入：每步的最终层 Beta 后验 + 敞口 + 自身证据量
        const exploreInputs: ExplorationStepInput[] = []
        // 后缀和：exposure_i = Σ_{j≥i} b_j（第 i 步失败作废的总量）
        const suffix = new Array<number>(previews.length + 1).fill(0)
        for (let i = previews.length - 1; i >= 0; i--) {
          suffix[i] = suffix[i + 1]! + previews[i]!.estimated
        }
        for (const [i, pv] of previews.entries()) {
          // V5.2：操作级成功率 —— 大小分桶协变量调制（"删 2GB 的成功率"）
          const r = rel.reliabilityOf(pv.op.action, { sizeBytes: pv.estimated })
          const pRetry = r.retryAdjustedProbability ?? r.successProbability
          // V5.6：后验缺省时以 (均值, 强度 10) 近似 —— 注入 mock 的
          // 兼容路径，真实模型始终暴露与 mean 同源的 Beta 参数
          const post = r.posterior ?? {
            alpha: r.successProbability * 10,
            beta: (1 - r.successProbability) * 10,
          }
          exploreInputs.push({
            index: i,
            action: pv.op.action,
            mean: r.successProbability,
            alpha: post.alpha,
            beta: post.beta,
            exposureBytes: suffix[i]!,
            evidence: r.successes + r.failures,
          })
          // V5.4：耗时预测（时间加权中位；零历史 = null 诚实留白）；
          // V5.5：有耗时对账证据时按修正因子缩放（预测偏乐观 → 放大）
          const durP50 = r.duration?.p50 ?? null
          steps.push({
            index: i,
            action: pv.op.action,
            operationId: pv.op.id,
            summary: pv.summary,
            estimatedBytes: pv.estimated,
            successProbability: r.successProbability,
            selfWeight: r.selfWeight,
            exposureBytes: suffix[i]!,
            calibration: r.calibration,
            // V5.3 失败模式智能：这步为什么挂 + 引擎自愈后的有效成功率
            failureModes: r.failureModes ?? [],
            transientShare: r.transientShare ?? 0,
            retryAdjustedProbability: pRetry,
            predictedDurationMs: durP50 !== null
              ? applyDurationCorrection(durP50, calibration)
              : null,
            // V5.5：自我校准 —— 存证战绩学习到的系统性偏差修正
            calibratedProbability: calibration !== null
              ? applyCalibrationShift(pRetry, calibration)
              : null,
          })
        }

        // 事务成功率：Saga 全成或全无 → 连乘
        const pSuccess = steps.reduce((acc, s) => acc * s.successProbability, 1)
        // V5.3：重试感知成功率 —— 引擎自动重试瞬态失败前提下的连乘
        const pRetryAdjusted = steps.reduce((acc, s) => acc * s.retryAdjustedProbability, 1)

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
        //（"先修哪里"的可行动性排序依据，而非只报忧）
        // V5.3：附主导失败模式与处方 —— 诊断书而非只报忧
        let weakest: OracleWeakestStepDetail | null = null
        for (const s of steps) {
          const vuln = (1 - s.successProbability) * s.exposureBytes
          const cur = weakest ? (1 - weakest.successProbability) * weakest.exposureBytes : -1
          if (vuln > cur && vuln > 0) {
            const repaired = pSuccess / s.successProbability
            const dominant = s.failureModes[0] ?? null
            weakest = {
              index: s.index, action: s.action,
              successProbability: s.successProbability, exposureBytes: s.exposureBytes,
              repairedSuccessProbability: Math.min(1, repaired),
              repairUplift: Math.min(1, repaired) - pSuccess,
              dominantFailureMode: dominant ? dominant.mode : null,
              dominantFailureShare: dominant ? dominant.share : 0,
              prescription: dominant ? MODE_PRESCRIPTIONS[dominant.mode] : null,
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

        // ── V5.6 探索智能：Thompson 后验采样 + 信息价值排序 ──────
        // 均值口径是纯利用：新动作永远竞争不过有历史的动作（富者愈富
        // 死锁）。后验采样让不确定的动作获得探索机会 —— 执行即学习，
        // 探索/利用比例由后验宽度自动调节。种子与 MC 错位（独立流），
        // 同输入逐位可复现。探索是建议不是行为：决策权仍在用户。
        let exploration: ThompsonExploration | null = null
        if (exploreInputs.length > 0) {
          try {
            exploration = thompsonExplore(exploreInputs, {
              seed: (mcSeed ^ 0x7ea5ed) >>> 0,
            })
          } catch { exploration = null }
        }

        // 置信度：样本量驱动（统计的诚实——数据不够就说不够）
        const confidence: OracleConfidence =
          rel.sampleCount >= 30 ? 'high' : rel.sampleCount >= 5 ? 'medium' : 'low'
        // 纯先验步骤数（该动作零历史，成功率完全来自先验收缩）——
        // 冷启动叙事的透明度：明确告诉用户"这个数从哪来"
        const priorOnlySteps = steps.filter(s => (s.selfWeight ?? 0) === 0).length

        // ── V5.2 决策智能：帕累托最优计划合成（优化失败不阻断推演） ──
        // V5.3：候选成功率取重试调整口径 —— 计划合成描述的是引擎将
        // 真实执行的行为（含瞬态自动重试），预测与执行语义对齐
        let optimizedPlan: OptimizedPlan | null = null
        try {
          const candidates = previews.map((pv, i) => {
            const r = rel.reliabilityOf(pv.op.action, { sizeBytes: pv.estimated })
            return {
              action: pv.op.action,
              index: i,
              successProbability: r.retryAdjustedProbability ?? r.successProbability,
              estimatedBytes: pv.estimated,
              calibrationRatio: r.calibration ? r.calibration.p50 : 1,
              riskLevel: 'medium' as const,
            }
          })
          const opt = optimize(candidates, deps.optimizerGoal ?? { kind: 'pareto' })
          optimizedPlan = opt.ok ? opt.value : null
        } catch { optimizedPlan = null }

        // ── V5.4 耗时预测：各步 p50 之和（任一步零历史 → null 诚实留白）─
        // 悲观上界 = 各步 p90 之和（"每步都跑在最慢 10% 分位"的串联）。
        // 墙钟口径与引擎计时一致（含重试退避等待）—— 用户等的就是这个数。
        // V5.5：逐步耗时已按对账修正因子缩放，悲观上界同口径。
        const durationAll = previews.length > 0
          && steps.every(s => s.predictedDurationMs !== null)
        const predictedDurationMs = durationAll
          ? steps.reduce((acc, s) => acc + (s.predictedDurationMs ?? 0), 0)
          : null
        const pessimisticDurationMs = durationAll
          ? previews.reduce((acc, pv) => {
            const r = rel.reliabilityOf(pv.op.action, { sizeBytes: pv.estimated })
            const p90 = r.duration?.p90 ?? 0
            return acc + applyDurationCorrection(p90, calibration)
          }, 0)
          : null

        // ── V5.5 自我校准：校准后事务成功率（Saga 连乘，与存证口径一致）─
        const calibratedSuccessProbability = calibration !== null
          ? steps.reduce((acc, s) => acc * (s.calibratedProbability ?? s.retryAdjustedProbability), 1)
          : null

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
          optimizedPlan,
          exploration,
          retryAdjustedSuccessProbability: pRetryAdjusted,
          predictedDurationMs,
          pessimisticDurationMs,
          trackRecord,
          calibration,
          calibratedSuccessProbability,
          narrative: narrate(pSuccess, expectedReclaim, weakest, broken, confidence, mc,
            priorOnlySteps, rel.globalSuccessProbability, pRetryAdjusted, predictedDurationMs,
            calibratedSuccessProbability, calibration, exploration),
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
  priorOnlySteps = 0,
  globalPrior = 0.95,
  pRetryAdjusted?: number,
  predictedDurationMs?: number | null,
  calibratedP?: number | null,
  calibration?: CalibrationShift | null,
  exploration?: ThompsonExploration | null,
): string {
  const pct = (p: number) => `${(p * 100).toFixed(1)}%`
  const parts: string[] = []
  parts.push(`事务成功率 ${pct(p)}，期望回收 ${fmtBytes(expected)}`)
  // V5.3：重试感知口径 —— 引擎将自愈瞬态失败，用户应看到"有效成功率"
  if (typeof pRetryAdjusted === 'number' && pRetryAdjusted > p + 0.0005) {
    parts.push(`引擎自动重试瞬态失败（EBUSY/超时等）后有效成功率 ${pct(pRetryAdjusted)}（+${((pRetryAdjusted - p) * 100).toFixed(1)} 个百分点）`)
  }
  // V5.5：自我校准口径 —— 存证战绩显示的历史偏差已被修正进本次预测
  if (typeof calibratedP === 'number' && typeof pRetryAdjusted === 'number'
    && calibration != null
    && Math.abs(calibratedP - pRetryAdjusted) > 0.0005) {
    const bias = calibration.actualRate < calibration.meanPredicted ? '过自信' : '过保守'
    parts.push(`自我校准后成功率 ${pct(calibratedP)}（历史预测${bias}：存证均值 ${pct(calibration.meanPredicted)} vs 实际 ${pct(calibration.actualRate)}，${calibration.evidence} 步证据 → logit 位移 ${calibration.delta >= 0 ? '+' : ''}${calibration.delta.toFixed(2)}）`)
  }
  // V5.4：耗时预测 —— 来自动作历史的时间加权中位（有据可依的"要多久"）
  if (typeof predictedDurationMs === 'number' && predictedDurationMs > 0) {
    parts.push(`预计耗时约 ${fmtDuration(predictedDurationMs)}`)
  }
  if (mc.trials > 0) {
    // 蒙特卡洛互证口径：P10/P90 是含失败回滚的分布分位（悲观-乐观带）
    parts.push(`蒙特卡洛 ${mc.trials} 次抽样：回收 P10 ${fmtBytes(mc.p10)} ~ P90 ${fmtBytes(mc.p90)}（抽样成功率 ${pct(mc.successRate)}）`)
    // V5.6：下行风险 —— CVaR₁₀ 诚实回答"最差 10% 情形剩多少"
    parts.push(`下行风险 CVaR₁₀ ${fmtBytes(mc.cvar10)}（最差 10% 情形的平均回收）`)
  }
  // V5.6：Thompson 探索口径 —— 打破纯利用的富者愈富死锁
  if (exploration != null && exploration.steps.length > 0) {
    const info = exploration.mostInformative
    const infoPart = info !== null
      ? `信息价值最高：第 ${info.index} 步 ${info.action}（自身历史 ${info.evidence} 条，不确定敞口 ≈ ${fmtBytes(info.uncertaintyBytes)}，优先执行可最快收窄先知盲区）`
      : ''
    parts.push(`Thompson 探索口径成功率 ${pct(exploration.sampledTxProbability)}（均值口径 ${pct(exploration.meanTxProbability)}${infoPart ? `；${infoPart}` : ''}）`)
  }
  if (weakest && (1 - weakest.successProbability) * weakest.exposureBytes > 0) {
    const diag = weakest.dominantFailureMode !== null
      ? `，历史主导失败模式 ${weakest.dominantFailureMode}（占 ${(weakest.dominantFailureShare * 100).toFixed(0)}%）；处方：${weakest.prescription}`
      : ''
    parts.push(`最脆弱环节是第 ${weakest.index} 步 ${weakest.action}（成功率 ${(weakest.successProbability * 100).toFixed(0)}%，失败将作废 ${fmtBytes(weakest.exposureBytes)} 潜在回收；修复它可将整体成功率提升至 ${pct(weakest.repairedSuccessProbability)}（+${(weakest.repairUplift * 100).toFixed(1)} 个百分点）${diag}）`)
  }
  if (broken && broken.length > 0) {
    parts.push(`⚠️ 将损坏 ${broken.length} 个外部依赖方（${broken.join(', ')}），建议先解除依赖或同批删除`)
  } else if (p >= 0.85) {
    parts.push('各环节可靠，可放心进入 dry-run → commit')
  }
  if (confidence === 'low') {
    // 冷启动透明度：低成功率若源自"零历史"，必须说明数字来自设计先验
    //（引擎含预检/备份/回滚，失败属例外）而非历史故障证据
    parts.push(`历史样本不足（${priorOnlySteps} 步无自身历史，成功率收缩向设计先验 ${pct(globalPrior)}）—— 执行越多，先知越准`)
  }
  return parts.join('；') + '。'
}

// src/infra/prediction-score.ts — V5.4 预测评分级（先知问责制的读侧）
// 数据源是审计链（与可靠性模型同源）：预测存证条目（PREDICT_AUDIT_ACTION，
// commit 执行前写入）× 步骤结局条目（OP_AUDIT_PREFIX 前缀）× 事务终结条目
// （tx-commit / tx-rollback）。三方按 txId 关联对账：
//
//   事务级 Brier = (P_tx − y)²           y ∈ {0,1}（committed=1 / rolled-back=0）
//   步骤级 Brier = (p_i − y_i)²          仅对"有结局条目"的步骤计分
//                                          （首败之后的步骤被 Saga 回滚跳过，
//                                           无结局 = 不计分 —— 惩罚只落在
//                                           已发生的事实上，不惩罚未执行）
//   基线 Brier   = ȳ(1−ȳ)                 ȳ = 实际结局基准率（"永远预测基准率"
//                                          的无技能参照 —— 技能分的分母）
//   技能分       = 1 − Brier/Brier_base   > 0 优于基线；≤ 0 还不如报基准率
//
// 对账纪律：
//   - 未终结事务（活跃/崩溃未恢复）→ 跳过：结局未定，计分即作弊
//   - 演习事务（predict 存证带 drill 标记）→ 跳过：人为注入的崩溃不是
//     先知的预测失误，计入只会污染战绩
//   - 畸形存证条目（外部写入/旧版本形态）→ 防御性跳过，绝不让对账崩溃
import type { IAuditLog } from '../contracts/logging'
import { OP_AUDIT_PREFIX, PREDICT_AUDIT_ACTION } from '../contracts/logging'
import type { TxId } from '../contracts/base'
import type {
  IPredictionScorer, PredictionRecord, PredictionScorecard, StepPrediction,
} from '../contracts/prediction.contract'

export interface PredictionScorerOptions {
  readonly audit: IAuditLog
  /** recent 明细上限（默认 10；新→旧） */
  readonly recentLimit?: number
  /** 耗时比分布所需最少样本（默认 3，不足 = null 诚实留白） */
  readonly minDurationSamples?: number
  /** 只统计该时间之后的存证（ISO；默认全部） */
  readonly since?: string
}

interface StepOutcome {
  readonly outcome: 0 | 1
  readonly durationMs: number | null
}

interface TxLedger {
  predict: PredictionRecord | null
  predictedAt: string
  terminal: 0 | 1 | null
  readonly stepOutcomes: Map<string, StepOutcome>   // operationId → 结局
}

function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const pos = (n - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/** 防御性解析预测存证 detail —— 任何形态异常返回 null（跳过而非崩溃） */
function parsePrediction(detail: Readonly<Record<string, unknown>>): PredictionRecord | null {
  const stepsRaw = detail.steps
  const txPRaw = detail.txSuccessProbability
  if (!Array.isArray(stepsRaw) || typeof txPRaw !== 'number') return null
  const steps: StepPrediction[] = []
  for (const s of stepsRaw) {
    if (typeof s !== 'object' || s === null) return null
    const o = s as Readonly<Record<string, unknown>>
    if (typeof o.operationId !== 'string' || typeof o.action !== 'string') return null
    if (typeof o.predictedP !== 'number' || !Number.isFinite(o.predictedP)) return null
    steps.push({
      index: typeof o.index === 'number' ? o.index : steps.length,
      operationId: o.operationId,
      action: o.action,
      estimatedBytes: typeof o.estimatedBytes === 'number' ? o.estimatedBytes : null,
      predictedP: o.predictedP,
      predictedDurationMs: typeof o.predictedDurationMs === 'number' ? o.predictedDurationMs : null,
    })
  }
  return {
    steps,
    txSuccessProbability: txPRaw,
    ...(detail.drill === true ? { drill: true } : {}),
  }
}

export async function createPredictionScorer(
  options: PredictionScorerOptions,
): Promise<IPredictionScorer> {
  const recentLimit = options.recentLimit ?? 10
  const minDur = options.minDurationSamples ?? 3

  async function scorecard(): Promise<PredictionScorecard> {
    const entries = await options.audit.query(
      options.since !== undefined ? { since: options.since } : {},
    )

    // 按事务聚合三方证据（单次线性扫描）
    const ledgers = new Map<TxId, TxLedger>()
    function ledgerOf(txId: TxId): TxLedger {
      let l = ledgers.get(txId)
      if (l === undefined) {
        l = { predict: null, predictedAt: '', terminal: null, stepOutcomes: new Map() }
        ledgers.set(txId, l)
      }
      return l
    }
    for (const e of entries) {
      if (e.txId === undefined) continue
      const l = ledgerOf(e.txId)
      if (e.action === PREDICT_AUDIT_ACTION) {
        // 同一事务多次存证（理论不可达，防御性取最后一条）
        const parsed = parsePrediction(e.detail)
        if (parsed !== null) {
          l.predict = parsed
          l.predictedAt = e.timestamp
        }
      } else if (e.action === 'tx-commit') {
        l.terminal = 1
      } else if (e.action === 'tx-rollback') {
        l.terminal = 0
      } else if (e.action.startsWith(OP_AUDIT_PREFIX) && e.outcome !== 'skipped') {
        const opId = (e.detail as { operationId?: unknown }).operationId
        const durMs = (e.detail as { durationMs?: unknown }).durationMs
        if (typeof opId === 'string') {
          // skip-and-continue 的步骤先记 failure 再标 skipped —— 逐条覆盖，
          // 最后一条即最终结局（success=1 / failure=0）
          l.stepOutcomes.set(opId, {
            outcome: e.outcome === 'success' ? 1 : 0,
            durationMs: typeof durMs === 'number' && Number.isFinite(durMs) ? durMs : null,
          })
        }
      }
    }

    // 对账：已存证 + 已终结 + 非演习 的事务才计分
    let brierTxSum = 0
    let brierStepSum = 0
    let scoredTx = 0
    let scoredSteps = 0
    let actualSum = 0
    const durationRatios: number[] = []
    const recent: PredictionScorecard['recent'][number][] = []
    for (const [txId, l] of ledgers) {
      if (l.predict === null || l.terminal === null || l.predict.drill === true) continue
      const pTx = l.predict.txSuccessProbability
      const actual = l.terminal
      brierTxSum += (pTx - actual) ** 2
      actualSum += actual
      scoredTx++
      for (const sp of l.predict.steps) {
        const so = l.stepOutcomes.get(sp.operationId)
        if (so === undefined) continue   // 首败后被回滚跳过的步骤：无结局不计分
        brierStepSum += (sp.predictedP - so.outcome) ** 2
        scoredSteps++
        if (sp.predictedDurationMs !== null && sp.predictedDurationMs > 0 && so.durationMs !== null) {
          durationRatios.push(so.durationMs / sp.predictedDurationMs)
        }
      }
      recent.push({
        txId,
        predictedAt: l.predictedAt,
        predictedP: pTx,
        actual,
        brier: (pTx - actual) ** 2,
        drill: false,
      })
    }

    const brierTx = scoredTx > 0 ? brierTxSum / scoredTx : null
    const brierSteps = scoredSteps > 0 ? brierStepSum / scoredSteps : null
    // 基线 = 永远预测基准率 ȳ 的 Brier = ȳ(1−ȳ)。全同结局（ȳ∈{0,1}）时
    // 基线退化为 0 —— "无技能"已完美，技能分无定义 → null（诚实而非除零）
    const yBar = scoredTx > 0 ? actualSum / scoredTx : 0
    const brierBaseline = scoredTx > 0 && yBar > 0 && yBar < 1 ? yBar * (1 - yBar) : null
    const skillScore = brierTx !== null && brierBaseline !== null && brierBaseline > 0
      ? 1 - brierTx / brierBaseline
      : null

    durationRatios.sort((a, b) => a - b)
    const durationRatio = durationRatios.length >= minDur
      ? {
        samples: durationRatios.length,
        p50: quantile(durationRatios, 0.5),
        p90: quantile(durationRatios, 0.9),
      }
      : null

    recent.sort((a, b) => (a.predictedAt < b.predictedAt ? 1 : a.predictedAt > b.predictedAt ? -1 : 0))

    return {
      scoredTx,
      scoredSteps,
      brierTx,
      brierSteps,
      brierBaseline,
      skillScore,
      durationRatio,
      recent: recent.slice(0, recentLimit),
    }
  }

  return { scorecard }
}

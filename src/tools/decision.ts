// src/tools/decision.ts — 决策域工具（该不该清、怎么清最优）
// nuke_strategies / nuke_oracle / nuke_failures / nuke_scorecard /
// nuke_blastradius / nuke_trend / nuke_forecast / nuke_policy
import type { Context } from '@deepseek-ai/cordis'

import { fmtBytes, fmtDuration } from '../contracts/base'
import type { CleanStrategy, ProfileName } from '../contracts/base'
import type { RiskLevel } from '../contracts/blast-radius.contract'
import type { ForecastSeverity } from '../contracts/disk-forecast.contract'
import { MODE_PRESCRIPTIONS } from '../contracts/failure.contract'
import type { AlertSeverity } from '../contracts/guardian.contract'
import type { OracleConfidence } from '../contracts/oracle.contract'
import { DEFAULT_BACKUP_RETENTION_DAYS } from '../contracts/policy.contract'
import type { TrendTrigger } from '../contracts/trend.contract'
import { createPredictionScorer } from '../infra/prediction-score'
import { createReliabilityModel } from '../infra/reliability'
import { STRATEGY_ACTIONS } from '../operations'
import type { Runtime } from '../runtime'

import { checkProfile, checkPlugins, defineTextTool } from './shared'

export function registerDecisionTools(ctx: Context, rt: Runtime): void {
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
    description: '先知推演：dry-run 说"我打算做什么"，先知说"做了会怎样"——事务成功率、期望回收（校准分布修正 + 蒙特卡洛 P10/P50/P90 分布 + 下行风险 CVaR₁₀）、最脆弱步骤（含修复收益）、爆炸半径、磁盘倒计时延长、Thompson 探索口径与信息价值排序（数据不足时建议先执行哪步以最快积累证据）。基于历史执行数据（贝叶斯学习 + 自我校准），零副作用不拿锁。建议清理前先问先知',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, description: '要推演的插件名列表' },
      plugin_name: { type: 'string', description: '单个插件名（plugin_names 简写）' },
      profile: { type: 'string', description: '默认 "web"' },
      strategy: { type: 'string', enum: ['safe', 'balanced', 'aggressive'], description: '推演所用策略，默认 balanced' },
    },
    execute: async (args) => {
      const { profile = 'web', strategy = 'balanced', plugin_names, plugin_name } = args
      const names: string[] = plugin_names ?? (plugin_name ? [plugin_name] : [])
      const cp = checkPlugins(rt, names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const cprof = checkProfile(rt, profile)
      if (!cprof.ok) return { content: `❌ ${cprof.error}` }

      const r = await rt.oracle.divine({
        plugins: cp.plugins, profile: cprof.profile, strategy,
      })
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const o = r.value

      const pct = (n: number) => `${(n * 100).toFixed(1)}%`
      const confIcon: Record<OracleConfidence, string> = { high: '🟢', medium: '🟡', low: '🔴' }
      // V5.3：重试感知口径 —— 引擎将自动重试瞬态失败，两档成功率并列
      const retryLine = o.retryAdjustedSuccessProbability > o.transactionSuccessProbability + 0.0005
        ? `   ♻️ 重试感知成功率: ${pct(o.retryAdjustedSuccessProbability)}（引擎自动重试瞬态失败 EBUSY/超时后的有效口径）`
        : ''
      // V5.5：自我校准口径 —— 存证战绩学到的系统性偏差已修正进本次预测
      const cal = o.calibration
      let calLine = ''
      if (cal !== null && o.calibratedSuccessProbability !== null
        && Math.abs(o.calibratedSuccessProbability - o.retryAdjustedSuccessProbability) > 0.0005) {
        const bias = cal.actualRate < cal.meanPredicted ? '过自信' : '过保守'
        calLine = `   ⚖️ 自我校准后: ${pct(o.calibratedSuccessProbability)}（历史预测系统性${bias}：存证均值 ${pct(cal.meanPredicted)} vs 实际 ${pct(cal.actualRate)}，${cal.evidence} 步证据 → logit 位移 ${cal.delta >= 0 ? '+' : ''}${cal.delta.toFixed(2)}）`
      }
      const lines = [
        `🔮 先知推演 @ ${new Date().toISOString()}`,
        `   插件: ${cp.plugins.join(', ')}  |  profile: ${cprof.profile}  |  策略: ${strategy}`,
        `   事务成功率: ${pct(o.transactionSuccessProbability)}  ${confIcon[o.confidence]} 置信 ${o.confidence}（${o.evidence.stepSamples} 个历史步骤样本${o.confidence === 'low' ? `；零/少样本时收缩向设计先验 ${pct(o.evidence.globalSuccessProbability)}` : ''}）`,
        ...(retryLine ? [retryLine] : []),
        ...(calLine ? [calLine] : []),
        `   期望回收: ${fmtBytes(o.expectedReclaimBytes)}（已折算失败回滚；若成功: ${fmtBytes(o.reclaimP10IfSuccess)} ~ ${fmtBytes(o.reclaimP90IfSuccess)}）`,
        `   预估总量: ${fmtBytes(o.totalEstimatedBytes)}  |  失败期望回滚深度: ${o.expectedRollbackDepth.toFixed(1)} 步`,
      ]
      // V5.4：耗时预测 —— 各步历史中位之和（任一步零历史则诚实不显示）
      if (o.predictedDurationMs !== null) {
        const pes = o.pessimisticDurationMs !== null && o.pessimisticDurationMs > o.predictedDurationMs
          ? `（悲观上界 ${fmtDuration(o.pessimisticDurationMs)}）`
          : ''
        lines.push(`   ⏱️ 预计耗时: ~${fmtDuration(o.predictedDurationMs)}${pes}  ← 来自历史步骤耗时的时间加权中位`)
      }
      // V5.4：先知战绩 —— 预测存证 vs 实际结局的对账摘要（问责制）
      const tr = o.trackRecord
      if (tr !== null && tr.scoredTx > 0 && tr.skillScore !== null) {
        lines.push(`   🏅 先知战绩: 技能分 ${tr.skillScore >= 0 ? '+' : ''}${tr.skillScore.toFixed(2)}（已对账 ${tr.scoredTx} 次预测，Brier ${(tr.brierTx ?? 0).toFixed(3)} vs 基线 ${(tr.brierBaseline ?? 0).toFixed(3)}）→ nuke_scorecard`)
      }
      if (o.monteCarlo.trials > 0) {
        const mc = o.monteCarlo
        // 蒙特卡洛互证口径：P10/P90 是含失败回滚（=0）的无条件分布，
        // 与解析式期望/成功率并列交叉验证（种子固定 → 逐位可复现）
        lines.push(`   🎲 蒙特卡洛 ${mc.trials} 次抽样（种子 ${mc.seed}）: 无条件回收 P10 ${fmtBytes(mc.p10)} / P50 ${fmtBytes(mc.p50)} / P90 ${fmtBytes(mc.p90)}，抽样成功率 ${pct(mc.successRate)}`)
        // V5.6：下行风险 —— CVaR₁₀（最差 10% 情形的平均回收）
        lines.push(`   📉 下行风险 CVaR₁₀: ${fmtBytes(mc.cvar10)}（最差 10% 情形的平均回收；Saga 全或无语义下尾部多为失败回滚 = 0）`)
      }
      // V5.6：Thompson 受控探索 —— 后验采样口径 + 信息价值排序
      const ex = o.exploration
      if (ex !== null && ex.steps.length > 0) {
        const arrow = ex.sampledTxProbability >= ex.meanTxProbability ? '↑' : '↓'
        lines.push(`   🧪 Thompson 探索口径: ${pct(ex.sampledTxProbability)}（均值 ${pct(ex.meanTxProbability)} ${arrow}，种子 ${ex.seed}）`)
        const info = ex.mostInformative
        if (info !== null) {
          lines.push(`      📡 最值得先执行: 第 ${info.index} 步 ${info.action}（自身历史 ${info.evidence} 条，后验 σ ${(info.posteriorSd * 100).toFixed(1)}pp，不确定敞口 ≈ ${fmtBytes(info.uncertaintyBytes)}）`)
        }
      }
      if (o.weakestStep) {
        lines.push(`   ⚠️ 最脆弱: 第 ${o.weakestStep.index} 步 ${o.weakestStep.action}（成功率 ${pct(o.weakestStep.successProbability)}，失败作废 ${fmtBytes(o.weakestStep.exposureBytes)}）`)
        lines.push(`      🔧 修复该步可令整体成功率升至 ${pct(o.weakestStep.repairedSuccessProbability)}（+${(o.weakestStep.repairUplift * 100).toFixed(1)} 个百分点）`)
        // V5.3 失败模式诊断：为什么弱 + 怎么办（处方来自失败分类学）
        if (o.weakestStep.dominantFailureMode !== null) {
          const t = o.weakestStep.dominantFailureShare * 100
          lines.push(`      🩺 主导失败模式: ${o.weakestStep.dominantFailureMode}（占历史失败 ${t.toFixed(0)}%）`)
          lines.push(`      💊 处方: ${o.weakestStep.prescription}`)
        }
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
        // 🧭 = 该动作零历史，成功率纯为先验收缩（冷启动透明度）
        const prior = (s.selfWeight ?? 0) === 0 ? ' 🧭' : ''
        // V5.3：重试调整成功率（有瞬态历史且投影有提升时显示差额）
        const retryAdj = s.retryAdjustedProbability > s.successProbability + 0.0005
          ? `  → 重试感知 ${pct(s.retryAdjustedProbability)}`
          : ''
        // V5.5：自我校准后成功率（有对账证据且修正有实际变化时显示）
        const calAdj = s.calibratedProbability !== null
          && Math.abs(s.calibratedProbability - s.retryAdjustedProbability) > 0.0005
          ? `  → 校准 ${pct(s.calibratedProbability)}`
          : ''
        // V5.3：主导失败模式（⚡=瞬态可自愈 / 🔒=永久需介入）
        const modes = s.failureModes.length > 0
          ? `  模式 ${s.failureModes.map(m =>
            `${m.mode}${m.transience === 'transient' ? '⚡' : '🔒'}${(m.share * 100).toFixed(0)}%`,
          ).join(' ')}`
          : ''
        // V5.4：该步历史耗时中位（零历史不显示 —— 不拿先验冒充耗时证据）
        const dur = s.predictedDurationMs !== null
          ? `  ~${fmtDuration(s.predictedDurationMs)}`
          : ''
        lines.push(`  [${s.index}] ${s.action}  ${fmtBytes(s.estimatedBytes)}  成功率 ${pct(s.successProbability)}${retryAdj}${calAdj}${cal}${prior}${modes}${dur}`)
      }
      // V5.2 决策智能：帕累托前沿 + 推荐计划（先知从"预测者"升级为"决策顾问"）
      // V5.3：候选成功率已取重试调整口径 —— 计划合成与引擎执行语义对齐
      const plan = o.optimizedPlan
      if (plan) {
        lines.push('', `─ 帕累托计划合成（${plan.solver === 'exact' ? '精确枚举' : '启发式'}）─`)
        lines.push(`   🎯 推荐: 保留 ${plan.recommended.actions.length}/${o.steps.length} 步 → 成功率 ${pct(plan.recommended.successProbability)} / 期望回收 ${fmtBytes(plan.recommended.expectedReclaimBytes)}`)
        lines.push(`      相对全集: 成功率 +${plan.vsFullSet.successUpliftPct.toFixed(1)} 个百分点，回收牺牲 ${plan.vsFullSet.reclaimSacrificePct.toFixed(1)}%`)
        if (plan.frontier.length > 1) {
          lines.push('      前沿（成功率 ↑ 回收量 ↓ 的权衡阶梯）:')
          for (const pt of plan.frontier) {
            const mark = pt === plan.recommended ? ' ★' : ''
            lines.push(`        ${pct(pt.successProbability)}  ${fmtBytes(pt.expectedReclaimBytes)}  （剔 ${pt.dropped} 步）${mark}`)
          }
        }
        if (plan.drops.length > 0) {
          lines.push('      剔除理由（性价比: 每换 1 个百分点成功率所费的回收字节）:')
          for (const d of plan.drops) {
            lines.push(`        ✂️ ${d.action}: +${d.successUpliftPct.toFixed(1)}pct 成功率，代价 ${fmtBytes(d.reclaimCostBytes)}${d.bytesPerPct === Number.POSITIVE_INFINITY ? '' : `（${fmtBytes(d.bytesPerPct)}/pct）`}`)
          }
        }
      }
      lines.push('', `💡 ${o.narrative}`)
      lines.push('', '决策链建议: nuke_oracle（后果推演+计划合成）→ nuke_clean dry_run（计划预演）→ nuke_clean（执行）')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_failures（失败档案：失败模式诊断书） ─────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_failures',
    description: '失败档案：从审计链学习每类动作的历史失败模式（EBUSY 锁定/超时/权限/校验拒绝…）、瞬态份额与处方，回答"清理为什么失败、怎么办"。⚡瞬态模式引擎将自动重试，🔒永久模式需按处方人工介入。零副作用，清理反复失败时先看这里',
    parameters: {},
    execute: async () => {
      const model = await createReliabilityModel({ audit: rt.audit })
      const all = [...model.byAction().values()]
        .filter(a => a.failures > 0 || a.successes > 0)
        .sort((a, b) => b.failures - a.failures)
      if (all.length === 0) {
        return { content: '📚 失败档案: 尚无历史执行样本 —— 先跑一次 nuke_clean，档案会从审计链自动学习' }
      }
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`
      const lines = [
        `📚 失败档案 @ ${new Date().toISOString()}（样本 ${model.sampleCount}，全局成功率 ${pct(model.globalSuccessProbability)}）`,
        '─ 动作 × 失败模式（按失败次数降序）─',
      ]
      for (const a of all) {
        const retry = (a.retryAdjustedProbability ?? a.successProbability) - a.successProbability
        const retryNote = retry > 0.0005
          ? `  ♻️ 重试感知 ${pct(a.retryAdjustedProbability ?? 0)}（+${(retry * 100).toFixed(1)}pct）`
          : ''
        lines.push(`  ${a.action}: 成 ${a.successes} / 败 ${a.failures}（成功率 ${pct(a.successProbability)}）${retryNote}`)
        for (const m of a.failureModes ?? []) {
          const icon = m.transience === 'transient' ? '⚡' : '🔒'
          lines.push(`    ${icon} ${m.mode}: ${m.count} 次（${(m.share * 100).toFixed(0)}% 的失败，${m.transience === 'transient' ? '瞬态可自愈' : '永久需介入'}）`)
          lines.push(`       💊 ${MODE_PRESCRIPTIONS[m.mode]}`)
        }
        if (a.failures === 0) lines.push('    （零失败 —— 无模式档案）')
      }
      lines.push('', '口径: ⚡瞬态 = 引擎自动重试（有界指数退避）；🔒永久 = 重试无意义，按处方处理。档案随每次清理自动更新')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_scorecard（先知战绩：预测问责对账单） ─────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_scorecard',
    description: '先知战绩对账单：每次 nuke_clean 执行前，预测（成功率/耗时）已存证进 hash chain —— 本工具用实际结局对账这些预测：Brier 技能分（对照无技能基线）、逐步命中明细、耗时偏差分布、重试疗效学习值。回答"先知的数字到底可不可信"。预测若不可证伪就与巫术无异 —— 先知公开自己的成绩单。零副作用',
    parameters: {},
    execute: async () => {
      const model = await createReliabilityModel({ audit: rt.audit })
      const scorer = await createPredictionScorer({ audit: rt.audit })
      const sc = await scorer.scorecard()
      const eff = model.retryEfficacy
      if (sc.scoredTx === 0) {
        return {
          content: [
            '🏅 先知战绩: 尚无可对账的预测',
            '',
            '口径: 预测只在真实 nuke_clean commit 执行前存证（dry-run 不存证）；',
            '跑一次真实清理后，这里会出现第一张成绩单。演习事务（人为注入崩溃）',
            '不计入战绩 —— 人为的失败不是先知的预测失误。',
          ].join('\n'),
        }
      }
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`
      const skill = sc.skillScore
      const skillLine = skill !== null
        ? `   📐 技能分: ${skill >= 0 ? '+' : ''}${skill.toFixed(2)}（1 − Brier/基线；>0 优于"永远预测基准率"的无技能基线${skill < 0 ? ' —— 当前还不如直接报基准率，预测谨慎参考' : ''}）`
        : '   📐 技能分: n/a（实际结局全同 —— 基线已完美，技能分无定义）'
      const lines = [
        `🏅 先知战绩 @ ${new Date().toISOString()}（已对账 ${sc.scoredTx} 个事务 / ${sc.scoredSteps} 个步骤）`,
        `   🎯 事务 Brier: ${sc.brierTx !== null ? sc.brierTx.toFixed(3) : 'n/a'}（0=完美 0.25=硬币水平；基线 ${sc.brierBaseline !== null ? sc.brierBaseline.toFixed(3) : 'n/a'}）`,
        `   📎 步骤 Brier: ${sc.brierSteps !== null ? sc.brierSteps.toFixed(3) : 'n/a'}（${sc.scoredSteps} 个有结局的步骤；回滚跳过的步骤不计分）`,
        skillLine,
      ]
      if (sc.durationRatio !== null) {
        const dr = sc.durationRatio
        lines.push(`   ⏱️ 耗时偏差: 实际/预测 中位 ${dr.p50.toFixed(2)}× / P90 ${dr.p90.toFixed(2)}×（${dr.samples} 样本；>1 = 预测偏乐观）`)
      }
      // V5.5 自我校准：战绩不止打分，还驱动再学习 —— 未来预测已按此修正
      const cs = sc.calibration
      if (cs !== null) {
        const bias = cs.actualRate < cs.meanPredicted ? '过自信' : '过保守'
        const durPart = cs.durationFactor !== null
          ? `；耗时因子 ${cs.durationFactor.toFixed(2)}×（${cs.durationSamples} 样本）`
          : ''
        lines.push(`   ⚖️ 自我校准: 历史预测系统性${bias}（存证均值 ${pct(cs.meanPredicted)} vs 实际 ${pct(cs.actualRate)}，${cs.evidence} 步证据）→ logit 位移 ${cs.delta >= 0 ? '+' : ''}${cs.delta.toFixed(2)}（证据权重 ${pct(cs.selfWeight)}）已修正进未来预测${durPart}`)
      }
      if (eff !== undefined) {
        const learned = eff.selfWeight > 0
        lines.push(`   ♻️ 重试疗效: 观测营救率 ${pct(eff.rescueRate)}（池 ${eff.pool}，救回 ${eff.rescued}${learned ? '' : '；零观测，纯先验'}）`)
      }
      lines.push('', '─ 最近对账（新 → 旧）─')
      for (const r of sc.recent) {
        const hit = r.actual === 1
        lines.push(`   tx ${r.txId.slice(0, 8)}…: 预测 ${pct(r.predictedP)} → ${hit ? '✅ 全成' : '❌ 回滚'}（Brier ${r.brier.toFixed(3)}）`)
      }
      lines.push('', '口径: 预测在 commit 执行前存证进 hash chain（时间戳先于结局，事后不可篡改）；', '   Brier = (p−y)²，技能分 > 0 表示先知优于"永远预测基准率"的无技能参照。战绩随每次真实清理自动更新')
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
      const cp = checkPlugins(rt, plugin_names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      // profile 是路径段：白名单校验（防路径穿越）
      let prof: ProfileName | undefined
      if (profile !== undefined) {
        const c = checkProfile(rt, profile)
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
    description: '历史趋势分析：时间加权 Theil-Sen 稳健回归 → 变化率（字节/天，含 95% 置信区间）、30 天外推与预测区间、3σ 异常检测、CUSUM 增长率变点（插件失控写盘早期信号）',
    parameters: {
      profile: { type: 'string', description: '限定 profile（省略 = 全部）' },
    },
    execute: async ({ profile }) => {
      let prof: ProfileName | undefined
      if (profile !== undefined) {
        const cp = checkProfile(rt, profile)
        if (!cp.ok) return { content: `❌ ${cp.error}` }
        prof = cp.profile
      }
      const r = await rt.trend.analyze(prof)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const t = r.value
      if (t.snapshotCount === 0) {
        return { content: '暂无历史快照 —— 运行 nuke_scan / nuke_clean / nuke_doctor 后自动积累。' }
      }
      const rate = (v: number) => `${v >= 0 ? '+' : '-'}${fmtBytes(Math.abs(v))}`
      const lines = [
        `📈 趋势分析（${t.snapshotCount} 个快照，${t.firstAt} → ${t.lastAt}）`,
        `   变化率: ${t.bytesPerDay >= 0 ? '+' : ''}${fmtBytes(Math.abs(t.bytesPerDay))}/天${t.bytesPerDay > 0 ? '（残留净增长）' : t.bytesPerDay < 0 ? '（净回收，趋势向好）' : ''}`,
      ]
      if (t.bytesPerDayLow !== null && t.bytesPerDayHigh !== null) {
        lines.push(`   增长率 95% 置信区间: ${rate(t.bytesPerDayLow)} ~ ${rate(t.bytesPerDayHigh)}/天`)
      }
      if (t.projected30dBytes !== null) {
        lines.push(`   30 天外推: ${fmtBytes(t.projected30dBytes)} 可回收`)
      }
      if (t.projected30dBytesLow !== null && t.projected30dBytesHigh !== null) {
        lines.push(`   30 天预测区间（95%）: ${fmtBytes(t.projected30dBytesLow)} ~ ${fmtBytes(t.projected30dBytesHigh)}`)
      }
      if (t.changepoints.length > 0) {
        lines.push('', `🔀 增长率变点（CUSUM 检出 ${t.changepoints.length} 处）:`)
        for (const cp of t.changepoints) {
          lines.push(`   ${cp.at} ${cp.direction === 'up' ? '📈 加速' : '📉 放缓'}: ${rate(cp.bytesPerDayBefore)}/天 → ${rate(cp.bytesPerDayAfter)}/天`)
        }
      }
      if (t.anomaly.detected) {
        lines.push('', `🚨 异常: ${t.anomaly.detail}`)
      } else if (t.snapshotCount >= 3) {
        lines.push('   ✅ 无异常突变')
      }
      if (t.latest) {
        const trig: Record<TrendTrigger, string> = { scan: '扫描', clean: '清理', doctor: '体检' }
        lines.push(`   最新快照: ${trig[t.latest.trigger]} @ ${t.latest.at}，可回收 ${fmtBytes(t.latest.bytesReclaimable)}`)
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_forecast ────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_forecast',
    description: '磁盘写满预测：趋势回归 × 实时余量 → 写满倒计时（daysUntilFull，含 95% 置信区间，分级按悲观界保守判定）、30 天走势与分级建议（附判定依据）',
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
      if (f.daysUntilFullLow !== null) {
        // CI 端点由斜率置信区间倒数反演：悲观界（增长最快 → 最早写满）
        // 驱动 severity 分级；乐观侧不可界（区间含"永不写满"）时如实标注
        const lo = `${f.daysUntilFullLow.toFixed(1)} 天${f.projectedFullAtLow !== null ? `（≈${f.projectedFullAtLow}）` : ''}`
        const hi = f.daysUntilFullHigh !== null
          ? `${f.daysUntilFullHigh.toFixed(1)} 天${f.projectedFullAtHigh !== null ? `（≈${f.projectedFullAtHigh}）` : ''}`
          : '不可界（区间含"永不写满"）'
        lines.push(`   📊 写满倒计时 95% 置信区间: ${lo}（悲观）~ ${hi}（乐观）`)
      }
      lines.push(`   分级依据: ${f.severityBasis}`)
      lines.push('', `💡 ${f.recommendation}`)
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_policy ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_policy',
    description: '查看当前清理策略守卫配置（保护名单/批量上限/回收上限/磁盘下限/时间黑窗）。策略文件: <dshHome>/.nuke/policy.json',
    parameters: {},
    execute: async () => {
      // loadValidated 而非 load：非法配置项被忽略时必须可见（"绝不静默
      // 接受非法配置"的承诺需要出口 —— 策略查看工具就是那个出口）
      const report = rt.policy.loadValidated()
      const p = report.policy
      const lines = ['🛡️ 当前清理策略（policy.json）:',]
      lines.push(`  保护名单: ${p.protectedPlugins.length > 0 ? p.protectedPlugins.join(', ') : '（空）'}`)
      lines.push(`  单事务插件上限: ${p.maxPluginsPerTx ?? '无限制'}`)
      lines.push(`  单事务文件上限: ${p.maxFilesPerTx !== null && p.maxFilesPerTx !== undefined ? String(p.maxFilesPerTx) : '无限制'}`)
      lines.push(`  单事务回收上限: ${p.maxReclaimBytesPerTx !== null ? fmtBytes(p.maxReclaimBytesPerTx) : '无限制'}`)
      lines.push(`  磁盘余量下限: ${p.minFreeDiskBytes !== null ? fmtBytes(p.minFreeDiskBytes) : '不检查'}`)
      lines.push(`  时间黑窗: ${p.blackout ? `${p.blackout.startHour}:00 - ${p.blackout.endHour}:00` : '无'}`)
      // V5.8 备份保留策略：tri-state 忠实展示（未配置=默认 14 天安全网）
      lines.push(`  备份保留期: ${
        p.backupRetentionDays === null
          ? '已关闭（时间维度不清理，不建议）'
          : p.backupRetentionDays !== undefined
            ? `${p.backupRetentionDays} 天`
            : `默认 ${DEFAULT_BACKUP_RETENTION_DAYS} 天（未配置）`
      }`)
      lines.push(`  备份区配额: ${p.backupQuotaBytes !== null && p.backupQuotaBytes !== undefined ? fmtBytes(p.backupQuotaBytes) : '无限制'}`)
      if (p.freezeWindows !== undefined && p.freezeWindows.length > 0) {
        lines.push(`  冻结窗: ${p.freezeWindows.map(w =>
          `${w.startHour}:00-${w.endHour}:00${w.reason ? `（${w.reason}）` : ''}`).join('、')}`)
      }
      if (report.issues.length > 0) {
        lines.push('', `⚠️ 策略加载发现 ${report.issues.length} 项非法配置（已被忽略，视为未配置）:`)
        for (const issue of report.issues) {
          lines.push(`  • [${issue.field}] ${issue.problem}`)
        }
        lines.push('', '以上项目当前未生效 —— 修正 policy.json 后自动恢复。')
      }
      lines.push('', '说明: 策略文件缺失或损坏时默认全放行；保护名单同时以引擎 pre-hook 形式强制执行（纵深防御）。')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_guardian ────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_guardian',
    description: '守卫者巡检：一键主动运维 —— 磁盘写满倒计时/趋势异常/健康阻断/可回收积压/崩溃残留事务，输出带行动建议的分级告警；同键告警默认 6h 抑制窗口去重（防告警风暴，重复 ≠ 消失，恶化升级为新键立即上报）',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(rt, profile)
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
      if (g.alerts.length === 0 && g.suppressedAlertKeys.length === 0) {
        lines.push('', '✅ 一切正常，无需行动。')
      } else {
        if (g.alerts.length > 0) {
          lines.push('', `发现 ${g.alerts.length} 条告警:`)
          for (const a of g.alerts) {
            lines.push(`  ${sevIcon[a.severity]} [${a.kind}] ${a.message}`)
            lines.push(`     → 建议调用 ${a.suggestedTool}`)
          }
        } else {
          // 全部告警处于抑制窗口内被去重：重复 ≠ 消失，不能谎报"一切正常"
          lines.push('', '🔕 本轮告警全部处于抑制窗口内未重发（问题仍在，窗口结束后复发将重新上报）:')
        }
        if (g.suppressedAlertKeys.length > 0) {
          lines.push('', `🔇 抑制窗口内去重 ${g.suppressedAlertKeys.length} 条同键重复告警（同键窗口内不重发）:`)
          for (const k of g.suppressedAlertKeys) lines.push(`     • ${k}`)
        }
      }
      return { content: lines.join('\n') }
    },
  }))
}

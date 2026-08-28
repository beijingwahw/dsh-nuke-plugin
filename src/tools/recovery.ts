// src/tools/recovery.ts — 恢复与保障域工具（坏了怎么救、日常怎么守）
// nuke_status / nuke_recover / nuke_verify / nuke_doctor / nuke_drill / nuke_ledger
import type { Context } from '@deepseek-ai/cordis'

import { fmtBytes } from '../contracts/base'
import type { ProfileName, TxId } from '../contracts/base'
import type { DoctorPriority, DoctorVerdict } from '../contracts/doctor.contract'
import { isDrillMatrixReport } from '../engine/drill'
import type { Runtime } from '../runtime'

import { checkProfile, defineTextTool } from './shared'

export function registerRecoveryTools(ctx: Context, rt: Runtime): void {
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
      const cp = checkProfile(rt, profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const r = await rt.doctor.diagnose(cp.profile)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const d = r.value
      const verdictIcon: Record<DoctorVerdict, string> = { healthy: '✅', attention: '🟡', critical: '🔴' }
      const priorityLabel: Record<DoctorPriority, string> = { 1: '🔴 P1 立即', 2: '🟠 P2 建议', 3: '🟢 P3 可选' }
      const lines = [
        `🩺 体检报告 [${cp.profile}]  ${verdictIcon[d.verdict]} ${d.verdict}`,
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
      // V5.2 环境矩阵：外部工具解析结果（与 runtime 健康检查同源，
      // 共享注册表 TTL 缓存 —— 两处输出永远一致）
      if (d.tools && d.tools.length > 0) {
        const toolIcon: Record<string, string> = { ok: '✅', rescued: '🟡', missing: '❌' }
        lines.push('', '─ 环境矩阵（外部工具）─')
        for (const t of d.tools) {
          lines.push(`  ${toolIcon[t.status] ?? '·'} ${t.tool}: ${t.detail}`)
          if (t.status === 'missing') {
            lines.push(`     🔧 ${t.fixHint}`)
          }
        }
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_drill（混沌演习：崩溃安全自检） ──────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_drill',
    description: '混沌演习：在沙箱中执行真实事务并在第 N 步后模拟进程崩溃（不回滚、锁悬挂），再走真实崩溃恢复路径，逐项验证数据字节级还原/审计链完整/WAL 终结，签发崩溃安全证书。matrix=true 一次跑完 plan 后/第 1 步后/第 2 步后三个注入点（各自独立沙箱，签发证书矩阵）。不触碰真实环境，随时可跑',
    parameters: {
      crash_after_step: { type: 'number', description: '第几步成功后"断电"（1-2，默认 1）' },
      matrix: { type: 'boolean', description: '矩阵模式：一次覆盖 plan 后/第 1 步后/第 2 步后三个注入点（各自独立沙箱验证，任一点失败则整体证书作废），默认 false 单点演习' },
    },
    execute: async ({ crash_after_step = 1, matrix = false }) => {
      // matrix=true 走证书矩阵（事务生命周期三段崩溃谱系独立验证）；
      // 否则单点演习（旧语义不变，crashedAtStep 如实标注注入点）
      const r = matrix
        ? await rt.drill.runMatrix()
        : await rt.drill.run({ afterStep: crash_after_step })
      if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
      const d = r.value
      const lines = [
        `${d.passed ? '🎖️ 崩溃安全证书已签发' : '⚠️ 演习未通过'}  演习 ${d.runId}`,
        isDrillMatrixReport(d)
          ? `   注入点矩阵: ${d.pointsVerified} 个断电位（plan 后 / 第 1 步后 / 第 2 步后）各自独立沙箱验证  |  恢复备份 ${d.restoredFiles} 项  |  总耗时 ${d.durationMs}ms`
          : `   注入点: 第 ${d.crashedAtStep} 步成功落盘后模拟进程死亡  |  恢复备份 ${d.restoredFiles} 项  |  耗时 ${d.durationMs}ms`,
      ]
      if (isDrillMatrixReport(d)) {
        lines.push('', '─ 证书矩阵（任一点失败则整体作废）─')
        for (const c of d.matrix) {
          const label = c.point === 'plan' ? 'plan 后（零步骤执行）' : `第 ${c.point} 步成功后`
          lines.push(`  ${c.passed ? '🎖️' : '❌'} ${label}: ${c.checks.filter(k => k.passed).length}/${c.checks.length} 项通过，恢复 ${c.restoredFiles} 项，${c.durationMs}ms（现场 ${c.runId}）`)
        }
      }
      lines.push(
        '',
        '─ 逐项验证 ─',
        ...d.checks.map(c => `  ${c.passed ? '✅' : '❌'} ${c.name}: ${c.detail}`),
        '',
        d.passed
          ? '本次演习证明：崩溃后 recover() 能完整还原环境，审计链无断裂，后续事务不受阻塞。建议定期演习（尤其升级后）。'
          : '存在失败项：崩溃恢复能力存疑，请勿在生产依赖自动恢复，优先人工核查。演习现场保留在 .nuke/drill/ 供取证。',
      )
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
        const cp = checkProfile(rt, profile)
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

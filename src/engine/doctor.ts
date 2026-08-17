// src/engine/doctor.ts — IDoctor 实现：一键体检编排器
// 纯编排层：感知能力全部来自注入组件，本文件只做组合与决策映射。
// 处方逻辑（可解释）：
//   priority 1 = 仍被引用 / critical 级 → 先摘引用（safe）
//   priority 2 = high/medium 级孤儿 → balanced 物理回收
//   priority 3 = 其余（info/low）→ 可选
import type { Clock, CleanStrategy } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { ResidualEvidence, ISeverityScorer } from '../contracts/scoring'
import type { IHealthInspector } from '../contracts/health.contract'
import type { IOrphanDetector, IResidualScanner } from '../contracts/scan'
import type { DoctorPriority, DoctorRecommendation, DoctorReport, IDoctor } from '../contracts/doctor.contract'

export interface DoctorDeps {
  readonly health: IHealthInspector
  readonly scanner: IResidualScanner
  readonly orphans: IOrphanDetector
  readonly scorer: ISeverityScorer
  readonly clock: Clock
}

/** 处方条目上限：报告可读性优先，超出部分仍计入总可回收空间 */
const MAX_RECOMMENDATIONS = 50

export function createDoctor(deps: DoctorDeps): IDoctor {
  function priorityOf(e: ResidualEvidence & { score: { band: string } }): DoctorPriority {
    if (e.referencedBy.length > 0 || e.score.band === 'critical') return 1
    if (e.score.band === 'high' || e.score.band === 'medium') return 2
    return 3
  }

  function strategyOf(e: ResidualEvidence): CleanStrategy {
    if (e.referencedBy.length > 0) return 'safe'        // 有引用：只摘引用，不动目录
    if (e.kind === 'temp-orphan') return 'aggressive'   // TEMP 清理属 aggressive 动作集
    return 'balanced'                                   // 普通孤儿：物理回收
  }

  function reasonOf(e: ResidualEvidence & { score: { total: number; band: string } }): string {
    if (e.referencedBy.length > 0) {
      return `仍被 ${e.referencedBy.join(', ')} 引用 —— 先以 safe 策略摘除配置引用，再评估目录回收`
    }
    if (e.kind === 'temp-orphan') return 'TEMP 过期孤儿（aggressive 动作，需确认令牌）'
    if (e.score.band === 'critical' || e.score.band === 'high') {
      return `${e.score.band} 级孤儿残留，建议 balanced 物理回收`
    }
    return `${e.score.band} 级残留（${e.score.total} 分），可择机清理`
  }

  return {
    async diagnose(profile, options) {
      try {
        // 1) 健康检查：critical 失败会传导为 verdict=critical
        const h = await deps.health.inspect(profile)
        if (!h.ok) return h
        const health = h.value

        // 2) 残留扫描：该 profile 下全部插件（safe 档即可，TEMP 由孤儿检测补充）
        const evidences: ResidualEvidence[] = []
        const signal = options?.signal
        for await (const ev of deps.scanner.scan({
          profile, strategy: 'safe', includeTemp: false,
          ...(signal ? { signal } : {}),
        })) {
          if (signal?.aborted) {
            return err({ code: 'E_CANCELLED', message: '体检被取消' })
          }
          if (ev.type === 'found') evidences.push(ev.evidence)
        }

        // 3) 孤儿检测：三类全局孤儿转成伪证据参与统一评分排序
        const o = await deps.orphans.detect({
          tempMaxAgeDays: 7,
          ...(signal ? { signal } : {}),
        })
        if (o.ok) {
          for (const d of o.value.orphanPluginDirs) {
            evidences.push({
              location: d.path, kind: 'node-modules',
              description: `node_modules 孤儿包: ${d.path}`,
              sizeBytes: d.sizeBytes, lastAccessedAt: null, referencedBy: [],
              suggestedAction: 'remove-node-modules',
            })
          }
          for (const d of o.value.orphanDataDirs) {
            evidences.push({
              location: d.path, kind: 'storage',
              description: `无主数据目录: ${d.path}`,
              sizeBytes: d.sizeBytes, lastAccessedAt: null, referencedBy: [],
              suggestedAction: 'remove-storages',
            })
          }
          for (const t of o.value.tempOrphans) {
            const age = new Date(deps.clock.now().getTime() - t.ageDays * 86_400_000)
            evidences.push({
              location: t.path, kind: 'temp-orphan',
              description: `TEMP 过期孤儿（${t.ageDays.toFixed(1)} 天）: ${t.path}`,
              sizeBytes: t.sizeBytes, lastAccessedAt: age, referencedBy: [],
              suggestedAction: 'purge-temp',
            })
          }
        }

        // 4) 统一评分 + 处方生成（stable sort：priority 升序、分值降序）
        const ranked = deps.scorer.rank(evidences)
        const all: DoctorRecommendation[] = ranked.map(e => ({
          priority: priorityOf(e),
          evidence: e,
          suggestedStrategy: strategyOf(e),
          reason: reasonOf(e),
        }))
        all.sort((a, b) =>
          a.priority - b.priority || b.evidence.score.total - a.evidence.score.total)

        const totalReclaimableBytes = evidences.reduce((s, e) => s + e.sizeBytes, 0)
        const hasUrgent = all.some(r => r.priority <= 2)

        const verdict = health.blocking || health.score < 40 ? 'critical'
          : health.score < 80 || hasUrgent ? 'attention'
          : 'healthy'

        const report: DoctorReport = {
          generatedAt: deps.clock.now().toISOString(),
          profile,
          verdict,
          healthScore: health.score,
          blocking: health.blocking,
          recommendations: all.slice(0, MAX_RECOMMENDATIONS),
          totalReclaimableBytes,
        }
        return ok(report)
      } catch (e) {
        return err(ioError('体检编排失败', e))
      }
    },
  }
}

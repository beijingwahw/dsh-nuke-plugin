// src/infra/reporter.ts — IReporter 实现：JSON（机器）/ Markdown（人类）双格式导出
// V5：双格式均追加汇总统计区（按动作分组的回收量/事务数/成功率/总回收）——
// 数据全部从传入 payload 推导，旧字段与旧段落格式不动（追加式扩展）。
import * as fs from 'fs'
import * as path from 'path'

import type { CleanAction, Result } from '../contracts/base'
import { err, fmtBytes, ioError, ok } from '../contracts/base'
import type {
  ActionReclaimStat, IReporter, ReportFormat, ReportPayload, ReportSummary,
} from '../contracts/logging'

import { writeTextAtomic } from './fs-utils'

export interface ReporterOptions {
  readonly reportsRoot: string   // 通常 <dshHome>/.nuke/reports
  readonly now?: () => Date
}

export function createReporter(options: ReporterOptions): IReporter {
  const now = options.now ?? (() => new Date())

  function baseName(payload: ReportPayload): string {
    const id = payload.tx?.txId ?? payload.dryRun?.txId
    const ts = now().toISOString().replace(/[:.]/g, '-')
    return id ? `nuke-${id}-${ts}` : `nuke-scan-${ts}`
  }

  function statusIcon(passed: boolean): string {
    return passed ? '✅' : '❌'
  }

  /** 汇总统计：按动作分组的回收量 / 事务数 / 步骤成功率 / 总回收。
   *  事务取实际回收（tx.steps），纯预演取预估（dryRun.actions），均无则零值。 */
  function buildSummary(payload: ReportPayload): ReportSummary {
    const byAction = new Map<CleanAction, ActionReclaimStat>()

    if (payload.tx) {
      for (const s of payload.tx.steps) {
        const prev = byAction.get(s.action)
        byAction.set(s.action, {
          action: s.action,
          steps: (prev?.steps ?? 0) + 1,
          bytesFreed: (prev?.bytesFreed ?? 0) + s.bytesFreed,
        })
      }
    } else if (payload.dryRun?.actions) {
      for (const a of payload.dryRun.actions) {
        const prev = byAction.get(a.action)
        byAction.set(a.action, {
          action: a.action,
          steps: (prev?.steps ?? 0) + 1,
          bytesFreed: (prev?.bytesFreed ?? 0) + a.estimatedBytes,
        })
      }
    }

    const steps = payload.tx?.steps ?? []
    const succeeded = steps.filter(s => s.status === 'done' || s.status === 'skipped').length
    const rate = steps.length > 0 ? succeeded / steps.length : null

    return {
      totalBytesFreed: payload.tx?.bytesFreedTotal
        ?? payload.dryRun?.estimatedBytesReclaimable ?? 0,
      txCount: payload.tx ? 1 : 0,
      successRate: rate,
      byAction: [...byAction.values()].sort((a, b) => b.bytesFreed - a.bytesFreed),
    }
  }

  function renderMarkdown(payload: ReportPayload): string {
    const L: string[] = []
    L.push('# Nuke 清理报告', '')
    L.push(`- **生成时间**: ${payload.generatedAt}`)
    L.push(`- **审计链校验**: ${payload.chainValid ? '✅ 完整' : '❌ 已被篡改'}`, '')

    if (payload.tx) {
      const tx = payload.tx
      L.push('## 事务摘要', '')
      L.push(`- **事务 ID**: ${tx.txId}`)
      L.push(`- **状态**: ${tx.state}`)
      L.push(`- **开始**: ${tx.startedAt}${tx.finishedAt ? ` / **结束**: ${tx.finishedAt}` : ''}`)
      L.push(`- **释放空间**: ${fmtBytes(tx.bytesFreedTotal)}`, '')
      L.push('| # | 操作 | 动作 | 状态 | 释放 |', '|---|---|---|---|---|')
      for (const s of tx.steps) {
        L.push(`| ${s.index} | ${s.operationId} | ${s.action} | ${s.status} | ${fmtBytes(s.bytesFreed)} |`)
      }
      L.push('')
    }

    if (payload.dryRun) {
      const dr = payload.dryRun
      L.push('## 预演（Dry-run）', '')
      L.push(`- **事务 ID**: ${dr.txId}`)
      L.push(`- **预计回收**: ${fmtBytes(dr.estimatedBytesReclaimable)}`, '')
      for (const p of dr.plans) {
        L.push(`### ${p.summary}`)
        // plans 元素契约：{ operation: OperationPlan; summary: string }
        L.push(`- ${p.summary}`)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 容错防御：历史/畸形 payload 缺 operation 字段时跳过明细渲染，而非让整个导出失败
        if (p.operation) {
          L.push(`- 触及路径: ${p.operation.touchedPaths.join(', ') || '无'}`)
          L.push(`- 预计回收: ${fmtBytes(p.operation.estimatedBytesReclaimable)}`)
          L.push(`- 需要独占锁: ${p.operation.requiresExclusiveLock ? '是' : '否'}`)
        }
        L.push('')
      }
      if (dr.warnings.length > 0) {
        L.push('### 警告', '')
        for (const w of dr.warnings) {
          L.push(`- ${w.blocking ? '⛔ [阻断] ' : '⚠️ '}${w.message}`)
        }
        L.push('')
      }
    }

    // ── V5 汇总统计区（追加式：数据由 payload 推导，旧段落不受影响） ──
    const summary = buildSummary(payload)
    L.push('## 汇总统计', '')
    L.push(`- **总回收**: ${fmtBytes(summary.totalBytesFreed)}`)
    L.push(`- **事务数**: ${summary.txCount}`)
    L.push(`- **步骤成功率**: ${summary.successRate === null ? '—' : `${(summary.successRate * 100).toFixed(0)}%`}`)
    if (summary.byAction.length > 0) {
      L.push('', '| 动作 | 步骤数 | 释放量 |', '|---|---|---|')
      for (const a of summary.byAction) {
        L.push(`| ${a.action} | ${a.steps} | ${fmtBytes(a.bytesFreed)} |`)
      }
    }
    L.push('')

    L.push('## 健康检查', '')
    L.push('| 状态 | 检查项 | 结果 | 级别 | 分组 |', '|---|---|---|---|---|')
    for (const h of payload.health) {
      const msg = h.message.replace(/\|/g, '\\|')
      L.push(`| ${statusIcon(h.passed)} | ${h.check} | ${msg} | ${h.severity} | ${h.group} |`)
    }
    L.push('')

    L.push('## 审计链', '')
    if (payload.auditTrail.length === 0) {
      L.push('(无审计记录)', '')
    } else {
      L.push('| seq | 时间 | 操作人 | 动作 | 结果 | hash |', '|---|---|---|---|---|---|')
      for (const a of payload.auditTrail) {
        L.push(`| ${a.seq} | ${a.timestamp} | ${a.actor} | ${a.action} | ${a.outcome} | \`${a.hash.slice(0, 12)}…\` |`)
      }
      L.push('')
    }

    return L.join('\n')
  }

  const reporter: IReporter = {
    async export(format: ReportFormat, payload: ReportPayload): Promise<Result<{ path: string; bytes: number }>> {
      try {
        fs.mkdirSync(options.reportsRoot, { recursive: true })
        const name = baseName(payload)
        const file = path.join(options.reportsRoot, `${name}.${format === 'json' ? 'json' : 'md'}`)
        const content = format === 'json'
          // JSON 追加式扩展：旧字段原样保留，仅新增 summary 汇总统计键
          ? JSON.stringify({ ...payload, summary: buildSummary(payload) }, null, 2)
          : renderMarkdown(payload)
        // 原子落盘（tmp+rename）：写一半崩溃不留半份报告 —— 报告是
        // 事后审计材料，半份报告比没有报告更误导
        writeTextAtomic(file, content)
        return ok({ path: file, bytes: Buffer.byteLength(content) })
      } catch (e) {
        return err(ioError('报告导出失败', e))
      }
    },
  }
  return reporter
}

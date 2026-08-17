// src/infra/reporter.ts — IReporter 实现：JSON（机器）/ Markdown（人类）双格式导出
import * as fs from 'fs'
import * as path from 'path'
import type { NukeError, Result } from '../contracts/base'
import { err, fmtBytes, ioError, ok } from '../contracts/base'
import type {
  IReporter, ReportFormat, ReportPayload,
} from '../contracts/logging'

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
        L.push(`### ${p.operation ?? p.summary}`)
        // plans 元素契约：{ operation: OperationPlan; summary: string }
        L.push(`- ${p.summary}`)
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
    async export(format: ReportFormat, payload: ReportPayload): Promise<Result<{ path: string; bytes: number }, NukeError>> {
      try {
        fs.mkdirSync(options.reportsRoot, { recursive: true })
        const name = baseName(payload)
        const file = path.join(options.reportsRoot, `${name}.${format === 'json' ? 'json' : 'md'}`)
        const content = format === 'json'
          ? JSON.stringify(payload, null, 2)
          : renderMarkdown(payload)
        fs.writeFileSync(file, content, 'utf-8')
        return ok({ path: file, bytes: Buffer.byteLength(content) })
      } catch (e) {
        return err(ioError('报告导出失败', e))
      }
    },
  }
  return reporter
}

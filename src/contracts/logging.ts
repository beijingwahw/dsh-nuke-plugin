// contracts/logging.ts — 子系统四：分级日志 / 不可变审计 / 报告导出
// 三件套：
//  1. ILogger      运行日志：debug/info/warn/error 分级 + ANSI 彩色（非 TTY 自动降级）
//  2. IAuditLog    审计日志：hash chain 不可变，任何篡改可被 verify() 检出
//  3. IReporter    报告导出：JSON（机器）/ Markdown（人类）

import type { NukeError, Result, TxId } from './base'
import type { TxSummary, DryRunReport } from './transaction'
import type { HealthCheckResult } from './health.contract'

// ─── 运行日志（彩色终端输出） ───────────────────────────────
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  readonly [key: string]: unknown
}

export interface ILogger {
  log(level: LogLevel, message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** 事务/模块级子 logger：自动附带 bindings（txId、plugin…） */
  child(bindings: LogFields): ILogger
  /** 进度条支持：0-100 或不确定态 */
  progress(ratio: number | null, label: string): void
  /** TTY 检测：非交互 sink 下自动剥离 ANSI（管道/CI 安全） */
  readonly sink: 'tty' | 'plain'
}

// ─── 不可变审计日志（hash chain） ──────────────────────────
export interface AuditEntry {
  readonly timestamp: string
  readonly actor: string            // 操作人：CLI 用户 / tool 调用者
  readonly action: string           // 'tx-begin' | 'step-execute' | 'tx-rollback' | ...
  readonly txId?: TxId
  readonly outcome: 'success' | 'failure' | 'skipped'
  readonly detail: Readonly<Record<string, unknown>>
}

/** 追加后返回带链哈希的固化条目：hash = sha256(prevHash ‖ canonicalJson(entry)) */
export interface HashedAuditEntry extends AuditEntry {
  readonly seq: number
  readonly prevHash: string
  readonly hash: string
}

export interface ChainVerification {
  readonly valid: boolean
  readonly firstBrokenSeq: number | null   // 篡改发生点
  readonly totalEntries: number
}

export interface IAuditLog {
  append(entry: AuditEntry): Promise<HashedAuditEntry>
  /** 全链校验：定位第一条被篡改/删除的记录 */
  verify(): Promise<ChainVerification>
  /** 审计查询（报告生成用），只读 */
  query(filter: { txId?: TxId; actor?: string; since?: string }):
    Promise<readonly HashedAuditEntry[]>
}

// ─── 报告导出 ─────────────────────────────────────────────
export type ReportFormat = 'json' | 'markdown'

export interface ReportPayload {
  readonly tx?: TxSummary
  readonly dryRun?: DryRunReport
  readonly health: readonly HealthCheckResult[]
  readonly auditTrail: readonly HashedAuditEntry[]
  readonly generatedAt: string
  readonly chainValid: boolean   // 审计链是否验证通过
}

export interface IReporter {
  /** 写入 <dshHome>/.nuke/reports/<name>.<ext> 并返回路径；文件名含 txId 与时间戳 */
  export(format: ReportFormat, payload: ReportPayload): Promise<Result<
    { path: string; bytes: number },
    NukeError
  >>
}

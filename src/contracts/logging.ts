// contracts/logging.ts — 子系统四：分级日志 / 不可变审计 / 报告导出
// 三件套：
//  1. ILogger      运行日志：debug/info/warn/error 分级 + ANSI 彩色（非 TTY 自动降级）
//  2. IAuditLog    审计日志：hash chain 不可变，任何篡改可被 verify() 检出
//  3. IReporter    报告导出：JSON（机器）/ Markdown（人类）

import type { CleanAction, Result, TxId } from './base'
import type { HealthCheckResult } from './health.contract'
import type { TxSummary, DryRunReport } from './transaction'

// ─── 运行日志（彩色终端输出） ───────────────────────────────
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, unknown>>;

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

/** 步骤级审计条目的 action 前缀（`op:<CleanAction>`）。
 *  写方（事务引擎 auditStep）与读方（可靠性模型）共同依赖此契约常量 ——
 *  前缀若在任一侧被硬编码改写，统计将静默失明（零样本 → 退化为先验），
 *  故必须收敛到契约层单一事实源。 */
export const OP_AUDIT_PREFIX = 'op:'

/** V5.4 预测存证条目的 action（`tx-predict`）。
 *  写方（事务引擎 commit 执行前存证）与读方（预测评分级对账）共同依赖
 *  此契约常量 —— 与 OP_AUDIT_PREFIX 同理收敛到契约层单一事实源：
 *  任一侧硬编码漂移都会让对账静默失明（零存证 → 战绩永远空白）。 */
export const PREDICT_AUDIT_ACTION = 'tx-predict'

export interface AuditEntry {
  readonly timestamp: string
  readonly actor: string            // 操作人：CLI 用户 / tool 调用者
  readonly action: string           // 'tx-begin' | 'dry-run' | 'tx-commit' | 'tx-rollback' | PREDICT_AUDIT_ACTION | `${OP_AUDIT_PREFIX}${action}` | ...
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

// ─── V5 增量：报告汇总统计区 ────────────────────────────────
// 数据全部从传入 payload 推导（tx.steps / dryRun.actions），不改变
// ReportPayload 既有字段语义；reporter 导出时追加呈现，旧字段不动。

/** 按动作分组的回收量统计（事务取实际回收，预演取预估量） */
export interface ActionReclaimStat {
  readonly action: CleanAction
  /** 该动作的步骤数（事务步骤 / 预演动作条目） */
  readonly steps: number
  /** 该动作累计回收字节（事务 = 实际 bytesFreed；预演 = estimatedBytes） */
  readonly bytesFreed: number
}

/** 报告级汇总统计 */
export interface ReportSummary {
  /** 总回收字节（tx 存在取 bytesFreedTotal；否则 dryRun 预估；均无 = 0） */
  readonly totalBytesFreed: number
  /** 覆盖的事务数（含 tx = 1，纯预演不计） */
  readonly txCount: number
  /** 步骤成功率（done+skipped / 全部步骤），0~1；无步骤时为 null */
  readonly successRate: number | null
  /** 按动作分组的回收量统计（按 bytesFreed 降序） */
  readonly byAction: readonly ActionReclaimStat[]
}

export interface IReporter {
  /** 写入 <dshHome>/.nuke/reports/<name>.<ext> 并返回路径；文件名含 txId 与时间戳 */
  export(format: ReportFormat, payload: ReportPayload): Promise<Result<
    { path: string; bytes: number }
  >>
}

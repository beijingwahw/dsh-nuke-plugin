// contracts/transaction.ts — 子系统二：安全执行与事务控制中枢
// 设计思想：
//  1. 命令模式 —— 每个清理动作是一个自带 validate/preview/execute/undo 的 CleanOperation
//  2. Saga 补偿 —— 失败不靠"继续"，靠逐已执行步骤的 undo 反向补偿
//  3. WAL 先行 —— 任何写盘前先追加预写日志，进程崩溃后 recover() 可重放
//  4. 回收区代替 rm —— 目录删除=原子改名进回收区，commit 后才允许 purge
//  5. Dry-run 与 commit 共享同一 Plan 投影，预演结果即真实结果

import type {
  AbsolutePath, CleanAction, CleanStrategy, Clock, LockId,
  NukeError, PluginName, ProfileName, Result, TxId,
} from './base'
import type { IPathResolver } from './paths'
import type { ILogger } from './logging'

// ─── 事务状态机（迁移受 ITransactionEngine 强制校验） ──────────
export type TxState =
  | 'draft'         // begin() 已受理
  | 'planned'       // plan() 已编译操作集
  | 'validating'    // 前置校验中
  | 'executing'     // 步骤执行中
  | 'committing'    // 全部成功，收尾（purge 备份/释放锁）
  | 'rolling-back'  // 反向补偿中
  | 'committed' | 'rolled-back' | 'failed'  // 终态

// ─── 请求与上下文 ───────────────────────────────────────────
export interface CleanRequest {
  readonly plugins: readonly PluginName[]
  readonly profile: ProfileName
  readonly strategy: CleanStrategy
  readonly dryRun: boolean
  /** aggressive 策略必须携带；由确认流程签发的一次性令牌 */
  readonly confirmationToken?: string
  /** 操作人标识（CLI 用户名 / tool 调用者），写入审计日志 */
  readonly actor: string
}

export interface TxContext {
  readonly txId: TxId
  readonly request: CleanRequest
  readonly resolver: IPathResolver
  /** 本事务已预留的备份区（操作的 stage* / restore 都经由它） */
  readonly backups: BackupArea
  readonly logger: ILogger
  readonly clock: Clock
}

// ─── 备份记录与备份仓库 ─────────────────────────────────────
export interface FileFingerprint {
  readonly path: AbsolutePath
  readonly hash: string       // sha256，前 16 hex
  readonly size: number
  readonly mtime: number
}

export interface BackupRecord {
  readonly operationId: string
  readonly kind: 'file-copy' | 'dir-move' | 'yaml-edit'
  readonly originalPath: AbsolutePath
  readonly backupPath: AbsolutePath
  /** 备份产物自身的指纹，恢复前先验证备份未被篡改 */
  readonly fingerprint: FileFingerprint
  /** yaml-edit 专用：原文件完整内容，供幂等恢复 */
  readonly originalContent?: string
}

export interface IBackupStore {
  /** 为事务预留独立备份区：$DSH_HOME/.nuke-backups/<txId>/ */
  reserve(txId: TxId): Promise<BackupArea>
}

export interface BackupArea {
  /** 单文件：复制留档 */
  stageFile(original: AbsolutePath): Promise<BackupRecord>
  /** 目录：原子改名（rename）进回收区 —— O(1)、可逆、不物理删除 */
  stageDir(original: AbsolutePath): Promise<BackupRecord>
  /** 配置编辑：先落原内容快照，再写新内容（写前 fsync） */
  stageEdit(original: AbsolutePath, nextContent: string): Promise<BackupRecord>
  /** 恢复：幂等（重复调用安全），恢复前校验备份指纹 */
  restore(record: BackupRecord): Promise<Result<void, NukeError>>
  /** 全部 stage 清单（含崩溃时已 stage 但未 execute 完成的）——恢复的一等依据 */
  manifest(): readonly BackupRecord[]
  /** 备份区中未被 manifest 覆盖的产物数（崩溃窗口残留）。>0 时禁止 purge：
   *  这些产物可能是数据唯一完整副本（stageDir 已把原位移走），销毁即永久丢失。 */
  orphanArtifacts(): number
  /** 事务 committed 后按保留策略（默认 7 天）清理回收区 */
  purge(txId: TxId): Promise<Result<void, NukeError>>
}

// ─── 原子操作（命令模式） ───────────────────────────────────

// ── V4 增量（仅新增，向后兼容）：操作风险等级 / 结构化命令捕获 / 影响面明细 ──

/** 操作风险等级（动作元数据维度；与 blast-radius 的 RiskLevel 相互独立：
 *  前者描述"这类动作固有风险"，后者描述"这次删除波及谁"）。 */
export type OperationRiskLevel = 'low' | 'medium' | 'high'

/** 外部命令执行的结构化捕获（exec 类操作专用）。
 *  preview 阶段为探针命令（--version）的结果；execute 阶段为真实命令的结果。
 *  stdout/stderr 已截断至有界长度，保证 WAL/审计链不因命令噪声膨胀。 */
export interface CommandExecutionDetail {
  readonly cmd: string
  readonly args: readonly string[]
  readonly exitCode: number | null          // null = 进程未正常退出（spawn 失败/被信号终止）
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** 含首次执行在内的总尝试次数（瞬态重试后 > 1） */
  readonly attempts: number
  /** 是否因超时被终止（fail-closed 信号：调用方必须按失败处理） */
  readonly timedOut: boolean
}

/** 目录清理影响面明细（fs 类操作 preview 阶段计算，供 dry-run 报告展示） */
export interface DirImpactEntry {
  readonly path: AbsolutePath
  readonly bytes: number
}

export interface DirImpactDetail {
  readonly dir: AbsolutePath
  readonly totalBytes: number
  /** 目录内 top-N 大文件（N 由操作配置，默认 5） */
  readonly topFiles: readonly DirImpactEntry[]
  /** 目录内 top-N 大子目录（递归体积） */
  readonly topDirs: readonly DirImpactEntry[]
}

export interface OperationPlan {
  readonly summary: string                  // 人类可读的操作描述
  readonly touchedPaths: readonly AbsolutePath[]
  readonly estimatedBytesReclaimable: number
  readonly requiresExclusiveLock: boolean
  /** V4 增量（可选）：本操作为幂等跳过（目标缺失/引用不存在），不产生副作用 */
  readonly skipped?: boolean
  /** V4 增量（可选）：探针命令的结构化输出（exec 类操作 preview 阶段填充） */
  readonly command?: CommandExecutionDetail
  /** V4 增量（可选）：目录影响面明细（fs 类操作 preview 阶段填充） */
  readonly impact?: DirImpactDetail
  /** V5 增量（可选）：本操作涉及的文件数（touchedPaths 去重计数；目录类操作
   *  可报告递归统计值）。preview 阶段填充，供上层策略守卫消费 ——
   *  缺省/未统计时文件数上限规则（maxFilesPerTx）跳过判定。 */
  readonly fileCount?: number
}

export interface CleanOperation {
  readonly id: string
  readonly action: CleanAction
  readonly target: PluginName
  /** V4 增量（可选）：动作风险等级（操作集编译器按 ACTION_METADATA 表注入） */
  readonly riskLevel?: OperationRiskLevel
  /** V4 增量（可选）：人类可读的动作语义描述（同上表注入） */
  readonly description?: string

  /** 零副作用预演：dry-run 与 commit 共享此投影 */
  preview(ctx: TxContext): Promise<OperationPlan>
  /** 前置校验：目标存在性、权限、依赖方、路径策略。失败则事务不进入 executing */
  validate(ctx: TxContext): Promise<Result<void, NukeError>>
  /** 执行：必须先通过 BackupArea 留下 undo 依据，再产生副作用；返回备份记录供 WAL 落盘 */
  execute(ctx: TxContext): Promise<Result<ExecutedStep, NukeError>>
  /** 反向补偿：幂等；仅依赖 BackupRecord，不依赖内存状态（崩溃恢复可用） */
  undo(ctx: TxContext, record: BackupRecord | null): Promise<Result<void, NukeError>>
}

export interface OperationOutcome {
  readonly bytesFreed: number
  readonly message: string
  /** V4 增量（可选）：本步骤为幂等跳过（无副作用发生） */
  readonly skipped?: boolean
  /** V4 增量（可选）：外部命令执行的结构化捕获（随 step-done 进 WAL 与审计链） */
  readonly command?: CommandExecutionDetail
}

export interface ExecutedStep {
  readonly outcome: OperationOutcome
  readonly backup: BackupRecord | null
}

// ─── 计划（Plan） ──────────────────────────────────────────
export interface PlanWarning {
  readonly code: string
  readonly message: string
  readonly blocking: boolean   // blocking 警告使 plan 无法进入 commit
}

export interface TxPlan {
  readonly txId: TxId
  readonly operations: readonly CleanOperation[]
  readonly estimatedBytesReclaimable: number
  readonly warnings: readonly PlanWarning[]
  readonly requiresConfirmationToken: boolean
}

// ─── 预写日志（WAL） ───────────────────────────────────────
export type WalRecord =
  | { readonly type: 'tx-begin'; readonly txId: TxId; readonly request: CleanRequest }
  | { readonly type: 'step-intent'; readonly index: number; readonly operationId: string; readonly action: CleanAction; readonly backup?: BackupRecord | null }
  | { readonly type: 'step-done'; readonly index: number; readonly operationId: string; readonly outcome: OperationOutcome; readonly backup: BackupRecord | null }
  | { readonly type: 'step-failed'; readonly index: number; readonly error: NukeError }
  | { readonly type: 'tx-commit'; readonly txId: TxId }
  | { readonly type: 'tx-rollback'; readonly txId: TxId; readonly reason: string }

export interface IWal {
  /** 追加一条记录到 <txId>.wal.jsonl 并 fdatasync（事务安全性的物理保证） */
  append(txId: TxId, record: WalRecord): Promise<void>
  /** 崩溃恢复时重放；最后一行可能因崩溃写半而丢弃 */
  replay(txId: TxId): Promise<readonly WalRecord[]>
  /** 列出全部未终结（无 tx-commit / tx-rollback 终结符）的事务 ID */
  unfinishedTxIds(): TxId[]
}

// ─── 事务引擎 ──────────────────────────────────────────────
export interface TxSummary {
  readonly txId: TxId
  readonly state: TxState
  readonly steps: readonly {
    index: number
    operationId: string
    action: CleanAction
    status: 'pending' | 'done' | 'failed' | 'skipped' | 'undone'
    bytesFreed: number
    backup: BackupRecord | null
  }[]
  readonly bytesFreedTotal: number
  readonly startedAt: string
  readonly finishedAt?: string
}

export interface ITransactionEngine {
  /** 受理请求：获取锁（独占）→ 创建 WAL → 返回会话。锁由引擎全程持有 */
  begin(request: CleanRequest): Promise<Result<TxSession, NukeError>>
  /** 编译策略为有序操作集；同时做依赖检测与确认令牌校验 */
  plan(session: TxSession): Promise<Result<TxPlan, NukeError>>
  /** 全量预演：逐操作 preview，零副作用。输出与 commit 同构的报告 */
  dryRun(plan: TxPlan): Promise<Result<DryRunReport, NukeError>>
  /** 校验 → 逐执行 → 全成败即 commit；任一败即自动 rollback（Saga 反向补偿） */
  commit(plan: TxPlan): Promise<Result<TxSummary, NukeError>>
  /** 手动回滚已提交前的事务（幂等） */
  rollback(txId: TxId): Promise<Result<TxSummary, NukeError>>
  /** 启动时扫描 .nuke-tx/ 下未终结的 WAL：有 step-done 无 tx-commit → 反向补偿 */
  recover(): Promise<Result<readonly TxSummary[], NukeError>>
  status(txId: TxId): Promise<TxSummary | null>
}

export interface TxSession {
  readonly txId: TxId
  readonly lockId: LockId
  readonly request: CleanRequest
}

/** V4 增量：dry-run 动作级明细（DryRunReport.actions 的元素形态）。
 *  由操作集编译器的 makeOperationPlan 供给，向后兼容 —— 引擎不填时报告形态不变。 */
export interface DryRunActionDetail {
  readonly action: CleanAction
  readonly target: PluginName
  readonly riskLevel: OperationRiskLevel
  readonly description: string
  readonly estimatedBytes: number
  /** V4.1 增量（可选）：本动作幂等跳过（目标缺失/引用不存在），执行时无副作用 */
  readonly skipped?: boolean
}

export interface DryRunReport {
  readonly txId: TxId
  readonly plans: readonly { readonly operation: OperationPlan; readonly summary: string }[]
  readonly estimatedBytesReclaimable: number
  readonly warnings: readonly PlanWarning[]
  /** V4 增量（可选）：动作清单明细（action/riskLevel/description/estimatedBytes） */
  readonly actions?: readonly DryRunActionDetail[]
}

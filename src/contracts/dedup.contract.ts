// contracts/dedup.contract.ts — 内容寻址去重分析器
// 跨 profile 的 node_modules 常有同版本依赖的多份拷贝（pnpm 已尽力，
// 但跨 store/历史遗留仍会产生真重复）。本分析器以 SHA-256 内容指纹
// 精确定位重复文件群，量化"若去重（hardlink/回收冗余拷贝）可回收多少空间"。
// 只读分析：不执行任何去重动作，结论供策略引擎与 UI 决策。

import type { AbsolutePath, NukeError, ProfileName, Result } from './base'

export interface DedupCopy {
  readonly path: AbsolutePath
  /** 由路径推断的 profile（推断不出为 null，如 TEMP 根下的文件） */
  readonly profile: ProfileName | null
}

export interface DedupGroup {
  /** 内容指纹（SHA-256） */
  readonly hash: string
  readonly sizeBytes: number
  readonly copies: readonly DedupCopy[]
  /** (copies - 1) × sizeBytes：保留一份时的最大可回收空间 */
  readonly reclaimableBytes: number
}

export interface DedupReport {
  /** 按 reclaimableBytes 降序（默认上限 100 组，防止报告爆炸） */
  readonly groups: readonly DedupGroup[]
  /** 全部重复群（含未列入 groups 的）合计可回收字节 */
  readonly totalReclaimableBytes: number
  readonly filesScanned: number
  readonly bytesScanned: number
  readonly durationMs: number
  /** 三级瀑布的阶段淘汰统计（性能收益可见化） */
  readonly stages?: {
    /** 尺寸唯一即淘汰：零哈希成本 */
    readonly sizeEliminated: number
    /** 头尾采样指纹不同即淘汰：未读全量 */
    readonly sampleEliminated: number
    /** 真正读了全量并计算 SHA-256 的文件数 */
    readonly fullHashed: number
    /** 采样阶段省下的全量读取字节 */
    readonly bytesSavedBySampling: number
  }
}

export interface DedupOptions {
  /** 分析根目录集合；缺省 = 所有 profile 的 node_modules */
  readonly roots?: readonly AbsolutePath[]
  /** 小于该尺寸的文件不参与（默认 4KB：小文件哈希成本 > 回收价值） */
  readonly minSizeBytes?: number
  readonly signal?: AbortSignal
}

export interface IDedupAnalyzer {
  /**
   * 三级瀑布算法（rmlint/jdupes 同族的世界级方案）：
   *   1. size 分桶 —— 尺寸唯一即淘汰（零哈希）
   *   2. 头尾采样指纹（各 4KB）—— 采样不同即淘汰（不全量读）
   *   3. 全量 SHA-256 —— 仅对采样碰撞者，保证零误报
   */
  analyze(options?: DedupOptions): Promise<Result<DedupReport, NukeError>>
}

// ─── 硬链接执行器：分析 → 实收 ──────────────────────────────

/** 单条链接动作的执行记录（undo 依据） */
export interface LinkJournalEntry {
  /** 被替换为硬链接的副本（victim） */
  readonly victim: AbsolutePath
  /** 保留的原件（canonical），undo 时从它复制回独立文件 */
  readonly canonical: AbsolutePath
  readonly sizeBytes: number
}

export interface DedupExecResult {
  /** 成功替换为硬链接的文件数 */
  readonly linkedFiles: number
  /** 实际回收字节（仅计替换前 nlink=1 的 victim —— 已共享 inode 的替换不省空间） */
  readonly bytesSaved: number
  readonly journal: readonly LinkJournalEntry[]
  /** 未执行的动作及原因（跨设备/已链接/复验失败/文件消失…） */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  /** true = 被 AbortSignal 中途取消：journal 携带已完成部分，调用方仍可 undo。
   *  关键安全语义：取消绝不丢弃已产生的副作用记录，否则部分应用不可逆。 */
  readonly cancelled: boolean
}

export interface DedupUndoReport {
  /** 成功恢复为独立文件的条数 */
  readonly undone: number
  /** 失败条目及原因（best-effort：单条失败不中断其余条目的恢复） */
  readonly failed: readonly { readonly victim: string; readonly error: string }[]
}

export interface IDedupExecutor {
  /** 将分析报告中的重复组转化为硬链接（verify-then-link，逐组 TOCTOU 复验）。
   *  中途取消返回 ok(cancelled=true)：journal 保留已完成部分供 undo。 */
  apply(report: DedupReport, options?: { signal?: AbortSignal }): Promise<Result<DedupExecResult, NukeError>>
  /** 反向补偿（best-effort）：journal 中的 victim 从 canonical 复制回独立文件。
   *  单条失败不中断其余恢复，进度与失败明细随报告返回。 */
  undo(journal: readonly LinkJournalEntry[]): Promise<Result<DedupUndoReport, NukeError>>
}

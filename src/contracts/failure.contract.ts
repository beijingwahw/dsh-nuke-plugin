// contracts/failure.contract.ts — 失败分类学（V5.3 失败模式智能的单一事实源）
//
// 核心思想：可靠性模型回答"这步有多大把握"，失败分类学回答
// "为什么会失败、失败了怎么办"。两者相乘，先知从概率黑盒升级为
// 可行动的诊断书：
//
//   预测（哪步会挂）→ 诊断（以什么方式挂）→ 处方（重试/规避/根治）
//
// 分类器输入是审计链 detail.error 的消息文本（errorToMessage 已归一化：
// NukeError 形态带 `[E_XXX]` 前缀，Node fs 错误带 errno 码）—— 与
// exec-ops 的 RETRYABLE_ERRNOS 语义对齐但覆盖面更广（命令级重试只管
// spawn 错误，步骤级还覆盖 fs/edit 操作失败）。
//
// 瞬态性（transience）是重试决策的唯一依据：
//   transient  → 引擎自动有界重试（指数退避）值得做
//   permanent  → 立即失败快速回滚，重试是纯浪费
//
// 写方（事务引擎 auditStep 记 failureMode）与读方（可靠性模型从
// error 文本分类）共享本模块 —— 分类规则若在任一侧漂移，统计与
// 行为将互相矛盾（按 A 分类、按 B 重试），故必须收敛到契约层。
import type { CleanAction } from './base'

// ─── 失败模式（canonical taxonomy）──────────────────────────

export type FailureMode =
  | 'locked'       // EBUSY/资源占用：文件被进程持有（Windows 常见）→ 瞬态
  | 'timeout'      // ETIMEDOUT/超时/被信号终止 → 瞬态
  | 'resource'     // EAGAIN/EMFILE/ENFILE/EINTR：句柄或调度暂不可用 → 瞬态
  | 'space'        // ENOSPC：备份暂存/临时区写满 → 释放空间后可重试
  | 'vanished'     // ENOENT：目标已消失（对清理而言≈目标已达成）
  | 'permission'   // EACCES/EPERM：权限或占用方持有 → 永久（需人工介入）
  | 'validation'   // E_VALIDATION/E_HOOK_VETO：前置校验拒绝 → 永久
  | 'dependency'   // 命令不存在/工具缺失 → 永久（装包或修 PATH）
  | 'io'           // 其余 IO 错误（EIO/EROFS/损坏…）→ 永久（保守：不盲试）
  | 'unknown'      // 无根因信息 → 永久（fail-closed：宁可失败不盲试）

/** 各模式的瞬态性判定（重试决策依据） */
export const MODE_TRANSIENCE: Readonly<Record<FailureMode, 'transient' | 'permanent'>> = {
  locked: 'transient',
  timeout: 'transient',
  resource: 'transient',
  space: 'transient',
  vanished: 'permanent',   // 目标不存在对删除是"已达成"；但作为失败出现时按永久处理（不重试）
  permission: 'permanent',
  validation: 'permanent',
  dependency: 'permanent',
  io: 'permanent',
  unknown: 'permanent',
}

/** 各模式的人类可读处方（先知最脆弱步骤 / 失败档案的工具输出） */
export const MODE_PRESCRIPTIONS: Readonly<Record<FailureMode, string>> = {
  locked: '文件被占用（EBUSY）——引擎将自动重试；若持续失败，关闭占用进程（dsh/编辑器/索引器）后再清理',
  timeout: '操作超时——引擎将自动重试；若持续失败，检查磁盘健康与系统负载',
  resource: '系统资源暂不可用（句柄/调度）——引擎将自动重试；若持续失败，减少并发负载后重试',
  space: '磁盘空间不足——释放备份暂存区（.nuke/backups 旧事务）或扩大磁盘后重试',
  vanished: '目标已消失——无需处理（清理目标已达成）；若反复出现，检查是否有并发清理',
  permission: '权限被拒——检查文件属主/权限位，或以管理员身份运行；Windows 上常为进程持有',
  validation: '前置校验拒绝——修正请求参数（策略/令牌/路径），重试不会改变结果',
  dependency: '外部命令缺失——安装对应 CLI 或修正 PATH（健康检查 nuke_health 可探测）',
  io: '底层 IO 错误——检查磁盘健康（SMART）与文件系统一致性后重试',
  unknown: '未知根因——重试大概率无效，请查看审计链 detail.error 定位',
}

// ─── 分类器（纯函数：消息文本 → 模式）──────────────────────

/** 模式匹配规则表（有序：首个命中生效）。
 *  码类模式优先匹配（`E_XXX` 前缀/errno 字面量），再落到措辞类。 */
const MODE_RULES: ReadonlyArray<{ readonly mode: FailureMode; readonly patterns: readonly RegExp[] }> = [
  // 契约错误码（errorToMessage 对 NukeError 形态产出 `[E_XXX] msg`）
  { mode: 'validation', patterns: [/\[E_VALIDATION\]/, /\[E_HOOK_VETO\]/, /\[E_POLICY\]/] },
  { mode: 'dependency', patterns: [/\[E_TOOL_MISSING\]/, /\[E_NOT_FOUND\]/, /spawn .* ENOENT/i, /command not found/i] },
  // errno 字面量（Node fs/spawn 根因消息）
  { mode: 'locked', patterns: [/\bEBUSY\b/, /\bEDEADLK\b/, /resource busy/i, /被占用/] },
  { mode: 'timeout', patterns: [/\bETIMEDOUT\b/, /\bEtimedout\b/, /timed? ?out/i, /超时/] },
  { mode: 'resource', patterns: [/\bEAGAIN\b/, /\bEMFILE\b/, /\bENFILE\b/, /\bEINTR\b/] },
  { mode: 'space', patterns: [/\bENOSPC\b/, /no space left/i, /磁盘空间不足/, /space insufficient/i] },
  { mode: 'vanished', patterns: [/\bENOENT\b/, /no such file or directory/i, /不存在/] },
  { mode: 'permission', patterns: [/\bEACCES\b/, /\bEPERM\b/, /permission denied/i, /权限/] },
  { mode: 'io', patterns: [/\bEIO\b/, /\bEROFS\b/, /\bEISDIR\b/, /\bENOTDIR\b/, /\bENOTEMPTY\b/, /read-only/i] },
]

/**
 * 失败消息 → 规范失败模式（纯函数、无 IO）。
 * 空串/无法识别 → 'unknown'（保守：永久，不盲目重试）。
 */
export function classifyFailureMode(message: string | null | undefined): FailureMode {
  if (typeof message !== 'string' || message.length === 0) return 'unknown'
  for (const rule of MODE_RULES) {
    for (const re of rule.patterns) {
      if (re.test(message)) return rule.mode
    }
  }
  return 'unknown'
}

// ─── 统计与重试策略 ─────────────────────────────────────────

/** 单动作的失败模式统计（可靠性模型从审计链学习） */
export interface FailureModeStat {
  readonly mode: FailureMode
  /** 该模式的失败次数 */
  readonly count: number
  /** 占该动作全部失败的份额 0-1（Σ share = 1） */
  readonly share: number
  readonly transience: 'transient' | 'permanent'
}

/** 步骤级重试策略（事务引擎）：
 *  只重试瞬态模式；次数有界、退避有顶 —— 最坏情况时延可控。 */
export interface RetryPolicy {
  /** 重试次数上限（不含首次执行），默认 2 */
  readonly maxRetries: number
  /** 首次退避基准（ms）；第 k 次重试前等待 base×2^(k-1)。测试可置 0 */
  readonly backoffMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 2, backoffMs: 150 }

/** 单次重试对瞬态失败的成功率（经验值 0.5）：
 *  重试调整模型 p_adj = p + (1-p)·t·(1-(1-e)^R) 的 e 参数。
 *  锁释放/句柄释放后自愈是概率事件而非确定事件，取中庸估计。 */
export const DEFAULT_RETRY_EFFICACY = 0.5

/** 重试调整成功率：p 为经验成功率，transientShare 为瞬态失败份额，
 *  retries 为重试次数上限，efficacy 为单次重试成功率。
 *  语义："引擎将自动重试瞬态失败的前提下，这步的有效成功率"。 */
export function retryAdjustedProbability(
  p: number,
  transientShare: number,
  retries: number,
  efficacy: number = DEFAULT_RETRY_EFFICACY,
): number {
  if (p >= 1 || transientShare <= 0 || retries <= 0 || efficacy <= 0) return p
  const resolved = 1 - (1 - efficacy) ** retries   // 瞬态失败被重试挽回的比例
  return p + (1 - p) * transientShare * resolved
}

/** 动作 × 模式统计的复合键约定（失败档案分组键，工具层使用） */
export type FailureArchiveKey = `${string}::${FailureMode}`

export function failureArchiveKey(action: CleanAction | string, mode: FailureMode): FailureArchiveKey {
  return `${action}::${mode}` as FailureArchiveKey
}

// contracts/drill.contract.ts — 混沌演习（崩溃安全自检）
// 设计哲学：安全性不该靠代码审查"相信"，而要靠受控崩溃"证明"。
// 每次演习在沙箱中真实地执行一次事务，在第 crashAfterStep 步成功
// 落盘后模拟进程死亡（SimulatedCrashError 穿透：不回滚、不释放锁），
// 然后走真实崩溃恢复路径 recover()，逐项断言环境被完整还原。
// 全部通过 → 签发崩溃安全证书。
import type { Result } from './base'

export interface DrillCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export interface DrillReport {
  readonly runId: string
  /** 崩溃注入点（第几步成功后"断电"，1-based） */
  readonly crashedAtStep: number
  readonly checks: readonly DrillCheck[]
  readonly passed: boolean
  readonly restoredFiles: number
  readonly auditChainValid: boolean
  readonly durationMs: number
}

export interface IDrill {
  /** 在沙箱中执行一次崩溃→恢复演习（不影响真实环境）。
   *  afterStep：第几步成功落盘后模拟断电（1-based，默认 1） */
  run(options?: { readonly afterStep?: number }): Promise<Result<DrillReport>>
}

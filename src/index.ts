// src/index.ts — 插件入口（纯组装：运行时构造 + 24 工具按域注册）
//
// 结构纪律：本文件不做任何业务逻辑。依赖接线全在 runtime.ts，
// 工具按用户旅程分四域注册（感知 → 决策 → 执行 → 恢复保障）。
import type { Context } from '@deepseek-ai/cordis'

import { buildRuntime } from './runtime'
import { registerDecisionTools } from './tools/decision'
import { registerExecutionTools } from './tools/execution'
import { registerPerceptionTools } from './tools/perception'
import { registerRecoveryTools } from './tools/recovery'

export const name = 'dsh-nuke-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  const rt = buildRuntime()
  registerPerceptionTools(ctx, rt)   // 感知：list/scan/deps/orphans/health
  registerDecisionTools(ctx, rt)     // 决策：strategies/oracle/failures/scorecard/blastradius/trend/forecast/policy/guardian
  registerExecutionTools(ctx, rt)    // 执行：clean/dedup/restorepoint
  registerRecoveryTools(ctx, rt)     // 恢复保障：status/locks/recover/verify/doctor/drill/ledger
}

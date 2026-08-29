// src/tools/shared.ts — 工具注册公共件
//
// 24 个工具共享的薄适配层：defineTextTool（统一 output 契约注入）、
// 图标映射与领域入参校验（白名单）。DSL 表达不了的领域约束
//（插件名格式/profile 白名单）全部收敛到这里，各域工具不再重复。
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ParameterSchemaSpec, ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { PluginName, ProfileName } from '../contracts/base'
import type { SeverityBand } from '../contracts/scoring'
import type { Runtime } from '../runtime'

// ─── 出参格式化 ─────────────────────────────────────────────
// fmtBytes 统一导入自契约层（全项目唯一实现，见 contracts/base.ts）

/** 图标映射键一律用契约联合类型：拼错键或缺键在编译期即失败 */
export const BAND_ICON: Record<SeverityBand, string> = {
  info: '·', low: '🟢', medium: '🟡', high: '🟠', critical: '🔴',
}

// ─── 工具注册（薄适配层，官方 defineTool DSL） ──────────────

/** dsh-tools 契约：execute 返回 canonical value，先经 output.schema 校验，
 *  再由 render(args, value) 投影为 ContentBlock 数组。
 *  本插件 24 个工具统一 shape：{ content: string }（纯文本）→ 单个 text 块，
 *  契约集中声明一次，由 defineTextTool 注入 —— 避免逐个注册重复 23 份。 */
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { content: { type: 'string', required: true } },
} as const

/** 统一定义入口：注入共享 output 契约后交给官方 defineTool。
 *  参数用 ParameterSchemaSpec DSL 声明 —— 框架完成 JSON Schema 编译、
 *  运行时参数校验（类型/enum/required）与 InferArgs 类型推导；DSL 表达
 *  不了的领域约束（插件名白名单、txId 格式、数值下限）仍在 execute 内
 *  手工检查（fail loudly，返回 ❌ 文本或抛 ToolArgsError 由宿主物化）。 */
export function defineTextTool<const S extends ParameterSchemaSpec>(tool: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  execute(args: InferArgs<S>): Promise<{ content: string }>
}): ToolDefinition {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args) {
      return tool.execute(args)
    },
  })
}

// ─── 领域入参校验（白名单） ─────────────────────────────────

/** 入参校验：插件名列表（元素类型已由 defineTool 保证为 string，这里做领域白名单） */
export function checkPlugins(
  rt: Runtime, names: readonly string[],
): { ok: true; plugins: PluginName[] } | { ok: false; error: string } {
  if (names.length === 0) return { ok: false, error: '请提供 plugin_names 数组（至少一个）' }
  for (const n of names) {
    const r = rt.validator.validatePluginName(n)
    if (!r.ok) return { ok: false, error: `插件名 "${n}" 非法: ${r.error.map(v => v.detail).join('; ')}` }
  }
  return { ok: true, plugins: names as PluginName[] }
}

export function checkProfile(
  rt: Runtime, p: string,
): { ok: true; profile: ProfileName } | { ok: false; error: string } {
  const r = rt.validator.validateProfileName(p)
  if (!r.ok) return { ok: false, error: `profile "${p}" 非法: ${r.error.map(v => v.detail).join('; ')}` }
  return { ok: true, profile: p as ProfileName }
}

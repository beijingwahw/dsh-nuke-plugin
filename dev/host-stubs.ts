/**
 * 开发期宿主服务桩（仅 `npm run dev` 的独立 cordis 进程使用，不参与构建产物）。
 *
 * 本插件 inject ['tools']，而独立 cordis 进程没有 dsh 宿主的 ToolRegistry，
 * 缺桩时 fiber 会永远停在 PENDING（apply 不执行、热重载无从观察）。
 * 桩按官方契约给出最小实现：register 接受任意工具定义并返回函数型 disposer
 * （宿主桥接代码会 `typeof dispose === 'function'` 检查）。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dev-host-stubs'

export function apply(ctx: Context): void {
  const registered = new Set<string>()
  ctx.provide('tools', {
    /** 记录注册名并返回函数型 disposer（对齐 dsh ToolRegistry 契约）。 */
    register(def: { name: string }) {
      registered.add(def.name)
      return () => {
        registered.delete(def.name)
      }
    },
    /** 已注册工具名快照（调试观察用）。 */
    list: () => [...registered],
  })
}

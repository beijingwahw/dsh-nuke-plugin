// vitest.config.ts — 测试运行配置
//
// 唯一职责：让 tools 层测试可以加载【真实】dsh-tools defineTool
//（含其 JSON Schema 参数校验）。两步：
//   1. server.deps.inline —— dsh-tools 默认被外置（Node 原生解析），
//      inline 化后其 import 走 vite resolver（alias 生效的前提）
//   2. resolve.alias —— 把 dsh-tools 声明、但本仓库不安装（由 harness
//      运行时提供）的 peerDependencies 解析到最小桩
import * as path from 'path'
import { defineConfig } from 'vitest/config'

const stub = path.resolve(__dirname, 'tests/stubs/dsh-peer-stubs.ts')

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-scope': stub,
      '@deepseek-ai/dsh-llm': stub,
      '@deepseek-ai/dsh-session': stub,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-tools/],
      },
    },
  },
})

import { defineConfig } from 'tsdown'

// 零运行时依赖构建：把 dsh-tools（连同其依赖 schemastery、以及 yaml）内联进 lib 产物。
// 动机：dsh-tools 声明 9 个 peerDependencies，而 profile 工作区的 pnpm 依赖图
// 永远不包含它们（由 harness 根环境在运行时经向上解析提供），pnpm 静态检查
// 看不见 → 对所有安装者必然误报 "Issues with peer dependencies"。
// 内联后安装图里不再出现 dsh-tools，警告从根上消失。
//
// cordis / dsh-scope / dsh-llm / dsh-session 为 harness 运行时单例
//（类身份、ctx 注册表必须与宿主共享），必须保持外置裸导入，由 harness 根解析。
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'lib',
  // 显式化内联意图（替代 noExternal 隐式语义）：只有列出的依赖被打进产物，
  // 其余一律外置 —— 防未来新增依赖被静默内联
  deps: {
    onlyBundle: [
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/cosmokit',   // dsh-tools 的传递依赖，连带内联
      '@deepseek-ai/schemastery', // 同上
      'yaml',
    ],
    // harness 运行时单例：永不内联（见顶部注释）
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
    ],
  },
})

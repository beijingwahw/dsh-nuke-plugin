// eslint.config.mjs — 世界级严格基线
// typescript-eslint strict 型预设（类型感知规则）+ import 卫生 +
// 零告警门禁（--max-warnings 0 见 package.json lint script）
import js from '@eslint/js'
import importPlugin from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['lib/**', 'node_modules/**', 'coverage/**', '*.config.*'],
  },
  js.configs.recommended,
  // 类型感知预设仅作用于 TS 源（cli/*.cjs 不在 projectService 覆盖内，
  // 走上方 js.recommended 基线即可）
  ...tseslint.configs.strictTypeChecked.map(c => ({ ...c, files: ['**/*.ts'] })),
  ...tseslint.configs.stylisticTypeChecked.map(c => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      // ── import 卫生 ─────────────────────────────────────
      'import/no-default-export': 'error',
      'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc' },
      }],
      'import/no-duplicates': 'error',
      'import/no-relative-parent-imports': 'off',

      // ── 类型安全收紧（在 strictTypeChecked 之上） ────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
      }],
      '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }],

      // ── 正确性 ──────────────────────────────────────────
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],

      // ── 项目现实适配（显式豁免，逐条有据） ───────────────
      // dsh-tools 的 ParameterSchemaSpec 是跨包常量推断，const 泛型
      // 参数在循环/映射中推导为宽类型 —— 这里保持非字面量断言自由
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // tsconfig 已开 noUncheckedIndexedAccess：索引访问返回 T|undefined，
      // `!` 是循环边界/长度已知情形下显式声明的局部 invariant ——
      // 与替代品（as 断言/冗余分支）相比是最诚实的写法（TS 官方在此
      // 组合下亦接受）。规则本身照开，仅豁免此冲突：
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 测试桩/影子上下文大量依赖接口协变，as never 是契约边界
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      // 视图模型（V5.x 各报告类型）跨层传递，结构化克隆语义明确
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      // fail-open 降级路径的空 catch 是有意的（增强失败不阻断主流程），
      // 逐处注释说明 —— 允许带注释空块（见 no-empty 配置）
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 契约接口（CleanOperation.validate/undo、影子桩等）统一要求
      // Promise<T> 返回 —— 同步桩实现保留 async 是最诚实的契约对齐
      // 写法（替代品 Promise.resolve 包裹徒增噪音）。规则对此类
      // 接口实现是已知误报：
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // 测试文件：宽松一档 —— 桩与剧本需要表达力
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // 测试桩以 any 模拟外部依赖的最小形状 —— 类型代价换取剧本聚焦
      '@typescript-eslint/no-explicit-any': 'off',
      // 剧本常把 void 返回（如 hooks 数组）直接排布 —— 非缺陷
      '@typescript-eslint/no-confusing-void-expression': 'off',
      'no-console': 'off',
    },
  },
  {
    // peer 依赖桩：空类即契约（对齐 dsh-scope/llm/session 的导出形状），
    // 不承载行为 —— 允许空类
    files: ['tests/stubs/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowEmpty: true }],
    },
  },
  {
    // 独立 CLI（零依赖 CommonJS 脚本）：Node 全局内联声明（npm 树损坏
    // 无法安装 globals 包，实测仅 console/process/Buffer 被标记）；
    // 空 catch 是有意的 fail-open（体积统计/遍历不因单文件失败中断）
    files: ['cli/**/*.cjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },
)

# dsh-nuke-plugin

> DeepSeek Harness 的工业级 Nuke 环境清理引擎 — 策略分级 · 批量原子事务 · 指纹快照回滚 · 崩溃自恢复 · 审计不可篡改

[![Tests](https://img.shields.io/badge/tests-206%2F206-brightgreen)] [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)] [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

为 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 打造的环境清理插件：把"删除插件残留"这件危险的事，做成一套**可验证、可撤销、可审计**的事务系统。

## 为什么需要它

dsh 的一切皆插件 —— 但插件的装卸会在 `.dsh/`、Nuke 目录、系统 TEMP 等处留下残留。手工清理容易误删，脚本清理不可逆。本插件用数据库级的纪律来做这件事：

- **先预演，后执行**：每个动作自带 `validate / preview / execute / undo`
- **一切可回滚**：WAL 预写日志 + 备份区 + Saga 补偿，崩溃后 `nuke_recover` 自动恢复
- **绝不物理删除**：目录删除 = 原子改名进回收区，commit 后才允许 purge
- **日志不可篡改**：hash chain 审计日志，任何篡改可被 `verify()` 检出
- **并发安全**：跨进程读写锁（O_EXCL + bootToken + guard 目录互斥）

## 核心能力

| 子系统 | 说明 |
|---|---|
| 事务引擎 | ACID 批量清理，WAL 预写日志，崩溃自恢复，Saga 反向补偿 |
| 残留扫描 | 按文件类型/最后访问/目录层级加权评分，三级策略（safe/balanced/aggressive） |
| 依赖分析 | 解析 dsh/nuke 配置与模块 import 关系，构建依赖图，爆炸半径 what-if 仿真 |
| 硬链接去重 | 三级瀑布（size → 采样指纹 → SHA-256）定位重复，verify-then-link 原子替换 |
| 健康体检 | init/menu/插件路径/环境变量巡检，critical 失败自动阻断清理 |
| 趋势预测 | JSONL 快照 + Theil-Sen 稳健回归，磁盘写满天数预测 + 3σ̂ 异常检测 |
| 守卫巡检 | 一键 patrol：磁盘/趋势/健康/未终结事务 → 带建议告警 |
| 空间台账 | 双式记账，每字节回收可溯源，按动作/profile/日聚合 |

## 安全纪律（设计原则）

1. **fail-closed** — 校验器/健康检查失败时拒绝操作，绝不"查不到就放行"
2. **路径Containment** — 所有路径操作限制在授权目录内，txId 白名单防穿越注入
3. **TOCTOU 复验** — 分析与执行是两个时刻，执行前重验指纹（size + SHA-256）
4. **诚实记账** — bytesSaved 只计真正释放的空间（nlink>1 的替换不虚增）
5. **保护名单** — 白名单/回收上限/黑窗期作为 pre-hook veto，超限即拒绝

## 快速开始

```bash
# 安装到 dsh
dsh plugin add beijingwahw/dsh-nuke-plugin

# 预演（不做任何改动）
nuke_scan --profile web

# 执行清理（自动：健康检查 → 策略守卫 → 事务 → 审计）
nuke_clean --plugins <name> --dry_run true
nuke_clean --plugins <name>
```

## 开发

```bash
npm install
npm run build        # tsdown 构建
npm run typecheck    # tsc --noEmit（零错误）
npm test             # vitest（206 用例）
```

### 架构

```
src/
├── contracts/   # 接口层：先定义契约，再实现（Result 类型消灭异常控制流）
├── infra/       # 基建：WAL / 锁 / 备份区 / 审计链 / 台账 / 校验器
├── engine/      # 引擎：事务 / 扫描 / 评分 / 依赖 / 去重 / 趋势 / 守卫
└── operations/  # 命令模式：每个动作自带 validate/preview/execute/undo
```

## License

[MIT](./LICENSE) © 2026 beijingwahw

# dsh-nuke-plugin

> DeepSeek Harness 的工业级 Nuke 环境清理引擎 — 事务回滚 · 崩溃自恢复 · 审计链 · 硬链接去重 · 趋势预测

[![Release](https://img.shields.io/github/v/release/beijingwahw/dsh-nuke-plugin?color=blue&label=release)](https://github.com/beijingwahw/dsh-nuke-plugin/releases)
[![Tests](https://img.shields.io/badge/tests-206%2F206-brightgreen)](https://github.com/beijingwahw/dsh-nuke-plugin/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

把"删除插件并清理残留"这件危险的事，做成一套**可验证、可撤销、可审计**的事务系统。


## 为什么需要它

dsh 的一切皆插件 —— 但插件的装卸会在 `.dsh/`、Nuke 目录、系统 TEMP 等处留下残留。手工清理容易误删，脚本清理不可逆，出了事无从追溯。本插件用数据库级的纪律来做这件事：

| 痛点 | 解法 |
|---|---|
| 删错无法挽回 | 每个动作自带 `validate / preview / execute / undo`，目录删除 = 原子改名进回收区 |
| 清理途中崩溃 | WAL 预写日志 + 备份区，`nuke_recover` 重放并反向补偿 |
| 出事无从追责 | hash chain 审计日志，任何篡改可被 `nuke_verify` 检出 |
| 并发清理打架 | 跨进程读写锁（O_EXCL + bootToken 归属核验 + guard 目录互斥） |
| 不知道能删多少 | 四因子评分 + 趋势回归 + 磁盘写满预测，先预演后执行 |

## 安装

```bash
dsh plugin add beijingwahw/dsh-nuke-plugin --profile web
```

安装后直接对话即可，例如：

> 帮我扫描一下 web profile 的插件残留，先预演不要真删

## 安全纪律（设计原则）

1. **fail-closed** — 校验器/健康检查自身失败时同样拒绝操作，绝不"查不到就放行"
2. **路径 Containment** — 所有路径操作限制在授权目录内；txId 白名单 `[A-Za-z0-9_-]{1,64}` 防穿越注入
3. **TOCTOU 复验** — 分析与执行是两个时刻，执行前重验指纹（size + SHA-256 + mtime）
4. **诚实记账** — bytesSaved 只计真正释放的空间（nlink>1 的硬链接替换不虚增）
5. **保护名单 + 限额 + 黑窗** — 作为引擎 pre-hook veto，超限即拒绝（纵深防御，不依赖单层检查）
6. **回收区代替物理删除** — commit 后才允许 purge；restore 失败或存在孤儿产物时绝不 purge

## 工具速查（19 个）

所有工具注册为 dsh Agent 工具，安装后直接让 Agent 调用即可。

### 感知 — 先看清现状

| 工具 | 说明 |
|---|---|
| `nuke_list` | 列出 profile 下已安装的第三方插件 |
| `nuke_scan` | 残留扫描（配置引用/目录/TEMP），四因子评分 + 可回收空间统计；省略插件名进入全局模式 |
| `nuke_deps` | 依赖关系检测：谁引用了目标插件（删除前必查） |
| `nuke_orphans` | 全局孤儿扫描：node_modules 未声明包 / 无主附件 / TEMP 过期条目 |
| `nuke_health` | 健康检查：config/dependency/runtime/residue 四组，critical 失败自动阻断清理 |

### 决策 — 评估风险与收益

| 工具 | 说明 |
|---|---|
| `nuke_blastradius` | 爆炸半径沙盘推演（what-if，零副作用）：删除会损坏谁、可级联谁、风险几级 |
| `nuke_strategies` | 查看三级策略（safe / balanced / aggressive）的动作集 |
| `nuke_policy` | 查看守卫配置：保护名单 / 批量上限 / 回收上限 / 磁盘下限 / 时间黑窗 |
| `nuke_trend` | 历史趋势：字节/天变化率、30 天外推、3σ̂ 异常检测（失控写盘早期信号） |
| `nuke_forecast` | 磁盘写满预测：趋势 × 实时余量 → 倒计时与分级建议 |

### 执行 — 事务化清理

| 工具 | 说明 |
|---|---|
| `nuke_clean` | 事务化强力卸载：健康闸门 → 独占锁 → 计划 → 预演/提交；失败自动 Saga 回滚 |
| `nuke_dedup` | 内容寻址去重：三级瀑布（尺寸 → 采样指纹 → SHA-256）分析，`apply=true` 时硬链接实收 |
| `nuke_restorepoint` | 配置还原点：list / create / restore / prune |

### 恢复与审计 — 出事有退路

| 工具 | 说明 |
|---|---|
| `nuke_status` | 查询事务状态（活跃/已终结，含步骤明细与回收统计） |
| `nuke_recover` | 崩溃恢复：扫描未终结事务的 WAL，反向补偿恢复到执行前状态 |
| `nuke_verify` | 审计链完整性校验（hash chain 任何篡改均可定位） |

### 运维 — 日常保养

| 工具 | 说明 |
|---|---|
| `nuke_doctor` | 一键全科体检：健康 + 残留 + 孤儿 + 评分 → P1/P2/P3 优先级处方 |
| `nuke_guardian` | 守卫者巡检：磁盘倒计时 / 趋势异常 / 未终结事务 → 带建议的分级告警 |
| `nuke_ledger` | 空间台账：每字节回收可溯源，按动作/profile/日聚合，freed/pending 双轨 |

## 典型工作流

### 第一次清理（推荐路径）

```
1. nuke_scan                    # 看清残留与可回收空间
2. nuke_blastradius [插件]       # 零副作用推演：会不会误伤
3. nuke_clean --dry_run true    # 预演：只出计划，不动文件
4. nuke_clean                   # 执行：失败自动回滚，全程审计
```

### aggressive 策略（需要确认令牌）

```
nuke_clean --strategy aggressive \
           --confirmation_token "CONFIRM:web:<plugin-a>,<plugin-b>"
```

### 崩溃后恢复

```
1. nuke_status                  # 查看未终结事务
2. nuke_recover                 # WAL 重放 + 反向补偿
3. nuke_verify                  # 校验审计链完整性
```

### 日常保养

```
nuke_guardian                   # 一键巡检，输出带建议的告警
nuke_forecast                   # 磁盘还能撑几天
```

## 事务生命周期

```
nuke_clean
   │
   ├─ 健康检查闸门（critical 失败 → 拒绝；检查本身失败 → 同样拒绝）
   │
   ├─ begin: 独占锁 + 事务 ID + WAL 开档
   │
   ├─ plan: 依赖校验 / 令牌校验 / 策略守卫（保护名单/上限/黑窗 veto）
   │
   ├─ dry_run? ── 是 ── 输出计划明细 → rollback 释放（零副作用）
   │
   ├─ commit（每步均经 WAL）:
   │     step-intent → 备份/stage → 副作用 → 事后断言
   │        │ 成功 → 下一步
   │        │ 失败 → Saga 反向补偿（undo 逆序）→ rollback
   │
   └─ finalize: 摘要缓存 → 释放锁 → 审计入链（hash-linked）

崩溃窗口（任意时刻断电/被杀）:
   下次 nuke_recover → WAL 重放 → 备份区逆序 restore → 全部成功才 purge
   restore 有失败或孤儿产物 → 保留备份，保持"未终结"，等待人工/重试
```

## 架构

```
src/
├── contracts/   # 契约层：先定义接口再实现；Result 类型消灭异常控制流
├── infra/       # 基建：WAL / 读写锁 / 备份区 / hash-chain 审计 / 台账 / 校验器
├── engine/      # 引擎：事务 / 扫描 / 评分 / 依赖图 / 去重 / 趋势 / 守卫 / 还原点
├── operations/  # 命令模式：每个动作自带 validate/preview/execute/undo
└── index.ts     # 组装运行时（依赖注入）+ 注册 19 个工具
```

数据落盘位置：`<dshHome>/.nuke/`（wal/ backups/ audit/ ledger/ history/ policy.json restore-points/）

## 开发

```bash
git clone https://github.com/beijingwahw/dsh-nuke-plugin
cd dsh-nuke-plugin
npm install
npm run typecheck    # tsc --noEmit（零错误）
npm test             # vitest（206 用例 / 25 文件）
npm run build        # tsdown 构建
npm run dev          # 开发期热更新进程（见下）
```

### 热更新（HMR）

| 层 | 方法 | 生效范围 |
|---|---|---|
| 运行配置 | 编辑 dsh 用户层 `cordis.patch.yml`（`~/.dsh/profiles/<name>/` 或 `~/.dsh/`），保存即生效 | dsh 原生监视用户层，事务性重载该行（bundle 层默认值已全量列出，照抄整行覆盖即可） |
| 开发期代码 | `npm run dev` 起独立 cordis + HMR 进程 | 保存 `src/` 下任意文件或 `cordis.yml` → 旧实例卸载（effect 回卷）→ 新代码挂载，无需重启 |
| 安装产物 | 改代码 → `npm run build` → 重新 `dsh plugin add` → 重启 dsh | 更新已安装的插件 |

`npm run dev` 的组成：仓库根 `cordis.yml` 依次挂 logger / timer / hmr / 宿主桩 / 本插件（直接加载 `src/index.ts`）；
`dev/host-stubs.ts` 提供 dsh 宿主 `tools` 服务的最小桩（本插件 inject `['tools']`，缺桩会永远 PENDING）。

> 注意：开发 HMR 需 Node ≥ 24.11（24.1.0 等早期 24.x 的 Node 内部接口与 cordis-plugin-loader 1.0.2 不兼容，表现为编辑文件不触发重载）。

## FAQ

**Q: 清理会物理删除我的文件吗？**
目录删除是原子改名进备份区（`rename`，跨设备回退 copy），commit 后 purge 前可 `nuke_recover`。restore 未全部成功或存在孤儿产物时，引擎拒绝 purge —— 这些产物可能是数据唯一副本。

**Q: 去重的硬链接安全吗？**
verify-then-link：canonical 与 victim 执行前重算 SHA-256 复验；跨文件系统（st_dev 不同）、符号链接、mtime 变化的 canonical 一律跳过。替换是 `link→tmp→rename` 原子操作，无空窗；journal 记录每一步，可 `undo` 复制回独立文件。

**Q: 趋势预测为什么用 Theil-Sen 而不是最小二乘？**
最小二乘 breakdown point 为 0% —— 单个离群点（一次异常写盘）就能把斜率拉偏，污染写满倒计时。Theil-Sen（成对斜率中位数）breakdown point 29.3%，配合 MAD×1.4826 稳健 σ，近三分之一数据被污染时预测仍然正确。

**Q: 多个 dsh 实例同时清理会怎样？**
`nuke_clean` 持有跨进程独占锁（O_EXCL 原子获取 + bootToken 归属核验 + 固定名 guard 目录互斥），后到者等待或失败，绝不会交叉写。

## License

[MIT](./LICENSE) © 2026 beijingwahw

// src/operations/edit-ops.ts — 配置引用清理（workspace yaml / profile patch / home patch）
// 命令模式：preview 零副作用；execute 先 stageEdit 留快照再写新内容（fsync）；
// undo = BackupArea.restore（yaml-edit 记录含 originalContent，幂等）。
//
// V4 升级：幂等 skip 语义 —— 引用已不存在时 preview/execute 均标记 skipped
// （不报错、不产生空操作），上层可机器读出"这一步本来就无事可做"。
import * as fs from 'fs'
import * as path from 'path'

import type { AbsolutePath, PluginName, Result } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { PathPolicy } from '../contracts/paths'
import type {
  CleanOperation, ExecutedStep, OperationPlan, TxContext,
} from '../contracts/transaction'
import { existsSafe } from '../infra/fs-utils'

import { removePluginFromYaml } from './yaml-edit'


export interface EditOpSpec {
  readonly id: string
  readonly action: 'clean-workspace-yaml' | 'clean-profile-patch' | 'clean-home-patch'
  readonly target: PluginName
  /** 相对 dshHome 的文件定位函数 */
  fileOf(ctx: TxContext): string
  readonly description: string
  readonly policy: PathPolicy
}

export function makeConfigEditOp(spec: EditOpSpec): CleanOperation {
  return {
    id: `${spec.id}:${spec.target}`,
    action: spec.action,
    target: spec.target,

    async preview(ctx: TxContext): Promise<OperationPlan> {
      const file = spec.fileOf(ctx)
      if (!existsSafe(file)) {
        return {
          summary: `${spec.description}: 文件不存在，跳过（${file}）`,
          touchedPaths: [], estimatedBytesReclaimable: 0, requiresExclusiveLock: false,
          skipped: true,
        }
      }
      // 读取失败（EACCES/TOCTOU）直接抛出：plan()/dryRun() 均有逐 op 异常收敛，
      // 异常会被转成 Result 上报而不会逃逸出契约
      const content = fs.readFileSync(file, 'utf-8')
      const next = removePluginFromYaml(content, spec.target)
      const touched = next === null ? [] : [file as AbsolutePath]
      return {
        summary: next === null
          ? `${spec.description}: 未发现 ${spec.target} 的引用，跳过`
          : `${spec.description}: 摘除 ${spec.target} 引用（${content.length - next.length} 字符）`,
        touchedPaths: touched,
        estimatedBytesReclaimable: 0,   // 配置编辑不回收磁盘空间
        requiresExclusiveLock: false,
        // V5：涉及文件数（maxFilesPerTx 数据源；实际编辑的 YAML 恰为 1 个文件）
        ...(next === null ? { fileCount: 0 } : { fileCount: 1 }),
        // 幂等语义：引用已不存在 → 机器可读的 skipped 标记（不报错、不产生空操作）
        ...(next === null ? { skipped: true } : {}),
      }
    },

    async validate(ctx: TxContext): Promise<Result<void>> {
      // 路径策略先于存在性检查：即使文件不存在，越白名单的目标也必须拒绝（纵深防御）
      const file = spec.fileOf(ctx)
      const check = await ctx.resolver.assertDeletable(file, spec.policy)
      if (!check.ok) return check
      return ok(undefined)
    },

    async execute(ctx: TxContext): Promise<Result<ExecutedStep>> {
      const file = spec.fileOf(ctx)
      if (!existsSafe(file)) {
        return ok({
          outcome: { bytesFreed: 0, message: '文件不存在，跳过', skipped: true },
          backup: null,
        })
      }
      // 读盘纳入 err 收敛：execute 的 IO 失败走 Result 才能享受引擎的
      // 瞬态重试（EMFILE/EAGAIN 类）；裸抛会绕过重试直达回滚
      let content: string
      try {
        content = fs.readFileSync(file, 'utf-8')
      } catch (e) {
        return err(ioError(`${spec.description}: 读取配置失败`, e))
      }
      const next = removePluginFromYaml(content, spec.target)
      if (next === null) {
        return ok({
          outcome: { bytesFreed: 0, message: '未发现引用，跳过', skipped: true },
          backup: null,
        })
      }
      try {
        const backup = await ctx.backups.stageEdit(file as AbsolutePath, next)
        return ok({
          outcome: { bytesFreed: 0, message: `${spec.description}: 已摘除 ${spec.target} 引用` },
          backup,
        })
      } catch (e) {
        return err(ioError(`${spec.description} 失败`, e))
      }
    },

    async undo(ctx: TxContext, record): Promise<Result<void>> {
      if (!record) return ok(undefined)
      return ctx.backups.restore(record)
    },
  }
}

/** 三个配置清理操作的标准策略 */
export function configPolicies(profile: string): {
  profileScoped: PathPolicy
  homePatch: PathPolicy
} {
  const deny = ['**/@deepseek-ai/dsh-base*', '**/.nuke/**']
  return {
    profileScoped: {
      allowedRoots: [{ kind: 'profile-dir', profile }],
      denyGlobs: deny, strictWindows: true,
    },
    homePatch: {
      allowedRoots: [{ kind: 'dsh-home-patch' }],
      denyGlobs: deny, strictWindows: true,
    },
  }
}

/** 便捷构造：单插件的三个配置编辑操作 */
export function configEditOps(
  target: PluginName, profile: string, dshHomeOf: (ctx: TxContext) => string,
): CleanOperation[] {
  const p = configPolicies(profile)
  return [
    makeConfigEditOp({
      id: 'op-clean-workspace-yaml', action: 'clean-workspace-yaml', target,
      fileOf: ctx => path.join(dshHomeOf(ctx), 'profiles', profile, 'pnpm-workspace.yaml'),
      description: '清理 pnpm-workspace.yaml', policy: p.profileScoped,
    }),
    makeConfigEditOp({
      id: 'op-clean-profile-patch', action: 'clean-profile-patch', target,
      fileOf: ctx => path.join(dshHomeOf(ctx), 'profiles', profile, 'cordis.patch.yml'),
      description: '清理 profile patch', policy: p.profileScoped,
    }),
    makeConfigEditOp({
      id: 'op-clean-home-patch', action: 'clean-home-patch', target,
      fileOf: ctx => path.join(dshHomeOf(ctx), 'cordis.patch.yml'),
      description: '清理 home patch', policy: p.homePatch,
    }),
  ]
}

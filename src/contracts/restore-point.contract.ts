// contracts/restore-point.contract.ts — 配置还原点
// 清理事务已有一级保护（op 级备份 + Saga 回滚），本模块是二级保护：
// 在任何清理动作之前，把关键配置文件（package.json / workspace yaml /
// patch yml / lockfile）快照到独立时间线。事务备份随事务 prune，
// 还原点独立留存 —— 即使事务记录被清理，配置仍可一键恢复到任意时点。
// 非侵入式：作为适配层前置动作调用，不侵入事务引擎内核。

import type { AbsolutePath, ProfileName, Result } from './base'

export interface RestorePointFile {
  /** 原始位置（恢复目标） */
  readonly source: AbsolutePath
  /** 快照存储位置 */
  readonly snapshot: AbsolutePath
  readonly bytes: number
}

export interface RestorePointMeta {
  /** rp-<timestamp>-<rand> */
  readonly id: string
  readonly createdAt: string
  readonly actor: string
  /** 创建动机，如 "pre-clean:balanced" / "manual" */
  readonly reason: string
  readonly profile: ProfileName
  readonly files: readonly RestorePointFile[]
}

export interface IRestorePointManager {
  /** 快照当前全部存在的关键配置；一个文件都没有 → E_VALIDATION（profile 不存在？） */
  create(input: {
    readonly actor: string
    readonly reason: string
    readonly profile: ProfileName
  }): Promise<Result<RestorePointMeta>>

  /** 全部还原点，createdAt 降序（最新在前） */
  list(): readonly RestorePointMeta[]

  /** 把快照内容原子写回原位置（逐文件 tmp+rename） */
  restore(id: string): Promise<Result<RestorePointMeta>>

  /** 只保留最近 keep 个，返回删除数 */
  prune(keep: number): Promise<Result<number>>
}

// contracts/health.contract.ts — 子系统三：系统健康检查
// 现有 health.ts 的升级：检查项从 5 项扩展为分层检查计划，
// 支持 critical 阻断（critical 失败 → 拒绝进入清理事务）。

import type { ProfileName, Result } from './base'

export interface HealthCheckResult {
  readonly check: string
  readonly passed: boolean
  readonly message: string
  readonly severity: 'info' | 'warning' | 'critical'
  /** 分组：配置/依赖/运行时/残留（UI 分区展示） */
  readonly group: 'config' | 'dependency' | 'runtime' | 'residue'
  readonly fix?: string   // 建议修复动作（人类可读）
}

export interface HealthReport {
  readonly profile: ProfileName
  readonly checkedAt: string
  readonly results: readonly HealthCheckResult[]
  /** 存在 critical 且 passed=false → 引擎拒绝开启清理事务 */
  readonly blocking: boolean
  readonly score: number   // 0-100 健康度（UI 仪表盘）
}

export interface IHealthInspector {
  /**
   * 检查计划：
   *  config    — package.json / pnpm-workspace.yaml / cordis.patch.yml 语法与一致性
   *  dependency— pnpm lockfile 一致性、bundles↔deps 对齐
   *  runtime   — dsh CLI 可用性、pnpm 可用性、锁残留、WAL 未完成事务
   *  residue   — 孤儿 bundle、膨胀的 storages/attachments 概要
   */
  inspect(profile: ProfileName): Promise<Result<HealthReport>>
}

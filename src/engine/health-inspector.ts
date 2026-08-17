// src/engine/health-inspector.ts — IHealthInspector 实现：分层健康检查
// 四组检查：config / dependency / runtime / residue
// critical 失败 → blocking=true → 事务引擎拒绝开启清理。
// 运行时命令（dsh/pnpm 探测）通过 runCommand 注入，单测零外部依赖。
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { parse as parseYaml } from 'yaml'
import type { NukeError, ProfileName, Result } from '../contracts/base'
import { err, errorToMessage, ioError, ok } from '../contracts/base'
import type {
  HealthCheckResult, HealthReport, IHealthInspector,
} from '../contracts/health.contract'

export interface HealthInspectorOptions {
  readonly dshHome: string
  /** 命令探测注入点：默认 spawnSync；测试注入桩实现 */
  readonly runCommand?: (cmd: string, args: readonly string[], opts: { cwd: string; timeoutMs: number }) =>
    { status: number | null; stdout: string; stderr: string }
  readonly walUnfinished?: () => readonly string[]
  readonly now?: () => Date
}

const SEVERITY_WEIGHT: Record<HealthCheckResult['severity'], number> = {
  info: 1, warning: 2, critical: 4,
}

export function createHealthInspector(options: HealthInspectorOptions): IHealthInspector {
  const now = options.now ?? (() => new Date())
  // spawnSync 失败时 stdout/stderr 可能为 null —— 归一化为 string（与 exec-ops 同纪律）
  const runCommand = options.runCommand ?? ((cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf-8', timeout: opts.timeoutMs })
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  })

  const R = (
    check: string, passed: boolean, message: string,
    severity: HealthCheckResult['severity'], group: HealthCheckResult['group'], fix?: string,
  ): HealthCheckResult => ({ check, passed, message, severity, group, ...(fix ? { fix } : {}) })

  // ─── config 组 ───────────────────────────────────────────
  function checkConfig(profile: string, out: HealthCheckResult[]): void {
    const profileDir = path.join(options.dshHome, 'profiles', profile)

    // 1. package.json 语法
    const pkgPath = path.join(profileDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        out.push(R('package.json 语法', true, 'JSON 格式正确', 'info', 'config'))
        // 2. bundles ↔ dependencies 对齐
        const bundles: string[] = pkg?.dsh?.profile?.bundles ?? []
        const deps = new Set(Object.keys(pkg?.dependencies ?? {}))
        const orphans = bundles.filter(b => !deps.has(b) && b !== '@deepseek-ai/dsh-base')
        if (orphans.length === 0) {
          out.push(R('bundles 一致性', true, '所有 bundle 均有对应依赖', 'info', 'config'))
        } else {
          out.push(R('bundles 一致性', false, `孤立 bundle: ${orphans.join(', ')}`, 'warning', 'config',
            '将孤立 bundle 加入 dependencies 或从 bundles 中移除'))
        }
      } catch (e) {
        out.push(R('package.json 语法', false, `JSON 解析失败: ${errorToMessage(e)}`, 'critical', 'config',
          '修复 JSON 语法；可从备份区恢复上一版本'))
      }
    } else {
      out.push(R('package.json 存在性', false, `profile "${profile}" 不存在或缺少 package.json`, 'critical', 'config'))
    }

    // 3. pnpm-workspace.yaml 语法
    const wsPath = path.join(profileDir, 'pnpm-workspace.yaml')
    if (fs.existsSync(wsPath)) {
      try {
        parseYaml(fs.readFileSync(wsPath, 'utf-8'))
        out.push(R('pnpm-workspace.yaml 语法', true, 'YAML 格式正确', 'info', 'config'))
      } catch (e) {
        out.push(R('pnpm-workspace.yaml 语法', false, `YAML 解析失败: ${errorToMessage(e)}`, 'critical', 'config'))
      }
    }

    // 4. cordis.patch.yml（profile 级 + home 级）
    for (const [label, pf] of [
      ['cordis.patch.yml (profile)', path.join(profileDir, 'cordis.patch.yml')],
      ['cordis.patch.yml (home)', path.join(options.dshHome, 'cordis.patch.yml')],
    ] as const) {
      if (!fs.existsSync(pf)) continue
      try {
        parseYaml(fs.readFileSync(pf, 'utf-8'))
        out.push(R(`${label} 语法`, true, 'YAML 格式正确', 'info', 'config'))
      } catch (e) {
        out.push(R(`${label} 语法`, false, `YAML 解析失败: ${errorToMessage(e)}`, 'critical', 'config'))
      }
    }
  }

  // ─── dependency 组 ──────────────────────────────────────
  function checkDependency(profile: string, out: HealthCheckResult[]): void {
    const profileDir = path.join(options.dshHome, 'profiles', profile)

    // lockfile 新鲜度：package.json 比 lockfile 新 → 可能 drift（不 spawn pnpm，保持检查零副作用）
    const pkgPath = path.join(profileDir, 'package.json')
    const lockPath = path.join(profileDir, 'pnpm-lock.yaml')
    if (fs.existsSync(pkgPath) && fs.existsSync(lockPath)) {
      const pkgMtime = fs.statSync(pkgPath).mtimeMs
      const lockMtime = fs.statSync(lockPath).mtimeMs
      if (pkgMtime > lockMtime) {
        out.push(R('lockfile 新鲜度', false,
          'package.json 比 pnpm-lock.yaml 更新，依赖可能漂移', 'warning', 'dependency',
          '在 profile 目录执行 pnpm install 刷新 lockfile'))
      } else {
        out.push(R('lockfile 新鲜度', true, 'lockfile 不早于 package.json', 'info', 'dependency'))
      }
    }

    // node_modules 完整性：声明的依赖都有目录
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const deps = Object.keys(pkg?.dependencies ?? {})
      const nm = path.join(profileDir, 'node_modules')
      const missing = deps.filter(d =>
        !fs.existsSync(path.join(nm, ...d.split('/'))) && d !== '@deepseek-ai/dsh-base')
      if (missing.length > 0) {
        out.push(R('依赖安装完整性', false, `缺失 node_modules 条目: ${missing.join(', ')}`, 'warning', 'dependency',
          '执行 pnpm install 补齐'))
      } else {
        out.push(R('依赖安装完整性', true, '声明的依赖均已安装', 'info', 'dependency'))
      }
    } catch {}
  }

  // ─── runtime 组 ─────────────────────────────────────────
  function checkRuntime(out: HealthCheckResult[]): void {
    const dsh = runCommand('dsh', ['--version'], { cwd: options.dshHome, timeoutMs: 5000 })
    if (dsh.status === 0) {
      out.push(R('dsh CLI', true, `版本: ${dsh.stdout.trim().slice(0, 60)}`, 'info', 'runtime'))
    } else {
      out.push(R('dsh CLI', false, 'dsh 命令不可用（不在 PATH 或执行失败）', 'critical', 'runtime',
        '确认 dsh 已安装且在 PATH 中；standard-remove 步骤将不可用'))
    }

    const pnpm = runCommand('pnpm', ['--version'], { cwd: options.dshHome, timeoutMs: 5000 })
    if (pnpm.status === 0) {
      out.push(R('pnpm CLI', true, `版本: ${pnpm.stdout.trim().slice(0, 60)}`, 'info', 'runtime'))
    } else {
      out.push(R('pnpm CLI', false, 'pnpm 命令不可用', 'warning', 'runtime', '安装 pnpm: npm i -g pnpm'))
    }

    // 锁残留
    const lockPath = path.join(options.dshHome, '.nuke', 'nuke.lock')
    if (fs.existsSync(lockPath)) {
      out.push(R('nuke 锁残留', false, `发现锁文件 ${lockPath}，可能存在并发清理或上次异常退出`, 'warning', 'runtime',
        '确认无清理进行后由管理员破锁'))
    } else {
      out.push(R('nuke 锁残留', true, '无锁残留', 'info', 'runtime'))
    }

    // WAL 未完成事务
    const unfinished = options.walUnfinished?.() ?? []
    if (unfinished.length > 0) {
      out.push(R('WAL 未完成事务', false, `${unfinished.length} 个未终结事务: ${unfinished.join(', ')}`, 'warning', 'runtime',
        '先执行 nuke recover 完成崩溃恢复'))
    } else {
      out.push(R('WAL 未完成事务', true, '无未终结事务', 'info', 'runtime'))
    }
  }

  // ─── residue 组 ─────────────────────────────────────────
  function checkResidue(out: HealthCheckResult[]): void {
    let orphanStorages = 0
    let orphanBytes = 0
    const storages = path.join(options.dshHome, 'storages')
    try {
      for (const e of fs.readdirSync(storages, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        let total = 0
        const d = path.join(storages, e.name)
        try { for (const f of fs.readdirSync(d)) { try { total += fs.statSync(path.join(d, f)).size } catch {} } } catch {}
        if (total > 50 * 1024 * 1024) { orphanStorages++; orphanBytes += total }
      }
    } catch {}
    if (orphanStorages > 0) {
      out.push(R('storages 膨胀', false,
        `${orphanStorages} 个插件存储超过 50MB（共 ${(orphanBytes / 1024 / 1024).toFixed(0)}MB）`,
        'info', 'residue', '运行 nuke scan 评估可回收空间'))
    } else {
      out.push(R('storages 膨胀', true, '无超 50MB 的插件存储', 'info', 'residue'))
    }
  }

  const inspector: IHealthInspector = {
    async inspect(profile: ProfileName): Promise<Result<HealthReport, NukeError>> {
      try {
        const results: HealthCheckResult[] = []
        checkConfig(profile, results)
        checkDependency(profile, results)
        checkRuntime(results)
        checkResidue(results)

        const blocking = results.some(r => r.severity === 'critical' && !r.passed)
        const weightTotal = results.reduce((s, r) => s + SEVERITY_WEIGHT[r.severity], 0)
        const weightGot = results.reduce((s, r) => s + (r.passed ? SEVERITY_WEIGHT[r.severity] : 0), 0)
        const score = weightTotal === 0 ? 100 : Math.round((100 * weightGot) / weightTotal)

        return ok({
          profile,
          checkedAt: now().toISOString(),
          results,
          blocking,
          score,
        })
      } catch (e) {
        return err(ioError('健康检查失败', e))
      }
    },
  }
  return inspector
}

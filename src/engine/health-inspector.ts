// src/engine/health-inspector.ts — IHealthInspector 实现：分层健康检查
// 四组检查：config / dependency / runtime / residue
// critical 失败 → blocking=true → 事务引擎拒绝开启清理。
// 运行时命令（dsh/pnpm 探测）通过 runCommand 注入，单测零外部依赖。
// V5：
//   1. 检查组并行执行（forEachPool 有界并发，全异步 IO），
//      结果按固定组序拼接 —— 输出与旧串行实现逐条一致（稳定序）。
//   2. 新增可选检查项：磁盘 inode 压力（statfs 探测；探测不到时标记
//      skipped 而非 failed —— fail-closed 不适用于"探测不到"）。
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

import { parse as parseYaml } from 'yaml'

import type { ProfileName, Result } from '../contracts/base'
import { err, errorToMessage, ioError, ok } from '../contracts/base'
import type {
  HealthCheckResult, HealthReport, IHealthInspector,
} from '../contracts/health.contract'
import type { IToolRegistry } from '../contracts/tool.contract'
import { DEFAULT_IO_CONCURRENCY, forEachPool } from '../infra/fs-utils'
import { createToolRegistry } from '../infra/tool-registry'

/** 命令探测的统一返回形态 */
interface CommandProbe {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** V5.1：spawn 层错误码（'ENOENT' = 命令未找到）；缺省 = 进程已执行。
   *  真实 spawnSync 在二进制缺失时 status=null 且 error.code='ENOENT'；
   *  "status 非 null" 意味着二进制确实执行了（退出码可能非 0）。
   *  旧桩用 status=127 模拟"命令不存在"是语义错误 —— 127 是 shell 的
   *  not-found 码，spawnSync（无 shell）不会产生它。 */
  readonly errorCode?: string
}

export interface HealthInspectorOptions {
  readonly dshHome: string
  /** 命令探测注入点：默认 spawnSync；测试注入桩实现（V5 起允许返回 Promise，
   *  异步桩可与并行检查组真实并发）。 */
  readonly runCommand?: (cmd: string, args: readonly string[], opts: { cwd: string; timeoutMs: number }) =>
    CommandProbe | Promise<CommandProbe>
  /** V5.1：命令解析注入点（PATH 救援探测）；缺省 = bin-resolver 真实实现，测试可注入 */
  readonly resolveCommand?: (cmd: string) => { readonly path: string; readonly dir: string } | null
  /** V5.2：共享工具注册表（解析单一事实源；缺省 = 用 runCommand/resolveCommand 组装私有注册表） */
  readonly toolRegistry?: IToolRegistry
  readonly walUnfinished?: () => readonly string[]
  readonly now?: () => Date
}

/** V5：检查结果的扩展形态 —— skipped 标记"探测不到"（既非失败也非通过）。
 *  该结果 passed=true、severity=info，不参与阻断与扣分；fail-closed 纪律
 *  针对"检查失败"，而"探测不到"是能力缺失，按跳过降级而非误报。 */
export type HealthCheckResultV5 = HealthCheckResult & {
  readonly skipped?: boolean
}

/** V5：报告形态（results 元素附带可选 skipped 标记，向后兼容） */
export type HealthReportV5 = Omit<HealthReport, 'results'> & {
  readonly results: readonly HealthCheckResultV5[]
}

const SEVERITY_WEIGHT: Record<HealthCheckResult['severity'], number> = {
  info: 1, warning: 2, critical: 4,
}

/** inode 余量告警阈值：可用 inode 占比低于 10% 视为压力（运维惯例阈值） */
const INODE_FREE_WARN_RATIO = 0.1

/** JSON 值的安全对象视图：null / 非对象 → null（窄化辅助，不改变运行时取值） */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : null
}

export function createHealthInspector(options: HealthInspectorOptions): IHealthInspector {
  const now = options.now ?? (() => new Date())
  // spawnSync 失败时 stdout/stderr 可能为 null —— 归一化为 string（与 exec-ops 同纪律）
  const runCommand = options.runCommand ?? ((cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf-8', timeout: opts.timeoutMs })
    return {
      status: r.status,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 防御性：外部输入（spawnSync 失败路径 stdout 运行时可能为 null，类型标注未覆盖）
      stdout: r.stdout ?? '',
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 防御性：外部输入（spawnSync 失败路径 stderr 运行时可能为 null，类型标注未覆盖）
      stderr: r.stderr ?? '',
      // V5.1：spawn 层错误码透传（ENOENT 判定的依据）
      ...(typeof (r.error as unknown as { code?: unknown } | null | undefined)?.code === 'string'
        ? { errorCode: (r.error as unknown as { code: string }).code }
        : {}),
    }
  })

  const R = (
    check: string, passed: boolean, message: string,
    severity: HealthCheckResult['severity'], group: HealthCheckResult['group'], fix?: string,
  ): HealthCheckResultV5 => ({ check, passed, message, severity, group, ...(fix ? { fix } : {}) })

  // ─── config 组 ───────────────────────────────────────────
  async function checkConfig(profile: string): Promise<HealthCheckResultV5[]> {
    const out: HealthCheckResultV5[] = []
    const profileDir = path.join(options.dshHome, 'profiles', profile)

    // 1. package.json 语法
    const pkgPath = path.join(profileDir, 'package.json')
    let pkgText: string | null = null
    try { pkgText = await fsp.readFile(pkgPath, 'utf-8') } catch { /* 不存在 */ }
    if (pkgText !== null) {
      try {
        const pkg = asRecord(JSON.parse(pkgText) as unknown)
        out.push(R('package.json 语法', true, 'JSON 格式正确', 'info', 'config'))
        // 2. bundles ↔ dependencies 对齐
        const bundlesRaw = asRecord(asRecord(pkg?.dsh)?.profile)?.bundles
        const bundles: string[] = Array.isArray(bundlesRaw) ? bundlesRaw as string[] : []
        const deps = new Set(Object.keys(asRecord(pkg?.dependencies) ?? {}))
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
    let wsText: string | null = null
    try { wsText = await fsp.readFile(wsPath, 'utf-8') } catch { /* 不存在 */ }
    if (wsText !== null) {
      try {
        parseYaml(wsText)
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
      let text: string
      try { text = await fsp.readFile(pf, 'utf-8') } catch { continue }
      try {
        parseYaml(text)
        out.push(R(`${label} 语法`, true, 'YAML 格式正确', 'info', 'config'))
      } catch (e) {
        out.push(R(`${label} 语法`, false, `YAML 解析失败: ${errorToMessage(e)}`, 'critical', 'config'))
      }
    }
    return out
  }

  // ─── dependency 组 ──────────────────────────────────────
  async function checkDependency(profile: string): Promise<HealthCheckResultV5[]> {
    const out: HealthCheckResultV5[] = []
    const profileDir = path.join(options.dshHome, 'profiles', profile)

    // lockfile 新鲜度：package.json 比 lockfile 新 → 可能 drift（不 spawn pnpm，保持检查零副作用）
    const pkgPath = path.join(profileDir, 'package.json')
    const lockPath = path.join(profileDir, 'pnpm-lock.yaml')
    const [pkgSt, lockSt] = await Promise.all([
      fsp.stat(pkgPath).then(s => s.mtimeMs, () => null),
      fsp.stat(lockPath).then(s => s.mtimeMs, () => null),
    ])
    if (pkgSt !== null && lockSt !== null) {
      if (pkgSt > lockSt) {
        out.push(R('lockfile 新鲜度', false,
          'package.json 比 pnpm-lock.yaml 更新，依赖可能漂移', 'warning', 'dependency',
          '在 profile 目录执行 pnpm install 刷新 lockfile'))
      } else {
        out.push(R('lockfile 新鲜度', true, 'lockfile 不早于 package.json', 'info', 'dependency'))
      }
    }

    // node_modules 完整性：声明的依赖都有目录
    try {
      const pkg = asRecord(JSON.parse(await fsp.readFile(pkgPath, 'utf-8')) as unknown)
      const deps = Object.keys(asRecord(pkg?.dependencies) ?? {})
      const nm = path.join(profileDir, 'node_modules')
      const missing: string[] = []
      for (const d of deps) {
        if (d === '@deepseek-ai/dsh-base') continue
        try { await fsp.access(path.join(nm, ...d.split('/'))) } catch { missing.push(d) }
      }
      if (missing.length > 0) {
        out.push(R('依赖安装完整性', false, `缺失 node_modules 条目: ${missing.join(', ')}`, 'warning', 'dependency',
          '执行 pnpm install 补齐'))
      } else {
        out.push(R('依赖安装完整性', true, '声明的依赖均已安装', 'info', 'dependency'))
      }
    } catch {}
    return out
  }

  // ─── runtime 组 ─────────────────────────────────────────
  /** V5：磁盘 inode 压力检查（statfs 探测）。
   *  探测不到（API 缺失 / 路径不存在 / 无权限 / 文件系统不报告 inode）
   *  → skipped 而非 failed："探测不到"是能力缺失而非健康问题。 */
  function checkInodePressure(): HealthCheckResultV5 {
    let st: ReturnType<typeof fs.statfsSync> | null = null
    try { st = fs.statfsSync(options.dshHome) } catch { /* 探测不到 → st 保持 null，按 skipped 降级 */ }
    const total = st === null ? NaN : st.files
    const free = st === null ? NaN : st.ffree
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
      return {
        check: '磁盘 inode 压力', passed: true,
        message: 'statfs 不可用或文件系统不报告 inode 用量，已跳过本项检查',
        severity: 'info', group: 'runtime', skipped: true,
      }
    }
    const ratio = free / total
    if (ratio < INODE_FREE_WARN_RATIO) {
      return R('磁盘 inode 压力', false,
        `inode 余量 ${(ratio * 100).toFixed(1)}%（free ${free}/${total}），接近耗尽`,
        'warning', 'runtime', '清理小文件密集目录（node_modules/.pnpm、缓存、TEMP），释放 inode')
    }
    return R('磁盘 inode 压力', true,
      `inode 余量充足（${(ratio * 100).toFixed(1)}%，free ${free}/${total}）`, 'info', 'runtime')
  }

  /** V5.2：CLI 探测委托工具注册表（单一事实源）—— 三段式语义
   *  （显式 env → PATH → 全局 bin 救援；旗标差异不误报；missing 仅 warning
   *  并携带能力映射的修复建议）全部收敛在注册表内，此处只做结果渲染 */
  const toolRegistry: IToolRegistry = options.toolRegistry ?? createToolRegistry({
    probe: (cmdOrPath: string) =>
      runCommand(cmdOrPath, ['--version'], { cwd: options.dshHome, timeoutMs: 5000 }),
    // 注意：注入解析器"返回 null"就是它的判定结果，不能穿透到默认解析器
    ...(options.resolveCommand ? { resolveCommand: options.resolveCommand } : {}),
  })

  async function probeCli(label: string, tool: string): Promise<HealthCheckResultV5> {
    const res = await toolRegistry.resolve(tool)
    if (res.status === 'missing') {
      // 能力降级而非全局阻断：残留清理/事务回滚不依赖外部 CLI
      return R(label, false, res.detail, 'warning', 'runtime', res.fixHint)
    }
    return R(label, true, res.detail, 'info', 'runtime')
  }

  async function checkRuntime(): Promise<HealthCheckResultV5[]> {
    const out: HealthCheckResultV5[] = []
    // V5.2：CLI 探测统一委托注册表（防两类误报：宿主 PATH 环境差异 / 旗标行为差异）
    out.push(await probeCli('dsh CLI', 'dsh'))
    out.push(await probeCli('pnpm CLI', 'pnpm'))

    // 锁残留（V5.1 修正路径）：V4/V5 锁协议写 .nuke/locks/<scope>.lock；
    // 旧检查只看 V3 死路径 .nuke/nuke.lock，真实锁残留永远漏检。
    const staleLocks: string[] = []
    try {
      for (const f of await fsp.readdir(path.join(options.dshHome, '.nuke', 'locks'))) {
        if (f.endsWith('.lock')) staleLocks.push(f)
      }
    } catch { /* 锁目录不存在 = 无残留 */ }
    // V3 遗留锁（CLI 旧版写 DSH_HOME/.nuke.lock）一并纳入
    try {
      await fsp.access(path.join(options.dshHome, '.nuke.lock'))
      staleLocks.push('.nuke.lock')
    } catch { /* 无遗留锁 */ }
    if (staleLocks.length > 0) {
      out.push(R('nuke 锁残留', false,
        `发现 ${staleLocks.length} 个锁文件: ${staleLocks.join(', ')}（可能存在并发清理或上次异常退出）`,
        'warning', 'runtime', '确认无清理进行后由管理员破锁（锁文件含 owner/TTL，破锁纪律见 lock-manager）'))
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

    // V5：磁盘 inode 压力（探测不到 → skipped）
    out.push(checkInodePressure())
    return out
  }

  // ─── residue 组 ─────────────────────────────────────────
  async function checkResidue(): Promise<HealthCheckResultV5[]> {
    const out: HealthCheckResultV5[] = []
    let orphanStorages = 0
    let orphanBytes = 0
    const storages = path.join(options.dshHome, 'storages')
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(storages, { withFileTypes: true }) } catch { entries = [] }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      let total = 0
      const d = path.join(storages, e.name)
      try {
        for (const f of await fsp.readdir(d)) {
          try { total += (await fsp.stat(path.join(d, f))).size } catch {}
        }
      } catch {}
      if (total > 50 * 1024 * 1024) { orphanStorages++; orphanBytes += total }
    }
    if (orphanStorages > 0) {
      out.push(R('storages 膨胀', false,
        `${orphanStorages} 个插件存储超过 50MB（共 ${(orphanBytes / 1024 / 1024).toFixed(0)}MB）`,
        'info', 'residue', '运行 nuke scan 评估可回收空间'))
    } else {
      out.push(R('storages 膨胀', true, '无超 50MB 的插件存储', 'info', 'residue'))
    }
    return out
  }

  const inspector: IHealthInspector = {
    async inspect(profile: ProfileName): Promise<Result<HealthReport>> {
      try {
        // V5：检查组并行执行（有界并发池）。四组互不依赖，各自的 fs/命令
        // 探测可重叠等待；拼接严格按固定组序 → 输出与旧串行实现逐条一致。
        const groups: (() => Promise<HealthCheckResultV5[]>)[] = [
          () => checkConfig(profile),
          () => checkDependency(profile),
          () => checkRuntime(),
          () => checkResidue(),
        ]
        const settled = await forEachPool(groups, DEFAULT_IO_CONCURRENCY, g => g())
        const results: HealthCheckResultV5[] = []
        for (const r of settled) {
          if (r.status === 'fulfilled') results.push(...r.value)
        }

        const blocking = results.some(r => r.severity === 'critical' && !r.passed)
        const weightTotal = results.reduce((s, r) => s + SEVERITY_WEIGHT[r.severity], 0)
        const weightGot = results.reduce((s, r) => s + (r.passed ? SEVERITY_WEIGHT[r.severity] : 0), 0)
        const score = weightTotal === 0 ? 100 : Math.round((100 * weightGot) / weightTotal)

        const report: HealthReportV5 = {
          profile,
          checkedAt: now().toISOString(),
          results,
          blocking,
          score,
        }
        return ok(report)
      } catch (e) {
        return err(ioError('健康检查失败', e))
      }
    },
  }
  return inspector
}

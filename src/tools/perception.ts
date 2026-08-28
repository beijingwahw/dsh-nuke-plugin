// src/tools/perception.ts — 感知域工具（环境里有什么、脏在哪）
// nuke_list / nuke_scan / nuke_deps / nuke_orphans / nuke_health
import * as fs from 'fs'
import * as path from 'path'

import type { Context } from '@deepseek-ai/cordis'

import { fmtBytes } from '../contracts/base'
import type { PluginName, ProfileName } from '../contracts/base'
import type { ResidualEvidence } from '../contracts/scoring'
import type { Runtime } from '../runtime'

import { BAND_ICON, checkPlugins, checkProfile, defineTextTool } from './shared'

export function registerPerceptionTools(ctx: Context, rt: Runtime): void {
  // ── nuke_list ────────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_list',
    description: '列出指定 profile 下所有已安装的第三方插件',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(rt, profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const pkgPath = path.join(rt.resolver.profileDir(cp.profile), 'package.json')
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        const asRecord = (v: unknown): Record<string, unknown> | null =>
          (v !== null && typeof v === 'object') ? v as Record<string, unknown> : null
        const rawBundles = asRecord(asRecord(asRecord(parsed)?.dsh)?.profile)?.bundles
        const bundles: string[] = Array.isArray(rawBundles)
          ? rawBundles.filter((b): b is string => typeof b === 'string' && !b.startsWith('@deepseek-ai/dsh-'))
          : []
        if (bundles.length === 0) return { content: `profile "${cp.profile}" 下没有第三方插件。` }
        return { content: `profile "${cp.profile}" 已安装 ${bundles.length} 个第三方插件：\n${bundles.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}` }
      } catch {
        return { content: `❌ 无法读取 ${pkgPath}（profile 不存在？）` }
      }
    },
  }))

  // ── nuke_scan ────────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_scan',
    description: '扫描插件残留（配置引用/目录/TEMP），带五因子严重程度评分与可回收空间统计。省略 plugin_name 进入全局模式',
    parameters: {
      plugin_name: { type: 'string', description: '插件名（省略 = 全 profile 全插件全局扫描）' },
      profile: { type: 'string', description: '默认 "web"' },
      include_temp: { type: 'boolean', description: '是否扫描 TEMP（仅 aggressive 生效），默认 false' },
    },
    execute: async ({ plugin_name, profile = 'web', include_temp = false }) => {
      const cp = checkProfile(rt, profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      // 领域校验：npm 包名规范（DSL 只保证 string 类型，保证不了格式）
      let plugin: PluginName | undefined
      if (plugin_name !== undefined) {
        const cn = rt.validator.validatePluginName(plugin_name)
        if (!cn.ok) return { content: `❌ 插件名非法: ${cn.error.map(v => v.detail).join('; ')}` }
        plugin = plugin_name as PluginName
      }
      const evidences: ResidualEvidence[] = []
      let bytesReclaimable = 0
      for await (const ev of rt.scanner.scan({
        ...(plugin !== undefined ? { plugin } : {}),
        profile: cp.profile,
        strategy: include_temp ? 'aggressive' : 'safe',
        includeTemp: include_temp,
      })) {
        if (ev.type === 'found') { evidences.push(ev.evidence); bytesReclaimable += ev.evidence.sizeBytes }
      }
      if (evidences.length === 0) {
        await rt.trend.record({
          at: new Date().toISOString(), trigger: 'scan', profile: cp.profile,
          bytesReclaimable: 0, bytesFreed: 0, residualCount: 0, healthScore: -1,
        })
        return { content: `✅ ${plugin_name ?? '全局扫描'} 无残留。` }
      }
      const ranked = rt.scorer.rank(evidences)
      await rt.trend.record({
        at: new Date().toISOString(), trigger: 'scan', profile: cp.profile,
        bytesReclaimable, bytesFreed: 0,
        residualCount: evidences.length, healthScore: -1,
      })
      const lines = ranked.map((e, i) =>
        `  ${i + 1}. ${BAND_ICON[e.score.band]} [${e.score.total}分/${e.score.band}] ${e.description}\n` +
        `     📍 ${e.location}  💾 ${fmtBytes(e.sizeBytes)}` +
        (e.referencedBy.length > 0 ? `  ⚠️ 仍被引用: ${e.referencedBy.join(', ')}` : '  ✅ 孤儿（无引用）'))
      return {
        content: `⚠️ 发现 ${evidences.length} 处残留，可回收 ${fmtBytes(bytesReclaimable)}：\n${lines.join('\n')}\n\n评分说明: 五因子加权（类型×访问衰减×层级×引用态×体量），≥60 需人工确认后再清理。`,
      }
    },
  }))

  // ── nuke_deps ────────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_deps',
    description: '依赖关系检测：哪些插件/profile 声明引用了目标插件（删除前必查）',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, required: true, description: '要检测的插件名列表' },
      profile: { type: 'string', description: '限定单 profile 分析（省略 = 全 profile）' },
    },
    execute: async ({ plugin_names, profile }) => {
      const cp = checkPlugins(rt, plugin_names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      // profile 是路径段：白名单校验后才能进入依赖图构建（防路径穿越）
      let prof: ProfileName | undefined
      if (profile !== undefined) {
        const c = checkProfile(rt, profile)
        if (!c.ok) return { content: `❌ ${c.error}` }
        prof = c.profile
      }
      const g = await rt.analyzer.buildGraph(prof)
      if (!g.ok) return { content: `❌ ${g.error.message}` }
      const lines: string[] = []
      for (const p of cp.plugins) {
        const deps = g.value.dependenciesOf(p)
        const dependents = g.value.dependentsOf(p)
        lines.push(`📦 ${p}`)
        lines.push(`   被依赖（删除会波及）: ${dependents.length > 0 ? dependents.join(', ') : '无'}`)
        lines.push(`   依赖（需要一起处理）: ${deps.length > 0 ? deps.join(', ') : '无'}`)
      }
      const blockers = await rt.analyzer.blockersOf(cp.plugins)
      if (blockers.ok && blockers.value.length > 0) {
        lines.push('', `🚨 阻断警告（同批删除后仍存在的外部依赖方）:`)
        for (const b of blockers.value) lines.push(`   ${b.plugin}: ${b.reason}`)
      }
      if (g.value.hasCycle()) lines.push('', `⚠️ 检测到依赖环: ${g.value.cycles().map(c => c.join(' → ')).join('; ')}`)
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_orphans ─────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_orphans',
    description: '全局孤儿扫描：node_modules 未声明包 / 无主 storages-attachments / TEMP 过期条目',
    parameters: {
      temp_max_age_days: { type: 'number', description: 'TEMP 条目过期天数，默认 7（须 ≥1）' },
    },
    execute: async ({ temp_max_age_days = 7 }) => {
      // 下限校验（领域规则，DSL 无数值下限）：0/负数会让全部 TEMP 条目
      //（含刚写入的）被判为孤儿；number 类型已由 DSL 保证
      if (temp_max_age_days < 1) {
        return { content: '❌ temp_max_age_days 必须为 ≥1 的数字（防止把刚写入的临时文件判为孤儿）' }
      }
      const ageDays = temp_max_age_days
      const r = await rt.orphans.detect({ tempMaxAgeDays: ageDays })
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const { orphanPluginDirs, orphanDataDirs, tempOrphans, totalReclaimableBytes } = r.value
      if (orphanPluginDirs.length + orphanDataDirs.length + tempOrphans.length === 0) {
        return { content: '✅ 未发现孤儿残留。' }
      }
      const lines = [`🗑️ 孤儿总计可回收 ${fmtBytes(totalReclaimableBytes)}`]
      if (orphanPluginDirs.length > 0) {
        lines.push('', `node_modules 孤儿包 (${orphanPluginDirs.length}):`)
        for (const d of orphanPluginDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`)
      }
      if (orphanDataDirs.length > 0) {
        lines.push('', `storages/attachments 无主目录 (${orphanDataDirs.length}):`)
        for (const d of orphanDataDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`)
      }
      if (tempOrphans.length > 0) {
        lines.push('', `TEMP 过期条目 (${tempOrphans.length}):`)
        for (const t of tempOrphans.slice(0, 20)) lines.push(`  ${t.path}  ${fmtBytes(t.sizeBytes)}  ${t.ageDays.toFixed(1)} 天`)
      }
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_health ──────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_health',
    description: '系统健康检查：config/dependency/runtime/residue 四组检查，输出健康度评分与阻断项',
    parameters: {
      profile: { type: 'string', description: '默认 "web"' },
    },
    execute: async ({ profile = 'web' }) => {
      const cp = checkProfile(rt, profile)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const r = await rt.health.inspect(cp.profile)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const icon = (passed: boolean, severity: 'info' | 'warning' | 'critical') =>
        passed ? '✅' : severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '❌'
      const lines = [
        `🏥 健康度 ${r.value.score}/100  ${r.value.blocking ? '🔴 存在阻断项（critical 失败，清理事务将被拒绝）' : '🟢 无阻断'}`,
        '',
        ...r.value.results.map(x =>
          `  ${icon(x.passed, x.severity)} [${x.group}/${x.severity}] ${x.check}: ${x.message}${x.fix ? `\n     💡 ${x.fix}` : ''}`),
      ]
      return { content: lines.join('\n') }
    },
  }))
}

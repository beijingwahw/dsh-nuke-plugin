// src/tools/execution.ts — 执行域工具（动手清理与实收）
// nuke_clean / nuke_dedup / nuke_restorepoint
import * as path from 'path'

import type { Context } from '@deepseek-ai/cordis'

import { errorToMessage, fmtBytes } from '../contracts/base'
import { LEDGER_GLOBAL } from '../contracts/ledger.contract'
import type { Runtime } from '../runtime'

import { checkProfile, checkPlugins, defineTextTool } from './shared'

export function registerExecutionTools(ctx: Context, rt: Runtime): void {
  // ── nuke_clean（核心） ───────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_clean',
    description: '事务化强力卸载：健康检查闸门 → 健康度阻断拒绝 → begin(独占锁) → plan(依赖/令牌校验) → [dry_run 预演 | commit 原子执行]。失败自动 Saga 回滚，全程审计',
    parameters: {
      plugin_names: { type: 'array', items: { type: 'string' }, description: '要卸载的插件名列表' },
      plugin_name: { type: 'string', description: '单个插件名（plugin_names 简写）' },
      profile: { type: 'string', description: '默认 "web"' },
      strategy: { type: 'string', enum: ['safe', 'balanced', 'aggressive'], description: 'safe / balanced / aggressive，默认 balanced' },
      dry_run: { type: 'boolean', description: '仅预演，默认 false' },
      confirmation_token: { type: 'string', description: 'aggressive 必填：CONFIRM:<profile>:<插件清单>' },
      skip_health: { type: 'boolean', description: '跳过健康检查闸门，默认 false' },
      skip_standard: { type: 'boolean', description: '跳过 dsh CLI 标准卸载步骤（CLI 不可用 / 宿主 PATH 缺口时的逃生通道），默认 false' },
      report_format: { type: 'string', enum: ['json', 'markdown', 'both', 'none'], description: '报告格式，默认 markdown' },
      actor: { type: 'string', description: '操作人标识（写入审计日志），默认 nuke-tool' },
    },
    execute: async (args) => {
      const {
        profile = 'web', strategy = 'balanced', dry_run = false,
        skip_health = false, skip_standard = false, report_format = 'markdown', actor = 'nuke-tool',
        plugin_names, plugin_name, confirmation_token,
      } = args
      // 类型与枚举（strategy/report_format）已由 defineTool 编译进 JSON Schema
      // 并在 execute 前校验；此处只做领域白名单（插件名/profile）
      const names: string[] = plugin_names ?? (plugin_name ? [plugin_name] : [])
      const cp = checkPlugins(rt, names)
      if (!cp.ok) return { content: `❌ ${cp.error}` }
      const cprof = checkProfile(rt, profile)
      if (!cprof.ok) return { content: `❌ ${cprof.error}` }
      const strat = strategy
      const fmt = report_format

      // 1) 健康检查闸门（critical 失败 → 拒绝）。fail-closed：检查本身失败
      //    （IO/解析异常）时同样拒绝 —— 安全闸门绝不能"查不到就放行"。
      if (!skip_health) {
        const h = await rt.health.inspect(cprof.profile)
        if (!h.ok) {
          return { content: `🚫 健康检查本身失败，清理被拒绝（可用 skip_health 强制跳过，不建议）: ${h.error.message}` }
        }
        if (h.value.blocking) {
          const critical = h.value.results.filter(x => !x.passed && x.severity === 'critical')
          return { content: `🚫 健康检查存在 critical 失败，清理被拒绝（可用 skip_health 强制跳过，不建议）:\n${critical.map(x => `  🔴 ${x.check}: ${x.message}`).join('\n')}` }
        }
      }

      // 2) 二级保护：配置还原点（dry-run 零副作用，跳过）
      const rpLines: string[] = []
      if (!dry_run) {
        const rp = await rt.restorePoints.create({
          actor, reason: `pre-clean:${strat}`, profile: cprof.profile,
        })
        rpLines.push(rp.ok
          ? `🛡️ 配置还原点 ${rp.value.id}（${rp.value.files.length} 文件，nuke_restorepoint 可恢复）`
          : `⚠️ 还原点创建失败: ${rp.error.message}（事务级备份仍生效）`)
      }

      // 2.5) V5.8 备份保留策略（自动触发）：新事务启动前顺带执行一轮
      //     GC —— 腾出的备份区空间正好服务本次清理。不进 commit 关键
      //     路径（终结语义必须快）；失败只降级为提示，绝不阻断清理。
      if (!dry_run) {
        const gc = await rt.backupGc.run()
        if (gc.ok && gc.value.purged.length > 0) {
          const r = gc.value
          rpLines.push(
            `🧹 备份 GC：清理 ${r.purged.length} 个过期事务备份` +
            `（释放 ${fmtBytes(r.purged.reduce((s, p) => s + p.bytes, 0))}，` +
            `台账结算 ${fmtBytes(r.settledBytes)}）`,
          )
        } else if (!gc.ok) {
          rpLines.push(`⚠️ 备份 GC 未执行: ${gc.error.message}（不影响本次清理）`)
        }
      }

      // 3) 事务：begin → plan →（dryRun | commit）
      const begin = await rt.engine.begin({
        plugins: cp.plugins, profile: cprof.profile, strategy: strat,
        dryRun: dry_run, actor,
        ...(confirmation_token !== undefined ? { confirmationToken: confirmation_token } : {}),
        ...(skip_standard ? { skipStandard: true } : {}),
      })
      if (!begin.ok) {
        return { content: `❌ 事务开启失败 [${begin.error.code}]: ${begin.error.message}` }
      }
      const session = begin.value
      const planR = await rt.engine.plan(session)
      if (!planR.ok) {
        await rt.engine.rollback(session.txId)
        return { content: `❌ 计划编译失败 [${planR.error.code}]: ${planR.error.message}` }
      }
      const plan = planR.value

      // 策略守卫第一层：plan 后全量规则检查（保护名单/数量/回收上限/磁盘/黑窗）。
      // 两个失败分支都必须回滚释放事务 —— begin 已持有独占锁，任何 return
      // 而不回滚都会让锁悬挂到 TTL，阻塞后续所有清理。
      const policyCheck = rt.policy.check({
        plugins: cp.plugins, estimatedBytes: plan.estimatedBytesReclaimable,
      })
      if (!policyCheck.ok) {
        await rt.engine.rollback(session.txId)
        return { content: `❌ 策略检查失败（事务已回滚释放）: ${policyCheck.error.message}` }
      }
      if (policyCheck.value.length > 0) {
        await rt.engine.rollback(session.txId)
        return {
          content: [
            `🛡️ 策略守卫拦截（事务已回滚释放）:`,
            ...policyCheck.value.map(v => `  ⛔ [${v.rule}] ${v.message}`),
            `策略文件: ${path.join(rt.nukeRoot, 'policy.json')}（nuke_policy 可查看）`,
          ].join('\n'),
        }
      }

      const out: string[] = [
        ...rpLines,
        `🔧 事务 [${session.txId}]  ${dry_run ? '预演（dry-run）' : '执行'}`,
        `   插件: ${cp.plugins.join(', ')}  |  profile: ${cprof.profile}  |  策略: ${strat}`,
        `   预计可回收: ${fmtBytes(plan.estimatedBytesReclaimable)}  |  步骤数: ${plan.operations.length}`,
      ]
      for (const w of plan.warnings) out.push(`  ${w.blocking ? '⛔' : '⚠️'} ${w.message}`)

      let txCommitted = false
      try {
        if (dry_run) {
          const dr = await rt.engine.dryRun(plan)
          if (dr.ok) {
            out.push('', '─ 预演明细 ─')
            for (const p of dr.value.plans) out.push(`  • ${p.summary}`)
            // V4.1：动作级明细（风险等级 + 幂等跳过标记），元数据存在时输出
            if (dr.value.actions && dr.value.actions.length > 0) {
              const riskIcon: Record<string, string> = { low: '🟢', medium: '🟡', high: '🔴' }
              const skippedCount = dr.value.actions.filter(a => a.skipped).length
              out.push('', '─ 动作清单（风险分级）─')
              for (const a of dr.value.actions) {
                const skip = a.skipped ? ' [跳过：目标不存在]' : ''
                out.push(`  ${riskIcon[a.riskLevel] ?? '⚪'} ${a.description} → ${a.target}${skip}  ${fmtBytes(a.estimatedBytes)}`)
              }
              if (skippedCount > 0) out.push(`  （${skippedCount} 个动作将幂等跳过，无副作用）`)
            }
            const filesTotal = dr.value.plans.reduce((s, p) => s + (p.operation.fileCount ?? 0), 0)
            out.push('', `预计回收 ${fmtBytes(dr.value.estimatedBytesReclaimable)}${filesTotal > 0 ? `（涉及 ${filesTotal} 个文件）` : ''}。确认后去掉 dry_run 执行。`)
          } else {
            // 预演失败不能静默：用户必须能看到失败原因，否则输出形同成功
            out.push('', `❌ 预演失败 [${dr.error.code}]: ${dr.error.message}`)
          }
          await rt.engine.rollback(session.txId)   // 释放锁
          return { content: out.join('\n') }
        }

        // V5：commit 前预飞复查 —— 零副作用 preview 拿到真实涉及文件数，
        // 对 maxFilesPerTx 做第二道策略闸门（首查在 plan 后，彼时文件数未知）。
        // 预演结果同时预热 estimates（commit 复用，不产生双倍遍历成本）。
        const preflight = await rt.engine.dryRun(plan)
        if (preflight.ok) {
          const fileCount = preflight.value.plans.reduce(
            (s, p) => s + (p.operation.fileCount ?? 0), 0)
          const recheck = rt.policy.check({
            plugins: cp.plugins, estimatedBytes: plan.estimatedBytesReclaimable, fileCount,
          })
          if (!recheck.ok) {
            await rt.engine.rollback(session.txId)
            return { content: `❌ 预飞策略复查失败（事务已回滚释放）: ${recheck.error.message}` }
          }
          if (recheck.value.length > 0) {
            await rt.engine.rollback(session.txId)
            return {
              content: [
                `🛡️ 预飞策略拦截（事务已回滚释放）:`,
                ...recheck.value.map(v => `  ⛔ [${v.rule}] ${v.message}${v.suggestion ? `\n     💡 ${v.suggestion}` : ''}`),
                `策略文件: ${path.join(rt.nukeRoot, 'policy.json')}（nuke_policy 可查看）`,
              ].join('\n'),
            }
          }
        }
        // 预飞失败（目录被并发改动等）不阻断 commit：execute 阶段自有
        // validate 闸门与 Saga 回滚兜底，此处只负责 maxFilesPerTx 数据供给。

        const commit = await rt.engine.commit(plan)
        if (!commit.ok) {
          // V5.8.3 防御纵深：引擎理论上已回滚释放，此处再补一次 —— 万一未来
          // 出现未覆盖的失败路径，锁也不会悬挂（已终结事务返回
          // E_TX_NOT_FOUND，无害；rollback 不抛异常）。
          await rt.engine.rollback(session.txId)
          out.push('', `❌ 执行失败已自动回滚 [${commit.error.code}]: ${commit.error.message}`)
          return { content: out.join('\n') }
        }
        txCommitted = true
        const tx = commit.value
        out.push('', '─ 执行结果 ─')
        for (const s of tx.steps) {
          const mark = s.status === 'done' ? '✅' : s.status === 'skipped' ? '⏭️' : s.status === 'undone' ? '↩️' : '❌'
          out.push(`  ${mark} [${s.index}] ${s.action} (${s.operationId})  ${s.status}${s.bytesFreed > 0 ? `  回收 ${fmtBytes(s.bytesFreed)}` : ''}`)
        }
        // V5.8 双轨记账（诚实性）：dir-move 步骤的字节只是"隔离进备份区"
        // （rename 未释放物理空间），记 pending —— 备份 GC 销毁备份区时才
        // 转 freed。totalFreed 从此只报真实物理回收，与磁盘可用字节同口径。
        let quarantinedBytes = 0
        for (const s of tx.steps) {
          if (s.status !== 'done' || s.bytesFreed <= 0) continue
          const quarantined = s.backup?.kind === 'dir-move'
          if (quarantined) quarantinedBytes += s.bytesFreed
          await rt.ledger.record({
            at: new Date().toISOString(),
            kind: quarantined ? 'pending' : 'freed',
            txId: session.txId,
            profile: cprof.profile, plugin: null, action: s.action,
            bytes: s.bytesFreed,
            note: quarantined
              ? `事务 ${session.txId} 步骤 ${s.index}：已隔离进备份区（宽限期内可恢复）`
              : `事务 ${session.txId} 步骤 ${s.index}`,
          })
        }
        out.push('', `状态: ${tx.state}  |  实际回收: ${fmtBytes(tx.bytesFreedTotal - quarantinedBytes)}`
          + (quarantinedBytes > 0 ? `（另有 ${fmtBytes(quarantinedBytes)} 已隔离进备份区，保留期后物理回收，nuke_gc 可查）` : ''))

        // 趋势快照 + 空间台账：数据驱动决策的原料
        await rt.trend.record({
          at: new Date().toISOString(), trigger: 'clean', profile: cprof.profile,
          bytesReclaimable: 0, bytesFreed: tx.bytesFreedTotal,
          residualCount: 0, healthScore: -1,
        })

        // 3) 报告导出
        if (fmt !== 'none') {
          const healthR = await rt.health.inspect(cprof.profile)
          const trail = await rt.audit.query({ txId: session.txId })
          const chain = await rt.audit.verify()
          const payload = {
            tx, health: healthR.ok ? healthR.value.results : [],
            auditTrail: trail, generatedAt: new Date().toISOString(), chainValid: chain.valid,
          }
          const formats = fmt === 'both' ? ['json', 'markdown'] as const
            : [fmt === 'json' ? 'json' : 'markdown'] as const
          for (const f of formats) {
            const r = await rt.reporter.export(f, payload)
            if (r.ok) out.push(`📄 ${f} 报告: ${r.value.path}`)
          }
        }
        return { content: out.join('\n') }
      } catch (e) {
        // 逃逸异常必须尽力回滚释放事务（独占锁不悬挂）；commit 已成功的事务
        // 不可回滚（此时异常只可能来自报告/台账等收尾，事务本身无恙）。
        if (txCommitted) {
          return { content: `⚠️ 事务已提交，但收尾阶段异常: ${errorToMessage(e)}` }
        }
        try {
          await rt.engine.rollback(session.txId)
          return { content: `❌ 未预期异常（事务已回滚释放）: ${errorToMessage(e)}` }
        } catch (e2) {
          return { content: `❌ 未预期异常且回滚失败: ${errorToMessage(e)} / ${errorToMessage(e2)}（请立即运行 nuke_recover）` }
        }
      }
    },
  }))

  // ── nuke_dedup ───────────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_dedup',
    description: '内容寻址去重：三级瀑布（尺寸分桶→头尾采样→全量 SHA-256）定位重复文件群；apply=true 时以硬链接实收（verify-then-link，需确认令牌）',
    parameters: {
      min_size_bytes: { type: 'integer', description: '参与分析的最小文件尺寸，默认 4096（须 ≥1）' },
      apply: { type: 'boolean', description: '将重复副本替换为硬链接实收空间（默认 false 只分析）' },
      confirm_token: { type: 'string', description: 'apply=true 时必填：LINK-DEDUP' },
    },
    execute: async ({ min_size_bytes, apply, confirm_token }) => {
      // 下限校验（领域规则）：0/负数会使全部文件进入哈希阶段 → 全盘 IO/CPU DoS；
      // integer 类型已由 DSL 保证
      if (min_size_bytes !== undefined && min_size_bytes < 1) {
        return { content: '❌ min_size_bytes 必须为 ≥1 的整数' }
      }
      const minSize = min_size_bytes
      // apply 属破坏性动作：显式令牌确认（与 aggressive 清理同纪律）
      if (apply === true && confirm_token !== 'LINK-DEDUP') {
        return { content: '❌ apply=true 需要确认令牌 confirm_token="LINK-DEDUP"（硬链接替换不可逆于权限语义）' }
      }
      const r = await rt.dedup.analyze(minSize !== undefined ? { minSizeBytes: minSize } : undefined)
      if (!r.ok) return { content: `❌ ${r.error.message}` }
      const d = r.value
      if (d.groups.length === 0) {
        return { content: `✅ 未发现重复文件（扫描 ${d.filesScanned} 个 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms）。` }
      }

      // 记 pending：去重潜力基线先入台账（双轨记账）。apply 路径随后记
      // 实际 freed，两者对照可得"潜力兑现率"；此前 pending 位于 apply 分支
      // 的 return 之后，apply=true 时永远不会被记录，双轨断裂。
      await rt.ledger.record({
        at: new Date().toISOString(), kind: 'pending', txId: null,
        profile: LEDGER_GLOBAL, plugin: null, action: 'dedup-potential',
        bytes: d.totalReclaimableBytes, note: `${d.groups.length} 组重复内容`,
      })

      // apply 模式：分析 → 复验 → 硬链接实收
      if (apply === true) {
        const ex = await rt.dedupExec.apply(d)
        if (!ex.ok) return { content: `❌ ${ex.error.message}` }
        const e = ex.value
        // 台账：此处记实际 freed（诚实值：仅独占 inode 的副本）
        await rt.ledger.record({
          at: new Date().toISOString(), kind: 'freed', txId: null,
          profile: LEDGER_GLOBAL, plugin: null, action: 'dedup-hardlink',
          bytes: e.bytesSaved, note: `${e.linkedFiles} 个副本硬链接化 / ${e.skipped.length} 跳过`,
        })
        const lines = [
          `${e.cancelled ? '⏹️ 去重执行被中途取消（已完成部分已记 journal，可 undo）' : '♻️ 硬链接去重完成'}：${e.linkedFiles} 个副本已链接，实际回收 ${fmtBytes(e.bytesSaved)}`,
          `   （跳过 ${e.skipped.length} 项：复验失败/跨设备/已链接等）`,
          '',
          '  已链接样本：',
        ]
        for (const j of e.journal.slice(0, 8)) {
          lines.push(`    • ${path.basename(j.victim)} → ${path.basename(j.canonical)} (${fmtBytes(j.sizeBytes)})`)
        }
        if (e.skipped.length > 0) {
          lines.push('', '  跳过样本：')
          for (const s of e.skipped.slice(0, 5)) lines.push(`    • ${path.basename(s.path)}: ${s.reason}`)
        }
        return { content: lines.join('\n') }
      }

      const lines = [
        `♻️ 发现 ${d.groups.length} 组重复，合计可回收 ${fmtBytes(d.totalReclaimableBytes)}`,
        `   扫描 ${d.filesScanned} 文件 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms`,
        `   三级瀑布：尺寸淘汰 ${d.stages?.sizeEliminated ?? '—'} / 采样淘汰 ${d.stages?.sampleEliminated ?? '—'} / 全量哈希 ${d.stages?.fullHashed ?? '—'}（省读 ${fmtBytes(d.stages?.bytesSavedBySampling ?? 0)}）`,
        '',
      ]
      for (const g of d.groups.slice(0, 10)) {
        lines.push(`  • ${fmtBytes(g.sizeBytes)} × ${g.copies.length} 份`)
        for (const c of g.copies) {
          lines.push(`      ${c.profile ?? '—'}/${path.basename(c.path)}`)
        }
      }
      if (d.groups.length > 10) lines.push('', `  … 及另外 ${d.groups.length - 10} 组`)
      lines.push('', '💡 确认后可执行硬链接实收：apply=true + confirm_token="LINK-DEDUP"')
      return { content: lines.join('\n') }
    },
  }))

  // ── nuke_restorepoint ────────────────────────────────────
  ctx.tools.register(defineTextTool({
    name: 'nuke_restorepoint',
    description: '配置还原点管理：清理前自动快照关键配置，事故后一键恢复（list / create / restore / prune）',
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'restore', 'prune'], description: 'list / create / restore / prune，默认 list' },
      id: { type: 'string', description: 'restore 目标还原点 id' },
      profile: { type: 'string', description: 'create 用，默认 "web"' },
      reason: { type: 'string', description: 'create 用，默认 manual' },
      keep: { type: 'integer', description: 'prune 用：保留最近几个，默认 5（须 ≥1）' },
      actor: { type: 'string', description: 'create 用，默认 nuke-tool' },
    },
    execute: async ({ action = 'list', id, profile = 'web', reason = 'manual', keep = 5, actor = 'nuke-tool' }) => {
      if (action === 'create') {
        const cp = checkProfile(rt, profile)
        if (!cp.ok) return { content: `❌ ${cp.error}` }
        const r = await rt.restorePoints.create({ actor, reason, profile: cp.profile })
        if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
        return {
          content: `🛡️ 还原点已创建: ${r.value.id}\n   文件 ${r.value.files.length} 个，快照于 ${r.value.createdAt}。`,
        }
      }
      if (action === 'restore') {
        if (!id) return { content: '❌ 请提供 id' }
        const r = await rt.restorePoints.restore(id)
        if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` }
        return { content: `↩️ 已恢复 ${r.value.files.length} 个配置文件到 ${r.value.createdAt} 时点（${r.value.id}）。` }
      }
      if (action === 'prune') {
        // keep 下限校验（领域规则）：0/负数 = 清空全部还原点（安全网不容许
        // 无确认全删）；integer 类型已由 DSL 保证
        if (keep < 1) {
          return { content: '❌ keep 必须为 ≥1 的整数（不允许清空全部还原点）' }
        }
        const r = await rt.restorePoints.prune(keep)
        if (!r.ok) return { content: `❌ ${r.error.message}` }
        return { content: `🧹 已删除 ${r.value} 个旧还原点。` }
      }
      // list
      const all = rt.restorePoints.list()
      if (all.length === 0) return { content: '暂无还原点。' }
      const lines = [`🛡️ ${all.length} 个还原点（最新在前）:`]
      for (const m of all) {
        lines.push(`  ${m.id}  ${m.createdAt}  ${m.files.length} 文件  by ${m.actor}  (${m.reason})`)
      }
      return { content: lines.join('\n') }
    },
  }))
}

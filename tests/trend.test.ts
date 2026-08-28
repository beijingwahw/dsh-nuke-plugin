// tests/trend.test.ts — 历史趋势追踪器单测
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTrendTracker } from '../src/engine/trend-tracker'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-test-'))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const DAY = 86_400_000
const T0 = Date.parse('2026-01-01T00:00:00Z')

/** 每次调用独立目录：测试间零串扰 */
let seq = 0
function tracker() {
  const dir = path.join(tmp, `history-${seq++}`)
  return { tracker: createTrendTracker({ historyDir: dir }), dir }
}

function snap(atMs: number, bytes: number, trigger: 'scan' | 'clean' | 'doctor' = 'scan') {
  return {
    at: new Date(atMs).toISOString(), trigger,
    profile: 'web' as any, bytesReclaimable: bytes, bytesFreed: 0,
    residualCount: 1, healthScore: 90,
  }
}

describe('趋势记录与分析', () => {
  it('空历史 → 零快照报告', async () => {
    const r = (await tracker().tracker.analyze())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.snapshotCount).toBe(0)
      expect(r.value.latest).toBeNull()
      expect(r.value.projected30dBytes).toBeNull()
    }
  })

  it('线性增长 → 斜率 = 字节/天，30 天外推正确', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + 1 * DAY, 2000))
    await t.record(snap(T0 + 2 * DAY, 3000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.round(r.value.bytesPerDay)).toBe(1000)
    expect(r.value.projected30dBytes).toBe(1000 + 1000 * 32)   // T0+32d 截距外推
    expect(r.value.anomaly.detected).toBe(false)
  })

  it('清理后回落 → 斜率为负（趋势向好）', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 5000))
    await t.record(snap(T0 + DAY, 1000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.bytesPerDay).toBeLessThan(0)
  })

  it('末值 3σ 突增 → 异常检出', async () => {
    const { tracker: t } = tracker()
    // 前四点完美线性，末点暴增 → 残差远超 3σ
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + DAY, 1100))
    await t.record(snap(T0 + 2 * DAY, 1200))
    await t.record(snap(T0 + 3 * DAY, 1300))
    await t.record(snap(T0 + 4 * DAY, 1_000_000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.anomaly.detected).toBe(true)
    expect(r.value.anomaly.detail).toContain('激增')
  })

  it('尾部半行容错：崩溃残留不破坏分析', async () => {
    const { tracker: t, dir } = tracker()
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + DAY, 2000))
    fs.appendFileSync(path.join(dir, 'trend.jsonl'), '{"at":"broken')
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.snapshotCount).toBe(2)
  })

  it('profile 过滤：只统计目标 profile', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 1000))
    await t.record({ ...snap(T0, 9999), profile: 'api' as any })
    const r = await t.analyze('web' as any)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.snapshotCount).toBe(1)
      expect(r.value.latest?.bytesReclaimable).toBe(1000)
    }
  })

  it('坏快照净化：非法日期/缺字段/非有限数整条剔除，不毒化回归', async () => {
    const { tracker: t, dir } = tracker()
    // 正常三点：完美线性 1000/day
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + 1 * DAY, 2000))
    await t.record(snap(T0 + 2 * DAY, 3000))
    // 三类坏条目直接写进 JSONL（模拟损坏/陈旧格式/篡改）
    fs.appendFileSync(path.join(dir, 'trend.jsonl'), [
      JSON.stringify({ ...snap(T0 + 3 * DAY, 999_999), at: 'not-a-date' }),   // 非法日期
      JSON.stringify({ trigger: 'scan', profile: 'web' }),                    // 缺数值字段
      `{"at":"${new Date(T0 + 3 * DAY).toISOString()}","trigger":"scan","profile":"web","bytesReclaimable":1e999,"bytesFreed":0,"residualCount":1,"healthScore":90}`,  // JSON.parse → Infinity
    ].join('\n') + '\n')
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.snapshotCount).toBe(3)                    // 坏条目全部剔除
    expect(Number.isFinite(r.value.bytesPerDay)).toBe(true)  // 绝不下发 NaN/Infinity
    expect(Math.round(r.value.bytesPerDay)).toBe(1000)
    expect(r.value.projected30dBytes).not.toBeNull()
    expect(Number.isFinite(r.value.projected30dBytes!)).toBe(true)
  })
})

/** 带调参的独立目录 tracker（时间加权/CUSUM 选项冒烟） */
function trackerTuned(extra: {
  halfLifeDays?: number
  cusumWarmup?: number
  cusumThresholdSigmas?: number
}) {
  const dir = path.join(tmp, `history-${seq++}`)
  return { tracker: createTrendTracker({ historyDir: dir, ...extra }), dir }
}

describe('趋势升级：时间加权 Theil-Sen / CUSUM 变点 / 预测区间', () => {
  it('时间加权：远端旧 regime 不再拉偏斜率（近期速率主导，均匀权重作对照）', async () => {
    // 90 天前以 5000/day 堆积（3 快照）；近 2 天转为 1000/day（3 快照）
    const data: [number, number][] = [
      [T0 - 90 * DAY, 100_000],
      [T0 - 89 * DAY, 105_000],
      [T0 - 88 * DAY, 110_000],
      [T0 - 2 * DAY, 200_000],
      [T0 - 1 * DAY, 201_000],
      [T0, 202_000],
    ]
    const { tracker: weighted } = tracker()
    const { tracker: uniform } = trackerTuned({ halfLifeDays: Infinity })
    for (const [at, bytes] of data) {
      await weighted.record(snap(at, bytes))
      await uniform.record(snap(at, bytes))
    }
    const wr = await weighted.analyze()
    const ur = await uniform.analyze()
    expect(wr.ok && ur.ok).toBe(true)
    if (!wr.ok || !ur.ok) return
    // 指数衰减（半衰期 30 天）压垮 90 天前的旧速率对 → 斜率 = 当下增长率
    expect(wr.value.bytesPerDay).toBeCloseTo(1000, 6)
    // 均匀权重（经典 Theil-Sen）= 全局平均速率 ≈ 1091/day，被旧 regime 拉高
    expect(ur.value.bytesPerDay).toBeGreaterThan(1050)
    expect(wr.value.bytesPerDay).toBeLessThan(ur.value.bytesPerDay)
    // 斜率 CI：下界仍是当下速率块，上界进入跨 regime 平均块（有界不越 1100）
    expect(wr.value.bytesPerDayLow).not.toBeNull()
    expect(wr.value.bytesPerDayLow!).toBeCloseTo(1000, 6)
    expect(wr.value.bytesPerDayHigh).not.toBeNull()
    expect(wr.value.bytesPerDayHigh!).toBeGreaterThan(1000)
    expect(wr.value.bytesPerDayHigh!).toBeLessThan(1100)
  })

  it('CUSUM 变点：增长率跳升被检出（时间 + 方向 + 前后速率），且同数据必得同结果', async () => {
    const { tracker: t } = tracker()
    // 前 4 天 1000/day，后 3 天 5000/day（连续每日快照）
    let bytes = 1000
    for (let d = 0; d <= 6; d++) {
      await t.record(snap(T0 + d * DAY, bytes))
      bytes += d < 3 ? 1000 : 5000
    }
    const r = await t.analyze()
    const r2 = await t.analyze()
    expect(r.ok && r2.ok).toBe(true)
    if (!r.ok || !r2.ok) return
    expect(r.value).toEqual(r2.value)   // 无墙钟依赖：分析是数据的纯函数
    expect(r.value.changepoints).toHaveLength(1)
    const cp = r.value.changepoints[0]!
    expect(cp.direction).toBe('up')
    // 变点挂在新 regime 首个快照：d3→d4 区间首次出现 5000/day
    expect(cp.at).toBe(new Date(T0 + 4 * DAY).toISOString())
    expect(cp.bytesPerDayBefore).toBeCloseTo(1000, 6)
    expect(cp.bytesPerDayAfter).toBeCloseTo(5000, 6)
  })

  it('CUSUM 变点：清理后增长率转负 → down 方向 + 前后速率正确', async () => {
    const { tracker: t } = tracker()
    // 前 4 天 +2000/day 堆积；清理生效后 −1000/day 回落
    let bytes = 1000
    for (let d = 0; d <= 6; d++) {
      await t.record(snap(T0 + d * DAY, bytes))
      bytes += d < 3 ? 2000 : -1000
    }
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changepoints).toHaveLength(1)
    const cp = r.value.changepoints[0]!
    expect(cp.direction).toBe('down')
    expect(cp.at).toBe(new Date(T0 + 4 * DAY).toISOString())
    expect(cp.bytesPerDayBefore).toBeCloseTo(2000, 6)
    expect(cp.bytesPerDayAfter).toBeCloseTo(-1000, 6)
  })

  it('CUSUM 多变点：三段 regime 逐段识别（1000 → 3000 → 5000/day）', async () => {
    const { tracker: t } = tracker()
    let bytes = 1000
    for (let d = 0; d <= 9; d++) {
      await t.record(snap(T0 + d * DAY, bytes))
      bytes += d < 3 ? 1000 : d < 6 ? 3000 : 5000
    }
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changepoints).toHaveLength(2)
    const [c1, c2] = r.value.changepoints
    expect(c1!.at).toBe(new Date(T0 + 4 * DAY).toISOString())
    expect(c1!.direction).toBe('up')
    expect(c1!.bytesPerDayBefore).toBeCloseTo(1000, 6)
    expect(c1!.bytesPerDayAfter).toBeCloseTo(3000, 6)
    expect(c2!.at).toBe(new Date(T0 + 7 * DAY).toISOString())
    expect(c2!.direction).toBe('up')
    expect(c2!.bytesPerDayBefore).toBeCloseTo(3000, 6)
    expect(c2!.bytesPerDayAfter).toBeCloseTo(5000, 6)
  })

  it('平稳噪声序列：无变点（K 容差吸收 ±σ̂/2 内抖动，不误报）', async () => {
    const { tracker: t } = tracker()
    // 局部率在 1000/day 附近小幅抖动（±2%）
    const values = [1000, 1980, 3000, 4010, 5000, 6005]
    for (let d = 0; d < values.length; d++) {
      await t.record(snap(T0 + d * DAY, values[d]!))
    }
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changepoints).toEqual([])
  })

  it('单点尖峰不构成变点（CUSUM 报警被前后中位数后验否决——那是异常检测的职责）', async () => {
    const { tracker: t } = tracker()
    // 稳定 1000/day，中间一个区间暴增 98000/day 后立即回落
    const values = [1000, 2000, 3000, 4000, 102_000, 103_000, 104_000, 105_000]
    for (let d = 0; d < values.length; d++) {
      await t.record(snap(T0 + d * DAY, values[d]!))
    }
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changepoints).toEqual([])
  })

  it('预测区间（完美线性）：斜率不确定性为零 → 零宽区间，点估计即区间', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + DAY, 2000))
    await t.record(snap(T0 + 2 * DAY, 3000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.bytesPerDayLow).not.toBeNull()
    expect(r.value.bytesPerDayHigh).not.toBeNull()
    expect(r.value.bytesPerDayLow!).toBeCloseTo(1000, 6)
    expect(r.value.bytesPerDayHigh!).toBeCloseTo(1000, 6)
    expect(r.value.projected30dBytesLow).not.toBeNull()
    expect(r.value.projected30dBytesHigh).not.toBeNull()
    expect(r.value.projected30dBytesLow!).toBeCloseTo(33000, 6)
    expect(r.value.projected30dBytesHigh!).toBeCloseTo(33000, 6)
  })

  it('预测区间（噪声数据）：斜率不确定性传播 → 点估计严格居区间内', async () => {
    const { tracker: t } = tracker()
    await t.record(snap(T0, 1000))
    await t.record(snap(T0 + DAY, 2200))
    await t.record(snap(T0 + 2 * DAY, 3000))
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 斜率 CI：成对斜率 800/1000/1200 的加权分位 → 严格包住中位斜率
    expect(r.value.bytesPerDayLow).not.toBeNull()
    expect(r.value.bytesPerDayHigh).not.toBeNull()
    expect(r.value.bytesPerDayLow!).toBeLessThan(r.value.bytesPerDay)
    expect(r.value.bytesPerDayHigh!).toBeGreaterThan(r.value.bytesPerDay)
    // 30 天外推区间：宽度 = (slopeHigh − slopeLow)×30d，点估计居中
    expect(r.value.projected30dBytes).not.toBeNull()
    expect(r.value.projected30dBytesLow).not.toBeNull()
    expect(r.value.projected30dBytesHigh).not.toBeNull()
    expect(r.value.projected30dBytesLow!).toBeLessThan(r.value.projected30dBytes!)
    expect(r.value.projected30dBytesHigh!).toBeGreaterThan(r.value.projected30dBytes!)
  })

  it('样本不足：单快照 → 新字段全部 null；两快照 → 退化零宽区间（两点定一线）', async () => {
    const { tracker: t1 } = tracker()
    await t1.record(snap(T0, 5000))
    const r1 = await t1.analyze()
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.value.changepoints).toEqual([])
    expect(r1.value.bytesPerDayLow).toBeNull()
    expect(r1.value.bytesPerDayHigh).toBeNull()
    expect(r1.value.projected30dBytesLow).toBeNull()
    expect(r1.value.projected30dBytesHigh).toBeNull()

    const { tracker: t2 } = tracker()
    await t2.record(snap(T0, 1000))
    await t2.record(snap(T0 + DAY, 2000))
    const r2 = await t2.analyze()
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.value.changepoints).toEqual([])
    expect(r2.value.bytesPerDayLow).not.toBeNull()
    expect(r2.value.bytesPerDayLow!).toBeCloseTo(1000, 6)
    expect(r2.value.bytesPerDayHigh!).toBeCloseTo(1000, 6)
    expect(r2.value.projected30dBytesLow).not.toBeNull()
    expect(r2.value.projected30dBytesLow!).toBeCloseTo(32000, 6)
    expect(r2.value.projected30dBytesHigh!).toBeCloseTo(32000, 6)
  })

  it('CUSUM 热身窗可配：热身要求超过率序列长度 → 检测关闭（不误报）', async () => {
    const { tracker: t } = trackerTuned({ cusumWarmup: 10 })
    // 与"增长率跳升"相同的数据（6 个局部率 < 热身 10）
    let bytes = 1000
    for (let d = 0; d <= 6; d++) {
      await t.record(snap(T0 + d * DAY, bytes))
      bytes += d < 3 ? 1000 : 5000
    }
    const r = await t.analyze()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changepoints).toEqual([])
  })
})

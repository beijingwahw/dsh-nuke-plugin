// tests/failure-taxonomy.test.ts — 失败分类学（V5.3 失败模式智能的信任根）
// 分类器是写方（引擎重试决策）与读方（可靠性统计）共享的单一事实源：
// 一个模式被判瞬态，引擎就敢重试；被判永久，立即回滚。此处穷举
// 真实世界错误形态，锁死两侧语义永不漂移。
import { describe, expect, it } from 'vitest'

import {
  classifyFailureMode, DEFAULT_RETRY_EFFICACY, MODE_PRESCRIPTIONS, MODE_TRANSIENCE,
  retryAdjustedProbability,
} from '../src/contracts/failure.contract'
import type { FailureMode } from '../src/contracts/failure.contract'

describe('失败分类学：classifyFailureMode', () => {
  it('errno 字面量 → 对应模式（Node fs/spawn 根因消息）', () => {
    expect(classifyFailureMode("rename 'a' -> 'b': EBUSY: resource busy or locked")).toBe('locked')
    expect(classifyFailureMode('EBUSY: 该文件被另一进程使用')).toBe('locked')
    expect(classifyFailureMode('ETIMEDOUT: operation timed out')).toBe('timeout')
    expect(classifyFailureMode('命令执行超时（300s）被终止')).toBe('timeout')
    expect(classifyFailureMode('EMFILE: too many open files')).toBe('resource')
    expect(classifyFailureMode('EAGAIN: resource temporarily unavailable')).toBe('resource')
    expect(classifyFailureMode('ENOSPC: no space left on device')).toBe('space')
    expect(classifyFailureMode('磁盘空间不足，无法完成操作')).toBe('space')
    expect(classifyFailureMode("ENOENT: no such file or directory, unlink 'x'")).toBe('vanished')
    expect(classifyFailureMode("EACCES: permission denied, unlink '/root/x'")).toBe('permission')
    expect(classifyFailureMode('EPERM: operation not permitted')).toBe('permission')
    expect(classifyFailureMode('EIO: i/o error')).toBe('io')
    expect(classifyFailureMode('EROFS: read-only file system')).toBe('io')
  })

  it('NukeError 前缀形态（errorToMessage 产出 `[E_XXX] msg`）→ 契约码类模式', () => {
    expect(classifyFailureMode('[E_VALIDATION] 路径越界: /etc')).toBe('validation')
    expect(classifyFailureMode('[E_HOOK_VETO] 策略守卫否决: 保护名单')).toBe('validation')
    expect(classifyFailureMode('[E_TOOL_MISSING] dsh CLI 不可用')).toBe('dependency')
    expect(classifyFailureMode('spawn dsh ENOENT')).toBe('dependency')
    expect(classifyFailureMode('Error: spawn pnpm ENOENT — command not found')).toBe('dependency')
  })

  it('中文措辞 → 对应模式', () => {
    expect(classifyFailureMode('文件被占用，无法删除')).toBe('locked')
    expect(classifyFailureMode('目标目录不存在')).toBe('vanished')
    expect(classifyFailureMode('权限不足')).toBe('permission')
  })

  it('空/无根因 → unknown（保守：永久，不盲试）', () => {
    expect(classifyFailureMode('')).toBe('unknown')
    expect(classifyFailureMode(null)).toBe('unknown')
    expect(classifyFailureMode(undefined)).toBe('unknown')
    expect(classifyFailureMode('完全无法识别的消息')).toBe('unknown')
  })

  it('全模式瞬态性与处方完备：每个模式都有判定与处方（编译期穷举 + 运行期完备）', () => {
    const modes: readonly FailureMode[] = [
      'locked', 'timeout', 'resource', 'space', 'vanished',
      'permission', 'validation', 'dependency', 'io', 'unknown',
    ]
    for (const m of modes) {
      expect(MODE_TRANSIENCE[m]).toMatch(/^(transient|permanent)$/)
      expect(MODE_PRESCRIPTIONS[m].length).toBeGreaterThan(4)
    }
    // 瞬态集合 = 引擎会自动重试的集合（重试决策的语义锚点）
    expect(MODE_TRANSIENCE.locked).toBe('transient')
    expect(MODE_TRANSIENCE.timeout).toBe('transient')
    expect(MODE_TRANSIENCE.resource).toBe('transient')
    expect(MODE_TRANSIENCE.space).toBe('transient')
    // 永久集合 = 重试纯浪费
    expect(MODE_TRANSIENCE.validation).toBe('permanent')
    expect(MODE_TRANSIENCE.permission).toBe('permanent')
    expect(MODE_TRANSIENCE.dependency).toBe('permanent')
    expect(MODE_TRANSIENCE.unknown).toBe('permanent')
  })
})

describe('重试调整概率模型：retryAdjustedProbability', () => {
  it('零瞬态份额 / 满成功率 / 零重试 → 原样返回（恒等边界）', () => {
    expect(retryAdjustedProbability(0.8, 0, 2)).toBe(0.8)
    expect(retryAdjustedProbability(1, 1, 2)).toBe(1)
    expect(retryAdjustedProbability(0.8, 1, 0)).toBe(0.8)
    expect(retryAdjustedProbability(0.8, 1, 2, 0)).toBe(0.8)
  })

  it('全瞬态失败 + 2 次重试 × 成功率 0.5 → 挽回 75% 失败质量', () => {
    // p=0.6, t=1, R=2, e=0.5 → 0.6 + 0.4×1×0.75 = 0.9
    expect(retryAdjustedProbability(0.6, 1, 2, 0.5)).toBeCloseTo(0.9, 10)
  })

  it('半瞬态份额 → 按份额比例挽回', () => {
    // p=0.6, t=0.5, R=2, e=0.5 → 0.6 + 0.4×0.5×0.75 = 0.75
    expect(retryAdjustedProbability(0.6, 0.5, 2, 0.5)).toBeCloseTo(0.75, 10)
  })

  it('重试次数单调不减（边际收益递减）', () => {
    let prev = retryAdjustedProbability(0.5, 1, 0)
    for (let r = 1; r <= 6; r++) {
      const cur = retryAdjustedProbability(0.5, 1, r)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
    // R→∞ 收敛于 p + (1-p)·t = 1（全瞬态全挽回）
    expect(retryAdjustedProbability(0.5, 1, 60)).toBeCloseTo(1, 6)
  })

  it('默认参数：efficacy=0.5', () => {
    expect(DEFAULT_RETRY_EFFICACY).toBe(0.5)
    expect(retryAdjustedProbability(0.6, 1, 2)).toBeCloseTo(0.9, 10)
  })
})

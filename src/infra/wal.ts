// src/infra/wal.ts — IWal 实现：JSONL 追加 + fdatasync + 崩溃重放 + CRC 完整性
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import type { Result, TxId } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type { IWal, WalRecord } from '../contracts/transaction'

import { fsyncDir, writeAllSync } from './fs-utils'

export interface WalOptions {
  readonly walRoot: string   // <dshHome>/.nuke/tx
}

/**
 * 每事务一个 <txId>.wal.jsonl。
 * 物理保证：每条记录 append + fdatasync 后才返回 —— 进程崩溃最多丢"正在写"的
 * 那一条；重放时 step-intent 无对应 step-done 的步骤按"半执行"处理（触发反向补偿）。
 *
 * 完整性保证（世界级升级）：JSON.parse 只能拦"语法损坏"——字段被篡改或位腐烂后
 * 仍是合法 JSON，重放会拿到被污染的意图。每条记录写入时附带 `__crc`
 * （SHA-256 截断 16 hex，覆盖记录除 __crc 外的规范化 JSON），
 * replay/unfinishedTxIds 逐条校验：CRC 不匹配按损坏处理（同语法损坏纪律）。
 * 无 __crc 的历史行（旧版本写入）按原样接受 —— 读取宽容，写入严格。
 *
 * CRC 覆盖面（V5.8.1 修复）：规范化序列化必须递归覆盖所有层级。旧实现的
 * JSON.stringify 数组 replacer 是逐层递归的键白名单，嵌套载荷（outcome 的
 * bytesFreed、backup 的 originalPath/fingerprint、error 的 details…）被序列化
 * 为空对象 —— 深层篡改零成本通过校验。现改为递归键排序序列化；存量行的
 * __crc 用旧算法复现校验（双算法接受），新写入一律走修复版。
 *
 * 归档（archiveFinished）：已终结事务（含 tx-commit/tx-rollback）的 WAL 文件
 * 移入 archive/ 子目录 —— append-only 语义保留（replay 仍可查询归档文件），
 * unfinishedTxIds 只扫活跃文件，崩溃恢复的扫描面随归档单调收缩。
 *
 * 尾部修复（repairTail）：崩溃写半的行只可能出现在文件物理尾部。检测到
 * 尾部语法半行 → 截断到最后一行完整记录（含 fsync，之后追加不再粘连）；
 * 完整行的 CRC/结构损坏 = 疑似篡改 → 拒绝修复保留现场（fail-closed）。
 *
 * 目录持久性：新建 WAL 文件后对父目录 fsync（文件目录项本身落盘），
 * rename 归档后对源/目标目录 fsync —— 崩溃后"文件存在与否"与记录内容
 * 具有一致的持久性等级。
 */
// txId 白名单：字母数字与-_，长度 ≤ 64。含路径分隔符/点/空白的 txId 一律非法，
// 杜绝 "../etc/passwd" 式穿越（引擎生成的 txId 为 16 位 hex，天然满足）。
const TXID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CRC_FIELD = '__crc'

type CrcCarrier = WalRecord & { __crc?: string }

/** 递归规范化序列化：所有层级的键按码位排序、undefined 值剔除。
 *
 *  为什么不能用 JSON.stringify 的数组 replacer 做键序稳定化：数组 replacer
 *  在 ECMAScript 语义里是"逐层递归生效的键白名单"（SerializeJSONObject
 *  对每个嵌套对象都用同一 PropertyList 过滤），不是"只排序顶层键"。
 *  顶层键名之外的嵌套内容一律被序列化为 {} —— 实测 step-done 记录的
 *  canonical 只剩 {"backup":{},"index":0,...,"outcome":{}}，bytesFreed/
 *  backupPath/fingerprint/error.details 等嵌套载荷完全缺席，CRC 对深层
 *  篡改形同虚设。本实现逐层显式排序，任意深度的内容都参与哈希。
 *
 *  标量仍走 JSON.stringify：与旧算法的数字/字符串序列化（1e+21、-0→0、
 *  NaN/Infinity→null）逐位一致，保证只有"嵌套覆盖面"这一维度发生变化。 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    // JSON.stringify 运行时对 undefined/symbol/function 返回 undefined，
    // 但其类型签名声明为 string —— 经 unknown 桥接后显式判空
    const s = JSON.stringify(v) as string | undefined
    return s ?? 'null'
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`
}

/** 规范化 CRC（修复版）：递归规范化序列化后取 SHA-256 前 16 hex */
function computeCrc(record: WalRecord): string {
  const { ...rest } = record as CrcCarrier
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 剔除 __crc 字段后做规范化序列化（delete 动态键是契约字段名的直接表达）
  delete (rest as Record<string, unknown>)[CRC_FIELD]
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 16)
}

/** 旧版 CRC（缺陷版，仅用于读取历史行）：已落盘记录的 __crc 由旧算法计算，
 *  读取侧必须能用同一算法复现，否则升级后全部存量 WAL 被误判为篡改
 *  （fail-closed 保留现场 → 永不归档、恢复面永不收缩）。与"无 __crc 的
 *  历史行按原样接受"同一读取宽容纪律；新写入一律走修复版 computeCrc。
 *  已知局限：旧算法不覆盖嵌套内容，历史行的深层篡改仍不可检 —— 这是
 *  存量数据的固有属性，只能向前修复，无法追溯补强。 */
function legacyCrc(record: WalRecord): string {
  const { ...rest } = record as CrcCarrier
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 同上：复现旧算法的规范化输入
  delete (rest as Record<string, unknown>)[CRC_FIELD]
  const canonical = JSON.stringify(rest, Object.keys(rest).sort())
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// ─── 行级判定：区分"崩溃写半"与"疑似篡改" ─────────────────────
// 语法解析失败 = 物理不完整（崩溃残留半行，只可能出现在文件尾部）；
// JSON 合法但结构/CRC 不符 = 完整行被篡改或位腐烂。尾部修复只认前者。
type LineVerdict = 'ok' | 'partial' | 'corrupt'

function lineVerdict(line: string): { verdict: LineVerdict; record: WalRecord | null } {
  let parsed: CrcCarrier
  try {
    parsed = JSON.parse(line) as CrcCarrier
  } catch { return { verdict: 'partial', record: null } }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.parse("null") 运行时得到 null（typeof null === 'object' 会漏过首判），此判据是 fail-closed 必需
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
    return { verdict: 'corrupt', record: null }
  }
  if (parsed[CRC_FIELD] !== undefined) {
    // 双算法接受：修复版（新写入）或缺陷版（升级前的存量行）任一匹配即通过。
    // 只认修复版会把全部存量 WAL 误判为篡改；只认缺陷版则修复毫无意义。
    if (typeof parsed[CRC_FIELD] !== 'string'
      || (parsed[CRC_FIELD] !== computeCrc(parsed) && parsed[CRC_FIELD] !== legacyCrc(parsed))) {
      return { verdict: 'corrupt', record: null }   // CRC 不匹配：静默篡改/位腐烂
    }
    const { ...clean } = parsed
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 返回前剥离 __crc 载荷字段（调用方拿到的是纯 WalRecord）
    delete (clean as Record<string, unknown>)[CRC_FIELD]
    return { verdict: 'ok', record: clean as WalRecord }
  }
  return { verdict: 'ok', record: parsed }   // 旧版无 CRC 行：读取宽容
}

/** 解析并校验一行；返回 null = 该行损坏（语法或 CRC） */
function parseLine(line: string): WalRecord | null {
  return lineVerdict(line).record
}

/** 尾部修复报告 */
export interface WalTailRepair {
  /** 是否对文件做了物理修复（截断半行 / 补齐行尾换行） */
  readonly repaired: boolean
  /** 截掉的字节数（补换行场景为 0） */
  readonly truncatedBytes: number
  /** 修复后的完整记录集（与 replay 同一语义） */
  readonly records: readonly WalRecord[]
  /** 人类可读警告：repaired 时说明损坏细节，否则 null */
  readonly warning: string | null
}

/** createWal 的运行时能力集：IWal 契约的超集（只增不改，向后兼容） */
export interface WalRuntime extends IWal {
  /** 归档已终结事务：WAL 文件移入 archive/（幂等，可重复调用）。
   *  损坏文件（中间行/CRC）fail-closed 不归档 —— 无法确认事务真实
   *  状态，留在活跃区交由人工介入。返回本次归档的 txId 列表。 */
  archiveFinished(): Promise<Result<readonly TxId[]>>
  /** 尾部半行自动修复：截断到最后一行完整记录（含 fsync）。
   *  完整行损坏（CRC/结构）→ 拒绝修复保留现场（fail-closed）。 */
  repairTail(txId: TxId): Promise<Result<WalTailRepair>>
}

/** 活跃文件扫描结果：未终结判定与归档判定共用 */
interface ActiveScan {
  readonly txId: TxId
  readonly finished: boolean
  readonly corrupt: boolean
}

export function createWal(options: WalOptions): WalRuntime {
  fs.mkdirSync(options.walRoot, { recursive: true })
  const archiveDir = path.join(options.walRoot, 'archive')

  function safeTxId(txId: TxId): string {
    if (!TXID_RE.test(txId)) {
      // fail-closed：非法 txId 直接抛错，绝不参与路径拼接
      throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`)
    }
    return txId
  }

  function file(txId: TxId): string {
    return path.join(options.walRoot, `${safeTxId(txId)}.wal.jsonl`)
  }

  function archivedFile(txId: TxId): string {
    return path.join(archiveDir, `${safeTxId(txId)}.wal.jsonl`)
  }

  /** 活跃区扫描：unfinishedTxIds（未终结清单）与 archiveFinished（归档
   *  候选）共用的单一实现。archive/ 子目录不参与扫描（文件名不匹配
   *  .wal.jsonl 后缀的自然过滤 + 显式排除语义）。 */
  function scanActiveFiles(): ActiveScan[] {
    const out: ActiveScan[] = []
    let files: string[]
    try { files = fs.readdirSync(options.walRoot) } catch { return out }
    for (const f of files) {
      if (!f.endsWith('.wal.jsonl')) continue
      const txId = f.slice(0, -'.wal.jsonl'.length)
      if (!TXID_RE.test(txId)) continue   // 文件名注入：跳过，绝不进入恢复流程
      let text: string
      try {
        text = fs.readFileSync(path.join(options.walRoot, f), 'utf-8')
      } catch {
        continue   // 单文件 IO 错误不中断其余事务的恢复
      }
      const lines = text.split('\n').filter(l => l.trim().length > 0)
      let corruptMiddle = false
      let finished = false
      lines.forEach((l, i) => {
        const rec = parseLine(l)
        if (rec === null) {
          if (i !== lines.length - 1) corruptMiddle = true   // 中间行损坏（非尾部半行）
          return
        }
        if (rec.type === 'tx-commit' || rec.type === 'tx-rollback') finished = true
      })
      out.push({ txId: txId as TxId, finished, corrupt: corruptMiddle })
    }
    return out
  }

  return {
    async append(txId: TxId, record: WalRecord): Promise<void> {
      const p = file(txId)
      const line = JSON.stringify({ ...record, [CRC_FIELD]: computeCrc(record) } as CrcCarrier)
      // 新建文件检测：目录项本身需要 fsync 才能保证崩溃后"文件存在"这一
      // 事实落盘（create 持久性）。已存在文件的 append 不改目录项，跳过。
      // existsSync 与 open 之间的竞态最坏导致一次多余的目录 fsync，无害。
      const existed = fs.existsSync(p)
      const fd = fs.openSync(p, 'a')
      try {
        writeAllSync(fd, Buffer.from(line + '\n', 'utf-8'))
        fs.fdatasyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (!existed) fsyncDir(options.walRoot)
    },

    async replay(txId: TxId): Promise<readonly WalRecord[]> {
      let text: string
      try {
        text = fs.readFileSync(file(txId), 'utf-8')
      } catch {
        // 活跃区不存在/不可读 → 归档区（归档语义 = append-only 保留、可查询）
        try {
          text = fs.readFileSync(archivedFile(txId), 'utf-8')
        } catch {
          return []   // 两处皆不可读（含 existsSync 与 read 之间的 TOCTOU）
        }
      }
      const lines = text.split('\n').filter(l => l.trim().length > 0)
      const records: WalRecord[] = []
      let corruptMiddle = false
      for (const [i, line] of lines.entries()) {
        const rec = parseLine(line)
        if (rec === null) {
          if (i === lines.length - 1) break   // 尾部写半的行：崩溃残留，丢弃
          corruptMiddle = true
          break   // 中间行损坏（语法或 CRC）：疑似篡改，停止重放
        }
        records.push(rec)
      }
      if (corruptMiddle) {
        // 中间行损坏的事务不可信：返回空记录集，
        // recover() 将因找不到 step-intent 而跳过自动补偿（宁可保守也不误恢复）
        return []
      }
      return records
    },

    unfinishedTxIds(): TxId[] {
      // 只扫活跃文件：归档事务已终结，天然不属于恢复面
      return scanActiveFiles()
        .filter(s => !s.corrupt && !s.finished)
        .map(s => s.txId)
    },

    async archiveFinished(): Promise<Result<readonly TxId[]>> {
      try {
        const moved: TxId[] = []
        for (const s of scanActiveFiles()) {
          if (!s.finished || s.corrupt) continue   // 未终结/损坏：不归档（fail-closed）
          const from = file(s.txId)
          const to = archivedFile(s.txId)
          if (fs.existsSync(to)) {
            // 归档区已有同名 tx：覆盖会破坏 append-only 语义，跳过保现场
            continue
          }
          fs.mkdirSync(archiveDir, { recursive: true })
          fs.renameSync(from, to)
          moved.push(s.txId)
        }
        if (moved.length > 0) {
          // rename 持久性：源目录与目标目录的目录项变更都落盘
          fsyncDir(options.walRoot)
          fsyncDir(archiveDir)
        }
        return ok(moved)
      } catch (e) {
        return err(ioError('WAL 归档失败', e))
      }
    },

    async repairTail(txId: TxId): Promise<Result<WalTailRepair>> {
      // 目标解析：活跃区优先（进行中的文件），缺失再看归档区（同样可修复）
      let target: string
      let text: string
      try {
        target = file(txId)
        text = fs.readFileSync(target, 'utf-8')
      } catch {
        try {
          target = archivedFile(txId)
          text = fs.readFileSync(target, 'utf-8')
        } catch {
          // 文件不存在 = 无可修复之物（与 replay 的空文件语义一致）
          return ok({ repaired: false, truncatedBytes: 0, records: [], warning: null })
        }
      }
      const lines = text.split('\n')
      // 行游标：offset 始终指向本行行尾（含 \n）的字节偏移；
      // 最后一段物理上无 \n，其 +1 是虚拟值 —— 仅用于 complete 行，不外溢
      let offset = 0
      let lastGoodEnd = 0     // 最后一条"物理完整 + 解析完好"记录行尾的偏移
      const records: WalRecord[] = []
      let corruptReason: string | null = null
      let tailPartial = false
      let tailNeedsNewline = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const isFinalFragment = i === lines.length - 1
        offset += Buffer.byteLength(line, 'utf-8') + 1
        if (line.trim().length === 0) continue   // 空行：不产出记录，不视为损坏
        const v = lineVerdict(line)
        if (v.verdict === 'ok') {
          records.push(v.record!)
          if (isFinalFragment) {
            // 完好记录但无行尾换行：内容有效，但后续 append 会直接拼在其后
            // 造成两行粘连（之后被当作中间损坏处理）→ 需补一个 \n 规范化
            tailNeedsNewline = true
          } else {
            lastGoodEnd = offset
          }
        } else if (v.verdict === 'partial') {
          if (isFinalFragment) {
            tailPartial = true   // 物理尾部的崩溃半行：可安全截断
          } else {
            // 语法损坏却物理完整：不是崩溃残留（半行必在尾部）→ 疑似篡改
            corruptReason = `第 ${i + 1} 行语法损坏且非尾部半行（疑似篡改）`
          }
        } else {
          // 完整行损坏（CRC/结构）：绝不物理删除证据（fail-closed）
          corruptReason = `第 ${i + 1} 行 CRC/结构校验失败`
        }
        if (corruptReason !== null) break
      }
      if (corruptReason !== null) {
        return err({
          code: 'E_IO',
          message: `WAL 尾部修复拒绝（fail-closed）：${corruptReason}`,
          details: { file: target },
        })
      }
      // 情形一：尾部崩溃半行 → 截断到最后一行完整记录（fsync 持久化）
      if (tailPartial) {
        try {
          const fd = fs.openSync(target, 'r+')
          try {
            fs.ftruncateSync(fd, lastGoodEnd)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
        } catch (e) {
          return err(ioError('WAL 尾部截断失败', e))
        }
        const truncatedBytes = Buffer.byteLength(text, 'utf-8') - lastGoodEnd
        return ok({
          repaired: true,
          truncatedBytes,
          records,
          warning: `检测到尾部半行（${truncatedBytes} 字节崩溃残留），已截断到最后一行完整记录`,
        })
      }
      // 情形二：尾部完好记录缺换行 → 补 \n（防后续追加粘连），零截断
      if (tailNeedsNewline) {
        try {
          const fd = fs.openSync(target, 'a')
          try {
            writeAllSync(fd, Buffer.from('\n', 'utf-8'))
            fs.fdatasyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
        } catch (e) {
          return err(ioError('WAL 行尾规范化失败', e))
        }
        return ok({
          repaired: true,
          truncatedBytes: 0,
          records,
          warning: '尾部记录缺少换行符，已补齐（防后续追加粘连）',
        })
      }
      return ok({ repaired: false, truncatedBytes: 0, records, warning: null })
    },
  }
}

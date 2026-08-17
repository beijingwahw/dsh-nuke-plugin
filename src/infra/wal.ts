// src/infra/wal.ts — IWal 实现：JSONL 追加 + fdatasync + 崩溃重放 + CRC 完整性
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { TxId } from '../contracts/base'
import type { IWal, WalRecord } from '../contracts/transaction'

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
 */
// txId 白名单：字母数字与-_，长度 ≤ 64。含路径分隔符/点/空白的 txId 一律非法，
// 杜绝 "../etc/passwd" 式穿越（引擎生成的 txId 为 16 位 hex，天然满足）。
const TXID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CRC_FIELD = '__crc'

type CrcCarrier = WalRecord & { __crc?: string }

/** 规范化 CRC：键序稳定的 JSON 序列化后取 SHA-256 前 16 hex */
function computeCrc(record: WalRecord): string {
  const { ...rest } = record as CrcCarrier
  delete (rest as Record<string, unknown>)[CRC_FIELD]
  const canonical = JSON.stringify(rest, Object.keys(rest).sort())
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** 解析并校验一行；返回 null = 该行损坏（语法或 CRC） */
function parseLine(line: string): WalRecord | null {
  let parsed: CrcCarrier
  try {
    parsed = JSON.parse(line) as CrcCarrier
  } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') return null
  if (parsed[CRC_FIELD] !== undefined) {
    if (typeof parsed[CRC_FIELD] !== 'string' || parsed[CRC_FIELD] !== computeCrc(parsed)) {
      return null   // CRC 不匹配：静默篡改/位腐烂 → 按损坏处理
    }
    const { ...clean } = parsed
    delete (clean as Record<string, unknown>)[CRC_FIELD]
    return clean as WalRecord
  }
  return parsed   // 旧版无 CRC 行：读取宽容
}

export function createWal(options: WalOptions): IWal {
  fs.mkdirSync(options.walRoot, { recursive: true })

  function file(txId: TxId): string {
    if (!TXID_RE.test(txId)) {
      // fail-closed：非法 txId 直接抛错，绝不参与路径拼接
      throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`)
    }
    return path.join(options.walRoot, `${txId}.wal.jsonl`)
  }

  return {
    async append(txId: TxId, record: WalRecord): Promise<void> {
      const line = JSON.stringify({ ...record, [CRC_FIELD]: computeCrc(record) } as CrcCarrier)
      const fd = fs.openSync(file(txId), 'a')
      try {
        fs.writeSync(fd, line + '\n')
        fs.fdatasyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    },

    async replay(txId: TxId): Promise<readonly WalRecord[]> {
      const p = file(txId)
      let text: string
      try {
        text = fs.readFileSync(p, 'utf-8')
      } catch {
        return []   // 不存在/不可读（含 existsSync 与 read 之间的 TOCTOU）
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
      const out: TxId[] = []
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
        // 损坏文件不进入自动恢复：无法确认事务真实状态，人工介入
        if (corruptMiddle) continue
        if (!finished) out.push(txId as TxId)
      }
      return out
    },
  }
}

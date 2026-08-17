// src/infra/audit-log.ts — IAuditLog 实现：hash chain 不可变审计
// hash_n = sha256( hash_{n-1} ‖ canonicalJson(entry_n) )
// 任何对历史条目的修改/删除都会破坏链条，verify() 定位第一个断裂点。
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { TxId } from '../contracts/base'
import type {
  AuditEntry, ChainVerification, IAuditLog, HashedAuditEntry,
} from '../contracts/logging'
import { readJsonl, writeJsonAtomic } from './fs-utils'

export interface AuditLogOptions {
  readonly filePath: string   // <dshHome>/.nuke/audit/chain.jsonl
}

const GENESIS = '0'.repeat(16)

interface ChainHead {
  readonly seq: number
  readonly hash: string
}

/** 规范化 JSON：键排序 + 无空格，保证同一条目任何环境算出同一 hash */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',') + '}'
}

export function computeHash(prevHash: string, entry: Omit<AuditEntry, never>): string {
  return crypto.createHash('sha256')
    .update(prevHash + canonicalJson(entry))
    .digest('hex')
    .slice(0, 16)
}

export function createAuditLog(options: AuditLogOptions): IAuditLog {
  fs.mkdirSync(path.dirname(options.filePath), { recursive: true })
  if (!fs.existsSync(options.filePath)) fs.writeFileSync(options.filePath, '')

  /** 链尾哨兵文件：独立记录最后一次 append 的 seq/hash。
   *  单独删除链文件尾部不会破坏剩余链的连续性（尾条目无后继引用），
   *  哨兵使 verify() 能检出这种"抹除最近记录"的截断攻击。 */
  function headFile(): string {
    return options.filePath + '.head.json'
  }

  function readAll(): HashedAuditEntry[] {
    // 容错读取：损坏行（含崩溃残留半行）跳过而非抛错。
    // 被跳过的行会导致后续条目 seq 错位 → verify() 必然失败 → 篡改可检出。
    return readJsonl<HashedAuditEntry>(options.filePath) ?? []
  }

  // ─── 链尾内存缓存：append O(1) 的关键 ─────────────────────
  // 旧实现每次 append 都 readAll() 两次（lastHash + length），N 条链的总成本
  // 是 O(N²) 次 JSON.parse。缓存后仅在构造时加载一次；外部篡改链文件不在
  // 运行时威胁模型内（verify() 负责检出），query() 仍走全量读。
  const tail = (() => {
    const all = readAll()
    const last = all[all.length - 1]
    return { seq: all.length, hash: last?.hash ?? GENESIS }
  })()

  return {
    async append(entry: AuditEntry): Promise<HashedAuditEntry> {
      const prev = tail.hash
      const seq = tail.seq
      const hashed: HashedAuditEntry = {
        ...entry,
        seq,
        prevHash: prev,
        hash: computeHash(prev, entry),
      }
      tail.seq = seq + 1
      tail.hash = hashed.hash
      // append 模式 + fdatasync：审计链物理上的追加不可改写
      const fd = fs.openSync(options.filePath, 'a')
      try {
        fs.writeSync(fd, JSON.stringify(hashed) + '\n')
        fs.fdatasyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      // 链尾哨兵随每次 append 更新（原子写）
      writeJsonAtomic(headFile(), { seq: hashed.seq, hash: hashed.hash } satisfies ChainHead)
      return hashed
    },

    async verify(): Promise<ChainVerification> {
      const all = readAll()
      let prev = GENESIS
      for (const [i, e] of all.entries()) {
        // 重算哈希时剔除链自身字段，与 append 时的输入保持一致
        const { seq: _s, prevHash: _p, hash: _h, ...raw } = e
        if (e.seq !== i || e.prevHash !== prev || e.hash !== computeHash(prev, raw)) {
          return { valid: false, firstBrokenSeq: e.seq, totalEntries: all.length }
        }
        prev = e.hash
      }
      // 链尾哨兵比对：检出"删除尾部若干条"的截断攻击
      // （尾条目无后继引用，仅靠链式校验无法发现其缺失）
      if (fs.existsSync(headFile())) {
        let head: ChainHead | null = null
        try {
          head = JSON.parse(fs.readFileSync(headFile(), 'utf-8')) as ChainHead
        } catch { head = null }
        const last = all[all.length - 1]
        if (head && typeof head.seq === 'number' && typeof head.hash === 'string') {
          const expectedSeq = last ? last.seq : -1
          const expectedHash = last ? last.hash : GENESIS
          if (head.seq !== expectedSeq || head.hash !== expectedHash) {
            return { valid: false, firstBrokenSeq: null, totalEntries: all.length }
          }
        }
      }
      return { valid: true, firstBrokenSeq: null, totalEntries: all.length }
    },

    async query(filter: { txId?: TxId; actor?: string; since?: string }) {
      return readAll().filter(e =>
        (filter.txId === undefined || e.txId === filter.txId) &&
        (filter.actor === undefined || e.actor === filter.actor) &&
        (filter.since === undefined || e.timestamp >= filter.since),
      )
    },
  }
}

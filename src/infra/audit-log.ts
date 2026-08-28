// src/infra/audit-log.ts — IAuditLog 实现：hash chain 不可变审计
// hash_n = sha256( hash_{n-1} ‖ canonicalJson(entry_n) )
// 任何对历史条目的修改/删除都会破坏链条，verify() 定位第一个断裂点。
//
// 升级一（批量追加 appendMany）：N 条共享一次 open/fdatasync/哨兵原子写。
// fsync 是审计日志的主成本，批量场景每条摊销 O(1) 次落盘；单条 append
// 走同一条核心路径（1 条 = 批量的退化情形，行为不变）。
//
// 升级二（增量校验 verifyIncremental）：以 .head.json 哨兵（或调用方显式
// 给出的可信锚点）为界，只重算锚点之后的哈希。全量 verify 是 O(N) 次
// sha256；例行巡检/故障恢复场景"上次校验后只追加了少量条目"，增量路径
// 把重算量降到 O(新增)。
// 信任模型（诚实声明）：锚点之前的前缀被视为可信，其历史篡改不在增量
// 路径的检出范围内 —— 需要完整保证时用 verify()（全链语义，绝不缓存
// 哈希结果偷懒）。哨兵缺失/损坏时增量路径退化为全链重算（fail-closed）。
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

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

/** 增量校验的可信锚点：seq 及其对应的 hash（受信前缀的最后一行）。
 *  seq = -1 表示创世（锚点即 GENESIS，等价于全链重算）。 */
export interface VerifyCheckpoint {
  readonly seq: number
  readonly hash: string
}

/** createAuditLog 的运行时能力集：IAuditLog 契约的超集（只增不改，向后兼容） */
export interface AuditLogRuntime extends IAuditLog {
  /** 批量追加：全部条目拼接为一次写入，共享一次 fdatasync 与一次哨兵
   *  原子写。失败边界：写失败时整批不落地（内存链尾不推进，与磁盘
   *  保持一致）；成功时批内哈希链与逐条 append 完全同构。 */
  appendMany(entries: readonly AuditEntry[]): Promise<readonly HashedAuditEntry[]>
  /** 增量校验：从可信锚点（缺省 = .head.json 哨兵）之后重算哈希。
   *  显式锚点允许调用方从"指定 seq"起校验。返回结构与 verify() 同构。 */
  verifyIncremental(checkpoint?: VerifyCheckpoint): Promise<ChainVerification>
}

export function createAuditLog(options: AuditLogOptions): AuditLogRuntime {
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

  /** 读取哨兵：缺失/损坏/结构非法 → null（磁盘数据不可信纪律） */
  function readHead(): ChainHead | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(headFile(), 'utf-8')) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const h = parsed as Partial<ChainHead>
        if (typeof h.seq === 'number' && typeof h.hash === 'string') {
          return { seq: h.seq, hash: h.hash }
        }
      }
      return null
    } catch { return null }
  }

  /** 哨兵比对：检出"删除尾部若干条"的截断攻击（尾条目无后继引用，
   *  仅靠链式校验无法发现其缺失）。返回 null = 一致或哨兵不存在。 */
  function sentinelFailure(all: readonly HashedAuditEntry[]): ChainVerification | null {
    const head = readHead()
    if (head === null) return null
    const last = all[all.length - 1]
    const expectedSeq = last ? last.seq : -1
    const expectedHash = last ? last.hash : GENESIS
    if (head.seq !== expectedSeq || head.hash !== expectedHash) {
      return { valid: false, firstBrokenSeq: null, totalEntries: all.length }
    }
    return null
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

  /** 批量追加核心路径：单次 open + 单次 fdatasync + 单次哨兵写。
   *  append(1 条) 与 appendMany(N 条) 共用 —— 语义同构，成本随批量摊薄。 */
  async function appendManyCore(entries: readonly AuditEntry[]): Promise<readonly HashedAuditEntry[]> {
    if (entries.length === 0) return []
    const hashed: HashedAuditEntry[] = []
    const lines: string[] = []
    let prev = tail.hash
    let seq = tail.seq
    for (const entry of entries) {
      const h: HashedAuditEntry = {
        ...entry,
        seq,
        prevHash: prev,
        hash: computeHash(prev, entry),
      }
      hashed.push(h)
      lines.push(JSON.stringify(h) + '\n')
      prev = h.hash
      seq++
    }
    // 先落盘、后推进内存链尾：写失败时整批不落地，内存态与磁盘一致
    // （fail-closed；旧实现先推链尾再写盘，写失败会留下"内存超前"的错位）。
    // append 模式 + fdatasync：审计链物理上的追加不可改写
    const fd = fs.openSync(options.filePath, 'a')
    try {
      fs.writeSync(fd, lines.join(''))
      fs.fdatasyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    tail.seq = seq
    tail.hash = prev
    // 链尾哨兵随批量的最后一条更新（原子写）
    const last = hashed[hashed.length - 1]!
    writeJsonAtomic(headFile(), { seq: last.seq, hash: last.hash } satisfies ChainHead)
    return hashed
  }

  return {
    async append(entry: AuditEntry): Promise<HashedAuditEntry> {
      const [first] = await appendManyCore([entry])
      return first!
    },

    appendMany: appendManyCore,

    async verify(): Promise<ChainVerification> {
      const all = readAll()
      let prev = GENESIS
      for (const [i, e] of all.entries()) {
        // 重算哈希时剔除链自身字段，与 append 时的输入保持一致
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest 解构剔除 seq/prevHash/hash 是惯用法，被剔除的兄弟变量是该模式的固有噪音
        const { seq: _s, prevHash: _p, hash: _h, ...raw } = e
        if (e.seq !== i || e.prevHash !== prev || e.hash !== computeHash(prev, raw)) {
          return { valid: false, firstBrokenSeq: e.seq, totalEntries: all.length }
        }
        prev = e.hash
      }
      return sentinelFailure(all) ?? { valid: true, firstBrokenSeq: null, totalEntries: all.length }
    },

    async verifyIncremental(checkpoint?: VerifyCheckpoint): Promise<ChainVerification> {
      const all = readAll()
      // 第一步（廉价，零哈希重算）：全链 seq 连续性。任何位置的增删都会
      // 让 seq 与行下标错位 —— 先用 O(N) 次整数比较兜住结构完整性
      for (const [i, e] of all.entries()) {
        if (e.seq !== i) {
          return { valid: false, firstBrokenSeq: e.seq, totalEntries: all.length }
        }
      }
      // 第二步：锚点解析。优先级 = 显式指定 > .head.json 哨兵 > 创世。
      // 哨兵缺失/损坏 → 退化为全链重算（fail-closed，绝不因哨兵不可用而放水）
      let anchorSeq: number
      let anchorHash: string
      if (checkpoint !== undefined) {
        anchorSeq = checkpoint.seq
        anchorHash = checkpoint.hash
      } else {
        const head = readHead()
        anchorSeq = head?.seq ?? -1
        anchorHash = head?.hash ?? GENESIS
      }
      if (anchorSeq < -1 || anchorSeq >= all.length) {
        // 锚点越界：哨兵高于链长 = 尾部被截断；显式锚点非法同判
        return { valid: false, firstBrokenSeq: null, totalEntries: all.length }
      }
      if (anchorSeq >= 0 && all[anchorSeq]!.hash !== anchorHash) {
        // 锚点行自身与受信哈希不符：受信前缀已被改动 → fail-closed
        return { valid: false, firstBrokenSeq: anchorSeq, totalEntries: all.length }
      }
      // 第三步（增量主体）：只重算锚点之后的哈希，跳过受信前缀的
      // O(anchor) 次 sha256 —— 增量校验的全部收益所在
      let prev = anchorHash
      for (let i = anchorSeq + 1; i < all.length; i++) {
        const e = all[i]!
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同 verify()：rest 解构剔除链自身字段，兄弟变量是固有噪音
        const { seq: _s, prevHash: _p, hash: _h, ...raw } = e
        if (e.prevHash !== prev || e.hash !== computeHash(prev, raw)) {
          return { valid: false, firstBrokenSeq: e.seq, totalEntries: all.length }
        }
        prev = e.hash
      }
      // 第四步：哨兵比对（截断攻击检出，与 verify() 共用同一实现）
      return sentinelFailure(all) ?? { valid: true, firstBrokenSeq: null, totalEntries: all.length }
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

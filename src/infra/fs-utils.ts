// src/infra/fs-utils.ts — 全项目唯一的文件系统小工具集
// 质量纪律：任何 fs 操作模式（递归体积/原子写/JSONL 容错读）只允许在此实现一次。
// 所有 engine/infra 组件从这里导入 —— 修一处 = 修全局。
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/** 递归目录体积（符号链接不跟随；读不到的条目按 0 计）。
 *  入口 lstat 防护 + 深度上限：传入符号链接返回 0（防 symlink→/ 的全盘递归 DoS），
 *  超过 64 层深视为异常结构直接停止。 */
export function dirSize(p: string): number {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return 0
  } catch { return 0 }
  let total = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 64) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile()) { try { total += fs.statSync(full).size } catch {} }
    }
  }
  walk(p, 0)
  return total
}

/** 目录统计（V5）：一次遍历同时产出总体积与文件数 —— 供 preview 填充
 *  OperationPlan.fileCount（策略守卫 maxFilesPerTx 的数据源），避免
 *  "dirSize 一遍 + 计数一遍" 的双倍遍历。遍历纪律与 dirSize 完全一致：
 *  符号链接不跟随、深度上限 64、读不到的条目按 0/不计。 */
export function dirStats(p: string): { bytes: number; fileCount: number } {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return { bytes: 0, fileCount: 0 }
  } catch { return { bytes: 0, fileCount: 0 } }
  let bytes = 0
  let fileCount = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 64) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile()) {
        fileCount++
        try { bytes += fs.statSync(full).size } catch { /* 读不到按 0 计 */ }
      }
    }
  }
  walk(p, 0)
  return { bytes, fileCount }
}

export function existsSafe(p: string): boolean {
  try { return fs.existsSync(p) } catch { return false }
}

/** statfs 磁盘采样（Node ≥18.15）：free = bsize×bavail，total = bsize×blocks。
 *  旧 Node（API 缺失抛 TypeError）/ 无权限 / 路径不存在 → null（fail-soft，
 *  调用方按"磁盘信息不可用"降级，绝不阻断主流程）。全项目唯一实现。 */
export function statfsBytes(root: string): { free: number; total: number } | null {
  try {
    const st = fs.statfsSync(root)
    return {
      free: st.bsize * st.bavail,
      total: st.bsize * st.blocks,
    }
  } catch { return null }
}

/** 进程崩溃安全的唯一临时文件名：同进程并发不撞车 */
function tmpName(dst: string): string {
  return `${dst}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * 原子复制：tmp + rename，中断不留半写文件于目标位。
 * 自动创建父目录；返回目标文件字节数。失败路径清理 tmp（防半写残留堆积）。
 */
export function copyAtomic(src: string, dst: string): number {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const tmp = tmpName(dst)
  try {
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, dst)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* tmp 未创建或已被 rename 移走 */ }
    throw e
  }
  return fs.statSync(dst).size
}

/** 原子写文本（UTF-8）：配置/meta 落盘统一入口。失败路径清理 tmp。 */
export function writeTextAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = tmpName(file)
  try {
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 同上 */ }
    throw e
  }
}

/** 原子写 JSON（2 空格缩进，确定性输出） */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2))
}

/**
 * 容错式 JSONL 读取：逐行解析，损坏行（含崩溃残留的尾部半行）跳过。
 * 返回 null 表示文件不存在/不可读。
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- JSON 解析边界：调用方以 readJsonl<T> 声明对磁盘数据的预期形状，T 单次出现在返回位是该模式的固有形态
export function readJsonl<T>(file: string): T[] | null {
  let text: string
  try { text = fs.readFileSync(file, 'utf-8') } catch { return null }
  const out: T[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { out.push(JSON.parse(trimmed) as T) } catch { /* 半行容错 */ }
  }
  return out
}

/** 追加一行 JSON（自动建目录） */
export function appendJsonl(file: string, entry: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
}

// ─── 统一遍历原语：全项目唯一的目录树行走 ─────────────────────
// 此前 dirSize / dirSizeAsync / hashDir / TEMP 扫描各写一份"readdir + 递归 +
// 深度上限 + symlink 跳过"，语义漂移是必然。walk 以 AsyncIterable 流式输出，
// 消费方（体积统计/哈希/扫描）只写业务判断，遍历纪律收敛于此一处。

export type WalkEntryKind = 'dir' | 'file' | 'symlink' | 'other'

export interface WalkEntry {
  readonly path: string
  readonly name: string
  /** 相对 root 的深度：root 直接子项为 1 */
  readonly depth: number
  readonly kind: WalkEntryKind
}

export interface WalkOptions {
  /** 中止信号：置位后立即停止产出与下降（已产出条目不受影响）。
   *  显式 undefined 合法（exactOptionalPropertyTypes 下允许调用方透传可选信号） */
  readonly signal?: AbortSignal | undefined
  /** 条目最大深度（含）：直接子项为 1。默认 64（与 dirSize 深度纪律同源） */
  readonly maxDepth?: number
  /** 跳过符号链接条目（默认 true）。false 时产出 symlink 条目但【绝不】下降
   *  进入 —— 防 symlink→/ 的全盘递归 DoS 是不可协商的安全底线 */
  readonly skipSymlinks?: boolean
  /** 错误容忍回调：某目录读失败时上报（dir, error）后跳过该子树，不抛错。
   *  fail-soft 语义与 dirSize"读不到按 0 计"一脉相承 */
  readonly onEntryError?: (dir: string, e: unknown) => void
}

function kindOf(e: fs.Dirent): WalkEntryKind {
  if (e.isDirectory()) return 'dir'
  if (e.isFile()) return 'file'
  if (e.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * 统一目录遍历原语：流式（AsyncIterable）产出条目，内存 O(1)。
 * 顺序确定：同一目录的直接条目按名字序（localeCompare）连续产出（先序：
 * 目录先于其子孙产出）；某目录条目全部产出后，再按名字序逐个下降子目录。
 * root 本身不产出，只产出其后代。
 */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry, void, void> {
  const maxDepth = options.maxDepth ?? 64
  const skipSymlinks = options.skipSymlinks ?? true
  const signal = options.signal
  interface Frame { readonly dir: string; readonly childDepth: number }
  const stack: Frame[] = [{ dir: root, childDepth: 1 }]
  while (stack.length > 0) {
    if (signal?.aborted) return
    const frame = stack.pop()!
    if (frame.childDepth > maxDepth) continue   // 超深：异常结构，停止下降
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(frame.dir, { withFileTypes: true })
    } catch (e) {
      // 读不到的子树跳过（fail-soft）；root 读失败 = 空遍历
      options.onEntryError?.(frame.dir, e)
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const subdirs: string[] = []
    for (const e of entries) {
      if (signal?.aborted) return
      const kind = kindOf(e)
      if (kind === 'symlink' && skipSymlinks) continue
      const full = path.join(frame.dir, e.name)
      yield { path: full, name: e.name, depth: frame.childDepth, kind }
      // 只对真实目录下降；symlink 即便产出也绝不进入（见 WalkOptions 注释）
      if (kind === 'dir') subdirs.push(full)
    }
    // 逆序压栈：名字序靠前的子目录先出栈（保持确定性先序）
    for (let i = subdirs.length - 1; i >= 0; i--) {
      stack.push({ dir: subdirs[i]!, childDepth: frame.childDepth + 1 })
    }
  }
}

// ─── 瞬态错误退避重试：EMFILE/ENFILE/EBUSY 类有限次重试 ────────
// 句柄耗尽（EMFILE/ENFILE）与 Windows 文件占用（EBUSY）是典型瞬态：
// 立即失败会把可自愈的 IO 抖动升级为用户可见错误。指数退避 + 有限次，
// 非瞬态错误立即透传（不做无意义重试）。

export const TRANSIENT_ERRNO_CODES: readonly string[] = [
  'EMFILE',   // 进程级句柄耗尽
  'ENFILE',   // 系统级文件表满
  'EBUSY',    // 资源占用（Windows 常见）
  'EAGAIN',   // 资源暂不可用
  'ETXTBSY',  // 文本段占用中写入
  'EINTR',    // 被信号打断的系统调用
]

export interface TransientRetryOptions {
  /** 重试次数上限（不含首次执行），默认 3 */
  readonly retries?: number
  /** 首次退避基准（ms），默认 10；第 k 次重试前等待 base×2^k */
  readonly baseDelayMs?: number
  /** 单次退避上限（ms），默认 200 */
  readonly maxDelayMs?: number
  /** 视为瞬态的错误码集合，默认 TRANSIENT_ERRNO_CODES */
  readonly codes?: readonly string[]
  /** 中止信号：置位后不再重试，直接抛出当前错误 */
  readonly signal?: AbortSignal
}

/** 错误是否属于给定瞬态码集合（非 Error / 无 code 一律非瞬态） */
export function isTransientError(e: unknown, codes: readonly string[] = TRANSIENT_ERRNO_CODES): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && codes.includes(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 瞬态错误退避重试：fn 抛出瞬态错误时按指数退避有限次重试。
 *  重试耗尽 / 非瞬态错误 / 已中止 → 原样抛出最后一次错误。 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 10
  const maxDelayMs = options.maxDelayMs ?? 200
  const codes = options.codes ?? TRANSIENT_ERRNO_CODES
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (options.signal?.aborted) throw e
      // 首次失败后的第 attempt 次重试前需为瞬态且未超限，否则原样抛出
      if (!isTransientError(e, codes) || attempt >= retries) throw e
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt))
    }
  }
}

/** 目录条目 fsync：rename / 新建文件后持久化目录项本身。
 *  fail-soft：部分平台/文件系统不支持目录 fsync，失败静默降级
 *  （持久性是尽力而为的加强项，不是正确性前提）。 */
export function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* 平台不支持 / 目录已消失：降级为无目录级持久性保证 */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 关闭失败不影响主流程 */ }
    }
  }
}

// ─── 有界并发池：全项目并行 I/O 的统一基建 ─────────────────
// 突破点：磁盘扫描/哈希/体积统计从串行（一次一个 syscall）变为
// 有界并发（默认 8 路在途），SSD/NVMe 上接近线性加速。
// 上界保证：不产生无限制句柄/内存；顺序不保证（调用方自行排序）。

export const DEFAULT_IO_CONCURRENCY = 8

/** 有界并发 map：保持输入顺序的输出；fn 抛错该项为 rejected（不炸整池） */
export async function forEachPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let cursor = 0
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1))
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!, i) }
      } catch (e) {
        results[i] = { status: 'rejected', reason: e }
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, worker))
  return results
}

/** 流式目录体积（dirSize 的异步版，签名不变）：基于统一遍历原语 walk，
 *  单次遍历 O(1) 内存产出累计值，支持 AbortSignal 中止。
 *  语义与 dirSize 一致：符号链接不跟随（计 0）、读不到按 0、深度上限 64。
 *  concurrency 参数保留仅为签名兼容 —— statSync 是同步调用，
 *  并发池并不产生真实并行收益，流式单轨反而是更诚实的实现。 */
export async function dirSizeAsync(
  p: string,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<number> {
  void opts.concurrency
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return 0
  } catch { return 0 }
  let total = 0
  for await (const e of walk(p, {
    maxDepth: 64,
    skipSymlinks: true,
    signal: opts.signal,
    onEntryError: () => { /* 读不到的子树按 0 计（与 dirSize 一致） */ },
  })) {
    if (e.kind === 'file') {
      try { total += fs.statSync(e.path).size } catch { /* 读不到的文件按 0 计 */ }
    }
  }
  return total
}

// ─── TEMP 孤儿扫描：全项目唯一实现 ─────────────────────────
// 此前 residual-scanner / orphan-detector / fs-ops(purge-temp) 三处各持
// 一份"标记正则 + mtime + 期限 + 体积"的相同遍历 —— 修一处漏两处的经典温床。

export interface TempOrphanEntry {
  readonly path: string
  readonly isDir: boolean
  readonly sizeBytes: number
  readonly ageDays: number
}

/** TEMP 根目录下带 dsh 痕迹且超过 maxAgeDays 的条目，按体积降序。
 *  符号链接不跟随（statSync 遵循链接，故先用 lstat 排除）。 */
export function tempOrphanEntries(
  tempRoot: string,
  maxAgeDays: number,
  now: () => Date,
  markerRe = /dsh|deepseek|cordis/i,
): TempOrphanEntry[] {
  const out: TempOrphanEntry[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(tempRoot, { withFileTypes: true }) } catch { return out }
  const nowMs = now().getTime()
  for (const e of entries) {
    if (!markerRe.test(e.name)) continue
    const full = path.join(tempRoot, e.name)
    try {
      // lstat 排除符号链接：statSync 会跟随链接，symlink→大目录 = 误报体积
      const lst = fs.lstatSync(full)
      if (lst.isSymbolicLink()) continue
      const st = fs.statSync(full)
      const ageDays = (nowMs - st.mtimeMs) / 86_400_000
      if (ageDays >= maxAgeDays) {
        out.push({
          path: full,
          isDir: lst.isDirectory(),
          sizeBytes: lst.isDirectory() ? dirSize(full) : st.size,
          ageDays,
        })
      }
    } catch {}
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

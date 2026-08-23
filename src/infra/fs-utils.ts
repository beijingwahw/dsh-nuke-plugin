// src/infra/fs-utils.ts — 全项目唯一的文件系统小工具集
// 质量纪律：任何 fs 操作模式（递归体积/原子写/JSONL 容错读）只允许在此实现一次。
// 所有 engine/infra 组件从这里导入 —— 修一处 = 修全局。
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

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

export function existsSafe(p: string): boolean {
  try { return fs.existsSync(p) } catch { return false }
}

/** statfs 磁盘采样（Node ≥18.15）：free = bsize×bavail，total = bsize×blocks。
 *  旧 Node（API 缺失抛 TypeError）/ 无权限 / 路径不存在 → null（fail-soft，
 *  调用方按"磁盘信息不可用"降级，绝不阻断主流程）。全项目唯一实现。 */
export function statfsBytes(root: string): { free: number; total: number } | null {
  try {
    const st = fs.statfsSync(root)
    if (!st) return null
    return {
      free: Number(st.bsize) * Number(st.bavail),
      total: Number(st.bsize) * Number(st.blocks),
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
export function appendJsonl<T>(file: string, entry: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
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

/** 并行目录体积（dirSize 的并发版）：目录读经并发池分发。
 *  语义与 dirSize 一致：符号链接不跟随、读不到按 0、深度上限 64。 */
export async function dirSizeAsync(
  p: string,
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const concurrency = opts.concurrency ?? DEFAULT_IO_CONCURRENCY
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return 0
  } catch { return 0 }
  let total = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 64 || opts.signal?.aborted) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    const subdirs: string[] = []
    await forEachPool(entries, concurrency, async e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) subdirs.push(full)
      else if (e.isFile()) { try { total += fs.statSync(full).size } catch {} }
    })
    await forEachPool(subdirs, concurrency, sub => walk(sub, depth + 1))
  }
  await walk(p, 0)
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
  markerRe: RegExp = /dsh|deepseek|cordis/i,
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

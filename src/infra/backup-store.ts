// src/infra/backup-store.ts — IBackupStore 实现：回收区代替物理删除
// 三种备份形态：
//   file-copy  配置文件：复制留档
//   dir-move   目录：fs.renameSync 原子移入回收区（O(1)、可逆）
//   yaml-edit  配置编辑：先存原内容快照，再写新内容（写前 fsync）
// 安全纪律：
//   1. txId 白名单校验（与 WAL 同源）—— purge 是递归 rm，绝不接受路径拼接输入
//   2. stage* 的副作用与 manifest 落盘必须同生共死：manifest 写失败即反向补偿
//      副作用，否则"原位已移走 + 备份无记录"会让恢复流程销毁唯一数据副本
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { AbsolutePath, NukeError, Result, TxId } from '../contracts/base'
import { err, ioError, ok } from '../contracts/base'
import type {
  BackupArea, BackupRecord, FileFingerprint, IBackupStore,
} from '../contracts/transaction'
import { dirSize, readJsonl } from './fs-utils'

// 与 wal.ts 同源的白名单：字母数字与-_，长度 ≤ 64；路径分隔符/点/空白一律非法
const TXID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface BackupStoreOptions {
  readonly backupRoot: string   // <dshHome>/.nuke/backups
  readonly now?: () => Date
}

export function createBackupStore(options: BackupStoreOptions): IBackupStore {

  fs.mkdirSync(options.backupRoot, { recursive: true })

  function hashFile(p: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)
  }

  function hashString(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, 16)
  }

  /** 目录指纹：按序累积全部文件内容哈希（结构敏感，与旧 fingerprint.ts 一致） */
  function hashDir(p: string): string {
    const h = crypto.createHash('sha256')
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.isFile()) h.update(fs.readFileSync(full))
      }
    }
    walk(p)
    return h.digest('hex').slice(0, 16)
  }

  function fingerprintOf(p: string, content?: string): FileFingerprint {
    const stat = fs.statSync(p)
    if (stat.isDirectory()) {
      return {
        path: p as AbsolutePath,
        hash: hashDir(p),
        size: dirSize(p),
        mtime: Math.floor(stat.mtimeMs),
      }
    }
    return {
      path: p as AbsolutePath,
      hash: content !== undefined ? hashString(content) : hashFile(p),
      size: content !== undefined ? Buffer.byteLength(content) : stat.size,
      mtime: Math.floor(stat.mtimeMs),
    }
  }

  function txArea(txId: TxId): string {
    // fail-closed：purge 是递归 rm，txId 绝不参与未校验的路径拼接（防 "../" 穿越）
    if (!TXID_RE.test(txId)) {
      throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`)
    }
    return path.join(options.backupRoot, txId)
  }

  function manifestFile(txId: TxId): string {
    return path.join(txArea(txId), 'manifest.jsonl')
  }

  function appendManifest(txId: TxId, record: BackupRecord): void {
    const fd = fs.openSync(manifestFile(txId), 'a')
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n')
      fs.fdatasyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  function writeSync(p: string, content: string): void {
    const fd = fs.openSync(p, 'w')
    try {
      fs.writeSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  return {
    async reserve(txId: TxId): Promise<BackupArea> {
      fs.mkdirSync(txArea(txId), { recursive: true })

      /** manifest 读取的闭包级实现（对象字面量方法间不能互相按名调用） */
      const readManifest = (): readonly BackupRecord[] => {
        const p = manifestFile(txId)
        if (!fs.existsSync(p)) return []
        // 容错读取：崩溃残留半行跳过而非抛错（与 fs-utils JSONL 纪律一致）
        return readJsonl<BackupRecord>(p) ?? []
      }

      const area: BackupArea = {
        async stageFile(original: AbsolutePath): Promise<BackupRecord> {
          const backupPath = path.join(txArea(txId), `f-${counter()}-${path.basename(original)}`) as AbsolutePath
          fs.copyFileSync(original, backupPath)
          const record: BackupRecord = {
            operationId: counter(),
            kind: 'file-copy',
            originalPath: original,
            backupPath,
            fingerprint: fingerprintOf(backupPath),
          }
          try {
            appendManifest(txId, record)
          } catch (e) {
            // 原位未动：清掉备份即完全回退，绝不留"无记录的产物"
            try { fs.unlinkSync(backupPath) } catch { /* 已不存在 */ }
            throw e
          }
          return record
        },

        async stageDir(original: AbsolutePath): Promise<BackupRecord> {
          // 原子移入回收区：rename 跨设备时回退 copy+rm（仍在回收区语义内）。
          // 纪律：manifest 落盘成功之后才允许 rm 原位 —— cp 路径下一旦
          // manifest 失败，备份删除即回到干净状态，原位始终完好。
          const backupPath = path.join(txArea(txId), `d-${counter()}-${path.basename(original)}`) as AbsolutePath
          let movedByRename = false
          try {
            fs.renameSync(original, backupPath)
            movedByRename = true
          } catch {
            try {
              fs.cpSync(original, backupPath, { recursive: true })
            } catch (e) {
              try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch { /* 残留交由 orphan 守卫 */ }
              throw e   // 原位未动，半写备份已清理
            }
          }
          const record: BackupRecord = {
            operationId: counter(),
            kind: 'dir-move',
            originalPath: original,
            backupPath,
            fingerprint: fingerprintOf(backupPath),
          }
          try {
            appendManifest(txId, record)
          } catch (e) {
            // manifest 失败：把数据放回原位（rename 反向 / cp 反向），不留孤儿
            if (movedByRename) {
              try { fs.renameSync(backupPath, original) } catch { /* 保底留给 orphan 守卫 */ }
            } else {
              try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch { /* 同上 */ }
            }
            throw e
          }
          if (!movedByRename) {
            // manifest 已持久化：此刻起备份可恢复，才允许移除原位
            fs.rmSync(original, { recursive: true, force: true })
          }
          return record
        },

        async stageEdit(original: AbsolutePath, nextContent: string): Promise<BackupRecord> {
          const backupPath = path.join(txArea(txId), `e-${counter()}-${path.basename(original)}`) as AbsolutePath
          const originalContent = fs.readFileSync(original, 'utf-8')
          writeSync(backupPath, originalContent)   // 原内容先落盘 + fsync
          writeSync(original, nextContent)          // 再写新内容
          const record: BackupRecord = {
            operationId: counter(),
            kind: 'yaml-edit',
            originalPath: original,
            backupPath,
            fingerprint: fingerprintOf(backupPath, originalContent),
            originalContent,
          }
          try {
            appendManifest(txId, record)
          } catch (e) {
            // 原位已被改写：立即写回原内容，恢复 stage 前状态
            writeSync(original, originalContent)
            try { fs.unlinkSync(backupPath) } catch { /* 已不存在 */ }
            throw e
          }
          return record
        },

        async restore(record: BackupRecord): Promise<Result<void, NukeError>> {
          // 恢复前校验备份产物未被篡改（hash 与备份时不一致 → 拒绝恢复并报错）
          try {
            if (!fs.existsSync(record.backupPath)) {
              // dir-move 幂等：备份已被移回原位 = 已恢复过，重复调用视为成功
              if (record.kind === 'dir-move' && fs.existsSync(record.originalPath)) {
                return ok(undefined)
              }
              return err({ code: 'E_IO', message: `备份产物不存在: ${record.backupPath}` })
            }
            const currentHash = record.kind === 'dir-move'
              ? hashDir(record.backupPath)
              : record.originalContent !== undefined
                ? hashString(fs.readFileSync(record.backupPath, 'utf-8'))
                : hashFile(record.backupPath)
            if (currentHash !== record.fingerprint.hash) {
              return err({
                code: 'E_IO',
                message: `备份被篡改，拒绝恢复: ${record.backupPath}`,
                details: { expected: record.fingerprint.hash, actual: currentHash },
              })
            }
            switch (record.kind) {
              case 'file-copy':
                fs.copyFileSync(record.backupPath, record.originalPath)
                break
              case 'dir-move':
                // 防静默覆盖：stage 后若原位被重建（如重新生成的 node_modules），
                // 恢复会销毁新内容 —— 拒绝并交由人工决策，绝不rename覆盖
                if (fs.existsSync(record.originalPath)) {
                  return err({
                    code: 'E_IO',
                    message: `原位已存在新内容，拒绝覆盖式恢复: ${record.originalPath}`,
                  })
                }
                try {
                  fs.renameSync(record.backupPath, record.originalPath)
                } catch {
                  fs.cpSync(record.backupPath, record.originalPath, { recursive: true })
                  fs.rmSync(record.backupPath, { recursive: true, force: true })
                }
                break
              case 'yaml-edit':
                writeSync(record.originalPath, record.originalContent
                  ?? fs.readFileSync(record.backupPath, 'utf-8'))
                break
            }
            return ok(undefined)
          } catch (e) {
            return err(ioError('恢复失败', e))
          }
        },

        manifest(): readonly BackupRecord[] {
          return readManifest()
        },

        orphanArtifacts(): number {
          // purge 守卫：清点备份区中未被 manifest 记录的产物。崩溃窗口
          // （副作用已发生、manifest 未落盘）留下的产物可能是数据唯一副本。
          const area = txArea(txId)
          let entries: string[]
          try { entries = fs.readdirSync(area) } catch { return 0 }
          const known = new Set(readManifest().map(r => path.basename(r.backupPath)))
          known.add('manifest.jsonl')
          return entries.filter(name => !known.has(name)).length
        },

        async purge(txId: TxId): Promise<Result<void, NukeError>> {
          try {
            fs.rmSync(txArea(txId), { recursive: true, force: true })
            return ok(undefined)
          } catch (e) {
            return err(ioError('清理备份区失败', e))
          }
        },
      }
      return area
    },
  }

  /** 备份产物唯一后缀（随机 hex：同事务内多文件备份不撞名） */
  function counter(): string {
    return crypto.randomBytes(6).toString('hex')
  }
}

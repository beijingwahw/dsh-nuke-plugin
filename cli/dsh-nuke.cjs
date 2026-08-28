#!/usr/bin/env node
// dsh-nuke CLI V4 — DeepSeek Harness 插件强力卸载工具
// 零依赖，仅需 Node.js。dsh 系统崩溃时仍可运行。
// 与插件版共享 V4 锁协议（.nuke/locks/）与备份、日志、快照目录 —— 并发清理真正互斥。
// V4 升级：锁协议对齐插件版（O_EXCL + bootToken + 安全破锁）· --json 机器可读输出
//          --version · 崩溃兜底 · symlink/深度防护遍历 · 瞬态 IO 重试 · 修复 strategies undefined 缺陷

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ═══════════════════════════════════════════════════════════
//  基础工具
// ═══════════════════════════════════════════════════════════

const DSH_HOME = process.env.DSH_HOME

  || path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh');

const c = {
  red:    s => `\x1b[31m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

const SAFE_RE = /^[a-z0-9@/\-_.]+$/;
function assertSafe(value, label) {
  if (!SAFE_RE.test(value)) {
    console.error(c.red(`❌ ${label} 包含非法字符: "${value}"`));
    process.exit(1);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// 遍历纪律（与插件版 fs-utils 对齐）：不走 symlink（防逃逸与环）、限制深度（防病态深目录拖死）
const MAX_WALK_DEPTH = 64;

// 瞬态错误集合（与插件版 TRANSIENT_ERRNO_CODES 同源）：这类失败退避重试通常可自愈
const TRANSIENT_ERRNOS = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN', 'EINTR']);

/** 同步瞬态重试：指数退避（25ms → 100ms 封顶）。仅包装关键 IO，非瞬态错误立即抛出 */
function withRetrySync(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      const code = e && e.code;
      if (i >= attempts - 1 || !TRANSIENT_ERRNOS.has(code)) throw e;
      const delay = Math.min(25 * Math.pow(2, i), 100);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); // 同步 sleep
    }
  }
}

function dirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const stack = [{ dir: dirPath, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_WALK_DEPTH) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // entry.isSymbolicLink() 显式排除：symlink 目录既不下钻也不计体积（防逃逸/防环）
        if (entry.isFile()) { try { total += fs.statSync(full).size; } catch {} }
        else if (entry.isDirectory() && !entry.isSymbolicLink()) { stack.push({ dir: full, depth: depth + 1 }); }
      }
    } catch {}
  }
  return total;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}

function hashDir(dirPath) {
  const hash = crypto.createHash('sha256');
  walkDir(dirPath, f => hash.update(fs.readFileSync(f)));
  return hash.digest('hex').slice(0, 16);
}

function walkDir(dir, cb, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // 不沿 symlink 下钻：目录环（a→b→a）会在深度限制内绕死进程
      if (entry.isDirectory() && !entry.isSymbolicLink()) walkDir(full, cb, depth + 1);
      else if (entry.isFile()) cb(full);
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════
//  日志
// ═══════════════════════════════════════════════════════════

function log(action, detail) {
  const dir = path.join(DSH_HOME, '.nuke-logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(file, `[${new Date().toISOString()}] [${action}] ${detail}\n`);
}

// ═══════════════════════════════════════════════════════════
//  备份
// ═══════════════════════════════════════════════════════════

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(DSH_HOME, '.nuke-backups');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(filePath)}.${ts}.bak`);
  fs.copyFileSync(filePath, dest);
  log('BACKUP', `${filePath} → ${dest}`);
  return dest;
}

// ═══════════════════════════════════════════════════════════
//  并发锁（与插件版共享）
// ═══════════════════════════════════════════════════════════

const LOCK_DIR = path.join(DSH_HOME, '.nuke', 'locks');
const LOCK_FILE = path.join(LOCK_DIR, 'global.lock');       // CLI 全局独占锁（V4 协议）
const LEGACY_LOCK_FILE = path.join(DSH_HOME, '.nuke.lock'); // V3 遗留锁（兼容探测）
const LOCK_TTL_MS = 300000;
const CLI_BOOT_TOKEN = `cli-${crypto.randomBytes(8).toString('hex')}`;

/** 进程存活探测（与插件版 ProcessProbe 同语义：pid + hostname 双重核验） */
function isProcessAlive(pid, hostname) {
  if (hostname && hostname !== os.hostname()) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 读取 V4 锁文件（结构非法视为无锁） */
function readV4Lock(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.owners)) return null;
    return parsed;
  } catch { return null; }
}

/** 判断一个 V4 锁文件是否存在"活跃"持有者（未过期且进程存活） */
function hasActiveOwner(lock) {
  if (!lock) return false;
  const now = Date.now();
  return lock.owners.some(o => {
    const alive = o.owner && typeof o.owner.pid === 'number' && isProcessAlive(o.owner.pid, o.owner.hostname);
    return o.expiresAt > now && alive;
  });
}

/** 扫描插件版/CLI 留下的全部 V4 锁，返回活跃锁描述（供互斥判断与提示） */
function findActiveV4Locks() {
  const active = [];
  try {
    for (const f of fs.readdirSync(LOCK_DIR)) {
      if (!f.endsWith('.lock')) continue;
      const p = path.join(LOCK_DIR, f);
      const lock = readV4Lock(p);
      if (hasActiveOwner(lock)) {
        const o = lock.owners[0].owner;
        active.push({ file: f, pid: o.pid, purpose: o.purpose || 'unknown' });
      }
    }
  } catch {}
  return active;
}

/** 安全破锁：所有 owner 均过期且死亡 → 清除；任一活跃 → 返回 false */
function breakStaleV4Lock(p) {
  const lock = readV4Lock(p);
  if (!lock) return true; // 已消失
  if (hasActiveOwner(lock)) return false;
  try { fs.unlinkSync(p); } catch {}
  return true;
}

function acquireLock(operation) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  // 1) V3 遗留锁兼容探测：未超时的旧锁同样构成互斥（升级窗口期保护）
  if (fs.existsSync(LEGACY_LOCK_FILE)) {
    try {
      const info = JSON.parse(fs.readFileSync(LEGACY_LOCK_FILE, 'utf-8'));
      const elapsed = Date.now() - new Date(info.startedAt).getTime();
      if (elapsed <= (info.timeout || 300000)) {
        console.error(c.red(`🔒 检测到 V3 遗留锁（PID: ${info.pid}，已运行 ${Math.round(elapsed / 1000)}s）。请等待其完成或升级插件版后重试。`));
        process.exit(1);
      }
      fs.unlinkSync(LEGACY_LOCK_FILE);
    } catch { try { fs.unlinkSync(LEGACY_LOCK_FILE); } catch {} }
  }

  // 2) V4 互斥：global.lock 已存在 → 尝试安全破锁，破不动即拒绝
  if (fs.existsSync(LOCK_FILE)) {
    const holder = readV4Lock(LOCK_FILE);
    if (holder && !breakStaleV4Lock(LOCK_FILE)) {
      const o = holder.owners[0].owner;
      console.error(c.red(`🔒 另一个 nuke 操作持有全局锁（PID: ${o.pid}，用途: ${o.purpose || 'unknown'}）`));
      console.error(c.dim('   破锁纪律：仅当持有者进程死亡且 TTL 过期时自动清除；否则请等待其完成。'));
      process.exit(1);
    }
  }

  // 3) 探测其他作用域的活跃 exclusive 锁（插件版并发清理中 → CLI 让路）
  const others = findActiveV4Locks().filter(l => l.file !== 'global.lock');
  if (others.length > 0) {
    const desc = others.map(l => `${l.file}(PID ${l.pid}, ${l.purpose})`).join(', ');
    console.error(c.red(`🔒 检测到并发清理进行中: ${desc}`));
    process.exit(1);
  }

  // 4) O_EXCL 原子创建（与插件版 writeLockAtomic 同构）
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({
      version: 1,
      scope: 'global',
      mode: 'exclusive',
      owners: [{
        owner: {
          pid: process.pid, hostname: os.hostname(),
          bootToken: CLI_BOOT_TOKEN, purpose: `cli:${operation}`,
        },
        acquiredAt: new Date().toISOString(),
        expiresAt: Date.now() + LOCK_TTL_MS,
      }],
    }, null, 2));
    fs.closeSync(fd);
  } catch {
    console.error(c.red('❌ 无法创建锁文件（可能存在并发竞争，请重试）'));
    process.exit(1);
  }
}

function releaseLock() {
  // 只清除自己的锁：确认锁内 bootToken 归属，防止误删他人刚重建的锁
  try {
    const lock = readV4Lock(LOCK_FILE);
    if (lock && lock.owners.some(o => o.owner && o.owner.bootToken === CLI_BOOT_TOKEN)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════
//  事务系统
// ═══════════════════════════════════════════════════════════

function txDir() {
  const d = path.join(DSH_HOME, '.nuke-tx');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function saveTx(tx) { withRetrySync(() => fs.writeFileSync(path.join(txDir(), `${tx.id}.json`), JSON.stringify(tx, null, 2))); }
function clearTx(id) {
  const p = path.join(txDir(), `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function genTxId() { return crypto.randomBytes(4).toString('hex'); }

// ═══════════════════════════════════════════════════════════
//  文件指纹快照
// ═══════════════════════════════════════════════════════════

function takeSnapshot(profile, pluginName) {
  const profileDir = path.join(DSH_HOME, 'profiles', profile);
  const targets = [
    path.join(profileDir, 'package.json'),
    path.join(profileDir, 'pnpm-workspace.yaml'),
    path.join(profileDir, 'cordis.patch.yml'),
    path.join(DSH_HOME, 'cordis.patch.yml'),
  ];

  const fingerprints = [];
  for (const fp of targets) {
    if (!fs.existsSync(fp)) continue;
    try {
      const stat = fs.statSync(fp);
      fingerprints.push({ path: fp, hash: hashFile(fp), size: stat.size, mtime: stat.getTime() });
    } catch {}
  }

  for (const dir of [
    path.join(DSH_HOME, 'storages', pluginName),
    path.join(profileDir, 'node_modules', pluginName),
    path.join(DSH_HOME, 'attachments', 'v1', pluginName),
  ]) {
    if (!fs.existsSync(dir)) continue;
    try {
      const stat = fs.statSync(dir);
      fingerprints.push({ path: dir, hash: hashDir(dir), size: stat.size, mtime: stat.getTime() });
    } catch {}
  }

  let bundleVersion;
  const pkgPath = path.join(profileDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { bundleVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))?.dependencies?.[pluginName]; } catch {}
  }

  return { pluginName, profile, timestamp: new Date().toISOString(), fingerprints, bundleVersion };
}

function verifySnapshot(snapshot) {
  const mismatches = [];
  for (const fp of snapshot.fingerprints) {
    if (!fs.existsSync(fp.path)) { mismatches.push({ path: fp.path, expected: fp.hash, actual: '<deleted>' }); continue; }
    try {
      const stat = fs.statSync(fp.path);
      if (stat.size === fp.size && stat.getTime() === fp.mtime) continue;
      const h = stat.isFile() ? hashFile(fp.path) : hashDir(fp.path);
      if (h !== fp.hash) mismatches.push({ path: fp.path, expected: fp.hash, actual: h });
    } catch {}
  }
  return { valid: mismatches.length === 0, mismatches };
}

// ═══════════════════════════════════════════════════════════
//  策略定义
// ═══════════════════════════════════════════════════════════

const STRATEGIES = {
  safe: {
    label: '🛡️ 安全模式',
    description: '仅标准卸载 + 清理配置引用，不删除目录',
    actions: ['standard-remove', 'clean-workspace-yaml', 'clean-profile-patch', 'clean-home-patch'],
  },
  balanced: {
    label: '⚖️ 均衡模式',
    description: '标准卸载 + 配置清理 + 删除 storages/attachments/node_modules',
    actions: ['standard-remove', 'clean-workspace-yaml', 'clean-profile-patch', 'clean-home-patch',
              'remove-node-modules', 'remove-storages', 'remove-attachments'],
  },
  aggressive: {
    label: '💥 激进模式',
    description: '均衡模式 + pnpm store prune，彻底清除',
    actions: ['standard-remove', 'clean-workspace-yaml', 'clean-profile-patch', 'clean-home-patch',
              'remove-node-modules', 'remove-storages', 'remove-attachments', 'pnpm-store-prune'],
  },
};

// ═══════════════════════════════════════════════════════════
//  Profile / Bundle 查询
// ═══════════════════════════════════════════════════════════

function listProfiles() {
  const dir = path.join(DSH_HOME, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => { try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; } });
}

function getInstalledBundles(profile) {
  const p = path.join(DSH_HOME, 'profiles', profile, 'package.json');
  if (!fs.existsSync(p)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (pkg?.dsh?.profile?.bundles || []).filter(b => !b.startsWith('@deepseek-ai/dsh-'));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════
//  依赖关系检测
// ═══════════════════════════════════════════════════════════

function checkDependents(profile, pluginName) {
  const bundles = getInstalledBundles(profile);
  const nmRoot = path.join(DSH_HOME, 'profiles', profile, 'node_modules');
  const result = [];
  for (const b of bundles) {
    if (b === pluginName) continue;
    const pkgPath = path.join(nmRoot, b, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
      if (allDeps?.[pluginName]) result.push(b);
    } catch {}
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
//  残留扫描
// ═══════════════════════════════════════════════════════════

function scanResiduals(profile, pluginName) {
  const list = [];
  const profileDir = path.join(DSH_HOME, 'profiles', profile);

  const fileChecks = [
    { path: path.join(profileDir, 'pnpm-workspace.yaml'), test: c => c.includes(pluginName), desc: `allowBuilds 中仍有 ${pluginName}`, severity: 3, action: 'clean-workspace-yaml' },
    { path: path.join(profileDir, 'cordis.patch.yml'), test: c => c.includes(pluginName), desc: `profile patch 中仍有 ${pluginName}`, severity: 5, action: 'clean-profile-patch' },
    { path: path.join(DSH_HOME, 'cordis.patch.yml'), test: c => c.includes(pluginName), desc: `home patch 中仍有 ${pluginName}`, severity: 5, action: 'clean-home-patch' },
  ];

  for (const check of fileChecks) {
    if (!fs.existsSync(check.path)) continue;
    try {
      const content = fs.readFileSync(check.path, 'utf-8');
      if (check.test(content)) {
        list.push({ location: check.path, description: check.desc, severity: check.severity, sizeBytes: fs.statSync(check.path).size, action: check.action });
      }
    } catch {}
  }

  const dirChecks = [
    { dir: path.join(profileDir, 'node_modules', pluginName), desc: 'node_modules 包目录', severity: 2, action: 'remove-node-modules' },
    { dir: path.join(DSH_HOME, 'storages', pluginName), desc: 'storages 持久化数据', severity: 3, action: 'remove-storages' },
    { dir: path.join(DSH_HOME, 'attachments', 'v1', pluginName), desc: 'attachments 会话附件', severity: 2, action: 'remove-attachments' },
  ];

  for (const dc of dirChecks) {
    if (!fs.existsSync(dc.dir)) continue;
    list.push({ location: dc.dir, description: dc.desc, severity: dc.severity, sizeBytes: dirSize(dc.dir), action: dc.action });
  }

  // sessions 引用（仅报告）
  const sessionsDir = path.join(DSH_HOME, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    let count = 0;
    try {
      for (const entry of fs.readdirSync(sessionsDir)) {
        const sf = path.join(sessionsDir, entry);
        if (!fs.statSync(sf).isFile()) continue;
        try {
          const fd = fs.openSync(sf, 'r');
          const buf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          if (buf.toString('utf-8').includes(pluginName)) count++;
        } catch {}
      }
    } catch {}
    if (count > 0) {
      list.push({ location: sessionsDir, description: `${count} 个会话日志中引用了 ${pluginName}（仅报告）`, severity: 1, sizeBytes: 0, action: 'report-only' });
    }
  }

  list.sort((a, b) => b.severity - a.severity);
  return list;
}

// ═══════════════════════════════════════════════════════════
//  YAML 块精确删除
// ═══════════════════════════════════════════════════════════

function removeYamlBlock(content, pluginId) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { if (!skip) result.push(line); continue; }
    const m = trimmed.match(/^-\s+id:\s*(.+)$/);
    if (m) { if (m[1].trim() === pluginId) { skip = true; continue; } else if (skip) { skip = false; } }
    if (!line.startsWith(' ') && !line.startsWith('\t') && trimmed.includes(':') && !trimmed.startsWith('-')) { if (skip) skip = false; }
    if (!skip) result.push(line);
  }
  while (result.length > 1 && result[result.length - 1].trim() === '' && result[result.length - 2].trim() === '') result.pop();
  const out = result.join('\n');
  return out.endsWith('\n') ? out : out + '\n';
}

// ═══════════════════════════════════════════════════════════
//  核心清理引擎
// ═══════════════════════════════════════════════════════════

function executeClean(profile, pluginName, actions, tx) {
  const cleaned = [];
  let totalFreed = 0;
  const profileDir = path.join(DSH_HOME, 'profiles', profile);

  const runAction = (action, fn) => {
    if (!actions.includes(action)) return;
    const step = { action, target: pluginName, status: 'pending' };
    tx.steps.push(step);
    try {
      const result = fn();
      if (result) { cleaned.push(result); step.status = 'done'; }
      else { step.status = 'skipped'; }
    } catch (err) {
      step.status = 'failed'; step.error = err.message;
      log('ERROR', `${action} failed: ${err.message}`);
    }
    saveTx(tx);
  };

  runAction('standard-remove', () => {
    const r = spawnSync('dsh', ['plugin', '--profile', profile, 'remove', pluginName], { timeout: 30000, encoding: 'utf-8' });
    return r.status === 0 ? '标准卸载完成' : null;
  });

  runAction('clean-workspace-yaml', () => {
    const wsPath = path.join(profileDir, 'pnpm-workspace.yaml');
    if (!fs.existsSync(wsPath)) return null;
    const content = fs.readFileSync(wsPath, 'utf-8');
    if (!content.includes(pluginName)) return null;
    const backup = backupFile(wsPath);
    const step = tx.steps[tx.steps.length - 1];
    if (backup) step.backup = backup;
    const lines = content.split('\n');
    const newLines = lines.filter(l => !l.trim().startsWith(pluginName + ':') && !l.trim().startsWith(pluginName + ' :'));
    const newContent = newLines.join('\n');
    if (newContent !== content) { fs.writeFileSync(wsPath, newContent); log('CLEAN', `workspace.yaml: removed ${pluginName}`); return '已清理 pnpm-workspace.yaml'; }
    return null;
  });

  runAction('clean-profile-patch', () => {
    const p = path.join(profileDir, 'cordis.patch.yml');
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf-8');
    if (!content.includes(pluginName)) return null;
    const backup = backupFile(p);
    const step = tx.steps[tx.steps.length - 1];
    if (backup) step.backup = backup;
    const result = removeYamlBlock(content, pluginName);
    if (result !== content) { fs.writeFileSync(p, result); log('CLEAN', `profile patch: removed ${pluginName}`); return '已清理 profile cordis.patch.yml'; }
    return null;
  });

  runAction('clean-home-patch', () => {
    const p = path.join(DSH_HOME, 'cordis.patch.yml');
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf-8');
    if (!content.includes(pluginName)) return null;
    const backup = backupFile(p);
    const step = tx.steps[tx.steps.length - 1];
    if (backup) step.backup = backup;
    const result = removeYamlBlock(content, pluginName);
    if (result !== content) { fs.writeFileSync(p, result); log('CLEAN', `home patch: removed ${pluginName}`); return '已清理 home cordis.patch.yml'; }
    return null;
  });

  const dirActions = [
    { action: 'remove-node-modules', dir: path.join(profileDir, 'node_modules', pluginName), label: 'node_modules' },
    { action: 'remove-storages', dir: path.join(DSH_HOME, 'storages', pluginName), label: 'storages' },
    { action: 'remove-attachments', dir: path.join(DSH_HOME, 'attachments', 'v1', pluginName), label: 'attachments' },
  ];

  for (const da of dirActions) {
    runAction(da.action, () => {
      if (!fs.existsSync(da.dir)) return null;
      const size = dirSize(da.dir);
      fs.rmSync(da.dir, { recursive: true, force: true });
      totalFreed += size;
      const step = tx.steps[tx.steps.length - 1];
      step.sizeFreed = size;
      log('CLEAN', `removed ${da.label}: ${da.dir} (${formatBytes(size)})`);
      return `已删除${da.label}: ${da.dir} (${formatBytes(size)})`;
    });
  }

  runAction('pnpm-store-prune', () => {
    const r = spawnSync('pnpm', ['store', 'prune'], { encoding: 'utf-8', timeout: 60000 });
    if (r.status === 0) { log('CLEAN', 'pnpm store pruned'); return '已执行 pnpm store prune'; }
    return null;
  });

  return { cleaned, totalFreed };
}

// ═══════════════════════════════════════════════════════════
//  健康检查
// ═══════════════════════════════════════════════════════════

function runHealthChecks(profile) {
  const results = [];
  const profileDir = path.join(DSH_HOME, 'profiles', profile);

  const pkgPath = path.join(profileDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      results.push({ check: 'package.json 语法', passed: true, message: 'JSON 格式正确' });
      const bundles = pkg?.dsh?.profile?.bundles || [];
      const deps = Object.keys(pkg?.dependencies || {});
      const orphans = bundles.filter(b => !deps.includes(b) && b !== '@deepseek-ai/dsh-base');
      results.push({ check: 'bundles 一致性', passed: orphans.length === 0, message: orphans.length === 0 ? '所有 bundle 均有对应依赖' : `孤立: ${orphans.join(', ')}` });
    } catch (err) {
      results.push({ check: 'package.json', passed: false, message: `解析失败: ${err.message}` });
    }
  }

  for (const pf of [path.join(profileDir, 'cordis.patch.yml'), path.join(DSH_HOME, 'cordis.patch.yml')]) {
    if (!fs.existsSync(pf)) continue;
    try {
      const content = fs.readFileSync(pf, 'utf-8');
      if (content.trim() === '' || content.trim() === '[]') continue;
      results.push({ check: path.relative(DSH_HOME, pf), passed: true, message: '文件正常' });
    } catch (err) {
      results.push({ check: path.basename(pf), passed: false, message: err.message });
    }
  }

  const dshCheck = spawnSync('dsh', ['--version'], { encoding: 'utf-8', timeout: 5000 });
  // V5.1：status 非 null = 二进制确实执行了（--version 旗标行为差异不算不可用）；
  // status null（spawn ENOENT）才是真正找不到 —— 与插件版 probeCli 三段式语义对齐
  results.push({
    check: 'dsh CLI',
    passed: dshCheck.status !== null,
    message: dshCheck.status === 0
      ? dshCheck.stdout.trim()
      : dshCheck.status !== null
        ? `可用（--version 退出码 ${dshCheck.status}）`
        : '不可用（不在 PATH；CLI 在交互 shell 运行，请确认 dsh 已全局安装）',
  });

  return results;
}

// ═══════════════════════════════════════════════════════════
//  报告生成
// ═══════════════════════════════════════════════════════════

function saveReport(tx, profile, strategy, totalFreed, residualsBefore, residualsAfter, healthResults, backups, warnings) {
  const reportDir = path.join(DSH_HOME, '.nuke-reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const report = {
    transactionId: tx.id, pluginNames: tx.pluginNames, profile, strategy,
    startedAt: tx.startedAt, finishedAt: new Date().toISOString(),
    stepsTotal: tx.steps.length,
    stepsSucceeded: tx.steps.filter(s => s.status === 'done').length,
    stepsFailed: tx.steps.filter(s => s.status === 'failed').length,
    stepsSkipped: tx.steps.filter(s => s.status === 'skipped').length,
    totalSpaceFreed: totalFreed, residualsBefore, residualsAfter,
    healthCheck: healthResults, backups, warnings,
  };

  // JSON
  fs.writeFileSync(path.join(reportDir, `nuke-${tx.id}.json`), JSON.stringify(report, null, 2));

  // Markdown
  const lines = [
    `# Nuke 清理报告`, ``,
    `- **事务 ID**: ${tx.id}`, `- **插件**: ${tx.pluginNames.join(', ')}`,
    `- **Profile**: ${profile}`, `- **策略**: ${strategy}`,
    `- **开始**: ${tx.startedAt}`, `- **完成**: ${report.finishedAt}`, ``,
    `## 执行摘要`, ``,
    `| 指标 | 值 |`, `|---|---|`,
    `| 总步骤 | ${report.stepsTotal} |`, `| 成功 | ${report.stepsSucceeded} |`,
    `| 失败 | ${report.stepsFailed} |`, `| 跳过 | ${report.stepsSkipped} |`,
    `| 释放空间 | ${formatBytes(totalFreed)} |`,
    `| 残留 | ${residualsBefore} → ${residualsAfter} |`, ``,
  ];
  if (healthResults.length > 0) {
    lines.push(`## 健康检查`, ``);
    healthResults.forEach(h => lines.push(`- ${h.passed ? '✅' : '🔴'} **${h.check}**: ${h.message}`));
    lines.push(``);
  }
  if (backups.length > 0) { lines.push(`## 备份`, ``); backups.forEach(b => lines.push(`- \`${b}\``)); lines.push(``); }
  fs.writeFileSync(path.join(reportDir, `nuke-${tx.id}.md`), lines.join('\n'));

  return report;
}

// ═══════════════════════════════════════════════════════════
//  子命令实现
// ═══════════════════════════════════════════════════════════

function cmdClean(positional, flags) {
  const names = [];
  for (const arg of positional) {
    if (arg.includes(',')) arg.split(',').forEach(n => names.push(n.trim()));
    else names.push(arg);
  }
  if (names.length === 0) { console.error(c.red('❌ 请指定至少一个插件名称')); process.exit(1); }
  names.forEach(n => assertSafe(n, '插件名'));

  const profile = flags.profile || 'web';
  const strategy = flags.strategy || 'balanced';
  const dryRun = flags.dryRun || false;
  assertSafe(profile, 'profile');

  const strat = STRATEGIES[strategy];
  if (!strat) { console.error(c.red(`❌ 未知策略: ${strategy}`)); process.exit(1); }

  acquireLock(`cli-nuke:${names.join(',')}`);

  try {
    const txId = genTxId();
    log('NUKE_START', `tx=${txId} plugins=[${names.join(',')}] profile=${profile} strategy=${strategy}`);

    const tx = { id: txId, pluginNames: names, profile, strategy, steps: [], startedAt: new Date().toISOString() };
    const allBackups = [];
    const allWarnings = [];
    let totalSpaceFreed = 0;
    let totalResBefore = 0;
    let totalResAfter = 0;

    const report = [];
    report.push(c.bold(`🔧 dsh-nuke CLI [${txId}]`));
    report.push(c.dim(`   插件: ${names.join(', ')} | profile: ${profile} | 策略: ${strat.label} | dry_run: ${dryRun}`));
    report.push('═'.repeat(60));

    // 依赖检测
    for (const name of names) {
      const deps = checkDependents(profile, name);
      if (deps.length > 0) {
        const warn = `"${name}" 被以下插件依赖: ${deps.join(', ')}`;
        allWarnings.push(warn);
        report.push(c.red(`🚨 ${warn}`));
      }
    }

    // 快照
    if (!dryRun) {
      report.push('\n' + c.cyan('[准备] 拍摄文件快照...'));
      for (const name of names) {
        const snapshot = takeSnapshot(profile, name);
        const snapDir = path.join(DSH_HOME, '.nuke-snapshots');
        fs.mkdirSync(snapDir, { recursive: true });
        fs.writeFileSync(path.join(snapDir, `${name.replace(/\//g, '__')}.${txId}.json`), JSON.stringify(snapshot, null, 2));
        report.push(c.dim(`  📸 ${name}: ${snapshot.fingerprints.length} 个文件已记录`));
      }
    }

    // 逐个卸载
    for (let idx = 0; idx < names.length; idx++) {
      const name = names[idx];
      report.push('\n' + c.bold(`[${idx + 1}/${names.length}] ${name}`));
      report.push('─'.repeat(50));

      const residuals = scanResiduals(profile, name);
      totalResBefore += residuals.length;

      if (residuals.length > 0) {
        const totalSize = residuals.reduce((s, r) => s + r.sizeBytes, 0);
        report.push(c.yellow(`  发现 ${residuals.length} 处残留 (${formatBytes(totalSize)})`));
      } else {
        report.push(c.green('  无残留'));
      }

      if (dryRun) { report.push(c.dim('  ⏭️ dry_run 模式')); continue; }

      let actions = [...strat.actions];
      if (flags.skipStandard) actions = actions.filter(a => a !== 'standard-remove');

      const { cleaned, totalFreed } = executeClean(profile, name, actions, tx);
      totalSpaceFreed += totalFreed;
      cleaned.forEach(item => report.push(c.green(`  ✅ ${item}`)));
      tx.steps.filter(s => s.backup).forEach(s => allBackups.push(s.backup));

      const finalRes = scanResiduals(profile, name);
      totalResAfter += finalRes.length;
      if (finalRes.length === 0) { report.push(c.green('  ✅ 验证通过')); }
      else {
        report.push(c.red(`  ⚠️ 仍有 ${finalRes.length} 处残留`));
        finalRes.forEach(r => {
          if (r.action === 'report-only') report.push(c.dim(`    ℹ️ ${r.description}`));
          else report.push(c.red(`    - ${r.description}`));
        });
      }
    }

    // 健康检查
    let healthResults = [];
    if (!dryRun && !flags.skipHealth) {
      report.push('\n' + c.cyan('[健康检查]'));
      healthResults = runHealthChecks(profile);
      healthResults.forEach(hr => {
        const icon = hr.passed ? c.green('✅') : c.red('🔴');
        report.push(`  ${icon} ${hr.check}: ${hr.message}`);
        if (!hr.passed) allWarnings.push(`${hr.check}: ${hr.message}`);
      });
    }

    tx.finishedAt = new Date().toISOString();
    saveTx(tx);

    // 报告
    report.push('\n' + '═'.repeat(60));
    report.push(c.bold('📊 清理报告'));
    report.push(`  步骤: ${tx.steps.filter(s => s.status === 'done').length} 成功 / ${tx.steps.filter(s => s.status === 'failed').length} 失败 / ${tx.steps.filter(s => s.status === 'skipped').length} 跳过`);
    report.push(`  释放空间: ${formatBytes(totalSpaceFreed)}`);
    report.push(`  残留: ${totalResBefore} → ${totalResAfter}`);

    if (!dryRun) {
      saveReport(tx, profile, strategy, totalSpaceFreed, totalResBefore, totalResAfter, healthResults, allBackups, allWarnings);
      report.push(c.dim(`  📄 JSON 报告: ${path.join(DSH_HOME, '.nuke-reports', `nuke-${txId}.json`)}`));
      report.push(c.dim(`  📄 Markdown 报告: ${path.join(DSH_HOME, '.nuke-reports', `nuke-${txId}.md`)}`));
      clearTx(txId);
    }

    if (allBackups.length > 0) {
      report.push('\n' + c.dim(`📦 已备份 ${allBackups.length} 个文件到: ${path.join(DSH_HOME, '.nuke-backups')}`));
    }

    console.log(report.join('\n'));
    log('NUKE_DONE', `${names.join(',')} | freed=${totalSpaceFreed} | residuals=${totalResAfter}`);

  } finally {
    releaseLock();
  }
}

function cmdScan(positional, flags) {
  const pluginName = positional[0];
  if (!pluginName) { console.error(c.red('❌ 请指定插件名')); process.exit(1); }
  assertSafe(pluginName, '插件名');
  const profile = flags.profile || 'web';
  assertSafe(profile, 'profile');

  const residuals = scanResiduals(profile, pluginName);
  const totalSize = residuals.reduce((s, r) => s + r.sizeBytes, 0);

  // --json：机器可读输出（CI/脚本消费），一条 JSON 到 stdout，人类提示全部进 stderr
  if (flags.json) {
    console.log(JSON.stringify({
      command: 'scan', plugin: pluginName, profile,
      residuals: residuals.map(r => ({
        description: r.description, location: r.location,
        severity: r.severity, sizeBytes: r.sizeBytes, action: r.action || null,
      })),
      totalResiduals: residuals.length, totalSizeBytes: totalSize,
    }));
    return;
  }

  if (residuals.length === 0) { console.log(c.green(`✅ "${pluginName}" 无残留。`)); return; }

  console.log(c.yellow(`⚠️ 发现 ${residuals.length} 处残留（共 ${formatBytes(totalSize)}）：`));
  residuals.forEach((r, i) => {
    const bar = '█'.repeat(r.severity) + '░'.repeat(5 - r.severity);
    console.log(`  ${i + 1}. [${bar}] ${r.description}`);
    console.log(c.dim(`     📍 ${r.location}  💾 ${formatBytes(r.sizeBytes)}`));
  });
  console.log(`\n严重程度: ████░ 4/5 = 高危  |  █░░░░ 1/5 = 低危`);
}

function cmdDeps(positional, flags) {
  const pluginName = positional[0];
  if (!pluginName) { console.error(c.red('❌ 请指定插件名')); process.exit(1); }
  assertSafe(pluginName, '插件名');
  const profile = flags.profile || 'web';
  assertSafe(profile, 'profile');

  const deps = checkDependents(profile, pluginName);
  if (flags.json) {
    console.log(JSON.stringify({
      command: 'deps', plugin: pluginName, profile,
      dependents: deps, blocked: deps.length > 0,
    }));
    return;
  }
  if (deps.length === 0) { console.log(c.green(`✅ 没有其他插件依赖 "${pluginName}"。`)); return; }
  console.log(c.red(`🚨 ${deps.length} 个插件依赖 "${pluginName}"：`));
  deps.forEach((d, i) => console.log(c.red(`  ${i + 1}. ${d}`)));
}

function cmdSweep(flags) {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    if (flags.json) console.log(JSON.stringify({ command: 'sweep', profiles: [], orphans: [], total: 0 }));
    else console.log('未找到任何 profile。');
    return;
  }

  const jsonOut = { command: 'sweep', profiles, orphans: [], total: 0 };
  if (!flags.json) {
    console.log(c.bold('🧹 全局孤儿扫描'));
    console.log('═'.repeat(55));
  }
  let total = 0;

  for (const profile of profiles) {
    const bundles = getInstalledBundles(profile);
    const profileDir = path.join(DSH_HOME, 'profiles', profile);
    const patchFiles = [path.join(profileDir, 'cordis.patch.yml'), path.join(DSH_HOME, 'cordis.patch.yml')];

    const orphans = new Set();
    for (const pf of patchFiles) {
      if (!fs.existsSync(pf)) continue;
      const content = fs.readFileSync(pf, 'utf-8');
      for (const m of content.matchAll(/id:\s*(.+)/g)) {
        const id = m[1].trim();
        if (!id.startsWith('@deepseek-ai/dsh-') && !bundles.includes(id)) orphans.add(id);
      }
    }

    if (orphans.size > 0 && !flags.json) console.log(`\n${c.cyan(`📁 profile "${profile}"`)}`);
    for (const id of orphans) {
      total++;
      const res = scanResiduals(profile, id);
      const size = res.reduce((s, r) => s + r.sizeBytes, 0);
      jsonOut.orphans.push({ profile, id, residuals: res.length, sizeBytes: size });
      if (!flags.json) {
        const icon = res.length > 0 ? c.red('🔴') : c.green('🟢');
        console.log(`  ${icon} ${id} (${res.length} 处残留, ${formatBytes(size)})`);
      }
    }
  }
  jsonOut.total = total;

  if (flags.json) { console.log(JSON.stringify(jsonOut)); return; }
  if (total === 0) console.log('\n' + c.green('✅ 系统干干净净！'));
  else console.log(`\n共 ${total} 个孤儿配置。使用 clean 子命令清理。`);
}

function cmdHealth(flags) {
  const profile = flags.profile || 'web';
  assertSafe(profile, 'profile');
  const results = runHealthChecks(profile);
  if (flags.json) {
    console.log(JSON.stringify({
      command: 'health', profile,
      checks: results, passed: results.filter(r => r.passed).length, total: results.length,
    }));
    return;
  }
  console.log(c.bold(`🏥 系统健康检查 (${profile})\n`));
  results.forEach(hr => {
    const icon = hr.passed ? c.green('✅') : c.red('🔴');
    console.log(`  ${icon} ${hr.check}: ${hr.message}`);
  });
  const passed = results.filter(r => r.passed).length;
  console.log(`\n${passed}/${results.length} 项通过`);
}

function cmdRestore(positional) {
  const backupDir = path.join(DSH_HOME, '.nuke-backups');
  const file = positional[0];

  if (!file) {
    // list
    if (!fs.existsSync(backupDir)) { console.log('没有备份文件。'); return; }
    const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.bak')).sort().reverse();
    if (files.length === 0) { console.log('没有备份文件。'); return; }
    console.log(`可用备份（${files.length}）：`);
    files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    return;
  }

  const src = path.join(backupDir, file);
  if (!fs.existsSync(src)) { console.error(c.red(`❌ 文件不存在: ${file}`)); process.exit(1); }

  const parts = file.split('.');
  const tsIdx = parts.findIndex(p => p.includes('T'));
  if (tsIdx < 1) { console.error(c.red('❌ 无法推断原始路径')); process.exit(1); }
  const origName = parts.slice(0, tsIdx).join('.');

  const candidates = [
    path.join(DSH_HOME, 'cordis.patch.yml'),
    path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'),
    path.join(DSH_HOME, 'profiles', 'web', 'package.json'),
    path.join(DSH_HOME, 'profiles', 'web', 'pnpm-workspace.yaml'),
  ];
  const target = candidates.find(p => path.basename(p) === origName);
  if (!target) { console.error(c.red(`❌ 无法确定 "${origName}" 的目标路径`)); process.exit(1); }

  backupFile(target);
  fs.copyFileSync(src, target);
  log('RESTORE', `${src} → ${target}`);
  console.log(c.green(`✅ 已恢复: ${target}`));
}

function cmdLogs(positional) {
  const date = positional[0] || new Date().toISOString().slice(0, 10);
  const logFile = path.join(DSH_HOME, '.nuke-logs', `${date}.log`);
  if (!fs.existsSync(logFile)) { console.log(`${date} 无记录。`); return; }
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  console.log(`📋 ${date} 日志（${lines.length} 条）：`);
  lines.forEach(l => console.log(`  ${l}`));
}

function cmdReports(positional) {
  const reportDir = path.join(DSH_HOME, '.nuke-reports');
  if (!fs.existsSync(reportDir)) { console.log('没有历史报告。'); return; }

  if (positional[0]) {
    // view by tx id
    const txId = positional[0];
    const format = positional[1] || 'md';
    const f = path.join(reportDir, `nuke-${txId}.${format}`);
    if (!fs.existsSync(f)) { console.error(c.red(`❌ 报告不存在: ${txId}`)); process.exit(1); }
    console.log(fs.readFileSync(f, 'utf-8'));
    return;
  }

  const files = fs.readdirSync(reportDir).sort().reverse();
  if (files.length === 0) { console.log('没有历史报告。'); return; }
  console.log(`历史报告（${files.length}）：`);
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}

function cmdSnapshot(positional) {
  const pluginName = positional[0];
  const txId = positional[1];

  const snapDir = path.join(DSH_HOME, '.nuke-snapshots');
  if (!fs.existsSync(snapDir)) { console.log('没有快照。'); return; }

  if (!pluginName) {
    // list
    const files = fs.readdirSync(snapDir).filter(f => f.endsWith('.json')).sort().reverse();
    if (files.length === 0) { console.log('没有快照。'); return; }
    console.log(`快照列表（${files.length}）：`);
    files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    return;
  }

  if (!txId) { console.error(c.red('❌ 请指定事务 ID')); process.exit(1); }

  const snapFile = path.join(snapDir, `${pluginName.replace(/\//g, '__')}.${txId}.json`);
  if (!fs.existsSync(snapFile)) { console.error(c.red('❌ 快照不存在')); process.exit(1); }

  const snapshot = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
  const result = verifySnapshot(snapshot);
  if (result.valid) {
    console.log(c.green(`✅ 快照验证通过：所有 ${snapshot.fingerprints.length} 个文件指纹匹配。`));
  } else {
    console.log(c.red(`⚠️ 快照验证失败：${result.mismatches.length} 个文件不匹配`));
    result.mismatches.forEach(m => console.log(c.red(`  - ${m.path}: 期望 ${m.expected}，实际 ${m.actual}`)));
  }
}

function cmdStrategies() {
  console.log(c.bold('可用清理策略：\n'));
  for (const [name, s] of Object.entries(STRATEGIES)) {
    console.log(`${c.bold(s.label)} (${name})`);
    console.log(`  ${s.description}`);
    console.log(`  动作: ${s.actions.join(', ')}\n`);
  }
}

// ═══════════════════════════════════════════════════════════
//  路由
// ═══════════════════════════════════════════════════════════

const allArgs = process.argv.slice(2);
const command = allArgs[0];
const restArgs = allArgs.slice(1);

// 解析 flags
const flags = {};
const positional = [];
for (let i = 0; i < restArgs.length; i++) {
  if (restArgs[i] === '--profile')       { flags.profile = restArgs[++i]; }
  else if (restArgs[i] === '--dry-run')  { flags.dryRun = true; }
  else if (restArgs[i] === '--strategy') { flags.strategy = restArgs[++i]; }
  else if (restArgs[i] === '--skip-standard') { flags.skipStandard = true; }
  else if (restArgs[i] === '--skip-health')   { flags.skipHealth = true; }
  else if (restArgs[i] === '--json')     { flags.json = true; }   // 机器可读输出（scan/deps/health/sweep）
  else if (restArgs[i] === '--version' || restArgs[i] === '-v') { flags.version = true; }
  else { positional.push(restArgs[i]); }
}

// 崩溃兜底：任何未捕获异常都以 fail-closed 姿态退出并提示，不裸抛栈压过用户视线
process.on('uncaughtException', err => {
  try { releaseLock(); } catch {}
  console.error(c.red(`❌ dsh-nuke 发生未捕获异常: ${err && err.message ? err.message : err}`));
  console.error(c.dim('   这不应发生，请携带以上信息提 issue: https://github.com/beijingwahw/dsh-nuke-plugin/issues'));
  process.exit(1);
});

// help/version 不依赖 DSH_HOME（排障时可能恰好环境损坏，最需要看到用法）
// 注意 --version 可独立于子命令出现（此时它占据 command 位，不进 flags 解析）
if (flags.version || command === '--version' || command === '-v') {
  console.log(require('../package.json').version || '0.0.0');
  process.exit(0);
}

if (!fs.existsSync(DSH_HOME)) {
  // help 例外：环境缺失时仍允许看用法
  if (command === '-h' || command === '--help' || command === 'help' || command === undefined) {
    printHelp();
    process.exit(0);
  }
  console.error(c.red(`❌ DSH_HOME 不存在: ${DSH_HOME}`));
  console.error(c.dim('   请确认 DeepSeek Harness 已安装，或设置 DSH_HOME 环境变量。'));
  process.exit(1);
}

switch (command) {
  case 'clean':      cmdClean(positional, flags); break;
  case 'scan':       cmdScan(positional, flags); break;
  case 'deps':       cmdDeps(positional, flags); break;
  case 'sweep':      cmdSweep(flags); break;
  case 'health':     cmdHealth(flags); break;
  case 'restore':    cmdRestore(positional); break;
  case 'logs':       cmdLogs(positional); break;
  case 'reports':    cmdReports(positional); break;
  case 'snapshot':   cmdSnapshot(positional); break;
  case 'strategies': cmdStrategies(); break;
  case '-h':
  case '--help':
  case 'help':
  case undefined:
    printHelp();
    break;
  default:
    console.error(c.red(`❌ 未知命令: ${command}`));
    printHelp();
    process.exit(1);
}

function printHelp() {
  console.log(`
${c.bold('dsh-nuke')} — DeepSeek Harness 插件强力卸载工具（独立 CLI 版）

${c.cyan('特点:')} 零依赖，仅需 Node.js。dsh 系统崩溃时仍可运行。
       与插件版共享 V4 锁协议（.nuke/locks/）与备份/日志/快照目录，
       CLI 与插件并发清理真正互斥。

${c.cyan('子命令:')}
  clean <插件...>       强力卸载（支持多个，逗号或空格分隔）
  scan <插件>           扫描残留（含严重程度评分）
  deps <插件>           检查哪些插件依赖了目标插件
  sweep                 全局扫描所有 profile 的孤儿残留
  health                检查 DSH 系统健康状态
  strategies            查看所有清理策略
  restore [备份文件]     列出或恢复备份
  logs [日期]           查看操作日志
  reports [事务ID]      查看历史清理报告
  snapshot <插件> <ID>  验证文件快照完整性

${c.cyan('通用选项:')}
  --profile <name>      指定 profile（默认: web）
  --strategy <s>        safe / balanced / aggressive（默认: balanced）
  --dry-run             仅预览，不执行
  --skip-standard       跳过标准卸载
  --skip-health         跳过健康检查
  --json                机器可读输出（scan / deps / sweep / health）
  --version, -v         输出版本号

${c.cyan('示例:')}
  node dsh-nuke.js clean powercontext-dsh
  node dsh-nuke.js clean plugin-a plugin-b --strategy aggressive
  node dsh-nuke.js clean powercontext-dsh --dry-run
  node dsh-nuke.js scan powercontext-dsh
  node dsh-nuke.js scan powercontext-dsh --json
  node dsh-nuke.js deps powercontext-dsh
  node dsh-nuke.js sweep
  node dsh-nuke.js health --json
  node dsh-nuke.js restore
  node dsh-nuke.js restore cordis.patch.yml.2026-08-16T10-00-00-000Z.bak
  node dsh-nuke.js logs
  node dsh-nuke.js reports
  node dsh-nuke.js reports abc12345
  node dsh-nuke.js snapshot powercontext-dsh abc12345
`);
}
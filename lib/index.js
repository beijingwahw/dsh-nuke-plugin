Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let fs = require("fs");
fs = __toESM(fs);
let path = require("path");
path = __toESM(path);
let os = require("os");
os = __toESM(os);
let crypto = require("crypto");
crypto = __toESM(crypto);
let child_process = require("child_process");
let yaml = require("yaml");
//#region src/infra/logger.ts
const LEVEL_ORDER = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
const ANSI = {
	debug: "\x1B[2m",
	info: "\x1B[36m",
	warn: "\x1B[33m",
	error: "\x1B[31m"
};
const RESET = "\x1B[0m";
const LABEL = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERROR"
};
function createLogger(options = {}) {
	const sink = options.sink ?? (process.stdout.isTTY ? "tty" : "plain");
	const minOrder = LEVEL_ORDER[options.minLevel ?? "info"];
	const write = options.writer ?? ((l) => process.stdout.write(l + "\n"));
	const writeErr = options.errWriter ?? options.writer ?? ((l) => process.stderr.write(l + "\n"));
	let inProgress = false;
	/** 非 TTY 刻度去重：同一 10% 刻度只输出一行（旧实现 0.91~0.99 会刷出 9 行 "90%"） */
	let lastEmittedTick = -1;
	function render(level, message, fields) {
		const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
		const color = sink === "tty" ? ANSI[level] : "";
		const reset = sink === "tty" ? RESET : "";
		let line = `${color}[${ts}] ${LABEL[level]}${reset} ${message}`;
		const merged = {
			...options.bindings,
			...fields
		};
		const keys = Object.keys(merged);
		if (keys.length > 0) {
			const pairs = keys.map((k) => `${k}=${fmtVal(merged[k])}`).join(" ");
			line += `  ${sink === "tty" ? "\x1B[2m" + pairs + RESET : pairs}`;
		}
		return line;
	}
	function fmtVal(v) {
		if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
		try {
			return JSON.stringify(v) ?? String(v);
		} catch {
			return String(v);
		}
	}
	const logger = {
		sink,
		log(level, message, fields) {
			if (LEVEL_ORDER[level] < minOrder) return;
			if (inProgress && sink === "tty") {
				write("\n");
				inProgress = false;
			}
			const line = render(level, message, fields);
			if (level === "error") writeErr(line);
			else if (level === "warn") write(line);
			else write(line);
		},
		debug(m, f) {
			logger.log("debug", m, f);
		},
		info(m, f) {
			logger.log("info", m, f);
		},
		warn(m, f) {
			logger.log("warn", m, f);
		},
		error(m, f) {
			logger.log("error", m, f);
		},
		child(bindings) {
			return createLogger({
				...options,
				bindings: {
					...options.bindings,
					...bindings
				}
			});
		},
		progress(ratio, label) {
			if (sink !== "tty") {
				if (ratio === null) {
					lastEmittedTick = -1;
					return;
				}
				const pct = Math.round(ratio * 100);
				const tick = Math.floor(pct / 10) * 10;
				if (pct % 10 === 0 && tick !== lastEmittedTick) {
					lastEmittedTick = tick;
					write(render("debug", `[progress] ${label} ${pct}%`));
				}
				return;
			}
			const width = 24;
			const filled = Math.round(width * Math.max(0, Math.min(1, ratio ?? 0)));
			const bar = "█".repeat(filled) + "░".repeat(width - filled);
			const pct = ratio === null ? " -- " : String(Math.round(ratio * 100)).padStart(3) + "%";
			write(`\r\x1b[2m  ${bar} ${pct} ${label}\x1b[0m`);
			inProgress = ratio !== null && ratio < 1;
			if (ratio === null || ratio >= 1) write("\n");
		}
	};
	return logger;
}
//#endregion
//#region src/contracts/base.ts
function ok(value) {
	return {
		ok: true,
		value
	};
}
function err(error) {
	return {
		ok: false,
		error
	};
}
function errorToMessage(e) {
	if (e instanceof Error) return e.message;
	if (typeof e === "object" && e !== null) {
		const maybe = e;
		if (typeof maybe.message === "string") return typeof maybe.code === "string" ? `[${maybe.code}] ${maybe.message}` : maybe.message;
	}
	return String(e);
}
/** 统一 IO 类错误构造：message 形如 "<context>: <root cause>" */
function ioError(context, e) {
	return {
		code: "E_IO",
		message: `${context}: ${errorToMessage(e)}`
	};
}
/** 全项目唯一的字节数人性化格式化（B/KB/MB/GB）。
*  此前 severity-scorer 与 reporter 各持一份相同实现 —— 统一到契约层。 */
function fmtBytes$1(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
	return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
//#endregion
//#region src/infra/validator.ts
const PLUGIN_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_PROFILES = /* @__PURE__ */ new Set([
	"profiles",
	"storages",
	"attachments",
	"sessions",
	"node_modules",
	"global"
]);
const NUL_RE = /\0/;
const SHELL_META_RE = /[;|&$`\n\r]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const REDOS_PATTERNS = [
	/\((?:[^()\\]|\\.)*[+*]\)\s*[+*{]/,
	/\((?:[^()\\]|\\.)*[+*]\s*\|/,
	/\\[bB]|\(\?<=/
];
function v(kind, detail, field) {
	return {
		kind,
		detail,
		...field ? { field } : {}
	};
}
function splitSegments(p) {
	return p.split(/[\\/]+/).filter((s) => s.length > 0);
}
function createValidator(platform = "linux") {
	const isWin = platform === "windows";
	return {
		validatePluginName(input) {
			const violations = [];
			if (!input || input.length === 0) return err([v("empty", "插件名为空", "pluginName")]);
			if (input.length > 214) violations.push(v("too-long", `长度 ${input.length} 超过 npm 上限 214`, "pluginName"));
			if (NUL_RE.test(input)) violations.push(v("nul-byte", "包含 NUL 字节", "pluginName"));
			if (!PLUGIN_NAME_RE.test(input)) violations.push(v("charset", `仅允许小写字母/数字/-/./_/~ 与可选 @scope/ 前缀，收到: "${input}"`, "pluginName"));
			if (SHELL_META_RE.test(input)) violations.push(v("shell-metachar", "包含 shell 元字符", "pluginName"));
			return violations.length ? err(violations) : ok(input);
		},
		validateProfileName(input) {
			const violations = [];
			if (!input || input.length === 0) return err([v("empty", "profile 名为空", "profileName")]);
			if (NUL_RE.test(input)) violations.push(v("nul-byte", "包含 NUL 字节", "profileName"));
			if (!PROFILE_NAME_RE.test(input)) violations.push(v("charset", "仅允许 [a-z0-9-]，首字符须为字母或数字，长度 1~64", "profileName"));
			if (RESERVED_PROFILES.has(input)) violations.push(v("syntax", `"${input}" 是保留目录名`, "profileName"));
			if (SHELL_META_RE.test(input)) violations.push(v("shell-metachar", "包含 shell 元字符", "profileName"));
			return violations.length ? err(violations) : ok(input);
		},
		validatePath(input, options) {
			const violations = [];
			const field = "path";
			if (!input || input.length === 0) return err([v("empty", "路径为空", field)]);
			if (NUL_RE.test(input)) violations.push(v("nul-byte", "包含 NUL 字节", field));
			if (input.length > 4096) violations.push(v("too-long", "路径超过 4096 字符", field));
			const segments = splitSegments(input);
			if (segments.includes("..")) violations.push(v("traversal", "包含 \"..\" 穿越段", field));
			if (options.mustBeAbsolute) {
				if (!(input.startsWith("/") || isWin && /^[a-zA-Z]:[\\/]/.test(input))) violations.push(v("absolute-required", "必须是绝对路径", field));
			}
			if (isWin && options.strictWindows) {
				if (input.startsWith("\\\\") || input.startsWith("//")) violations.push(v("unc-path", "Windows 严格模式拒绝 UNC 路径", field));
				for (const seg of segments) if (WIN_RESERVED.test(seg)) {
					violations.push(v("syntax", `Windows 保留设备名: "${seg}"`, field));
					break;
				}
			}
			if (/[\n\r]/.test(input)) violations.push(v("shell-metachar", "路径含换行符", field));
			return violations.length ? err(violations) : ok(input);
		},
		validateRegex(input) {
			const violations = [];
			if (!input || input.length === 0) return err([v("empty", "正则为空", "regex")]);
			if (input.length > 512) violations.push(v("too-long", "正则长度超过 512", "regex"));
			for (const pat of REDOS_PATTERNS) if (pat.test(input)) {
				violations.push(v("regex-unsafe", `检测到回溯风险结构（匹配 ${pat}），拒绝编译`, "regex"));
				break;
			}
			if (violations.length) return err(violations);
			try {
				return ok(new RegExp(input));
			} catch (e) {
				return err([v("syntax", `正则编译失败: ${errorToMessage(e)}`, "regex")]);
			}
		},
		validateCommandArgv(argv, allowBin) {
			const violations = [];
			if (argv.length === 0) return err([v("empty", "argv 为空", "command")]);
			const bin = argv[0];
			if (/[\\/]/.test(bin)) violations.push(v("syntax", `argv[0] 不允许包含路径分隔符（防白名单绕过）: "${bin}"`, "command"));
			const base = bin.split(/[\\/]/).pop().replace(/\.exe$/i, "");
			if (!allowBin.includes(base)) violations.push(v("syntax", `可执行文件 "${base}" 不在白名单 [${allowBin.join(", ")}]`, "command"));
			for (const [i, arg] of argv.entries()) {
				if (NUL_RE.test(arg)) {
					violations.push(v("nul-byte", `argv[${i}] 含 NUL`, "command"));
					break;
				}
				if (SHELL_META_RE.test(arg)) {
					violations.push(v("shell-metachar", `argv[${i}]="${arg}" 含 shell 元字符（命令必须是 argv 数组，禁止 shell 字符串）`, "command"));
					break;
				}
			}
			return violations.length ? err(violations) : ok(argv);
		},
		sanitizeForDisplay(input) {
			return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
		}
	};
}
//#endregion
//#region src/infra/path-resolver.ts
/** 简化 glob → RegExp：支持 * ? **（仅用于 denyGlobs 匹配） */
function globToRegex(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else re += "[^/\\\\]*";
		} else if (ch === "?") re += "[^/\\\\]";
		else if ("\\^$.|+()[]{}".includes(ch)) re += "\\" + ch;
		else re += ch;
	}
	return new RegExp(`^${re}$`, "i");
}
function createPathResolver(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? os.platform();
	const isWin = platform === "win32";
	const homeAbs = env.HOME || env.USERPROFILE || os.homedir();
	const tempAbs = isWin ? env.TEMP || env.APPDATA : env.TMPDIR || "/tmp";
	const dshHomeAbs = env.DSH_HOME || path.join(homeAbs, ".dsh");
	const info = {
		os: isWin ? "windows" : platform === "darwin" ? "macos" : "linux",
		home: homeAbs,
		tempRoot: tempAbs,
		dshHome: dshHomeAbs,
		pathSep: isWin ? "\\" : "/"
	};
	/** 归一化：win 反斜杠 → /，统一小写比较（win 大小写不敏感） */
	function normalizeForCompare(p) {
		let s = p.replace(/\\/g, "/");
		if (isWin) s = s.toLowerCase();
		return s;
	}
	const resolver = {
		platform() {
			return info;
		},
		async canonicalize(p) {
			try {
				const resolved = path.resolve(p);
				return ok(await fs.promises.realpath(resolved).catch(() => resolved));
			} catch (e) {
				return err(ioError(`路径解析失败: ${p}`, e));
			}
		},
		async isWithin(child, root) {
			const c = await resolver.canonicalize(child);
			const r = await resolver.canonicalize(root);
			if (!c.ok || !r.ok) return false;
			const cn = normalizeForCompare(c.value);
			const rn = normalizeForCompare(r.value);
			return cn === rn || cn.startsWith(rn + "/");
		},
		async assertDeletable(p, policy) {
			const canon = await resolver.canonicalize(p);
			if (!canon.ok) return canon;
			for (const glob of policy.denyGlobs) if (matchesGlob(canon.value, glob)) return err({
				code: "E_PATH_POLICY",
				message: `路径命中拒绝清单 "${glob}": ${canon.value}`,
				details: {
					path: canon.value,
					glob
				}
			});
			for (const root of resolveAllowedRoots(policy.allowedRoots)) if (await resolver.isWithin(canon.value, root)) {
				if (normalizeForCompare(canon.value).startsWith(normalizeForCompare(resolver.nukeStateRoot()))) return err({
					code: "E_PATH_POLICY",
					message: `禁止删除 nuke 自身状态目录下的路径: ${canon.value}`,
					details: { path: canon.value }
				});
				return ok(canon.value);
			}
			return err({
				code: "E_PATH_POLICY",
				message: `路径越出删除白名单根: ${canon.value}`,
				details: {
					path: canon.value,
					allowedRoots: policy.allowedRoots
				}
			});
		},
		profileDir(profile) {
			return path.join(dshHomeAbs, "profiles", profile);
		},
		storagesRoot() {
			return path.join(dshHomeAbs, "storages");
		},
		attachmentsRoot() {
			return path.join(dshHomeAbs, "attachments", "v1");
		},
		dshHomePatchFile() {
			return path.join(dshHomeAbs, "cordis.patch.yml");
		},
		nukeStateRoot() {
			return path.join(dshHomeAbs, ".nuke");
		}
	};
	/** denyGlob 匹配：全路径命中，或（多段 glob 时）路径尾部等长段命中，或（单段时）basename 命中 */
	function matchesGlob(canonPath, glob) {
		const norm = normalizeForCompare(canonPath);
		const re = globToRegex(glob);
		if (re.test(norm)) return true;
		const globSegs = glob.split("/").filter(Boolean);
		if (globSegs.length > 1) {
			const tail = norm.split("/").filter(Boolean).slice(-globSegs.length).join("/");
			return re.test(tail);
		}
		const base = norm.split("/").pop();
		return re.test(base);
	}
	function resolveAllowedRoots(roots) {
		const out = [];
		for (const root of roots) switch (root.kind) {
			case "profile-dir":
				out.push(path.join(dshHomeAbs, "profiles", root.profile));
				break;
			case "storages":
				out.push(path.join(dshHomeAbs, "storages"));
				break;
			case "attachments":
				out.push(path.join(dshHomeAbs, "attachments", "v1"));
				break;
			case "dsh-home-patch":
				out.push(path.join(dshHomeAbs, "cordis.patch.yml"));
				break;
			case "temp-orphan": out.push(tempAbs);
		}
		return out;
	}
	return resolver;
}
//#endregion
//#region src/infra/lock-manager.ts
const LOCK_DIR_NAME = "locks";
function scopeKey(scope) {
	switch (scope.kind) {
		case "global": return "global";
		case "profile": return `profile:${scope.profile}`;
		case "plugin": return `plugin:${scope.profile}/${scope.plugin}`;
	}
}
/** owner 内容等值（pid + bootToken）：反序列化后对象引用不同，禁止用 === 比较 */
function sameOwner(a, b) {
	return a.pid === b.pid && a.bootToken === b.bootToken;
}
function createLockManager(options) {
	const lockDir = path.join(options.lockRoot, LOCK_DIR_NAME);
	const now = options.now ?? (() => Date.now());
	const probe = options.probe ?? { isAlive(pid, hostname) {
		if (hostname !== os.hostname()) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	} };
	fs.mkdirSync(lockDir, { recursive: true });
	function lockPath(scope) {
		return path.join(lockDir, `${scopeKey(scope).replace(/[/@]/g, "_")}.lock`);
	}
	function readLock(p) {
		try {
			const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (typeof parsed !== "object" || parsed === null) return null;
			const c = parsed;
			if (c.version !== 1) return null;
			if (c.mode !== "shared" && c.mode !== "exclusive") return null;
			if (!Array.isArray(c.owners)) return null;
			for (const o of c.owners) {
				if (typeof o !== "object" || o === null) return null;
				if (typeof o.owner?.pid !== "number" || typeof o.owner?.bootToken !== "string") return null;
				if (typeof o.expiresAt !== "number") return null;
			}
			return parsed;
		} catch {
			return null;
		}
	}
	function writeLockAtomic(p, content) {
		try {
			const fd = fs.openSync(p, "wx");
			fs.writeSync(fd, JSON.stringify(content, null, 2));
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			return true;
		} catch {
			return false;
		}
	}
	/** 单次获取尝试（不含等待循环） */
	async function tryOnce(request) {
		const p = lockPath(request.scope);
		const me = {
			owner: request.owner,
			acquiredAt: new Date(now()).toISOString(),
			expiresAt: now() + request.ttlMs
		};
		if (request.mode === "shared") {
			if (await withGuard(p, now, () => {
				const cur = readLock(p);
				if (cur && cur.mode === "exclusive") return false;
				const content = cur && cur.mode === "shared" ? {
					...cur,
					owners: [...cur.owners.filter((o) => o.expiresAt > now()), me]
				} : {
					version: 1,
					scope: scopeKey(request.scope),
					mode: "shared",
					owners: [me]
				};
				const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
				fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
				fs.renameSync(tmp, p);
				return true;
			}) !== true) return null;
		} else if (!writeLockAtomic(p, {
			version: 1,
			scope: scopeKey(request.scope),
			mode: "exclusive",
			owners: [me]
		})) return null;
		const lockId = crypto.randomBytes(8).toString("hex");
		let released = false;
		return {
			id: lockId,
			request,
			acquiredAt: me.acquiredAt,
			async refresh() {
				if (released) return err({
					code: "E_LOCK_STATE",
					message: "锁已释放"
				});
				const done = await withGuard(p, now, () => {
					const cur = readLock(p);
					if (!cur) return false;
					if (!cur.owners.find((o) => sameOwner(o.owner, request.owner))) return false;
					const content = {
						...cur,
						owners: cur.owners.map((o) => sameOwner(o.owner, request.owner) ? {
							...o,
							expiresAt: now() + request.ttlMs
						} : o)
					};
					const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
					fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
					fs.renameSync(tmp, p);
					return true;
				});
				if (done === null) return err({
					code: "E_LOCK_STATE",
					message: "刷新锁失败：互斥 guard 在等待窗口内不可用"
				});
				if (done === false) return err({
					code: "E_LOCK_STALE",
					message: "锁文件已消失或本持有者已不在锁中（可能被安全破锁）"
				});
				return ok(void 0);
			},
			async release() {
				if (released) return ok(void 0);
				released = true;
				try {
					if (request.mode === "shared") {
						if (await withGuard(p, now, () => {
							const cur = readLock(p);
							if (!cur) return true;
							const rest = cur.owners.filter((o) => !sameOwner(o.owner, request.owner));
							if (rest.length === 0) try {
								fs.unlinkSync(p);
							} catch {}
							else {
								const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
								fs.writeFileSync(tmp, JSON.stringify({
									...cur,
									owners: rest
								}, null, 2));
								fs.renameSync(tmp, p);
							}
							return true;
						}) !== true) return err({
							code: "E_LOCK_STATE",
							message: "释放锁失败：互斥 guard 在等待窗口内不可用"
						});
					} else try {
						fs.unlinkSync(p);
					} catch {}
					return ok(void 0);
				} catch (e) {
					return err(ioError("释放锁失败", e));
				}
			}
		};
	}
	async function acquire(request) {
		const deadline = now() + request.waitTimeoutMs;
		for (;;) {
			const handle = await tryOnce(request);
			if (handle) return ok(handle);
			if (now() >= deadline) {
				const holders = readLock(lockPath(request.scope))?.owners.map((o) => `${o.owner.purpose}(pid ${o.owner.pid})`).join(", ") ?? "unknown";
				return err({
					code: "E_LOCK_HELD",
					message: `获取锁超时（${request.waitTimeoutMs}ms）：scope=${scopeKey(request.scope)} mode=${request.mode}，当前持有: ${holders}`
				});
			}
			await sleep(Math.min(50, Math.max(1, deadline - now())));
		}
	}
	return {
		acquire,
		async tryAcquire(request) {
			return await tryOnce(request);
		},
		async withLock(request, fn) {
			const got = await acquire(request);
			if (!got.ok) return got;
			try {
				return await fn(got.value);
			} catch (e) {
				return err(ioError("临界区异常", e));
			} finally {
				await got.value.release();
			}
		},
		async breakStale(proof) {
			if (!proof.verifiedDead) return err({
				code: "E_LOCK_STALE",
				message: "拒绝破锁：持有者进程仍存活，未满足 verifiedDead"
			});
			if (!proof.ttlExpired) return err({
				code: "E_LOCK_STALE",
				message: "拒绝破锁：TTL 未过期"
			});
			let broken = 0;
			for (const f of fs.readdirSync(lockDir)) {
				if (!f.endsWith(".lock")) continue;
				const fp = path.join(lockDir, f);
				if (await withGuard(fp, now, () => {
					const cur = readLock(fp);
					if (!cur) return;
					const staleSlots = cur.owners.filter((o) => sameOwner(o.owner, proof.owner) && o.expiresAt <= now() && !probe.isAlive(o.owner.pid, o.owner.hostname));
					if (staleSlots.length === 0) return;
					const rest = cur.owners.filter((o) => !staleSlots.includes(o));
					if (rest.length === 0) try {
						fs.unlinkSync(fp);
					} catch {}
					else {
						const tmp = fp + ".tmp." + crypto.randomBytes(4).toString("hex");
						fs.writeFileSync(tmp, JSON.stringify({
							...cur,
							owners: rest
						}, null, 2));
						fs.renameSync(tmp, fp);
					}
					broken++;
				}) === null) continue;
			}
			if (broken === 0) return err({
				code: "E_LOCK_STALE",
				message: "未找到符合条件的陈旧锁"
			});
			return ok(void 0);
		},
		holders(scope) {
			const cur = readLock(lockPath(scope));
			if (!cur) return [];
			return cur.owners.filter((o) => o.expiresAt > now()).map((o) => o.owner);
		}
	};
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
const GUARD_SUFFIX = ".mut";
const GUARD_SUPERSEDE_MS = 1e4;
const GUARD_RETRY_MS = 20;
const GUARD_MAX_WAIT_MS = 15e3;
/** 在 p 的 guard 保护下执行 fn（同步体）。返回 null = guard 在等待窗口内不可用。 */
async function withGuard(p, now, fn) {
	const guard = p + GUARD_SUFFIX;
	const token = crypto.randomBytes(8).toString("hex");
	const start = now();
	for (;;) {
		try {
			fs.mkdirSync(guard);
		} catch (e) {
			if (e.code !== "EEXIST") return null;
			try {
				const st = fs.statSync(guard);
				if (now() - st.mtimeMs > GUARD_SUPERSEDE_MS) {
					fs.rmSync(guard, {
						recursive: true,
						force: true
					});
					continue;
				}
			} catch {}
			if (now() - start > GUARD_MAX_WAIT_MS) return null;
			await sleep(GUARD_RETRY_MS);
			continue;
		}
		try {
			fs.writeFileSync(path.join(guard, "owner"), token, "utf-8");
			return fn();
		} finally {
			try {
				if (fs.readFileSync(path.join(guard, "owner"), "utf-8") === token) fs.rmSync(guard, {
					recursive: true,
					force: true
				});
			} catch {}
		}
	}
}
//#endregion
//#region src/infra/wal.ts
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
const TXID_RE$1 = /^[A-Za-z0-9_-]{1,64}$/;
const CRC_FIELD = "__crc";
/** 规范化 CRC：键序稳定的 JSON 序列化后取 SHA-256 前 16 hex */
function computeCrc(record) {
	const { ...rest } = record;
	delete rest[CRC_FIELD];
	const canonical = JSON.stringify(rest, Object.keys(rest).sort());
	return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
/** 解析并校验一行；返回 null = 该行损坏（语法或 CRC） */
function parseLine(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") return null;
	if (parsed[CRC_FIELD] !== void 0) {
		if (typeof parsed[CRC_FIELD] !== "string" || parsed[CRC_FIELD] !== computeCrc(parsed)) return null;
		const { ...clean } = parsed;
		delete clean[CRC_FIELD];
		return clean;
	}
	return parsed;
}
function createWal(options) {
	fs.mkdirSync(options.walRoot, { recursive: true });
	function file(txId) {
		if (!TXID_RE$1.test(txId)) throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`);
		return path.join(options.walRoot, `${txId}.wal.jsonl`);
	}
	return {
		async append(txId, record) {
			const line = JSON.stringify({
				...record,
				[CRC_FIELD]: computeCrc(record)
			});
			const fd = fs.openSync(file(txId), "a");
			try {
				fs.writeSync(fd, line + "\n");
				fs.fdatasyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		},
		async replay(txId) {
			const p = file(txId);
			let text;
			try {
				text = fs.readFileSync(p, "utf-8");
			} catch {
				return [];
			}
			const lines = text.split("\n").filter((l) => l.trim().length > 0);
			const records = [];
			let corruptMiddle = false;
			for (const [i, line] of lines.entries()) {
				const rec = parseLine(line);
				if (rec === null) {
					if (i === lines.length - 1) break;
					corruptMiddle = true;
					break;
				}
				records.push(rec);
			}
			if (corruptMiddle) return [];
			return records;
		},
		unfinishedTxIds() {
			const out = [];
			let files;
			try {
				files = fs.readdirSync(options.walRoot);
			} catch {
				return out;
			}
			for (const f of files) {
				if (!f.endsWith(".wal.jsonl")) continue;
				const txId = f.slice(0, -10);
				if (!TXID_RE$1.test(txId)) continue;
				let text;
				try {
					text = fs.readFileSync(path.join(options.walRoot, f), "utf-8");
				} catch {
					continue;
				}
				const lines = text.split("\n").filter((l) => l.trim().length > 0);
				let corruptMiddle = false;
				let finished = false;
				lines.forEach((l, i) => {
					const rec = parseLine(l);
					if (rec === null) {
						if (i !== lines.length - 1) corruptMiddle = true;
						return;
					}
					if (rec.type === "tx-commit" || rec.type === "tx-rollback") finished = true;
				});
				if (corruptMiddle) continue;
				if (!finished) out.push(txId);
			}
			return out;
		}
	};
}
//#endregion
//#region src/infra/fs-utils.ts
/** 递归目录体积（符号链接不跟随；读不到的条目按 0 计）。
*  入口 lstat 防护 + 深度上限：传入符号链接返回 0（防 symlink→/ 的全盘递归 DoS），
*  超过 64 层深视为异常结构直接停止。 */
function dirSize(p) {
	try {
		if (fs.lstatSync(p).isSymbolicLink()) return 0;
	} catch {
		return 0;
	}
	let total = 0;
	const walk = (dir, depth) => {
		if (depth > 64) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full, depth + 1);
			else if (e.isFile()) try {
				total += fs.statSync(full).size;
			} catch {}
		}
	};
	walk(p, 0);
	return total;
}
function existsSafe(p) {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}
/** 进程崩溃安全的唯一临时文件名：同进程并发不撞车 */
function tmpName(dst) {
	return `${dst}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
}
/**
* 原子复制：tmp + rename，中断不留半写文件于目标位。
* 自动创建父目录；返回目标文件字节数。失败路径清理 tmp（防半写残留堆积）。
*/
function copyAtomic(src, dst) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	const tmp = tmpName(dst);
	try {
		fs.copyFileSync(src, tmp);
		fs.renameSync(tmp, dst);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw e;
	}
	return fs.statSync(dst).size;
}
/** 原子写文本（UTF-8）：配置/meta 落盘统一入口。失败路径清理 tmp。 */
function writeTextAtomic(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = tmpName(file);
	try {
		fs.writeFileSync(tmp, content, "utf-8");
		fs.renameSync(tmp, file);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw e;
	}
}
/** 原子写 JSON（2 空格缩进，确定性输出） */
function writeJsonAtomic(file, value) {
	writeTextAtomic(file, JSON.stringify(value, null, 2));
}
/**
* 容错式 JSONL 读取：逐行解析，损坏行（含崩溃残留的尾部半行）跳过。
* 返回 null 表示文件不存在/不可读。
*/
function readJsonl(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	const out = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {}
	}
	return out;
}
/** 追加一行 JSON（自动建目录） */
function appendJsonl(file, entry) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}
/** 有界并发 map：保持输入顺序的输出；fn 抛错该项为 rejected（不炸整池） */
async function forEachPool(items, concurrency, fn) {
	const results = new Array(items.length);
	let cursor = 0;
	const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
	const worker = async () => {
		for (;;) {
			const i = cursor++;
			if (i >= items.length) return;
			try {
				results[i] = {
					status: "fulfilled",
					value: await fn(items[i], i)
				};
			} catch (e) {
				results[i] = {
					status: "rejected",
					reason: e
				};
			}
		}
	};
	await Promise.all(Array.from({ length: lanes }, worker));
	return results;
}
/** 并行目录体积（dirSize 的并发版）：目录读经并发池分发。
*  语义与 dirSize 一致：符号链接不跟随、读不到按 0、深度上限 64。 */
async function dirSizeAsync(p, opts = {}) {
	const concurrency = opts.concurrency ?? 8;
	try {
		if (fs.lstatSync(p).isSymbolicLink()) return 0;
	} catch {
		return 0;
	}
	let total = 0;
	const walk = async (dir, depth) => {
		if (depth > 64 || opts.signal?.aborted) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const subdirs = [];
		await forEachPool(entries, concurrency, async (e) => {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) subdirs.push(full);
			else if (e.isFile()) try {
				total += fs.statSync(full).size;
			} catch {}
		});
		await forEachPool(subdirs, concurrency, (sub) => walk(sub, depth + 1));
	};
	await walk(p, 0);
	return total;
}
/** TEMP 根目录下带 dsh 痕迹且超过 maxAgeDays 的条目，按体积降序。
*  符号链接不跟随（statSync 遵循链接，故先用 lstat 排除）。 */
function tempOrphanEntries(tempRoot, maxAgeDays, now, markerRe = /dsh|deepseek|cordis/i) {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(tempRoot, { withFileTypes: true });
	} catch {
		return out;
	}
	const nowMs = now().getTime();
	for (const e of entries) {
		if (!markerRe.test(e.name)) continue;
		const full = path.join(tempRoot, e.name);
		try {
			const lst = fs.lstatSync(full);
			if (lst.isSymbolicLink()) continue;
			const st = fs.statSync(full);
			const ageDays = (nowMs - st.mtimeMs) / 864e5;
			if (ageDays >= maxAgeDays) out.push({
				path: full,
				isDir: lst.isDirectory(),
				sizeBytes: lst.isDirectory() ? dirSize(full) : st.size,
				ageDays
			});
		} catch {}
	}
	return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
}
//#endregion
//#region src/infra/backup-store.ts
const TXID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function createBackupStore(options) {
	fs.mkdirSync(options.backupRoot, { recursive: true });
	function hashFile(p) {
		return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
	}
	function hashString(s) {
		return crypto.createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 16);
	}
	/** 目录指纹：按序累积全部文件内容哈希（结构敏感，与旧 fingerprint.ts 一致） */
	function hashDir(p) {
		const h = crypto.createHash("sha256");
		const walk = (dir) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (e.isFile()) h.update(fs.readFileSync(full));
			}
		};
		walk(p);
		return h.digest("hex").slice(0, 16);
	}
	function fingerprintOf(p, content) {
		const stat = fs.statSync(p);
		if (stat.isDirectory()) return {
			path: p,
			hash: hashDir(p),
			size: dirSize(p),
			mtime: Math.floor(stat.mtimeMs)
		};
		return {
			path: p,
			hash: content !== void 0 ? hashString(content) : hashFile(p),
			size: content !== void 0 ? Buffer.byteLength(content) : stat.size,
			mtime: Math.floor(stat.mtimeMs)
		};
	}
	function txArea(txId) {
		if (!TXID_RE.test(txId)) throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`);
		return path.join(options.backupRoot, txId);
	}
	function manifestFile(txId) {
		return path.join(txArea(txId), "manifest.jsonl");
	}
	function appendManifest(txId, record) {
		const fd = fs.openSync(manifestFile(txId), "a");
		try {
			fs.writeSync(fd, JSON.stringify(record) + "\n");
			fs.fdatasyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
	function writeSync(p, content) {
		const fd = fs.openSync(p, "w");
		try {
			fs.writeSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
	return { async reserve(txId) {
		fs.mkdirSync(txArea(txId), { recursive: true });
		/** manifest 读取的闭包级实现（对象字面量方法间不能互相按名调用） */
		const readManifest = () => {
			const p = manifestFile(txId);
			if (!fs.existsSync(p)) return [];
			return readJsonl(p) ?? [];
		};
		return {
			async stageFile(original) {
				const backupPath = path.join(txArea(txId), `f-${counter()}-${path.basename(original)}`);
				fs.copyFileSync(original, backupPath);
				const record = {
					operationId: counter(),
					kind: "file-copy",
					originalPath: original,
					backupPath,
					fingerprint: fingerprintOf(backupPath)
				};
				try {
					appendManifest(txId, record);
				} catch (e) {
					try {
						fs.unlinkSync(backupPath);
					} catch {}
					throw e;
				}
				return record;
			},
			async stageDir(original) {
				const backupPath = path.join(txArea(txId), `d-${counter()}-${path.basename(original)}`);
				let movedByRename = false;
				try {
					fs.renameSync(original, backupPath);
					movedByRename = true;
				} catch {
					try {
						fs.cpSync(original, backupPath, { recursive: true });
					} catch (e) {
						try {
							fs.rmSync(backupPath, {
								recursive: true,
								force: true
							});
						} catch {}
						throw e;
					}
				}
				const record = {
					operationId: counter(),
					kind: "dir-move",
					originalPath: original,
					backupPath,
					fingerprint: fingerprintOf(backupPath)
				};
				try {
					appendManifest(txId, record);
				} catch (e) {
					if (movedByRename) try {
						fs.renameSync(backupPath, original);
					} catch {}
					else try {
						fs.rmSync(backupPath, {
							recursive: true,
							force: true
						});
					} catch {}
					throw e;
				}
				if (!movedByRename) fs.rmSync(original, {
					recursive: true,
					force: true
				});
				return record;
			},
			async stageEdit(original, nextContent) {
				const backupPath = path.join(txArea(txId), `e-${counter()}-${path.basename(original)}`);
				const originalContent = fs.readFileSync(original, "utf-8");
				writeSync(backupPath, originalContent);
				writeSync(original, nextContent);
				const record = {
					operationId: counter(),
					kind: "yaml-edit",
					originalPath: original,
					backupPath,
					fingerprint: fingerprintOf(backupPath, originalContent),
					originalContent
				};
				try {
					appendManifest(txId, record);
				} catch (e) {
					writeSync(original, originalContent);
					try {
						fs.unlinkSync(backupPath);
					} catch {}
					throw e;
				}
				return record;
			},
			async restore(record) {
				try {
					if (!fs.existsSync(record.backupPath)) {
						if (record.kind === "dir-move" && fs.existsSync(record.originalPath)) return ok(void 0);
						return err({
							code: "E_IO",
							message: `备份产物不存在: ${record.backupPath}`
						});
					}
					const currentHash = record.kind === "dir-move" ? hashDir(record.backupPath) : record.originalContent !== void 0 ? hashString(fs.readFileSync(record.backupPath, "utf-8")) : hashFile(record.backupPath);
					if (currentHash !== record.fingerprint.hash) return err({
						code: "E_IO",
						message: `备份被篡改，拒绝恢复: ${record.backupPath}`,
						details: {
							expected: record.fingerprint.hash,
							actual: currentHash
						}
					});
					switch (record.kind) {
						case "file-copy":
							fs.copyFileSync(record.backupPath, record.originalPath);
							break;
						case "dir-move":
							if (fs.existsSync(record.originalPath)) return err({
								code: "E_IO",
								message: `原位已存在新内容，拒绝覆盖式恢复: ${record.originalPath}`
							});
							try {
								fs.renameSync(record.backupPath, record.originalPath);
							} catch {
								fs.cpSync(record.backupPath, record.originalPath, { recursive: true });
								fs.rmSync(record.backupPath, {
									recursive: true,
									force: true
								});
							}
							break;
						case "yaml-edit": writeSync(record.originalPath, record.originalContent ?? fs.readFileSync(record.backupPath, "utf-8"));
					}
					return ok(void 0);
				} catch (e) {
					return err(ioError("恢复失败", e));
				}
			},
			manifest() {
				return readManifest();
			},
			orphanArtifacts() {
				const area = txArea(txId);
				let entries;
				try {
					entries = fs.readdirSync(area);
				} catch {
					return 0;
				}
				const known = new Set(readManifest().map((r) => path.basename(r.backupPath)));
				known.add("manifest.jsonl");
				return entries.filter((name) => !known.has(name)).length;
			},
			async purge(txId) {
				try {
					fs.rmSync(txArea(txId), {
						recursive: true,
						force: true
					});
					return ok(void 0);
				} catch (e) {
					return err(ioError("清理备份区失败", e));
				}
			}
		};
	} };
	/** 备份产物唯一后缀（随机 hex：同事务内多文件备份不撞名） */
	function counter() {
		return crypto.randomBytes(6).toString("hex");
	}
}
//#endregion
//#region src/infra/audit-log.ts
const GENESIS = "0".repeat(16);
/** 规范化 JSON：键排序 + 无空格，保证同一条目任何环境算出同一 hash */
function canonicalJson(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
	return "{" + Object.entries(v).filter(([, val]) => val !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(",") + "}";
}
function computeHash(prevHash, entry) {
	return crypto.createHash("sha256").update(prevHash + canonicalJson(entry)).digest("hex").slice(0, 16);
}
function createAuditLog(options) {
	fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
	if (!fs.existsSync(options.filePath)) fs.writeFileSync(options.filePath, "");
	/** 链尾哨兵文件：独立记录最后一次 append 的 seq/hash。
	*  单独删除链文件尾部不会破坏剩余链的连续性（尾条目无后继引用），
	*  哨兵使 verify() 能检出这种"抹除最近记录"的截断攻击。 */
	function headFile() {
		return options.filePath + ".head.json";
	}
	function readAll() {
		return readJsonl(options.filePath) ?? [];
	}
	const tail = (() => {
		const all = readAll();
		const last = all[all.length - 1];
		return {
			seq: all.length,
			hash: last?.hash ?? GENESIS
		};
	})();
	return {
		async append(entry) {
			const prev = tail.hash;
			const seq = tail.seq;
			const hashed = {
				...entry,
				seq,
				prevHash: prev,
				hash: computeHash(prev, entry)
			};
			tail.seq = seq + 1;
			tail.hash = hashed.hash;
			const fd = fs.openSync(options.filePath, "a");
			try {
				fs.writeSync(fd, JSON.stringify(hashed) + "\n");
				fs.fdatasyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			writeJsonAtomic(headFile(), {
				seq: hashed.seq,
				hash: hashed.hash
			});
			return hashed;
		},
		async verify() {
			const all = readAll();
			let prev = GENESIS;
			for (const [i, e] of all.entries()) {
				const { seq: _s, prevHash: _p, hash: _h, ...raw } = e;
				if (e.seq !== i || e.prevHash !== prev || e.hash !== computeHash(prev, raw)) return {
					valid: false,
					firstBrokenSeq: e.seq,
					totalEntries: all.length
				};
				prev = e.hash;
			}
			if (fs.existsSync(headFile())) {
				let head = null;
				try {
					head = JSON.parse(fs.readFileSync(headFile(), "utf-8"));
				} catch {
					head = null;
				}
				const last = all[all.length - 1];
				if (head && typeof head.seq === "number" && typeof head.hash === "string") {
					const expectedSeq = last ? last.seq : -1;
					const expectedHash = last ? last.hash : GENESIS;
					if (head.seq !== expectedSeq || head.hash !== expectedHash) return {
						valid: false,
						firstBrokenSeq: null,
						totalEntries: all.length
					};
				}
			}
			return {
				valid: true,
				firstBrokenSeq: null,
				totalEntries: all.length
			};
		},
		async query(filter) {
			return readAll().filter((e) => (filter.txId === void 0 || e.txId === filter.txId) && (filter.actor === void 0 || e.actor === filter.actor) && (filter.since === void 0 || e.timestamp >= filter.since));
		}
	};
}
//#endregion
//#region src/engine/hook-registry.ts
const DEFAULT_ALLOW_BINS = [
	"node",
	"python",
	"python3",
	"dsh",
	"pnpm",
	"npm",
	"git"
];
function createHookRegistry(options) {
	const allowBins = options.allowBins ?? DEFAULT_ALLOW_BINS;
	const defs = [];
	let seq = 0;
	/** 磁盘钩子的注销句柄：loadFromDisk 幂等的关键 —— 重载前先注销上一轮，
	*  否则多次调用（如配置热重载）会叠加注册同一批钩子导致重复执行。 */
	let diskUnsubscribers = [];
	function runCommand(handler, ctx) {
		return new Promise((resolve) => {
			const bin = handler.argv[0] ?? "";
			const env = { PATH: process.env.PATH ?? "" };
			for (const key of handler.envWhitelist) {
				const v = process.env[key];
				if (v !== void 0) env[key] = v;
			}
			env.NUKE_PLUGIN = ctx.plugin;
			env.NUKE_PROFILE = ctx.profile;
			env.NUKE_ACTION = ctx.action;
			env.NUKE_TX = ctx.txId;
			(0, child_process.execFile)(bin, handler.argv.slice(1), {
				env,
				timeout: handler.timeoutMs,
				maxBuffer: 65536
			}, (error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr || stdout || "").trim().slice(0, 200);
					resolve({
						ok: false,
						message: `钩子命令失败(${bin}): ${error.message}${detail ? ` | ${detail}` : ""}`
					});
				} else resolve({
					ok: true,
					message: String(stdout).trim().slice(0, 200)
				});
			});
		});
	}
	function register(def) {
		const id = def.id ?? `hook-${seq++}`;
		const withId = {
			...def,
			id
		};
		defs.push(withId);
		return () => {
			const i = defs.indexOf(withId);
			if (i >= 0) defs.splice(i, 1);
		};
	}
	return {
		register,
		async emit(timing, ctx) {
			const matching = defs.filter((d) => d.timing === timing).filter((d) => d.actions === "*" || d.actions.includes(ctx.action)).sort((a, b) => a.priority - b.priority);
			let executed = 0, failed = 0;
			let verdict = { kind: "proceed" };
			let errorDirective = null;
			const messages = [];
			for (const def of matching) {
				executed++;
				if (def.handler.type === "inline") try {
					const r = await def.handler.run(ctx);
					if (timing === "pre" && r && typeof r === "object" && "kind" in r) {
						const v = r;
						if (v.kind === "veto" && verdict.kind !== "veto") verdict = v;
						if (v.kind === "proceed-with-warning") messages.push(`⚠️ ${v.message}`);
					}
					if (timing === "error" && typeof r === "string") errorDirective = errorDirective ?? r;
				} catch (e) {
					failed++;
					messages.push(`❌ 钩子 ${def.id} 异常: ${errorToMessage(e)}`);
					if (def.onFailure === "fail-fast") return err({
						code: "E_HOOK_VETO",
						message: `钩子 ${def.id} fail-fast: ${errorToMessage(e)}`
					});
				}
				else {
					const argv0 = def.handler.argv[0] ?? "";
					if (argv0 === "" || /[\\/]/.test(argv0)) {
						failed++;
						messages.push(`❌ 钩子 ${def.id} argv[0] 必须为裸命令名（禁止路径）: "${argv0}"`);
						if (def.onFailure === "fail-fast") return err({
							code: "E_HOOK_VETO",
							message: `钩子 ${def.id} argv[0] 含路径，拒绝执行`
						});
						continue;
					}
					const bin = argv0.replace(/\.exe$/i, "");
					if (!allowBins.includes(bin)) {
						failed++;
						messages.push(`❌ 钩子 ${def.id} 命令不在白名单: ${bin}`);
						if (def.onFailure === "fail-fast") return err({
							code: "E_HOOK_VETO",
							message: `钩子命令白名单外: ${bin}`
						});
						continue;
					}
					const r = await runCommand(def.handler, ctx);
					if (r.ok) {
						if (r.message) messages.push(`✅ [${def.id}] ${r.message}`);
					} else {
						failed++;
						messages.push(`❌ [${def.id}] ${r.message}`);
						if (timing === "pre" && def.handler.nonzeroExitIsVeto) verdict = {
							kind: "veto",
							reason: r.message
						};
						if (def.onFailure === "fail-fast") return err({
							code: "E_HOOK_VETO",
							message: `钩子 ${def.id} fail-fast`
						});
					}
				}
			}
			return ok({
				executed,
				failed,
				verdict,
				errorDirective,
				messages
			});
		},
		async loadFromDisk() {
			for (const off of diskUnsubscribers) off();
			diskUnsubscribers = [];
			for (const timing of [
				"pre",
				"post",
				"error"
			]) {
				const p = path.join(options.dir, `${timing}.json`);
				if (!fs.existsSync(p)) continue;
				try {
					const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
					if (!Array.isArray(parsed)) return err({
						code: "E_VALIDATION",
						message: `钩子文件必须是数组: ${p}`
					});
					for (const d of parsed) {
						if (typeof d !== "object" || d === null) continue;
						const def = d;
						if (typeof def.timing !== "string" || typeof def.onFailure !== "string") continue;
						if (def.handler?.type === "command") {
							const argv = def.handler.argv;
							if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) continue;
							if (/[\\/]/.test(argv[0] ?? "")) continue;
							if (!Array.isArray(def.handler.envWhitelist)) continue;
							if (typeof def.handler.timeoutMs !== "number") continue;
						} else if (def.handler?.type !== "inline") continue;
						diskUnsubscribers.push(register({
							...d,
							timing
						}));
					}
				} catch (e) {
					return err(ioError(`钩子文件解析失败 ${p}`, e));
				}
			}
			return ok(void 0);
		},
		list() {
			return [...defs];
		}
	};
}
//#endregion
//#region src/infra/scan-cache.ts
const MAX_DEFAULT = 4096;
const MAX_AGE_MS_DEFAULT = 864e5;
function createScanCache(options) {
	const maxEntries = options.maxEntries ?? MAX_DEFAULT;
	const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS_DEFAULT;
	const cache = /* @__PURE__ */ new Map();
	let dirty = false;
	let hits = 0;
	let misses = 0;
	try {
		if (fs.existsSync(options.filePath)) {
			const parsed = JSON.parse(fs.readFileSync(options.filePath, "utf-8"));
			if (typeof parsed === "object" && parsed !== null) {
				const shape = parsed;
				if (shape.version === 1 && typeof shape.entries === "object" && shape.entries !== null) {
					for (const [k, v] of Object.entries(shape.entries)) if (typeof v === "object" && v !== null && typeof v.mtimeMs === "number" && typeof v.size === "number" && typeof v.cachedAt === "number") cache.set(k, v);
				}
			}
		}
	} catch {}
	function evictIfNeeded() {
		while (cache.size > maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === void 0) break;
			cache.delete(oldest);
		}
	}
	return {
		get(filePath, mtimeMs, size) {
			const hit = cache.get(filePath);
			if (hit === void 0) {
				misses++;
				return null;
			}
			if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
				misses++;
				return null;
			}
			if (Date.now() - hit.cachedAt >= maxAgeMs) {
				misses++;
				return null;
			}
			hits++;
			cache.delete(filePath);
			cache.set(filePath, hit);
			return hit;
		},
		set(filePath, entry) {
			cache.delete(filePath);
			cache.set(filePath, {
				...entry,
				cachedAt: Date.now()
			});
			evictIfNeeded();
			dirty = true;
		},
		flush() {
			if (!dirty) return;
			const shape = {
				version: 1,
				entries: Object.fromEntries(cache)
			};
			try {
				fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
				writeJsonAtomic(options.filePath, shape);
				dirty = false;
			} catch {}
		},
		stats() {
			return {
				entries: cache.size,
				hits,
				misses
			};
		}
	};
}
//#endregion
//#region src/engine/transaction-engine.ts
/** 状态机合法迁移表 */
const TRANSITIONS = {
	draft: ["planned"],
	planned: ["validating", "draft"],
	validating: ["executing", "planned"],
	executing: ["committing", "rolling-back"],
	committing: ["committed"],
	"rolling-back": ["rolled-back", "failed"],
	committed: [],
	"rolled-back": [],
	failed: []
};
function createTransactionEngine(deps, operationFactory) {
	const runtimes = /* @__PURE__ */ new Map();
	/** 终结事务摘要缓存（commit/rollback 后仍可 status 查询；进程重启后回退 WAL 重建）。
	*  LRU 上限：长驻进程中无限增长的 Map 是慢性内存泄漏；溢出逐最旧，
	*  被逐条目仍可从 WAL 重建（status 的第三路径）。 */
	const FINISHED_CACHE_MAX = 128;
	const finished = /* @__PURE__ */ new Map();
	function rememberFinished(txId, summary) {
		if (finished.has(txId)) finished.delete(txId);
		else if (finished.size >= FINISHED_CACHE_MAX) {
			const oldest = finished.keys().next().value;
			if (oldest !== void 0) finished.delete(oldest);
		}
		finished.set(txId, summary);
	}
	function setState(rt, next) {
		if (!TRANSITIONS[rt.state].includes(next)) return err({
			code: "E_TX_STATE",
			message: `非法状态迁移: ${rt.state} → ${next}（tx ${rt.txId}）`
		});
		rt.state = next;
		return ok(void 0);
	}
	function makeCtxFromRt(rt) {
		return {
			txId: rt.txId,
			request: rt.request,
			resolver: deps.resolver,
			logger: deps.logger.child({ tx: rt.txId }),
			clock: deps.clock,
			backups: rt.backupsArea
		};
	}
	function hookCtx(txId, request, op, backup) {
		return {
			txId,
			actor: request.actor,
			plugin: op.target,
			profile: request.profile,
			strategy: request.strategy,
			action: op.action,
			...backup ? { backup } : {}
		};
	}
	/** Saga 反向补偿：manifest 逆序 restore（幂等），并逐 op 调 undo 做额外清理。
	*  安全纪律：本函数自身绝不抛出 —— 它运行在 commit 的失败分支与 catch 块中，
	*  一旦抛出会跳过外层的锁释放（独占锁悬挂 = 后续所有事务被阻塞直至 TTL）。 */
	async function rollbackRuntime(rt, reason) {
		if (!setState(rt, "rolling-back").ok) deps.logger.warn("回滚状态迁移被拒，继续执行补偿动作", {
			tx: rt.txId,
			state: rt.state
		});
		const ctx = makeCtxFromRt(rt);
		const records = rt.backupsArea.manifest();
		for (const record of [...records].reverse()) try {
			const r = await rt.backupsArea.restore(record);
			if (!r.ok) deps.logger.error("回滚恢复失败", {
				path: record.originalPath,
				error: r.error.message
			});
		} catch (e) {
			deps.logger.error("回滚恢复异常", {
				path: record.originalPath,
				error: errorToMessage(e)
			});
		}
		const executedOps = new Map(rt.steps.filter((s) => s.status === "done").map((s) => [s.operationId, s.backup]));
		for (const op of operationFactory(rt.request)) {
			const backup = executedOps.get(op.id) ?? null;
			try {
				const undo = await op.undo(ctx, backup);
				if (!undo.ok) deps.logger.warn("op.undo 报告", {
					op: op.id,
					error: undo.error.message
				});
			} catch (e) {
				deps.logger.error("op.undo 异常", {
					op: op.id,
					error: errorToMessage(e)
				});
			}
			rt.steps = rt.steps.map((s) => s.operationId === op.id && s.status === "done" ? {
				...s,
				status: "undone"
			} : s);
		}
		try {
			await deps.wal.append(ctx.txId, {
				type: "tx-rollback",
				txId: ctx.txId,
				reason
			});
		} catch (e) {
			deps.logger.error("回滚 WAL 追加失败（事务将保持可恢复状态）", {
				tx: ctx.txId,
				error: errorToMessage(e)
			});
		}
		rt.finishedAt = deps.clock.now().toISOString();
		setState(rt, rt.state === "rolling-back" ? "rolled-back" : "failed");
		try {
			await deps.audit.append({
				timestamp: rt.finishedAt,
				actor: rt.request.actor,
				action: "tx-rollback",
				txId: ctx.txId,
				outcome: "failure",
				detail: {
					reason,
					undone: records.length
				}
			});
		} catch (e) {
			deps.logger.error("回滚审计追加失败", {
				tx: ctx.txId,
				error: errorToMessage(e)
			});
		}
	}
	/** 事务终结收尾：摘要入缓存 → 释放独占锁 → 移除运行时。
	*  commit/rollback 的所有终态路径（成功/补偿失败/逃逸异常）都必须经过这里，
	*  否则锁悬挂会阻塞后续全部清理事务。 */
	async function finalize(rt) {
		rememberFinished(rt.txId, summarize(rt, rt.txId));
		await rt.lockHandle.release();
		runtimes.delete(rt.txId);
	}
	function summarize(rt, txId) {
		return {
			txId,
			state: rt.state,
			steps: rt.steps,
			bytesFreedTotal: rt.steps.reduce((sum, s) => sum + (s.bytesFreed || 0), 0),
			startedAt: rt.startedAt,
			...rt.finishedAt ? { finishedAt: rt.finishedAt } : {}
		};
	}
	/** WAL 重建路径的 startedAt：显式定位 tx-begin，不依赖 query 的返回顺序 */
	async function startedAtFromAudit(txId) {
		try {
			const entries = await deps.audit.query({ txId });
			return entries.find((e) => e.action === "tx-begin")?.timestamp ?? entries[0]?.timestamp ?? "";
		} catch {
			return "";
		}
	}
	return {
		async begin(request) {
			if (request.strategy === "aggressive" && !request.confirmationToken) return err({
				code: "E_VALIDATION",
				message: "aggressive 策略必须携带 confirmationToken（二次确认）"
			});
			const owner = {
				pid: process.pid,
				hostname: os.hostname(),
				bootToken: crypto.randomBytes(8).toString("hex"),
				purpose: "clean"
			};
			const acquired = await deps.lockManager.acquire({
				scope: { kind: "global" },
				mode: "exclusive",
				owner,
				waitTimeoutMs: 5e3,
				ttlMs: 3e5
			});
			if (!acquired.ok) return err(acquired.error);
			const txId = crypto.randomBytes(8).toString("hex");
			let backupsArea;
			try {
				backupsArea = await deps.backups.reserve(txId);
			} catch (e) {
				await acquired.value.release();
				return err(ioError("备份区预留失败", e));
			}
			const rt = {
				txId,
				state: "draft",
				request,
				steps: [],
				startedAt: deps.clock.now().toISOString(),
				lockHandle: acquired.value,
				backupsArea
			};
			runtimes.set(txId, rt);
			await deps.wal.append(txId, {
				type: "tx-begin",
				txId,
				request
			});
			await deps.audit.append({
				timestamp: rt.startedAt,
				actor: request.actor,
				action: "tx-begin",
				txId,
				outcome: "success",
				detail: {
					plugins: request.plugins,
					profile: request.profile,
					strategy: request.strategy,
					dryRun: request.dryRun
				}
			});
			return ok({
				txId,
				lockId: acquired.value.id,
				request
			});
		},
		async plan(session) {
			const rt = runtimes.get(session.txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${session.txId}`
			});
			const st = setState(rt, "planned");
			if (!st.ok) return err(st.error);
			const ctx = makeCtxFromRt(rt);
			const ops = operationFactory(rt.request);
			const warnings = [];
			if (rt.request.strategy === "aggressive") {
				const token = rt.request.confirmationToken ?? "";
				if (!(deps.verifyConfirmationToken ? deps.verifyConfirmationToken(token, rt.request) : false)) warnings.push({
					code: "CONFIRMATION_TOKEN_INVALID",
					blocking: true,
					message: "aggressive 策略确认令牌无效，commit 被阻止"
				});
			}
			let total = 0;
			for (const op of ops) {
				const p = await op.preview(ctx);
				total += p.estimatedBytesReclaimable;
			}
			return ok({
				txId: session.txId,
				operations: ops,
				estimatedBytesReclaimable: total,
				warnings,
				requiresConfirmationToken: rt.request.strategy === "aggressive"
			});
		},
		async dryRun(plan) {
			const rt = runtimes.get(plan.txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${plan.txId}`
			});
			const ctx = makeCtxFromRt(rt);
			const reports = [];
			let total = 0;
			for (const op of plan.operations) {
				const p = await op.preview(ctx);
				total += p.estimatedBytesReclaimable;
				reports.push({
					operation: p,
					summary: p.summary
				});
			}
			const report = {
				txId: plan.txId,
				plans: reports,
				estimatedBytesReclaimable: total,
				warnings: plan.warnings
			};
			await deps.audit.append({
				timestamp: deps.clock.now().toISOString(),
				actor: rt.request.actor,
				action: "dry-run",
				txId: plan.txId,
				outcome: "success",
				detail: {
					operations: reports.length,
					estimatedBytes: total
				}
			});
			return ok(report);
		},
		async commit(plan) {
			const rt = runtimes.get(plan.txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${plan.txId}`
			});
			if (rt.request.strategy === "aggressive") {
				if (!(deps.verifyConfirmationToken && rt.request.confirmationToken !== void 0 ? deps.verifyConfirmationToken(rt.request.confirmationToken, rt.request) : false)) return err({
					code: "E_VALIDATION",
					message: "aggressive 策略确认令牌无效，commit 被拒绝（令牌复验失败）"
				});
			}
			const blocking = plan.warnings.find((w) => w.blocking);
			if (blocking) return err({
				code: "E_VALIDATION",
				message: `计划存在阻断性警告: ${blocking.message}`
			});
			let st = setState(rt, "validating");
			if (!st.ok) return err(st.error);
			const ctx = makeCtxFromRt(rt);
			const txId = plan.txId;
			try {
				for (const op of plan.operations) {
					const v = await op.validate(ctx);
					if (!v.ok) {
						await rollbackRuntime(rt, `validate 失败: ${op.id}: ${v.error.message}`);
						await finalize(rt);
						return err(v.error);
					}
				}
				st = setState(rt, "executing");
				if (!st.ok) return err(st.error);
				for (const [index, op] of plan.operations.entries()) {
					rt.steps.push({
						index,
						operationId: op.id,
						action: op.action,
						status: "pending",
						bytesFreed: 0,
						backup: null
					});
					await deps.wal.append(txId, {
						type: "step-intent",
						index,
						operationId: op.id,
						action: op.action,
						backup: null
					});
					const pre = await deps.hooks.emit("pre", hookCtx(txId, rt.request, op));
					if (pre.ok && pre.value.verdict.kind === "veto") {
						rt.steps[index] = {
							...rt.steps[index],
							status: "skipped"
						};
						await rollbackRuntime(rt, `pre 钩子否决: ${pre.value.verdict.reason}`);
						await finalize(rt);
						return err({
							code: "E_HOOK_VETO",
							message: `钩子否决: ${pre.value.verdict.reason}`
						});
					}
					try {
						const executed = await op.execute(ctx);
						if (!executed.ok) {
							rt.steps[index] = {
								...rt.steps[index],
								status: "failed",
								backup: null
							};
							await deps.wal.append(txId, {
								type: "step-failed",
								index,
								error: executed.error
							});
							const errHook = await deps.hooks.emit("error", {
								...hookCtx(txId, rt.request, op),
								error: executed.error
							});
							if ((errHook.ok ? errHook.value.errorDirective : null) === "skip-and-continue") {
								rt.steps[index] = {
									...rt.steps[index],
									status: "skipped"
								};
								continue;
							}
							await rollbackRuntime(rt, `步骤 ${index}(${op.id}) 失败: ${executed.error.message}`);
							await finalize(rt);
							return err(executed.error);
						}
						const { outcome, backup } = executed.value;
						rt.steps[index] = {
							...rt.steps[index],
							status: "done",
							bytesFreed: outcome.bytesFreed,
							backup
						};
						await deps.wal.append(txId, {
							type: "step-done",
							index,
							operationId: op.id,
							outcome,
							backup
						});
						await deps.hooks.emit("post", hookCtx(txId, rt.request, op, backup));
					} catch (e) {
						await rollbackRuntime(rt, `步骤 ${index}(${op.id}) 异常: ${errorToMessage(e)}`);
						await finalize(rt);
						return err(ioError("事务执行失败", e));
					}
				}
				st = setState(rt, "committing");
				if (!st.ok) return err(st.error);
				await deps.wal.append(txId, {
					type: "tx-commit",
					txId
				});
				rt.finishedAt = deps.clock.now().toISOString();
				setState(rt, "committed");
				await deps.audit.append({
					timestamp: rt.finishedAt,
					actor: rt.request.actor,
					action: "tx-commit",
					txId,
					outcome: "success",
					detail: {
						steps: rt.steps.length,
						bytesFreed: rt.steps.reduce((s, x) => s + x.bytesFreed, 0)
					}
				});
				await finalize(rt);
				return ok(summarize(rt, txId));
			} catch (e) {
				try {
					await rollbackRuntime(rt, `commit 逃逸异常: ${errorToMessage(e)}`);
				} catch {}
				await finalize(rt);
				return err(ioError("事务执行失败", e));
			}
		},
		async rollback(txId) {
			const rt = runtimes.get(txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${txId}`
			});
			if (rt.state === "committed" || rt.state === "rolled-back") return err({
				code: "E_TX_STATE",
				message: `事务已终结（${rt.state}），无法回滚`
			});
			try {
				await rollbackRuntime(rt, "手动回滚");
			} finally {
				await finalize(rt);
			}
			return ok(summarize(rt, txId));
		},
		async recover() {
			const recovered = [];
			for (const txId of deps.wal.unfinishedTxIds()) {
				if (runtimes.has(txId)) continue;
				try {
					const intents = (await deps.wal.replay(txId)).filter((r) => r.type === "step-intent");
					const area = await deps.backups.reserve(txId);
					const manifest = area.manifest();
					let restoreFailures = 0;
					for (const record of [...manifest].reverse()) try {
						if (!(await area.restore(record)).ok) restoreFailures++;
					} catch {
						restoreFailures++;
					}
					if (restoreFailures > 0 || area.orphanArtifacts() > 0) {
						deps.logger.error("崩溃恢复存在失败项/孤儿产物：备份保留待人工核查/下次重试", {
							txId,
							failures: restoreFailures,
							orphans: area.orphanArtifacts(),
							total: manifest.length
						});
						recovered.push({
							txId,
							state: "failed",
							steps: intents.map((r) => ({
								index: r.index,
								operationId: r.operationId,
								action: r.action,
								status: "undone",
								bytesFreed: 0,
								backup: null
							})),
							bytesFreedTotal: 0,
							startedAt: await startedAtFromAudit(txId)
						});
						continue;
					}
					await deps.wal.append(txId, {
						type: "tx-rollback",
						txId,
						reason: "crash-recovery"
					});
					await area.purge(txId);
					const summary = {
						txId,
						state: "rolled-back",
						steps: intents.map((r) => ({
							index: r.index,
							operationId: r.operationId,
							action: r.action,
							status: "undone",
							bytesFreed: 0,
							backup: null
						})),
						bytesFreedTotal: 0,
						startedAt: await startedAtFromAudit(txId)
					};
					recovered.push(summary);
					deps.logger.info("崩溃恢复完成", {
						txId,
						restored: manifest.length
					});
				} catch (e) {
					deps.logger.error("崩溃恢复事务异常，跳过", {
						txId,
						error: errorToMessage(e)
					});
				}
			}
			return ok(recovered);
		},
		async status(txId) {
			const rt = runtimes.get(txId);
			if (rt) return summarize(rt, txId);
			const cached = finished.get(txId);
			if (cached) {
				finished.delete(txId);
				finished.set(txId, cached);
				return cached;
			}
			const records = await deps.wal.replay(txId);
			if (records.length === 0) return null;
			const begin = records.find((r) => r.type === "tx-begin");
			if (!begin || begin.type !== "tx-begin") return null;
			const actionByIndex = /* @__PURE__ */ new Map();
			for (const r of records) if (r.type === "step-intent") actionByIndex.set(r.index, r.action);
			const steps = records.filter((r) => r.type === "step-done").map((r) => ({
				index: r.index,
				operationId: r.operationId,
				action: actionByIndex.get(r.index) ?? "standard-remove",
				status: "done",
				bytesFreed: r.outcome.bytesFreed,
				backup: r.backup
			}));
			return {
				txId,
				state: records.some((r) => r.type === "tx-commit") ? "committed" : records.some((r) => r.type === "tx-rollback") ? "rolled-back" : "failed",
				steps,
				bytesFreedTotal: steps.reduce((s, x) => s + x.bytesFreed, 0),
				startedAt: await startedAtFromAudit(txId)
			};
		}
	};
}
//#endregion
//#region src/engine/severity-scorer.ts
const DEFAULT_WEIGHTS = {
	type: 30,
	recency: 20,
	depth: 10,
	reference: 30,
	size: 10,
	recencyHalfLifeDays: 30,
	bands: {
		info: 0,
		low: 20,
		medium: 40,
		high: 60,
		critical: 80
	}
};
/** 类型基础风险：config-ref 涉及配置改写最高危；temp 孤儿最低 */
const TYPE_BASE = {
	"config-ref": .9,
	"node-modules": .45,
	"storage": .65,
	"attachment": .4,
	"temp-orphan": .15,
	"lockfile": .3,
	"unknown": .55
};
const DAY_MS$1 = 864e5;
function createSeverityScorer(options = {}) {
	const w = options.weights ?? DEFAULT_WEIGHTS;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const weightSum = w.type + w.recency + w.depth + w.reference + w.size;
	function bandOf(total) {
		for (const b of [
			"critical",
			"high",
			"medium",
			"low",
			"info"
		]) if (total >= w.bands[b]) return b;
		return "info";
	}
	function factorType(e) {
		const raw = TYPE_BASE[e.kind];
		return {
			factor: "type",
			weight: w.type,
			raw,
			contribution: w.type * raw,
			note: `类型 ${e.kind} 基础风险 ${raw.toFixed(2)}`
		};
	}
	function factorRecency(e) {
		let raw;
		let note;
		if (e.lastAccessedAt === null) {
			raw = .5;
			note = "atime 不可用 → 中性 0.50";
		} else {
			const ageDays = Math.max(0, (now().getTime() - e.lastAccessedAt.getTime()) / DAY_MS$1);
			raw = 1 - Math.pow(2, -ageDays / w.recencyHalfLifeDays);
			note = `${Math.round(ageDays)} 天未访问（半衰期 ${w.recencyHalfLifeDays}d）→ 衰减 ${raw.toFixed(2)}`;
		}
		return {
			factor: "recency",
			weight: w.recency,
			raw,
			contribution: w.recency * raw,
			note
		};
	}
	function factorDepth(e) {
		const segs = e.location.replace(/\\/g, "/").split("/").filter(Boolean);
		const raw = Math.min(1, Math.max(0, segs.length - 4) / 8);
		return {
			factor: "depth",
			weight: w.depth,
			raw,
			contribution: w.depth * raw,
			note: `路径深度 ${segs.length} 段 → ${raw.toFixed(2)}`
		};
	}
	function factorReference(e) {
		const n = e.referencedBy.length;
		const raw = n === 0 ? 0 : Math.min(1, .7 + .1 * (n - 1));
		return {
			factor: "reference",
			weight: w.reference,
			raw,
			contribution: w.reference * raw,
			note: n === 0 ? "无任何插件引用（孤儿）" : `仍被 ${n} 个插件引用: ${e.referencedBy.join(", ")}`
		};
	}
	function factorSize(e) {
		const raw = Math.min(1, Math.log10(1 + Math.max(0, e.sizeBytes)) / 9);
		return {
			factor: "size",
			weight: w.size,
			raw,
			contribution: w.size * raw,
			note: `${fmtBytes$1(e.sizeBytes)} → 对数缩放 ${raw.toFixed(2)}`
		};
	}
	const scorer = {
		score(evidence) {
			const breakdown = [
				factorType(evidence),
				factorRecency(evidence),
				factorDepth(evidence),
				factorReference(evidence),
				factorSize(evidence)
			];
			const total = Math.round(Math.max(0, Math.min(100, 100 * breakdown.reduce((s, f) => s + f.contribution, 0) / weightSum)));
			return {
				total,
				band: bandOf(total),
				breakdown,
				safeToAutoClean: evidence.referencedBy.length === 0 && total < w.bands.high
			};
		},
		rank(evidences) {
			return evidences.map((e) => ({
				...e,
				score: scorer.score(e)
			})).sort((a, b) => b.score.total - a.score.total || b.sizeBytes - a.sizeBytes);
		}
	};
	return scorer;
}
//#endregion
//#region src/engine/dependency-analyzer.ts
const DEP_KINDS = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies"
];
function createDependencyAnalyzer(options) {
	const fsys = options.fs_ ?? fs;
	const yamlParse = options.yamlParse ?? yaml.parse;
	function listProfiles() {
		const dir = path.join(options.dshHome, "profiles");
		if (!fsys.existsSync(dir)) return [];
		return fsys.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	}
	function readJson(p) {
		try {
			return JSON.parse(fsys.readFileSync(p, "utf-8"));
		} catch {
			return null;
		}
	}
	/** 从 package.json 抽出 (name → kind) 依赖表 */
	function depsOf(pkg) {
		const out = /* @__PURE__ */ new Map();
		for (const kind of DEP_KINDS) {
			const sec = pkg[kind];
			if (sec && typeof sec === "object") for (const name of Object.keys(sec)) out.set(name, kind);
		}
		return out;
	}
	/** 解析 cordis.patch.yml：收集所有条目的 id（支持 {changes:[{id}]} 与 [{id}] 两种形态） */
	function patchIds(file) {
		if (!fsys.existsSync(file)) return {
			ids: [],
			parseError: null
		};
		try {
			const doc = yamlParse(fsys.readFileSync(file, "utf-8"));
			const ids = [];
			const visit = (node) => {
				if (Array.isArray(node)) {
					node.forEach(visit);
					return;
				}
				if (node && typeof node === "object") {
					const rec = node;
					if (typeof rec.id === "string") ids.push(rec.id);
					for (const v of Object.values(rec)) if (v && typeof v === "object") visit(v);
				}
			};
			visit(doc);
			return {
				ids: [...new Set(ids)],
				parseError: null
			};
		} catch (e) {
			return {
				ids: [],
				parseError: errorToMessage(e)
			};
		}
	}
	/** node_modules 下的一级包名（含 @scope/name 两段） */
	function listBundleDirs(nmRoot) {
		if (!fsys.existsSync(nmRoot)) return [];
		const out = [];
		for (const e of fsys.readdirSync(nmRoot, { withFileTypes: true })) {
			if (e.name.startsWith(".")) continue;
			if (e.name.startsWith("@")) {
				const scopeDir = path.join(nmRoot, e.name);
				if (!fsys.existsSync(scopeDir)) continue;
				for (const sub of fsys.readdirSync(scopeDir, { withFileTypes: true })) if (sub.isDirectory()) out.push(`${e.name}/${sub.name}`);
			} else if (e.isDirectory()) out.push(e.name);
		}
		return out;
	}
	function buildGraph(profileFilter) {
		const nodes = /* @__PURE__ */ new Map();
		const edges = [];
		const upsert = (name, patch = {}) => {
			const key = name;
			const cur = nodes.get(key) ?? {
				name: key,
				declaredIn: [],
				patchRefs: []
			};
			nodes.set(key, {
				name: key,
				declaredIn: dedupeJoin(cur.declaredIn, patch.declaredIn),
				patchRefs: dedupeJoin(cur.patchRefs, patch.patchRefs)
			});
		};
		const dedupeJoin = (a, b) => [.../* @__PURE__ */ new Set([...a, ...b ?? []])];
		for (const profile of listProfiles()) {
			if (profileFilter && profile !== profileFilter) continue;
			const profileDir = path.join(options.dshHome, "profiles", profile);
			const pkgPath = path.join(profileDir, "package.json");
			const synthetic = `profile:${profile}`;
			if (fsys.existsSync(pkgPath)) {
				const pkg = readJson(pkgPath);
				if (pkg) {
					upsert(synthetic, { declaredIn: [pkgPath] });
					for (const [dep, kind] of depsOf(pkg)) {
						upsert(dep);
						edges.push({
							from: synthetic,
							to: dep,
							kind,
							declaredIn: pkgPath
						});
					}
				}
			}
			const nmRoot = path.join(profileDir, "node_modules");
			for (const bundle of listBundleDirs(nmRoot)) {
				const bp = path.join(nmRoot, ...bundle.split("/"), "package.json");
				if (!fsys.existsSync(bp)) continue;
				const pkg = readJson(bp);
				if (!pkg) continue;
				upsert(bundle);
				for (const [dep, kind] of depsOf(pkg)) {
					if (!(nodes.has(dep) || fsys.existsSync(path.join(nmRoot, ...dep.split("/"))))) continue;
					upsert(dep);
					edges.push({
						from: bundle,
						to: dep,
						kind,
						declaredIn: bp
					});
				}
			}
			const patchFiles = [path.join(options.dshHome, "cordis.patch.yml"), path.join(profileDir, "cordis.patch.yml")];
			for (const pf of patchFiles) {
				const { ids } = patchIds(pf);
				for (const id of ids) {
					upsert(id, { patchRefs: [pf] });
					edges.push({
						from: synthetic,
						to: id,
						kind: "patch-ref",
						declaredIn: pf
					});
				}
			}
		}
		return makeGraph(nodes, edges);
	}
	function makeGraph(nodes, edges) {
		const forward = /* @__PURE__ */ new Map();
		const backward = /* @__PURE__ */ new Map();
		const touch = (m, k) => {
			if (!m.has(k)) m.set(k, /* @__PURE__ */ new Set());
		};
		for (const e of edges) {
			touch(forward, e.from);
			touch(forward, e.to);
			touch(backward, e.from);
			touch(backward, e.to);
			forward.get(e.from).add(e.to);
			backward.get(e.to).add(e.from);
		}
		for (const k of nodes.keys()) {
			touch(forward, k);
			touch(backward, k);
		}
		const closure = (start, next) => {
			const seen = /* @__PURE__ */ new Set();
			const queue = [start];
			for (let head = 0; head < queue.length; head++) {
				const cur = queue[head];
				for (const n of next(cur)) if (n !== start && !seen.has(n)) {
					seen.add(n);
					queue.push(n);
				}
			}
			return [...seen];
		};
		const dependentsMemo = /* @__PURE__ */ new Map();
		const dependenciesMemo = /* @__PURE__ */ new Map();
		const cycles = tarjanCycles(nodes, forward);
		return {
			nodes,
			edges,
			dependentsOf: (name) => {
				let v = dependentsMemo.get(name);
				if (v === void 0) {
					v = closure(name, (n) => [...backward.get(n) ?? []]);
					dependentsMemo.set(name, v);
				}
				return v;
			},
			dependenciesOf: (name) => {
				let v = dependenciesMemo.get(name);
				if (v === void 0) {
					v = closure(name, (n) => [...forward.get(n) ?? []]);
					dependenciesMemo.set(name, v);
				}
				return v;
			},
			hasCycle: () => cycles.length > 0,
			cycles: () => cycles
		};
	}
	function tarjanCycles(nodes, forward) {
		let index = 0;
		const stack = [];
		const onStack = /* @__PURE__ */ new Set();
		const indices = /* @__PURE__ */ new Map();
		const lowlink = /* @__PURE__ */ new Map();
		const out = [];
		const strongconnect = (v) => {
			indices.set(v, index);
			lowlink.set(v, index);
			index++;
			stack.push(v);
			onStack.add(v);
			for (const w of forward.get(v) ?? []) if (!indices.has(w)) {
				strongconnect(w);
				lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
			} else if (onStack.has(w)) lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
			if (lowlink.get(v) === indices.get(v)) {
				const scc = [];
				let w;
				do {
					w = stack.pop();
					onStack.delete(w);
					scc.push(w);
				} while (w !== v);
				if (scc.length > 1) out.push(scc);
				else if (scc.length === 1 && (forward.get(scc[0])?.has(scc[0]) ?? false)) out.push(scc);
			}
		};
		for (const n of nodes.keys()) if (!indices.has(n)) strongconnect(n);
		return out;
	}
	const analyzer = {
		async buildGraph(profile) {
			try {
				return ok(buildGraph(profile));
			} catch (e) {
				return err(ioError("依赖图构建失败", e));
			}
		},
		async blockersOf(plugins) {
			const g = await analyzer.buildGraph();
			if (!g.ok) return g;
			const removing = new Set(plugins);
			const out = [];
			for (const target of plugins) {
				const blockedBy = g.value.dependentsOf(target).filter((d) => !removing.has(d) && !d.startsWith("profile:"));
				if (blockedBy.length > 0) out.push({
					plugin: target,
					blockedBy,
					reason: `被其他插件依赖: ${blockedBy.join(", ")}`
				});
			}
			return ok(out);
		}
	};
	return analyzer;
}
//#endregion
//#region src/engine/residual-scanner.ts
const TEMP_MARKER_RE$1 = /dsh|deepseek|cordis/i;
function createResidualScanner(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const cache = options.scanCache;
	function referencedBy(plugin) {
		return options.referenceIndex?.get(plugin) ?? [];
	}
	function makeEvidence(partial) {
		return {
			location: partial.location,
			kind: partial.kind,
			description: partial.description,
			sizeBytes: partial.sizeBytes,
			lastAccessedAt: partial.atime,
			referencedBy: referencedBy(partial.plugin),
			suggestedAction: partial.suggestedAction
		};
	}
	/** 单插件 × 单 profile 的全部检查点 */
	function* checkPoints(plugin, profile) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		yield {
			kind: "config-ref",
			location: path.join(profileDir, "pnpm-workspace.yaml"),
			description: `pnpm-workspace.yaml 中仍引用 ${plugin}`,
			isFile: true,
			contains: plugin,
			action: "clean-workspace-yaml"
		};
		yield {
			kind: "config-ref",
			location: path.join(profileDir, "cordis.patch.yml"),
			description: `profile patch 中仍引用 ${plugin}`,
			isFile: true,
			contains: plugin,
			action: "clean-profile-patch"
		};
		yield {
			kind: "config-ref",
			location: path.join(options.dshHome, "cordis.patch.yml"),
			description: `home patch 中仍引用 ${plugin}`,
			isFile: true,
			contains: plugin,
			action: "clean-home-patch"
		};
		yield {
			kind: "node-modules",
			location: path.join(profileDir, "node_modules", ...plugin.split("/")),
			description: `node_modules 包目录: ${plugin}`,
			isFile: false,
			action: "remove-node-modules"
		};
		yield {
			kind: "storage",
			location: path.join(options.dshHome, "storages", plugin),
			description: `storages 持久化数据: ${plugin}`,
			isFile: false,
			action: "remove-storages"
		};
		yield {
			kind: "attachment",
			location: path.join(options.dshHome, "attachments", "v1", plugin),
			description: `attachments 会话附件: ${plugin}`,
			isFile: false,
			action: "remove-attachments"
		};
	}
	function listProfiles() {
		const dir = path.join(options.dshHome, "profiles");
		try {
			return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	}
	/** TEMP 孤儿（aggressive 专属）：共享实现（fs-utils.tempOrphanEntries） */
	const tempEntries = (maxAgeDays) => tempOrphanEntries(options.tempRoot, maxAgeDays, now, TEMP_MARKER_RE$1).map((e) => ({
		entry: e.path,
		size: e.sizeBytes,
		ageDays: e.ageDays
	}));
	async function* scan(request) {
		let scannedPaths = 0;
		let totalFound = 0;
		let bytesReclaimable = 0;
		const cancelled = () => request.signal?.aborted ?? false;
		const profiles = request.profile ? [request.profile] : listProfiles();
		for (const profile of profiles) {
			if (cancelled()) break;
			let plugins;
			if (request.plugin) plugins = [request.plugin];
			else plugins = globalPluginSet(profile);
			for (const plugin of plugins) {
				if (cancelled()) break;
				for (const cp of checkPoints(plugin, profile)) {
					if (cancelled()) break;
					scannedPaths++;
					yield {
						type: "progress",
						scannedPaths,
						currentRoot: path.dirname(cp.location)
					};
					let stat = null;
					try {
						stat = fs.statSync(cp.location);
					} catch {}
					if (stat === null) continue;
					const cached = cache?.get(cp.location, stat.mtimeMs, stat.size) ?? null;
					let containsHit = true;
					if (cp.isFile && cp.contains !== void 0) {
						if (cached?.containsHit !== void 0) containsHit = cached.containsHit;
						else {
							let content = "";
							try {
								content = fs.readFileSync(cp.location, "utf-8");
							} catch {}
							containsHit = content.includes(cp.contains);
							cache?.set(cp.location, {
								mtimeMs: stat.mtimeMs,
								size: stat.size,
								containsHit
							});
						}
						if (!containsHit) continue;
					}
					let size;
					if (cp.isFile) size = stat.size;
					else if (cached?.dirBytes !== void 0) size = cached.dirBytes;
					else {
						size = dirSize(cp.location);
						cache?.set(cp.location, {
							mtimeMs: stat.mtimeMs,
							size: stat.size,
							dirBytes: size
						});
					}
					bytesReclaimable += size;
					totalFound++;
					yield {
						type: "found",
						evidence: makeEvidence({
							location: cp.location,
							kind: cp.kind,
							description: cp.description,
							sizeBytes: size,
							plugin,
							suggestedAction: cp.action,
							atime: stat.atime
						})
					};
				}
			}
			if (cancelled()) break;
			const pd = path.join(options.dshHome, "profiles", profile);
			yield {
				type: "root-summary",
				root: pd,
				bytesScannable: dirSize(pd)
			};
		}
		if (!cancelled() && request.includeTemp && request.strategy === "aggressive") {
			for (const t of tempEntries(7)) {
				if (cancelled()) break;
				scannedPaths++;
				totalFound++;
				bytesReclaimable += t.size;
				yield {
					type: "found",
					evidence: makeEvidence({
						location: t.entry,
						kind: "temp-orphan",
						description: `TEMP 中 ${t.ageDays.toFixed(1)} 天未动的 dsh 残留`,
						sizeBytes: t.size,
						plugin: path.basename(t.entry),
						suggestedAction: "purge-temp",
						atime: null
					})
				};
			}
			yield {
				type: "root-summary",
				root: options.tempRoot,
				bytesScannable: dirSize(options.tempRoot)
			};
		}
		cache?.flush();
		yield {
			type: "done",
			totalFound,
			bytesReclaimable
		};
	}
	/** 全局模式：profile package.json 依赖 + storages/attachments 目录名 并集 */
	function globalPluginSet(profile) {
		const set = /* @__PURE__ */ new Set();
		const pkgPath = path.join(options.dshHome, "profiles", profile, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			for (const k of [
				"dependencies",
				"peerDependencies",
				"optionalDependencies"
			]) for (const name of Object.keys(pkg[k] ?? {})) set.add(name);
			for (const b of pkg?.dsh?.profile?.bundles ?? []) set.add(b);
		} catch {}
		for (const root of [path.join(options.dshHome, "storages"), path.join(options.dshHome, "attachments", "v1")]) try {
			for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) set.add(e.name);
		} catch {}
		set.delete("@deepseek-ai/dsh-base");
		return [...set];
	}
	return { scan };
}
//#endregion
//#region src/engine/orphan-detector.ts
const TEMP_MARKER_RE = /dsh|deepseek|cordis/i;
const PROTECTED = /* @__PURE__ */ new Set([
	"@deepseek-ai/dsh-base",
	".pnpm",
	".bin",
	".modules.yaml",
	"node_modules"
]);
function createOrphanDetector(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	function listProfiles() {
		try {
			return fs.readdirSync(path.join(options.dshHome, "profiles"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	}
	/** 全 profile 引用集合：package.json 依赖 + bundles + patch yml 中出现的 id */
	function referencedNames() {
		const refs = /* @__PURE__ */ new Set();
		const collectPkg = (pkgPath) => {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				for (const k of [
					"dependencies",
					"peerDependencies",
					"optionalDependencies"
				]) for (const name of Object.keys(pkg[k] ?? {})) refs.add(name);
				for (const b of pkg?.dsh?.profile?.bundles ?? []) refs.add(b);
			} catch {}
		};
		for (const profile of listProfiles()) {
			const profileDir = path.join(options.dshHome, "profiles", profile);
			collectPkg(path.join(profileDir, "package.json"));
			for (const pf of [path.join(options.dshHome, "cordis.patch.yml"), path.join(profileDir, "cordis.patch.yml")]) try {
				const text = fs.readFileSync(pf, "utf-8");
				for (const m of text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)) refs.add(m[1]);
			} catch {}
		}
		return refs;
	}
	/** node_modules 一级条目名（含 @scope 两段、.pnpm 展开到实际包名） */
	function installedPackages() {
		const out = [];
		for (const profile of listProfiles()) {
			const nm = path.join(options.dshHome, "profiles", profile, "node_modules");
			let top;
			try {
				top = fs.readdirSync(nm, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of top) {
				if (e.name.startsWith(".") || e.name === "node_modules") continue;
				if (e.name.startsWith("@")) try {
					for (const sub of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) if (sub.isDirectory()) out.push({
						name: `${e.name}/${sub.name}`,
						dir: path.join(nm, e.name, sub.name)
					});
				} catch {}
				else if (e.isDirectory()) out.push({
					name: e.name,
					dir: path.join(nm, e.name)
				});
			}
		}
		return out;
	}
	return { async detect(opts) {
		try {
			const refs = referencedNames();
			const signal = opts.signal;
			const candidates = installedPackages().filter((pkg) => !refs.has(pkg.name) && !PROTECTED.has(pkg.name) && !pkg.name.startsWith("@deepseek-ai/"));
			if (signal?.aborted) return err({
				code: "E_CANCELLED",
				message: "孤儿检测被取消"
			});
			const orphanPluginDirs = [];
			const sized1 = await forEachPool(candidates, 8, async (pkg) => ({
				path: pkg.dir,
				sizeBytes: await dirSizeAsync(pkg.dir, { ...signal ? { signal } : {} })
			}));
			for (const r of sized1) if (r.status === "fulfilled") orphanPluginDirs.push(r.value);
			orphanPluginDirs.sort((a, b) => b.sizeBytes - a.sizeBytes);
			const dataCandidates = [];
			for (const root of [path.join(options.dshHome, "storages"), path.join(options.dshHome, "attachments", "v1")]) {
				let entries;
				try {
					entries = fs.readdirSync(root, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const e of entries) {
					if (!e.isDirectory() || refs.has(e.name)) continue;
					dataCandidates.push(path.join(root, e.name));
				}
			}
			if (signal?.aborted) return err({
				code: "E_CANCELLED",
				message: "孤儿检测被取消"
			});
			const orphanDataDirs = [];
			const sized2 = await forEachPool(dataCandidates, 8, async (d) => ({
				path: d,
				sizeBytes: await dirSizeAsync(d, { ...signal ? { signal } : {} })
			}));
			for (const r of sized2) if (r.status === "fulfilled") orphanDataDirs.push(r.value);
			orphanDataDirs.sort((a, b) => b.sizeBytes - a.sizeBytes);
			if (signal?.aborted) return err({
				code: "E_CANCELLED",
				message: "孤儿检测被取消"
			});
			const tempOrphans = tempOrphanEntries(options.tempRoot, opts.tempMaxAgeDays, now, TEMP_MARKER_RE).map((e) => ({
				path: e.path,
				sizeBytes: e.sizeBytes,
				ageDays: e.ageDays
			}));
			return ok({
				orphanPluginDirs,
				orphanDataDirs,
				tempOrphans,
				totalReclaimableBytes: orphanPluginDirs.reduce((s, d) => s + d.sizeBytes, 0) + orphanDataDirs.reduce((s, d) => s + d.sizeBytes, 0) + tempOrphans.reduce((s, d) => s + d.sizeBytes, 0)
			});
		} catch (e) {
			return err(ioError("孤儿检测失败", e));
		}
	} };
}
//#endregion
//#region src/engine/health-inspector.ts
const SEVERITY_WEIGHT = {
	info: 1,
	warning: 2,
	critical: 4
};
function createHealthInspector(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const runCommand = options.runCommand ?? ((cmd, args, opts) => {
		const r = (0, child_process.spawnSync)(cmd, args, {
			cwd: opts.cwd,
			encoding: "utf-8",
			timeout: opts.timeoutMs
		});
		return {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? ""
		};
	});
	const R = (check, passed, message, severity, group, fix) => ({
		check,
		passed,
		message,
		severity,
		group,
		...fix ? { fix } : {}
	});
	function checkConfig(profile, out) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		const pkgPath = path.join(profileDir, "package.json");
		if (fs.existsSync(pkgPath)) try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			out.push(R("package.json 语法", true, "JSON 格式正确", "info", "config"));
			const bundles = pkg?.dsh?.profile?.bundles ?? [];
			const deps = new Set(Object.keys(pkg?.dependencies ?? {}));
			const orphans = bundles.filter((b) => !deps.has(b) && b !== "@deepseek-ai/dsh-base");
			if (orphans.length === 0) out.push(R("bundles 一致性", true, "所有 bundle 均有对应依赖", "info", "config"));
			else out.push(R("bundles 一致性", false, `孤立 bundle: ${orphans.join(", ")}`, "warning", "config", "将孤立 bundle 加入 dependencies 或从 bundles 中移除"));
		} catch (e) {
			out.push(R("package.json 语法", false, `JSON 解析失败: ${errorToMessage(e)}`, "critical", "config", "修复 JSON 语法；可从备份区恢复上一版本"));
		}
		else out.push(R("package.json 存在性", false, `profile "${profile}" 不存在或缺少 package.json`, "critical", "config"));
		const wsPath = path.join(profileDir, "pnpm-workspace.yaml");
		if (fs.existsSync(wsPath)) try {
			(0, yaml.parse)(fs.readFileSync(wsPath, "utf-8"));
			out.push(R("pnpm-workspace.yaml 语法", true, "YAML 格式正确", "info", "config"));
		} catch (e) {
			out.push(R("pnpm-workspace.yaml 语法", false, `YAML 解析失败: ${errorToMessage(e)}`, "critical", "config"));
		}
		for (const [label, pf] of [["cordis.patch.yml (profile)", path.join(profileDir, "cordis.patch.yml")], ["cordis.patch.yml (home)", path.join(options.dshHome, "cordis.patch.yml")]]) {
			if (!fs.existsSync(pf)) continue;
			try {
				(0, yaml.parse)(fs.readFileSync(pf, "utf-8"));
				out.push(R(`${label} 语法`, true, "YAML 格式正确", "info", "config"));
			} catch (e) {
				out.push(R(`${label} 语法`, false, `YAML 解析失败: ${errorToMessage(e)}`, "critical", "config"));
			}
		}
	}
	function checkDependency(profile, out) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		const pkgPath = path.join(profileDir, "package.json");
		const lockPath = path.join(profileDir, "pnpm-lock.yaml");
		if (fs.existsSync(pkgPath) && fs.existsSync(lockPath)) {
			if (fs.statSync(pkgPath).mtimeMs > fs.statSync(lockPath).mtimeMs) out.push(R("lockfile 新鲜度", false, "package.json 比 pnpm-lock.yaml 更新，依赖可能漂移", "warning", "dependency", "在 profile 目录执行 pnpm install 刷新 lockfile"));
			else out.push(R("lockfile 新鲜度", true, "lockfile 不早于 package.json", "info", "dependency"));
		}
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			const deps = Object.keys(pkg?.dependencies ?? {});
			const nm = path.join(profileDir, "node_modules");
			const missing = deps.filter((d) => !fs.existsSync(path.join(nm, ...d.split("/"))) && d !== "@deepseek-ai/dsh-base");
			if (missing.length > 0) out.push(R("依赖安装完整性", false, `缺失 node_modules 条目: ${missing.join(", ")}`, "warning", "dependency", "执行 pnpm install 补齐"));
			else out.push(R("依赖安装完整性", true, "声明的依赖均已安装", "info", "dependency"));
		} catch {}
	}
	function checkRuntime(out) {
		const dsh = runCommand("dsh", ["--version"], {
			cwd: options.dshHome,
			timeoutMs: 5e3
		});
		if (dsh.status === 0) out.push(R("dsh CLI", true, `版本: ${dsh.stdout.trim().slice(0, 60)}`, "info", "runtime"));
		else out.push(R("dsh CLI", false, "dsh 命令不可用（不在 PATH 或执行失败）", "critical", "runtime", "确认 dsh 已安装且在 PATH 中；standard-remove 步骤将不可用"));
		const pnpm = runCommand("pnpm", ["--version"], {
			cwd: options.dshHome,
			timeoutMs: 5e3
		});
		if (pnpm.status === 0) out.push(R("pnpm CLI", true, `版本: ${pnpm.stdout.trim().slice(0, 60)}`, "info", "runtime"));
		else out.push(R("pnpm CLI", false, "pnpm 命令不可用", "warning", "runtime", "安装 pnpm: npm i -g pnpm"));
		const lockPath = path.join(options.dshHome, ".nuke", "nuke.lock");
		if (fs.existsSync(lockPath)) out.push(R("nuke 锁残留", false, `发现锁文件 ${lockPath}，可能存在并发清理或上次异常退出`, "warning", "runtime", "确认无清理进行后由管理员破锁"));
		else out.push(R("nuke 锁残留", true, "无锁残留", "info", "runtime"));
		const unfinished = options.walUnfinished?.() ?? [];
		if (unfinished.length > 0) out.push(R("WAL 未完成事务", false, `${unfinished.length} 个未终结事务: ${unfinished.join(", ")}`, "warning", "runtime", "先执行 nuke recover 完成崩溃恢复"));
		else out.push(R("WAL 未完成事务", true, "无未终结事务", "info", "runtime"));
	}
	function checkResidue(out) {
		let orphanStorages = 0;
		let orphanBytes = 0;
		const storages = path.join(options.dshHome, "storages");
		try {
			for (const e of fs.readdirSync(storages, { withFileTypes: true })) {
				if (!e.isDirectory()) continue;
				let total = 0;
				const d = path.join(storages, e.name);
				try {
					for (const f of fs.readdirSync(d)) try {
						total += fs.statSync(path.join(d, f)).size;
					} catch {}
				} catch {}
				if (total > 52428800) {
					orphanStorages++;
					orphanBytes += total;
				}
			}
		} catch {}
		if (orphanStorages > 0) out.push(R("storages 膨胀", false, `${orphanStorages} 个插件存储超过 50MB（共 ${(orphanBytes / 1024 / 1024).toFixed(0)}MB）`, "info", "residue", "运行 nuke scan 评估可回收空间"));
		else out.push(R("storages 膨胀", true, "无超 50MB 的插件存储", "info", "residue"));
	}
	return { async inspect(profile) {
		try {
			const results = [];
			checkConfig(profile, results);
			checkDependency(profile, results);
			checkRuntime(results);
			checkResidue(results);
			const blocking = results.some((r) => r.severity === "critical" && !r.passed);
			const weightTotal = results.reduce((s, r) => s + SEVERITY_WEIGHT[r.severity], 0);
			const weightGot = results.reduce((s, r) => s + (r.passed ? SEVERITY_WEIGHT[r.severity] : 0), 0);
			const score = weightTotal === 0 ? 100 : Math.round(100 * weightGot / weightTotal);
			return ok({
				profile,
				checkedAt: now().toISOString(),
				results,
				blocking,
				score
			});
		} catch (e) {
			return err(ioError("健康检查失败", e));
		}
	} };
}
//#endregion
//#region src/infra/reporter.ts
function createReporter(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	function baseName(payload) {
		const id = payload.tx?.txId ?? payload.dryRun?.txId;
		const ts = now().toISOString().replace(/[:.]/g, "-");
		return id ? `nuke-${id}-${ts}` : `nuke-scan-${ts}`;
	}
	function statusIcon(passed) {
		return passed ? "✅" : "❌";
	}
	function renderMarkdown(payload) {
		const L = [];
		L.push("# Nuke 清理报告", "");
		L.push(`- **生成时间**: ${payload.generatedAt}`);
		L.push(`- **审计链校验**: ${payload.chainValid ? "✅ 完整" : "❌ 已被篡改"}`, "");
		if (payload.tx) {
			const tx = payload.tx;
			L.push("## 事务摘要", "");
			L.push(`- **事务 ID**: ${tx.txId}`);
			L.push(`- **状态**: ${tx.state}`);
			L.push(`- **开始**: ${tx.startedAt}${tx.finishedAt ? ` / **结束**: ${tx.finishedAt}` : ""}`);
			L.push(`- **释放空间**: ${fmtBytes$1(tx.bytesFreedTotal)}`, "");
			L.push("| # | 操作 | 动作 | 状态 | 释放 |", "|---|---|---|---|---|");
			for (const s of tx.steps) L.push(`| ${s.index} | ${s.operationId} | ${s.action} | ${s.status} | ${fmtBytes$1(s.bytesFreed)} |`);
			L.push("");
		}
		if (payload.dryRun) {
			const dr = payload.dryRun;
			L.push("## 预演（Dry-run）", "");
			L.push(`- **事务 ID**: ${dr.txId}`);
			L.push(`- **预计回收**: ${fmtBytes$1(dr.estimatedBytesReclaimable)}`, "");
			for (const p of dr.plans) {
				L.push(`### ${p.operation ?? p.summary}`);
				L.push(`- ${p.summary}`);
				if (p.operation) {
					L.push(`- 触及路径: ${p.operation.touchedPaths.join(", ") || "无"}`);
					L.push(`- 预计回收: ${fmtBytes$1(p.operation.estimatedBytesReclaimable)}`);
					L.push(`- 需要独占锁: ${p.operation.requiresExclusiveLock ? "是" : "否"}`);
				}
				L.push("");
			}
			if (dr.warnings.length > 0) {
				L.push("### 警告", "");
				for (const w of dr.warnings) L.push(`- ${w.blocking ? "⛔ [阻断] " : "⚠️ "}${w.message}`);
				L.push("");
			}
		}
		L.push("## 健康检查", "");
		L.push("| 状态 | 检查项 | 结果 | 级别 | 分组 |", "|---|---|---|---|---|");
		for (const h of payload.health) {
			const msg = h.message.replace(/\|/g, "\\|");
			L.push(`| ${statusIcon(h.passed)} | ${h.check} | ${msg} | ${h.severity} | ${h.group} |`);
		}
		L.push("");
		L.push("## 审计链", "");
		if (payload.auditTrail.length === 0) L.push("(无审计记录)", "");
		else {
			L.push("| seq | 时间 | 操作人 | 动作 | 结果 | hash |", "|---|---|---|---|---|---|");
			for (const a of payload.auditTrail) L.push(`| ${a.seq} | ${a.timestamp} | ${a.actor} | ${a.action} | ${a.outcome} | \`${a.hash.slice(0, 12)}…\` |`);
			L.push("");
		}
		return L.join("\n");
	}
	return { async export(format, payload) {
		try {
			fs.mkdirSync(options.reportsRoot, { recursive: true });
			const name = baseName(payload);
			const file = path.join(options.reportsRoot, `${name}.${format === "json" ? "json" : "md"}`);
			const content = format === "json" ? JSON.stringify(payload, null, 2) : renderMarkdown(payload);
			fs.writeFileSync(file, content, "utf-8");
			return ok({
				path: file,
				bytes: Buffer.byteLength(content)
			});
		} catch (e) {
			return err(ioError("报告导出失败", e));
		}
	} };
}
//#endregion
//#region src/engine/doctor.ts
/** 处方条目上限：报告可读性优先，超出部分仍计入总可回收空间 */
const MAX_RECOMMENDATIONS = 50;
function createDoctor(deps) {
	function priorityOf(e) {
		if (e.referencedBy.length > 0 || e.score.band === "critical") return 1;
		if (e.score.band === "high" || e.score.band === "medium") return 2;
		return 3;
	}
	function strategyOf(e) {
		if (e.referencedBy.length > 0) return "safe";
		if (e.kind === "temp-orphan") return "aggressive";
		return "balanced";
	}
	function reasonOf(e) {
		if (e.referencedBy.length > 0) return `仍被 ${e.referencedBy.join(", ")} 引用 —— 先以 safe 策略摘除配置引用，再评估目录回收`;
		if (e.kind === "temp-orphan") return "TEMP 过期孤儿（aggressive 动作，需确认令牌）";
		if (e.score.band === "critical" || e.score.band === "high") return `${e.score.band} 级孤儿残留，建议 balanced 物理回收`;
		return `${e.score.band} 级残留（${e.score.total} 分），可择机清理`;
	}
	return { async diagnose(profile, options) {
		try {
			const h = await deps.health.inspect(profile);
			if (!h.ok) return h;
			const health = h.value;
			const evidences = [];
			const signal = options?.signal;
			for await (const ev of deps.scanner.scan({
				profile,
				strategy: "safe",
				includeTemp: false,
				...signal ? { signal } : {}
			})) {
				if (signal?.aborted) return err({
					code: "E_CANCELLED",
					message: "体检被取消"
				});
				if (ev.type === "found") evidences.push(ev.evidence);
			}
			const o = await deps.orphans.detect({
				tempMaxAgeDays: 7,
				...signal ? { signal } : {}
			});
			if (o.ok) {
				for (const d of o.value.orphanPluginDirs) evidences.push({
					location: d.path,
					kind: "node-modules",
					description: `node_modules 孤儿包: ${d.path}`,
					sizeBytes: d.sizeBytes,
					lastAccessedAt: null,
					referencedBy: [],
					suggestedAction: "remove-node-modules"
				});
				for (const d of o.value.orphanDataDirs) evidences.push({
					location: d.path,
					kind: "storage",
					description: `无主数据目录: ${d.path}`,
					sizeBytes: d.sizeBytes,
					lastAccessedAt: null,
					referencedBy: [],
					suggestedAction: "remove-storages"
				});
				for (const t of o.value.tempOrphans) {
					const age = /* @__PURE__ */ new Date(deps.clock.now().getTime() - t.ageDays * 864e5);
					evidences.push({
						location: t.path,
						kind: "temp-orphan",
						description: `TEMP 过期孤儿（${t.ageDays.toFixed(1)} 天）: ${t.path}`,
						sizeBytes: t.sizeBytes,
						lastAccessedAt: age,
						referencedBy: [],
						suggestedAction: "purge-temp"
					});
				}
			}
			const all = deps.scorer.rank(evidences).map((e) => ({
				priority: priorityOf(e),
				evidence: e,
				suggestedStrategy: strategyOf(e),
				reason: reasonOf(e)
			}));
			all.sort((a, b) => a.priority - b.priority || b.evidence.score.total - a.evidence.score.total);
			const totalReclaimableBytes = evidences.reduce((s, e) => s + e.sizeBytes, 0);
			const hasUrgent = all.some((r) => r.priority <= 2);
			const verdict = health.blocking || health.score < 40 ? "critical" : health.score < 80 || hasUrgent ? "attention" : "healthy";
			return ok({
				generatedAt: deps.clock.now().toISOString(),
				profile,
				verdict,
				healthScore: health.score,
				blocking: health.blocking,
				recommendations: all.slice(0, MAX_RECOMMENDATIONS),
				totalReclaimableBytes
			});
		} catch (e) {
			return err(ioError("体检编排失败", e));
		}
	} };
}
//#endregion
//#region src/engine/dedup-analyzer.ts
const PROFILE_RE = /(?:^|[/\\])profiles[/\\]([^/\\]+)[/\\]/;
function createDedupAnalyzer(options) {
	const now = options.now ?? (() => Date.now());
	const maxGroups = options.maxGroups ?? 100;
	function defaultRoots() {
		const out = [];
		const profilesDir = path.join(options.dshHome, "profiles");
		try {
			for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(profilesDir, e.name, "node_modules"));
		} catch {}
		return out;
	}
	function profileOf(p) {
		return PROFILE_RE.exec(p)?.[1] ?? null;
	}
	/** 收集参与分析的文件：跳过符号链接、过滤小文件 */
	function collect(roots, minSize, signal) {
		const bySize = /* @__PURE__ */ new Map();
		let filesScanned = 0;
		let bytesScanned = 0;
		const walk = (dir) => {
			if (signal?.aborted) return false;
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return true;
			}
			for (const e of entries) {
				if (signal?.aborted) return false;
				const full = path.join(dir, e.name);
				if (e.isSymbolicLink()) continue;
				if (e.isDirectory()) {
					if (!walk(full)) return false;
				} else if (e.isFile()) {
					let size = 0;
					try {
						size = fs.statSync(full).size;
					} catch {
						continue;
					}
					if (size < minSize) continue;
					filesScanned++;
					bytesScanned += size;
					const bucket = bySize.get(size);
					if (bucket) bucket.push(full);
					else bySize.set(size, [full]);
				}
			}
			return true;
		};
		for (const root of roots) if (!walk(root)) return null;
		return {
			bySize,
			filesScanned,
			bytesScanned
		};
	}
	async function hashFile(p) {
		return await new Promise((resolve, reject) => {
			const h = crypto.createHash("sha256");
			const stream = fs.createReadStream(p);
			stream.on("data", (chunk) => h.update(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(h.digest("hex")));
		});
	}
	const SAMPLE_BYTES = 4096;
	/** 头尾采样指纹：一次 open + 两次定位 read（≤8KB IO），绝不读全量。
	*  小于 2×SAMPLE 的文件退化为头采（尾部与头部重叠无意义）。 */
	async function sampleFingerprint(p, size) {
		return await new Promise((resolve, reject) => {
			fs.open(p, "r", (err, fd) => {
				if (err) {
					reject(err);
					return;
				}
				const h = crypto.createHash("sha256");
				const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
				fs.read(fd, head, 0, head.length, 0, (e1) => {
					if (e1) {
						try {
							fs.closeSync(fd);
						} catch {}
						reject(e1);
						return;
					}
					if (size <= SAMPLE_BYTES) {
						try {
							fs.closeSync(fd);
						} catch {}
						h.update(head);
						resolve(`s:${h.digest("hex")}`);
						return;
					}
					const tail = Buffer.alloc(SAMPLE_BYTES);
					const tailStart = size - SAMPLE_BYTES;
					fs.read(fd, tail, 0, tail.length, tailStart, (e2) => {
						try {
							fs.closeSync(fd);
						} catch {}
						if (e2) {
							reject(e2);
							return;
						}
						h.update(head);
						h.update(tail);
						resolve(`s:${h.digest("hex")}`);
					});
				});
			});
		});
	}
	return { async analyze(analyzeOptions) {
		const started = now();
		const signal = analyzeOptions?.signal;
		const minSize = analyzeOptions?.minSizeBytes ?? 4096;
		const roots = analyzeOptions?.roots ?? defaultRoots();
		if (roots.length === 0) return ok({
			groups: [],
			totalReclaimableBytes: 0,
			filesScanned: 0,
			bytesScanned: 0,
			durationMs: 0
		});
		try {
			const collected = collect(roots, minSize, signal);
			if (!collected) return err({
				code: "E_CANCELLED",
				message: "去重分析被取消"
			});
			const { bySize, filesScanned, bytesScanned } = collected;
			let sizeEliminated = 0;
			const candidates = [];
			for (const [size, paths] of bySize) {
				if (paths.length < 2) {
					sizeEliminated += paths.length;
					continue;
				}
				candidates.push({
					size,
					paths
				});
			}
			let sampleEliminated = 0;
			let bytesSaved = 0;
			const sampleCollisions = [];
			for (const { size, paths } of candidates) {
				if (signal?.aborted) return err({
					code: "E_CANCELLED",
					message: "去重分析被取消"
				});
				const bySample = /* @__PURE__ */ new Map();
				const settled = await forEachPool(paths, 8, async (p) => ({
					p,
					fp: await sampleFingerprint(p, size)
				}));
				for (const r of settled) {
					if (r.status !== "fulfilled") continue;
					const { p, fp } = r.value;
					const bucket = bySample.get(fp);
					if (bucket) bucket.push(p);
					else bySample.set(fp, [p]);
				}
				for (const bucket of bySample.values()) if (bucket.length < 2) {
					sampleEliminated += bucket.length;
					bytesSaved += bucket.length * size;
				} else sampleCollisions.push({
					size,
					paths: bucket
				});
			}
			const groups = [];
			let fullHashed = 0;
			for (const { size, paths } of sampleCollisions) {
				if (signal?.aborted) return err({
					code: "E_CANCELLED",
					message: "去重分析被取消"
				});
				const byHash = /* @__PURE__ */ new Map();
				const settled = await forEachPool(paths, 8, async (p) => ({
					p,
					hash: await hashFile(p)
				}));
				for (const r of settled) {
					if (r.status !== "fulfilled") continue;
					const { p, hash } = r.value;
					fullHashed++;
					const bucket = byHash.get(hash);
					if (bucket) bucket.push(p);
					else byHash.set(hash, [p]);
				}
				for (const [hash, copies] of byHash) {
					if (copies.length < 2) continue;
					groups.push({
						hash,
						sizeBytes: size,
						copies: copies.map((p) => ({
							path: p,
							profile: profileOf(p)
						})),
						reclaimableBytes: (copies.length - 1) * size
					});
				}
			}
			groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
			const totalReclaimableBytes = groups.reduce((s, g) => s + g.reclaimableBytes, 0);
			return ok({
				groups: groups.slice(0, maxGroups),
				totalReclaimableBytes,
				filesScanned,
				bytesScanned,
				durationMs: now() - started,
				stages: {
					sizeEliminated,
					sampleEliminated,
					fullHashed,
					bytesSavedBySampling: bytesSaved
				}
			});
		} catch (e) {
			return err(ioError("去重分析失败", e));
		}
	} };
}
//#endregion
//#region src/engine/dedup-executor.ts
function createDedupExecutor() {
	function hashFile(p) {
		return new Promise((resolve, reject) => {
			const h = crypto.createHash("sha256");
			const stream = fs.createReadStream(p);
			stream.on("data", (chunk) => h.update(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(h.digest("hex")));
		});
	}
	return {
		async apply(report, opts) {
			const signal = opts?.signal;
			const journal = [];
			const skipped = [];
			let linkedFiles = 0;
			let bytesSaved = 0;
			let cancelled = false;
			outer: try {
				for (const group of report.groups) {
					if (signal?.aborted) {
						cancelled = true;
						break;
					}
					if (group.copies.length < 2) continue;
					const canonical = group.copies[0];
					try {
						if (await hashFile(canonical.path) !== group.hash) {
							skipped.push({
								path: canonical.path,
								reason: "复验失败：canonical 内容已变化（整组跳过）"
							});
							continue;
						}
					} catch (e) {
						skipped.push({
							path: canonical.path,
							reason: `canonical 读取失败: ${String(e).slice(0, 80)}`
						});
						continue;
					}
					let canonicalDev;
					let canonicalIno;
					let canonicalMtime;
					try {
						const st = fs.statSync(canonical.path);
						canonicalDev = st.dev;
						canonicalIno = st.ino;
						canonicalMtime = st.mtimeMs;
					} catch {
						skipped.push({
							path: canonical.path,
							reason: "canonical 消失"
						});
						continue;
					}
					for (const copy of group.copies.slice(1)) {
						if (signal?.aborted) {
							cancelled = true;
							break outer;
						}
						const victim = copy.path;
						let linked = false;
						try {
							let lst;
							try {
								lst = fs.lstatSync(victim);
							} catch {
								skipped.push({
									path: victim,
									reason: "victim 消失"
								});
								continue;
							}
							if (lst.isSymbolicLink()) {
								skipped.push({
									path: victim,
									reason: "符号链接（与分析器口径一致，跳过）"
								});
								continue;
							}
							try {
								const cst = fs.statSync(canonical.path);
								if (cst.ino !== canonicalIno || cst.dev !== canonicalDev || cst.mtimeMs !== canonicalMtime) {
									skipped.push({
										path: canonical.path,
										reason: "canonical 在组处理中被修改（整组中止）"
									});
									break;
								}
							} catch {
								skipped.push({
									path: canonical.path,
									reason: "canonical 消失（整组中止）"
								});
								break;
							}
							const vs = fs.statSync(victim);
							if (vs.ino === canonicalIno && vs.dev === canonicalDev) {
								skipped.push({
									path: victim,
									reason: "已是同一 inode（已链接）"
								});
								continue;
							}
							if (vs.dev !== canonicalDev) {
								skipped.push({
									path: victim,
									reason: "跨文件系统（st_dev 不同）"
								});
								continue;
							}
							if (vs.size !== group.sizeBytes) {
								skipped.push({
									path: victim,
									reason: "复验失败：尺寸已变化"
								});
								continue;
							}
							if (await hashFile(victim) !== group.hash) {
								skipped.push({
									path: victim,
									reason: "复验失败：内容已变化"
								});
								continue;
							}
							const tmp = `${victim}.dedup-${crypto.randomBytes(4).toString("hex")}`;
							try {
								fs.linkSync(canonical.path, tmp);
								fs.renameSync(tmp, victim);
								linked = true;
							} catch (e) {
								try {
									fs.unlinkSync(tmp);
								} catch {}
								skipped.push({
									path: victim,
									reason: `链接失败（可能不支持硬链接）: ${String(e).slice(0, 60)}`
								});
								continue;
							}
							let after;
							try {
								after = fs.statSync(victim);
							} catch {
								linkedFiles++;
								if (vs.nlink === 1) bytesSaved += group.sizeBytes;
								journal.push({
									victim,
									canonical: canonical.path,
									sizeBytes: group.sizeBytes
								});
								skipped.push({
									path: victim,
									reason: "事后 stat 失败：链接已生效并已记入 journal"
								});
								continue;
							}
							if (after.ino !== canonicalIno || after.dev !== canonicalDev) {
								linkedFiles++;
								if (vs.nlink === 1) bytesSaved += group.sizeBytes;
								journal.push({
									victim,
									canonical: canonical.path,
									sizeBytes: group.sizeBytes
								});
								skipped.push({
									path: victim,
									reason: "事后断言失败：inode 不匹配（链接已生效，记入 journal 可 undo）"
								});
								continue;
							}
							linkedFiles++;
							if (vs.nlink === 1) bytesSaved += group.sizeBytes;
							journal.push({
								victim,
								canonical: canonical.path,
								sizeBytes: group.sizeBytes
							});
						} catch (e) {
							if (linked) {
								linkedFiles++;
								journal.push({
									victim,
									canonical: canonical.path,
									sizeBytes: group.sizeBytes
								});
								skipped.push({
									path: victim,
									reason: `链接后处理异常（已记入 journal）: ${String(e).slice(0, 60)}`
								});
							} else skipped.push({
								path: victim,
								reason: `处理失败: ${String(e).slice(0, 80)}`
							});
						}
					}
				}
			} catch (e) {
				const error = ioError("去重执行失败", e);
				return err(journal.length > 0 ? {
					...error,
					details: {
						...error.details,
						journal,
						linkedFiles,
						bytesSaved
					}
				} : error);
			}
			return ok({
				linkedFiles,
				bytesSaved,
				journal,
				skipped,
				cancelled
			});
		},
		async undo(journal) {
			let undone = 0;
			const failed = [];
			for (const entry of journal) try {
				copyAtomic(entry.canonical, entry.victim);
				undone++;
			} catch (e) {
				failed.push({
					victim: entry.victim,
					error: String(e).slice(0, 120)
				});
			}
			return ok({
				undone,
				failed
			});
		}
	};
}
//#endregion
//#region src/engine/restore-point.ts
/** home 级关键配置（不含 profile 子目录） */
const HOME_FILES = [
	"package.json",
	"pnpm-workspace.yaml",
	"cordis.patch.yml"
];
/** profile 级关键配置（多一个 lockfile：依赖状态也是可恢复资产） */
const PROFILE_FILES = [
	"package.json",
	"pnpm-workspace.yaml",
	"cordis.patch.yml",
	"pnpm-lock.yaml"
];
function createRestorePointManager(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const rootDir = path.join(options.nukeRoot, "restore-points");
	function metaPath(id) {
		if (!/^rp-[0-9TZ -]+-[0-9a-f]+$/i.test(id)) return "";
		return path.join(rootDir, id, "meta.json");
	}
	/** 子路径是否严格位于 parent 之内（防 meta 篡改后的任意路径读写） */
	function within(parent, child) {
		const rel = path.relative(path.resolve(parent), path.resolve(child));
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	}
	function readMeta(id) {
		const p = metaPath(id);
		if (!p) return null;
		try {
			const m = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (m.id !== id) return null;
			if (typeof m.createdAt !== "string" || typeof m.actor !== "string") return null;
			if (!Array.isArray(m.files)) return null;
			for (const f of m.files) if (typeof f?.source !== "string" || typeof f?.snapshot !== "string") return null;
			return m;
		} catch {
			return null;
		}
	}
	return {
		async create(input) {
			try {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.profile)) return err({
					code: "E_VALIDATION",
					message: `profile 名非法: ${input.profile}`
				});
				const id = `rp-${now().toISOString().replace(/[:.]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
				const dir = path.join(rootDir, id);
				fs.mkdirSync(dir, { recursive: true });
				const files = [];
				const trySnap = (source, rel) => {
					if (!fs.existsSync(source)) return;
					try {
						const snapshot = path.join(dir, rel);
						const bytes = copyAtomic(source, snapshot);
						files.push({
							source,
							snapshot,
							bytes
						});
					} catch {}
				};
				for (const f of HOME_FILES) trySnap(path.join(options.dshHome, f), path.join("home", f));
				const profileDir = path.join(options.dshHome, "profiles", input.profile);
				for (const f of PROFILE_FILES) trySnap(path.join(profileDir, f), path.join(`profile-${input.profile}`, f));
				if (files.length === 0) {
					fs.rmSync(dir, {
						recursive: true,
						force: true
					});
					return err({
						code: "E_VALIDATION",
						message: `无可快照的配置文件（profile "${input.profile}" 不存在？）`
					});
				}
				const meta = {
					id,
					createdAt: now().toISOString(),
					actor: input.actor,
					reason: input.reason,
					profile: input.profile,
					files
				};
				writeJsonAtomic(path.join(dir, "meta.json"), meta);
				return ok(meta);
			} catch (e) {
				return err(ioError("创建还原点失败", e));
			}
		},
		list() {
			try {
				return fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => readMeta(e.name)).filter((m) => m !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			} catch {
				return [];
			}
		},
		async restore(id) {
			const meta = readMeta(id);
			if (!meta) return err({
				code: "E_VALIDATION",
				message: `还原点不存在或已损坏: ${id}`
			});
			const rpDir = path.join(rootDir, id);
			for (const f of meta.files) {
				if (!path.isAbsolute(f.source) || !within(options.dshHome, f.source)) return err({
					code: "E_VALIDATION",
					message: `还原点元数据包含越界路径，拒绝恢复: ${f.source}`
				});
				if (!within(rpDir, f.snapshot)) return err({
					code: "E_VALIDATION",
					message: `还原点快照路径越界，拒绝恢复: ${f.snapshot}`
				});
			}
			try {
				for (const f of meta.files) {
					if (!fs.existsSync(f.snapshot)) continue;
					copyAtomic(f.snapshot, f.source);
				}
				return ok(meta);
			} catch (e) {
				return err(ioError("恢复失败（部分文件可能已写回）", e));
			}
		},
		async prune(keep) {
			if (!Number.isInteger(keep) || keep < 1) return err({
				code: "E_VALIDATION",
				message: "keep 必须为 ≥1 的整数（不允许清空全部还原点）"
			});
			try {
				const victims = this.list().slice(keep);
				for (const v of victims) {
					const target = metaPath(v.id);
					if (!target) continue;
					fs.rmSync(path.dirname(target), {
						recursive: true,
						force: true
					});
				}
				return ok(victims.length);
			} catch (e) {
				return err(ioError("清理还原点失败", e));
			}
		}
	};
}
//#endregion
//#region src/engine/blast-radius.ts
function createBlastRadiusAnalyzer(options) {
	/** 轻量磁盘探测：目标的 node_modules/storages/attachments + 配置引用位置 */
	function probeOnDisk(plugin, profile) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		let bytes = 0;
		for (const dir of [
			path.join(profileDir, "node_modules", plugin),
			path.join(options.dshHome, "storages", plugin),
			path.join(options.dshHome, "attachments", plugin)
		]) if (fs.existsSync(dir)) bytes += dirSize(dir);
		const refs = [];
		for (const f of [
			path.join(options.dshHome, "cordis.patch.yml"),
			path.join(profileDir, "cordis.patch.yml"),
			path.join(options.dshHome, "pnpm-workspace.yaml")
		]) try {
			if (fs.readFileSync(f, "utf-8").includes(plugin)) refs.push(f);
		} catch {}
		return {
			bytes,
			refs
		};
	}
	return { async simulate(plugins, profile) {
		if (plugins.length === 0) return err({
			code: "E_VALIDATION",
			message: "爆炸半径仿真需要至少一个插件"
		});
		try {
			const g = await options.analyzer.buildGraph(profile);
			if (!g.ok) return g;
			const graph = g.value;
			const removal = new Set(plugins);
			const closure = /* @__PURE__ */ new Set();
			for (const target of plugins) for (const dep of graph.dependentsOf(target)) closure.add(dep);
			const broken = [...closure].filter((p) => !removal.has(p) && !p.startsWith("profile:"));
			const cascade = [...closure].filter((p) => removal.has(p));
			let bytes = 0;
			const refSet = /* @__PURE__ */ new Set();
			for (const plugin of plugins) {
				const { bytes: b, refs } = probeOnDisk(plugin, profile ?? "web");
				bytes += b;
				for (const r of refs) refSet.add(r);
			}
			const riskScore = Math.min(100, broken.length * 25 + cascade.length * 5 + Math.floor(bytes / 1024 ** 3) * 5);
			const riskLevel = riskScore >= 75 ? "extreme" : riskScore >= 50 ? "high" : riskScore >= 25 ? "medium" : "low";
			const advisories = [];
			if (broken.length > 0) advisories.push(`删除将损坏 ${broken.length} 个插件: ${broken.join(", ")} —— 将它们加入同批删除清单（有意级联），或先解除其依赖`);
			if (cascade.length > 0) advisories.push(`${cascade.length} 个插件随目标级联删除（同批），请确认这是预期行为`);
			if (bytes > 1024 ** 3) advisories.push(`预估回收超过 1GB，建议先 dry-run 核对操作清单`);
			if (advisories.length === 0) advisories.push("无外部波及，可以安全进入 dry-run → commit 流程");
			return ok({
				targets: plugins,
				cascadeRemovable: cascade,
				brokenDependents: broken,
				configRefs: [...refSet],
				estimatedBytesReclaimable: bytes,
				riskScore,
				riskLevel,
				advisories
			});
		} catch (e) {
			return err(ioError("爆炸半径仿真失败", e));
		}
	} };
}
//#endregion
//#region src/engine/trend-tracker.ts
const MS_PER_DAY = 864e5;
function median(values) {
	const s = [...values].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** 快照净化：JSONL 历史可能含损坏/陈旧格式条目（缺字段、非法日期、非有限数）。
*  NaN 是传染性的 —— 一个坏点会让 slope/σ̂/预测全部变 NaN，进而污染
*  daysUntilFull 与异常告警。在入口整条剔除，宁缺毋滥。 */
function sanitizeSnapshots(snaps) {
	return snaps.filter((s) => typeof s.at === "string" && Number.isFinite(Date.parse(s.at)) && typeof s.bytesReclaimable === "number" && Number.isFinite(s.bytesReclaimable));
}
function createTrendTracker(options) {
	const file = path.join(options.historyDir, "trend.jsonl");
	const readAll = () => readJsonl(file) ?? [];
	/** Theil-Sen 稳健回归：斜率 = 全部成对斜率的中位数；截距 = median(y - slope·x)。
	*  O(n²) 对 —— 快照量级（数百）下毫秒级；完美线性数据下与 LS 完全一致。 */
	function regress(points) {
		const n = points.length;
		if (n < 2) return {
			slope: 0,
			intercept: n === 1 ? points[0].y : 0
		};
		const slopes = [];
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
			const dx = points[j].x - points[i].x;
			if (dx !== 0) {
				const s = (points[j].y - points[i].y) / dx;
				if (Number.isFinite(s)) slopes.push(s);
			}
		}
		if (slopes.length === 0) return {
			slope: 0,
			intercept: median(points.map((p) => p.y))
		};
		const slope = median(slopes);
		const intercept = median(points.map((p) => p.y - slope * p.x));
		if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return {
			slope: 0,
			intercept: median(points.map((p) => p.y))
		};
		return {
			slope,
			intercept
		};
	}
	/** MAD×1.4826：对正态数据等价于标准差，但对离群点稳健（阈值不被污染） */
	function robustSigma(residuals) {
		const med = median(residuals);
		return 1.4826 * median(residuals.map((r) => Math.abs(r - med)));
	}
	return {
		async record(snapshot) {
			try {
				appendJsonl(file, snapshot);
				return ok(void 0);
			} catch (e) {
				return err(ioError("趋势快照写入失败", e));
			}
		},
		async analyze(profile) {
			try {
				const all = sanitizeSnapshots(readAll().filter((s) => profile === void 0 || s.profile === profile)).sort((a, b) => a.at.localeCompare(b.at));
				const n = all.length;
				const points = all.map((s) => ({
					x: Date.parse(s.at),
					y: s.bytesReclaimable
				}));
				let bytesPerDay = 0;
				let projected30dBytes = null;
				let anomalyDetail = null;
				if (n >= 2) {
					const { slope, intercept } = regress(points);
					bytesPerDay = slope * MS_PER_DAY;
					const lastX = points[n - 1].x;
					projected30dBytes = Math.max(0, intercept + slope * (lastX + 30 * MS_PER_DAY));
					if (n >= 3) {
						const train = points.slice(0, -1);
						const fit = regress(train);
						const sd = robustSigma(train.map((p) => p.y - (fit.intercept + fit.slope * p.x)));
						const predicted = fit.intercept + fit.slope * points[n - 1].x;
						const lastResidual = points[n - 1].y - predicted;
						if (sd > 0 ? Math.abs(lastResidual) > 3 * sd : lastResidual !== 0) anomalyDetail = `最新快照显著偏离趋势（3σ̂ ${lastResidual > 0 ? "激增" : "骤降"}）—— 可能存在插件失控写盘或清理异常`;
					}
				}
				return ok({
					snapshotCount: n,
					firstAt: n > 0 ? all[0].at : null,
					lastAt: n > 0 ? all[n - 1].at : null,
					bytesPerDay: Number.isFinite(bytesPerDay) ? bytesPerDay : 0,
					projected30dBytes: projected30dBytes !== null && Number.isFinite(projected30dBytes) ? projected30dBytes : null,
					anomaly: {
						detected: anomalyDetail !== null,
						detail: anomalyDetail
					},
					latest: n > 0 ? all[n - 1] : null
				});
			} catch (e) {
				return err(ioError("趋势分析失败", e));
			}
		}
	};
}
//#endregion
//#region src/infra/policy-guard.ts
const DEFAULT_POLICY = {
	version: 1,
	protectedPlugins: [],
	maxPluginsPerTx: null,
	maxReclaimBytesPerTx: null,
	minFreeDiskBytes: null,
	blackout: null
};
function createPolicyGuard(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	function freeBytes(root) {
		if (options.freeBytesOf) return options.freeBytesOf(root);
		try {
			const st = fs.statfsSync?.(root);
			return st ? Number(st.bsize) * Number(st.bavail) : null;
		} catch {
			return null;
		}
	}
	function load() {
		try {
			const raw = JSON.parse(fs.readFileSync(options.policyFile, "utf-8"));
			return {
				version: 1,
				protectedPlugins: Array.isArray(raw.protectedPlugins) ? raw.protectedPlugins.filter((x) => typeof x === "string") : [],
				maxPluginsPerTx: typeof raw.maxPluginsPerTx === "number" ? raw.maxPluginsPerTx : null,
				maxReclaimBytesPerTx: typeof raw.maxReclaimBytesPerTx === "number" ? raw.maxReclaimBytesPerTx : null,
				minFreeDiskBytes: typeof raw.minFreeDiskBytes === "number" ? raw.minFreeDiskBytes : null,
				blackout: raw.blackout && typeof raw.blackout.startHour === "number" && typeof raw.blackout.endHour === "number" ? {
					startHour: raw.blackout.startHour,
					endHour: raw.blackout.endHour
				} : null
			};
		} catch {
			return DEFAULT_POLICY;
		}
	}
	function check(request) {
		try {
			const policy = load();
			const violations = [];
			const protectedHit = request.plugins.filter((p) => policy.protectedPlugins.includes(p));
			if (protectedHit.length > 0) violations.push({
				rule: "PROTECTED_PLUGIN",
				blocking: true,
				offending: protectedHit,
				message: `保护名单插件禁止删除: ${protectedHit.join(", ")}`
			});
			if (policy.maxPluginsPerTx !== null && request.plugins.length > policy.maxPluginsPerTx) violations.push({
				rule: "TOO_MANY_PLUGINS",
				blocking: true,
				message: `单事务插件数 ${request.plugins.length} 超过上限 ${policy.maxPluginsPerTx}（防批量误删，请分批）`
			});
			if (policy.maxReclaimBytesPerTx !== null && request.estimatedBytes !== null && request.estimatedBytes > policy.maxReclaimBytesPerTx) violations.push({
				rule: "RECLAIM_CAP",
				blocking: true,
				message: `计划回收量超上限（预估 ${request.estimatedBytes} > ${policy.maxReclaimBytesPerTx}）—— 异常大的预估通常是计划出错的信号`
			});
			if (policy.minFreeDiskBytes !== null) {
				const free = freeBytes(options.diskRoot);
				if (free !== null && free < policy.minFreeDiskBytes) violations.push({
					rule: "LOW_FREE_DISK",
					blocking: true,
					message: `磁盘余量不足（${free} < ${policy.minFreeDiskBytes}）：清理的备份/回收区本身需要空间`
				});
			}
			if (policy.blackout) {
				const hour = now().getHours();
				const { startHour, endHour } = policy.blackout;
				if (startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour) violations.push({
					rule: "BLACKOUT_WINDOW",
					blocking: true,
					message: `当前处于清理黑窗期（${startHour}:00-${endHour}:00），拒绝执行`
				});
			}
			return ok(violations);
		} catch (e) {
			return err(ioError("策略检查失败", e));
		}
	}
	function asPreHook() {
		return {
			id: "policy-guard",
			timing: "pre",
			actions: "*",
			priority: -100,
			onFailure: "best-effort",
			handler: {
				type: "inline",
				run: async (ctx) => {
					if (load().protectedPlugins.includes(ctx.plugin)) return {
						kind: "veto",
						reason: `策略守卫: "${ctx.plugin}" 在保护名单中`
					};
				}
			}
		};
	}
	return {
		load,
		check,
		asPreHook
	};
}
//#endregion
//#region src/engine/disk-forecaster.ts
const DAY_MS = 864e5;
function createDiskForecaster(options) {
	function sample() {
		if (options.sampleDisk) return options.sampleDisk(options.diskRoot);
		try {
			const st = fs.statfsSync?.(options.diskRoot);
			if (!st) return null;
			return {
				free: Number(st.bsize) * Number(st.bavail),
				total: Number(st.bsize) * Number(st.blocks)
			};
		} catch {
			return null;
		}
	}
	return { async forecast() {
		try {
			const now = options.clock.now();
			const trendR = await options.trend.analyze();
			if (!trendR.ok) return trendR;
			const trend = trendR.value;
			const disk = sample();
			const growth = trend.snapshotCount >= 2 && trend.bytesPerDay > 0 ? trend.bytesPerDay : null;
			let daysUntilFull = null;
			let projectedFullAt = null;
			if (disk !== null && growth !== null && growth > 0 && disk.free > 0) {
				daysUntilFull = disk.free / growth;
				projectedFullAt = new Date(now.getTime() + daysUntilFull * DAY_MS).toISOString();
			}
			let severity = "ok";
			if (disk !== null && disk.total > 0) {
				const usedPct = (disk.total - disk.free) / disk.total * 100;
				if (usedPct >= 95) severity = "critical";
				else if (usedPct >= 85) severity = "warning";
				else if (usedPct >= 70) severity = "watch";
			}
			if (daysUntilFull !== null) {
				if (daysUntilFull <= 3) severity = "critical";
				else if (daysUntilFull <= 14 && severity !== "critical") severity = "warning";
				else if (daysUntilFull <= 30 && severity === "ok") severity = "watch";
			}
			if (trend.anomaly.detected && severity === "ok") severity = "watch";
			let recommendation;
			switch (severity) {
				case "critical":
					recommendation = "磁盘即将写满：立即 nuke_doctor 体检 → 按处方 nuke_clean（balanced），必要时 nuke_dedup 核查跨 profile 冗余";
					break;
				case "warning":
					recommendation = "磁盘余量承压：建议 nuke_orphans 扫一遍孤儿 → dry-run 评估回收量后执行";
					break;
				case "watch":
					recommendation = "保持观察：残留仍在增长，建议运行 nuke_doctor 获取处方";
					break;
				default: recommendation = trend.snapshotCount < 2 ? "趋势数据不足：多跑几次 nuke_scan 后即可获得预测能力" : "磁盘健康，按需清理即可";
			}
			return ok({
				sampledAt: now.toISOString(),
				totalBytes: disk?.total ?? null,
				freeBytes: disk?.free ?? null,
				usedPct: disk && disk.total > 0 ? Math.round((disk.total - disk.free) / disk.total * 1e3) / 10 : null,
				growthBytesPerDay: growth,
				daysUntilFull,
				projectedFullAt,
				severity,
				recommendation,
				trendBasis: {
					snapshotCount: trend.snapshotCount,
					bytesPerDay: trend.bytesPerDay,
					anomaly: trend.anomaly
				}
			});
		} catch (e) {
			return err(ioError("磁盘预测失败", e));
		}
	} };
}
//#endregion
//#region src/contracts/guardian.contract.ts
const DEFAULT_GUARDIAN_THRESHOLDS = {
	criticalDaysUntilFull: 3,
	warningDaysUntilFull: 14,
	backlogBytes: 2 * 1024 ** 3,
	minHealthScore: 60
};
//#endregion
//#region src/engine/guardian.ts
const SEV_ORDER = {
	critical: 0,
	warning: 1,
	info: 2
};
function createGuardian(deps) {
	return { async patrol(patrolOptions) {
		try {
			const profile = patrolOptions?.profile ?? "web";
			const th = {
				...DEFAULT_GUARDIAN_THRESHOLDS,
				...patrolOptions?.thresholds
			};
			const alerts = [];
			const partialFailures = [];
			let disk = null;
			const diskR = await deps.forecaster.forecast();
			if (diskR.ok) {
				disk = diskR.value;
				if (disk.daysUntilFull !== null) {
					if (disk.daysUntilFull <= th.criticalDaysUntilFull) alerts.push({
						kind: "DISK_CRITICAL",
						severity: "critical",
						message: `磁盘约 ${disk.daysUntilFull.toFixed(1)} 天后写满（余量 ${disk.freeBytes} 字节，日增 ${Math.round(disk.growthBytesPerDay ?? 0)}）`,
						suggestedTool: "nuke_doctor"
					});
					else if (disk.daysUntilFull <= th.warningDaysUntilFull) alerts.push({
						kind: "DISK_WARNING",
						severity: "warning",
						message: `磁盘 ${disk.daysUntilFull.toFixed(1)} 天后写满，开始规划清理`,
						suggestedTool: "nuke_orphans"
					});
				}
			} else partialFailures.push(`disk: ${diskR.error.message}`);
			let trend = null;
			const trendR = await deps.trend.analyze();
			if (trendR.ok) {
				trend = trendR.value;
				if (trend.anomaly.detected) alerts.push({
					kind: "TREND_ANOMALY",
					severity: "warning",
					message: trend.anomaly.detail ?? "残留量异常突变",
					suggestedTool: "nuke_doctor"
				});
			} else partialFailures.push(`trend: ${trendR.error.message}`);
			let doctor = null;
			const doctorR = await deps.doctor.diagnose(profile);
			if (doctorR.ok) {
				doctor = doctorR.value;
				if (doctor.blocking) alerts.push({
					kind: "HEALTH_BLOCKING",
					severity: "critical",
					message: `健康检查存在阻断项（评分 ${doctor.healthScore}/100），清理事务将被拒绝`,
					suggestedTool: "nuke_health"
				});
				else if (doctor.healthScore < th.minHealthScore) alerts.push({
					kind: "HEALTH_DROP",
					severity: "warning",
					message: `健康度 ${doctor.healthScore}/100 低于阈值 ${th.minHealthScore}`,
					suggestedTool: "nuke_health"
				});
				if (doctor.totalReclaimableBytes >= th.backlogBytes) alerts.push({
					kind: "RECLAIM_BACKLOG",
					severity: "warning",
					message: `可回收空间积压超阈值（${doctor.totalReclaimableBytes} ≥ ${th.backlogBytes}）`,
					suggestedTool: "nuke_clean"
				});
			} else partialFailures.push(`doctor: ${doctorR.error.message}`);
			const unfinished = deps.unfinishedTxIds();
			if (unfinished.length > 0) alerts.push({
				kind: "UNFINISHED_TX",
				severity: "critical",
				message: `检测到 ${unfinished.length} 个未终结事务（崩溃残留）: ${unfinished.join(", ")}`,
				suggestedTool: "nuke_recover"
			});
			alerts.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.kind.localeCompare(b.kind));
			return ok({
				patrolledAt: deps.clock.now().toISOString(),
				profile,
				alerts,
				disk,
				trend,
				doctor,
				partialFailures
			});
		} catch (e) {
			return err(ioError("守卫者巡检失败", e));
		}
	} };
}
//#endregion
//#region src/infra/ledger.ts
function createLedger(options) {
	const file = path.join(options.historyDir, "ledger.jsonl");
	const readAll = () => readJsonl(file) ?? [];
	function filterOf(filter) {
		return (e) => (filter?.kind === void 0 || e.kind === filter.kind) && (filter?.profile === void 0 || e.profile === filter.profile) && (filter?.since === void 0 || e.at >= filter.since);
	}
	function breakdown(entries, keyOf) {
		const map = /* @__PURE__ */ new Map();
		for (const e of entries) {
			const key = keyOf(e);
			const cur = map.get(key) ?? {
				bytes: 0,
				count: 0
			};
			cur.bytes += e.bytes;
			cur.count++;
			map.set(key, cur);
		}
		return [...map.entries()].map(([key, v]) => ({
			key,
			...v
		})).sort((a, b) => b.bytes - a.bytes);
	}
	return {
		async record(entry) {
			try {
				appendJsonl(file, entry);
				return ok(void 0);
			} catch (e) {
				return err(ioError("台账写入失败", e));
			}
		},
		async query(filter) {
			try {
				const all = readAll().filter(filterOf(filter));
				const freed = all.filter((e) => e.kind === "freed");
				const pending = all.filter((e) => e.kind === "pending");
				return ok({
					totalFreed: freed.reduce((s, e) => s + e.bytes, 0),
					totalPending: pending.reduce((s, e) => s + e.bytes, 0),
					entryCount: all.length,
					byAction: breakdown(all, (e) => e.action),
					byProfile: breakdown(all, (e) => e.profile),
					byDay: [...breakdown(all, (e) => e.at.slice(0, 10))].sort((a, b) => a.key.localeCompare(b.key))
				});
			} catch (e) {
				return err(ioError("台账查询失败", e));
			}
		},
		entries(filter, limit = 50) {
			return readAll().filter(filterOf(filter)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
		}
	};
}
//#endregion
//#region src/operations/yaml-edit.ts
function removePluginFromYaml(content, plugin) {
	const esc = plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const listItemRe = new RegExp(`^(\\s*)-\\s+id:\\s*${esc}\\s*$`);
	const stringItemRe = new RegExp(`^(\\s*)-\\s*['"]?${esc}['"]?\\s*$`);
	const mapKeyRe = new RegExp(`^(\\s*)['"]?${esc}['"]?\\s*:\\s*.*$`);
	const lines = content.split("\n");
	const keep = [];
	let dropDeeperThan = null;
	let touched = false;
	for (const line of lines) {
		const indent = line.match(/^(\s*)/)[1].length;
		if (dropDeeperThan !== null) {
			if (line.trim() === "") {
				keep.push({
					line,
					drop: true
				});
				touched = true;
				continue;
			}
			if (indent > dropDeeperThan) {
				keep.push({
					line,
					drop: true
				});
				touched = true;
				continue;
			}
			dropDeeperThan = null;
		}
		const mId = line.match(listItemRe);
		if (mId) {
			dropDeeperThan = mId[1].length;
			keep.push({
				line,
				drop: true
			});
			touched = true;
			continue;
		}
		if (stringItemRe.test(line)) {
			keep.push({
				line,
				drop: true
			});
			touched = true;
			continue;
		}
		if (mapKeyRe.test(line)) {
			keep.push({
				line,
				drop: true
			});
			touched = true;
			continue;
		}
		keep.push({
			line,
			drop: false
		});
	}
	if (!touched) return null;
	let out = keep.filter((k) => !k.drop).map((k) => k.line).join("\n");
	out = out.replace(/\n{3,}$/, "\n\n");
	if (out.trim().length > 0 && !out.endsWith("\n")) out += "\n";
	return out;
}
//#endregion
//#region src/operations/edit-ops.ts
function makeConfigEditOp(spec) {
	return {
		id: `${spec.id}:${spec.target}`,
		action: spec.action,
		target: spec.target,
		async preview(ctx) {
			const file = spec.fileOf(ctx);
			if (!existsSafe(file)) return {
				summary: `${spec.description}: 文件不存在，跳过（${file}）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: false
			};
			const content = fs.readFileSync(file, "utf-8");
			const next = removePluginFromYaml(content, spec.target);
			const touched = next === null ? [] : [file];
			return {
				summary: next === null ? `${spec.description}: 未发现 ${spec.target} 的引用，跳过` : `${spec.description}: 摘除 ${spec.target} 引用（${content.length - next.length} 字符）`,
				touchedPaths: touched,
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: false
			};
		},
		async validate(ctx) {
			const file = spec.fileOf(ctx);
			const check = await ctx.resolver.assertDeletable(file, spec.policy);
			if (!check.ok) return check;
			return ok(void 0);
		},
		async execute(ctx) {
			const file = spec.fileOf(ctx);
			if (!existsSafe(file)) return ok({
				outcome: {
					bytesFreed: 0,
					message: "文件不存在，跳过"
				},
				backup: null
			});
			const next = removePluginFromYaml(fs.readFileSync(file, "utf-8"), spec.target);
			if (next === null) return ok({
				outcome: {
					bytesFreed: 0,
					message: "未发现引用，跳过"
				},
				backup: null
			});
			try {
				const backup = await ctx.backups.stageEdit(file, next);
				return ok({
					outcome: {
						bytesFreed: 0,
						message: `${spec.description}: 已摘除 ${spec.target} 引用`
					},
					backup
				});
			} catch (e) {
				return err(ioError(`${spec.description} 失败`, e));
			}
		},
		async undo(ctx, record) {
			if (!record) return ok(void 0);
			return ctx.backups.restore(record);
		}
	};
}
/** 三个配置清理操作的标准策略 */
function configPolicies(profile) {
	const deny = ["**/@deepseek-ai/dsh-base*", "**/.nuke/**"];
	return {
		profileScoped: {
			allowedRoots: [{
				kind: "profile-dir",
				profile
			}],
			denyGlobs: deny,
			strictWindows: true
		},
		homePatch: {
			allowedRoots: [{ kind: "dsh-home-patch" }],
			denyGlobs: deny,
			strictWindows: true
		}
	};
}
/** 便捷构造：单插件的三个配置编辑操作 */
function configEditOps(target, profile, dshHomeOf) {
	const p = configPolicies(profile);
	return [
		makeConfigEditOp({
			id: "op-clean-workspace-yaml",
			action: "clean-workspace-yaml",
			target,
			fileOf: (ctx) => path.join(dshHomeOf(ctx), "profiles", profile, "pnpm-workspace.yaml"),
			description: "清理 pnpm-workspace.yaml",
			policy: p.profileScoped
		}),
		makeConfigEditOp({
			id: "op-clean-profile-patch",
			action: "clean-profile-patch",
			target,
			fileOf: (ctx) => path.join(dshHomeOf(ctx), "profiles", profile, "cordis.patch.yml"),
			description: "清理 profile patch",
			policy: p.profileScoped
		}),
		makeConfigEditOp({
			id: "op-clean-home-patch",
			action: "clean-home-patch",
			target,
			fileOf: (ctx) => path.join(dshHomeOf(ctx), "cordis.patch.yml"),
			description: "清理 home patch",
			policy: p.homePatch
		})
	];
}
//#endregion
//#region src/operations/fs-ops.ts
const DENY = [
	"**/@deepseek-ai/dsh-base*",
	"**/.nuke/**",
	"**/node_modules/.pnpm/**"
];
function makeDirRemoveOp(spec) {
	return {
		id: `${spec.id}:${spec.target}`,
		action: spec.action,
		target: spec.target,
		async preview(ctx) {
			const dir = spec.dirOf(ctx);
			if (!existsSafe(dir)) return {
				summary: `${spec.description}: 目录不存在，跳过（${dir}）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: false
			};
			const bytes = dirSize(dir);
			return {
				summary: `${spec.description}: ${dir}（${bytes} 字节 → 回收区）`,
				touchedPaths: [dir],
				estimatedBytesReclaimable: bytes,
				requiresExclusiveLock: false
			};
		},
		async validate(ctx) {
			const dir = spec.dirOf(ctx);
			const check = await ctx.resolver.assertDeletable(dir, spec.policy);
			if (!check.ok) return check;
			return ok(void 0);
		},
		async execute(ctx) {
			const dir = spec.dirOf(ctx);
			if (!existsSafe(dir)) return ok({
				outcome: {
					bytesFreed: 0,
					message: "目录不存在，跳过"
				},
				backup: null
			});
			try {
				const backup = await ctx.backups.stageDir(dir);
				return ok({
					outcome: {
						bytesFreed: backup.fingerprint.size,
						message: `${spec.description}: 已移入回收区`
					},
					backup
				});
			} catch (e) {
				return err(ioError(`${spec.description} 失败`, e));
			}
		},
		async undo(ctx, record) {
			if (!record) return ok(void 0);
			return ctx.backups.restore(record);
		}
	};
}
/** 便捷构造：单插件的三个目录清理操作 */
function dirRemoveOps(target, profile, dshHomeOf) {
	const profileScoped = {
		allowedRoots: [{
			kind: "profile-dir",
			profile
		}],
		denyGlobs: DENY,
		strictWindows: true
	};
	const storagesPolicy = {
		allowedRoots: [{ kind: "storages" }],
		denyGlobs: DENY,
		strictWindows: true
	};
	const attachmentsPolicy = {
		allowedRoots: [{ kind: "attachments" }],
		denyGlobs: DENY,
		strictWindows: true
	};
	return [
		makeDirRemoveOp({
			id: "op-remove-node-modules",
			action: "remove-node-modules",
			target,
			dirOf: (ctx) => path.join(dshHomeOf(ctx), "profiles", profile, "node_modules", ...target.split("/")),
			description: "移除 node_modules 包目录",
			policy: profileScoped
		}),
		makeDirRemoveOp({
			id: "op-remove-storages",
			action: "remove-storages",
			target,
			dirOf: (ctx) => path.join(dshHomeOf(ctx), "storages", target),
			description: "移除 storages 持久化数据",
			policy: storagesPolicy
		}),
		makeDirRemoveOp({
			id: "op-remove-attachments",
			action: "remove-attachments",
			target,
			dirOf: (ctx) => path.join(dshHomeOf(ctx), "attachments", "v1", target),
			description: "移除 attachments 会话附件",
			policy: attachmentsPolicy
		})
	];
}
const DEFAULT_MARKER = /dsh|deepseek|cordis/i;
function makePurgeTempOp(options) {
	const ttlDays = options.ttlDays ?? 7;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const marker = options.markerRe ?? DEFAULT_MARKER;
	/** 共享实现（fs-utils.tempOrphanEntries）：标记 + 期限 + 体积，符号链接排除 */
	const staleEntries = () => tempOrphanEntries(options.tempRoot, ttlDays, now, marker).map((e) => ({
		entry: e.path,
		isDir: e.isDir,
		size: e.sizeBytes
	}));
	return {
		id: "op-purge-temp:global",
		action: "purge-temp",
		target: "*temp*",
		async preview() {
			const entries = staleEntries();
			const bytes = entries.reduce((s, e) => s + e.size, 0);
			return {
				summary: `TEMP 孤儿清理: ${entries.length} 个过期条目（≥${ttlDays} 天，${bytes} 字节）`,
				touchedPaths: entries.map((e) => e.entry),
				estimatedBytesReclaimable: bytes,
				requiresExclusiveLock: false
			};
		},
		async validate() {
			return ok(void 0);
		},
		async execute(ctx) {
			const entries = staleEntries();
			if (entries.length === 0) return ok({
				outcome: {
					bytesFreed: 0,
					message: "无过期 TEMP 条目"
				},
				backup: null
			});
			let bytes = 0;
			let backup = null;
			const failures = [];
			for (const e of entries) try {
				if (e.isDir) {
					const rec = await ctx.backups.stageDir(e.entry);
					backup = backup ?? rec;
					bytes += e.size;
				} else {
					const rec = await ctx.backups.stageFile(e.entry);
					backup = backup ?? rec;
					fs.unlinkSync(e.entry);
					bytes += e.size;
				}
			} catch (err2) {
				failures.push(`${e.entry}: ${errorToMessage(err2)}`);
			}
			if (failures.length > 0 && bytes === 0) return err({
				code: "E_IO",
				message: `TEMP 清理全部失败: ${failures.join("; ")}`
			});
			return ok({
				outcome: {
					bytesFreed: bytes,
					message: `TEMP 清理 ${entries.length - failures.length}/${entries.length} 条${failures.length > 0 ? `（失败 ${failures.length}）` : ""}`
				},
				backup
			});
		},
		async undo(ctx, record) {
			if (!record) return ok(void 0);
			return ctx.backups.restore(record);
		}
	};
}
//#endregion
//#region src/operations/exec-ops.ts
/** spawnSync 包装：归一化 stdout/stderr（spawn 失败时可能为 null），
*  调用方拿到的永远是 string —— 消灭各调用点的 String(x || '') 兜底重复。 */
const defaultCommandRunner = (cmd, args, opts) => {
	const r = (0, child_process.spawnSync)(cmd, args, {
		cwd: opts.cwd,
		encoding: "utf-8",
		timeout: opts.timeoutMs
	});
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? ""
	};
};
function makeStandardRemoveOp(target, profile, options) {
	const run = options.runCommand ?? defaultCommandRunner;
	const timeoutMs = options.commandTimeoutMs ?? 6e4;
	return {
		id: `op-standard-remove:${target}`,
		action: "standard-remove",
		target,
		async preview() {
			return {
				summary: `dsh plugin --profile ${profile} remove ${target}（标准卸载）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: true
			};
		},
		async validate() {
			const name = options.validator.validatePluginName(target);
			if (!name.ok) return err({
				code: "E_VALIDATION",
				message: `插件名非法: ${target}`,
				details: { violations: name.error }
			});
			const prof = options.validator.validateProfileName(profile);
			if (!prof.ok) return err({
				code: "E_VALIDATION",
				message: `profile 名非法: ${profile}`,
				details: { violations: prof.error }
			});
			if (run("dsh", ["--version"], { timeoutMs: 5e3 }).status !== 0) return err({
				code: "E_IO",
				message: "dsh CLI 不可用（standard-remove 需要 dsh 在 PATH 中）"
			});
			return ok(void 0);
		},
		async execute() {
			const r = run("dsh", [
				"plugin",
				"--profile",
				profile,
				"remove",
				target
			], { timeoutMs });
			if (r.status !== 0) return err({
				code: "E_IO",
				message: `dsh 卸载失败（exit ${r.status}）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`
			});
			return ok({
				outcome: {
					bytesFreed: 0,
					message: `标准卸载完成: ${target}`
				},
				backup: null
			});
		},
		async undo() {
			return ok(void 0);
		}
	};
}
function makePnpmPruneOp(profile, profileDirOf, options) {
	const run = options.runCommand ?? defaultCommandRunner;
	const timeoutMs = options.commandTimeoutMs ?? 12e4;
	return {
		id: "op-pnpm-store-prune:global",
		action: "pnpm-store-prune",
		target: "*store*",
		async preview() {
			return {
				summary: `pnpm store prune（清理 profile ${profile} 关联的 pnpm 全局 store 未引用包）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: true
			};
		},
		async validate() {
			if (run("pnpm", ["--version"], { timeoutMs: 5e3 }).status !== 0) return err({
				code: "E_IO",
				message: "pnpm CLI 不可用（pnpm-store-prune 需要 pnpm 在 PATH 中）"
			});
			return ok(void 0);
		},
		async execute(ctx) {
			const r = run("pnpm", ["store", "prune"], {
				cwd: profileDirOf(ctx),
				timeoutMs
			});
			if (r.status !== 0) return err({
				code: "E_IO",
				message: `pnpm store prune 失败（exit ${r.status}）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`
			});
			return ok({
				outcome: {
					bytesFreed: 0,
					message: "pnpm store prune 完成（实际回收以 pnpm 输出为准）"
				},
				backup: null
			});
		},
		async undo() {
			return ok(void 0);
		}
	};
}
//#endregion
//#region src/operations/index.ts
const STRATEGY_ACTIONS = {
	safe: [
		"standard-remove",
		"clean-workspace-yaml",
		"clean-profile-patch",
		"clean-home-patch"
	],
	balanced: [
		"standard-remove",
		"clean-workspace-yaml",
		"clean-profile-patch",
		"clean-home-patch",
		"remove-node-modules",
		"remove-storages",
		"remove-attachments"
	],
	aggressive: [
		"standard-remove",
		"clean-workspace-yaml",
		"clean-profile-patch",
		"clean-home-patch",
		"remove-node-modules",
		"remove-storages",
		"remove-attachments",
		"pnpm-store-prune",
		"purge-temp"
	]
};
/**
* 生成引擎用的 operationFactory。
* 顺序即执行顺序：先标准卸载与配置摘除（轻、可逆），再物理回收目录，最后全局收尾。
*/
function makeOperationFactory(options) {
	return (request) => {
		const dshHomeOf = (c) => c.resolver.platform().dshHome;
		const actions = new Set(STRATEGY_ACTIONS[request.strategy]);
		const ops = [];
		const plugins = request.plugins.filter((p) => options.validator.validatePluginName(p).ok);
		for (const plugin of plugins) {
			if (actions.has("standard-remove")) ops.push(makeStandardRemoveOp(plugin, request.profile, {
				validator: options.validator,
				...options.runCommand ? { runCommand: options.runCommand } : {}
			}));
			ops.push(...configEditOps(plugin, request.profile, dshHomeOf).filter((op) => actions.has(op.action)));
			ops.push(...dirRemoveOps(plugin, request.profile, dshHomeOf).filter((op) => actions.has(op.action)));
		}
		if (actions.has("pnpm-store-prune")) ops.push(makePnpmPruneOp(request.profile, (c) => c.resolver.profileDir(request.profile), {
			validator: options.validator,
			...options.runCommand ? { runCommand: options.runCommand } : {}
		}));
		if (actions.has("purge-temp")) ops.push(makePurgeTempOp({
			tempRoot: options.tempRoot,
			...options.tempTtlDays !== void 0 ? { ttlDays: options.tempTtlDays } : {},
			...options.now ? { now: options.now } : {}
		}));
		return ops;
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-nuke-plugin";
const inject = ["tools"];
function buildRuntime() {
	const resolver = createPathResolver();
	const platform = resolver.platform();
	const nukeRoot = path.join(platform.dshHome, ".nuke");
	const logger = createLogger({ minLevel: process.env.NUKE_LOG_LEVEL === "debug" ? "debug" : "info" });
	const validator = createValidator(platform.os === "windows" ? "windows" : "linux");
	const lockManager = createLockManager({ lockRoot: nukeRoot });
	const wal = createWal({ walRoot: path.join(nukeRoot, "tx") });
	const backups = createBackupStore({ backupRoot: path.join(nukeRoot, "backups") });
	const audit = createAuditLog({ filePath: path.join(nukeRoot, "audit", "chain.jsonl") });
	const hooks = createHookRegistry({ dir: path.join(nukeRoot, "hooks") });
	/** aggressive 二次确认令牌：显式拼出 profile 与插件清单，防止误触 */
	const confirmationTokenOf = (profile, plugins) => `CONFIRM:${profile}:${[...plugins].sort().join(",")}`;
	const engine = createTransactionEngine({
		lockManager,
		wal,
		backups,
		audit,
		resolver,
		logger,
		hooks,
		clock: { now: () => /* @__PURE__ */ new Date() },
		verifyConfirmationToken: (token, req) => token === confirmationTokenOf(req.profile, req.plugins)
	}, makeOperationFactory({
		validator,
		tempRoot: platform.tempRoot,
		tempTtlDays: 7
	}));
	const scorer = createSeverityScorer();
	const analyzer = createDependencyAnalyzer({ dshHome: platform.dshHome });
	const scanCache = createScanCache({ filePath: path.join(nukeRoot, "cache", "scan-cache.json") });
	const scanner = createResidualScanner({
		dshHome: platform.dshHome,
		tempRoot: platform.tempRoot,
		scanCache
	});
	const orphans = createOrphanDetector({
		dshHome: platform.dshHome,
		tempRoot: platform.tempRoot
	});
	const health = createHealthInspector({
		dshHome: platform.dshHome,
		walUnfinished: () => wal.unfinishedTxIds()
	});
	const doctor = createDoctor({
		health,
		scanner,
		orphans,
		scorer,
		clock: { now: () => /* @__PURE__ */ new Date() }
	});
	const dedup = createDedupAnalyzer({ dshHome: platform.dshHome });
	const dedupExec = createDedupExecutor();
	const restorePoints = createRestorePointManager({
		dshHome: platform.dshHome,
		nukeRoot
	});
	const reporter = createReporter({ reportsRoot: path.join(nukeRoot, "reports") });
	const blastRadius = createBlastRadiusAnalyzer({
		dshHome: platform.dshHome,
		analyzer
	});
	const trend = createTrendTracker({ historyDir: path.join(nukeRoot, "history") });
	const ledger = createLedger({ historyDir: path.join(nukeRoot, "history") });
	const forecaster = createDiskForecaster({
		diskRoot: platform.dshHome,
		trend,
		clock: { now: () => /* @__PURE__ */ new Date() }
	});
	const guardian = createGuardian({
		forecaster,
		trend,
		doctor,
		unfinishedTxIds: () => wal.unfinishedTxIds(),
		clock: { now: () => /* @__PURE__ */ new Date() }
	});
	const policy = createPolicyGuard({
		policyFile: path.join(nukeRoot, "policy.json"),
		diskRoot: platform.dshHome,
		now: () => /* @__PURE__ */ new Date()
	});
	hooks.register(policy.asPreHook());
	return {
		resolver,
		platform,
		nukeRoot,
		logger,
		validator,
		engine,
		wal,
		audit,
		scorer,
		analyzer,
		scanner,
		orphans,
		health,
		doctor,
		dedup,
		dedupExec,
		restorePoints,
		reporter,
		blastRadius,
		trend,
		policy,
		forecaster,
		guardian,
		ledger,
		confirmationTokenOf
	};
}
function fmtBytes(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
	return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
const BAND_ICON = {
	info: "·",
	low: "🟢",
	medium: "🟡",
	high: "🟠",
	critical: "🔴"
};
const TOOL_OUTPUT = {
	schema: {
		type: "object",
		properties: { content: { type: "string" } },
		required: ["content"]
	},
	render: (_args, value) => [{
		type: "text",
		text: value.content
	}]
};
/** 统一注册入口：注入 output 契约后转发给宿主 */
function registerTool(ctx, tool) {
	const def = {
		...tool,
		output: TOOL_OUTPUT
	};
	ctx.tools.register(def);
}
function apply(ctx) {
	const rt = buildRuntime();
	/** 入参校验：插件名列表 */
	function checkPlugins(names) {
		if (!Array.isArray(names) || names.length === 0) return {
			ok: false,
			error: "请提供 plugin_names 数组（至少一个）"
		};
		for (const n of names) {
			const r = rt.validator.validatePluginName(String(n));
			if (!r.ok) return {
				ok: false,
				error: `插件名 "${n}" 非法: ${r.error.map((v) => v.detail).join("; ")}`
			};
		}
		return {
			ok: true,
			plugins: names.map(String)
		};
	}
	function checkProfile(p) {
		const r = rt.validator.validateProfileName(String(p));
		if (!r.ok) return {
			ok: false,
			error: `profile "${p}" 非法: ${r.error.map((v) => v.detail).join("; ")}`
		};
		return {
			ok: true,
			profile: String(p)
		};
	}
	function checkStrategy(s) {
		return s === "safe" || s === "balanced" || s === "aggressive" ? s : null;
	}
	registerTool(ctx, {
		name: "nuke_list",
		description: "列出指定 profile 下所有已安装的第三方插件",
		parameters: {
			type: "object",
			properties: { profile: {
				type: "string",
				description: "默认 \"web\""
			} }
		},
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const pkgPath = path.join(rt.resolver.profileDir(cp.profile), "package.json");
			try {
				const bundles = (JSON.parse(fs.readFileSync(pkgPath, "utf-8"))?.dsh?.profile?.bundles ?? []).filter((b) => !b.startsWith("@deepseek-ai/dsh-"));
				if (bundles.length === 0) return { content: `profile "${cp.profile}" 下没有第三方插件。` };
				return { content: `profile "${cp.profile}" 已安装 ${bundles.length} 个第三方插件：\n${bundles.map((b, i) => `  ${i + 1}. ${b}`).join("\n")}` };
			} catch {
				return { content: `❌ 无法读取 ${pkgPath}（profile 不存在？）` };
			}
		}
	});
	registerTool(ctx, {
		name: "nuke_scan",
		description: "扫描插件残留（配置引用/目录/TEMP），带四因子严重程度评分与可回收空间统计。省略 plugin_name 进入全局模式",
		parameters: {
			type: "object",
			properties: {
				plugin_name: {
					type: "string",
					description: "插件名（省略 = 全 profile 全插件全局扫描）"
				},
				profile: {
					type: "string",
					description: "默认 \"web\""
				},
				include_temp: {
					type: "boolean",
					description: "是否扫描 TEMP（仅 aggressive 生效），默认 false"
				}
			}
		},
		execute: async ({ plugin_name, profile = "web", include_temp = false }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			let plugin;
			if (plugin_name !== void 0) {
				const name = String(plugin_name);
				const cn = rt.validator.validatePluginName(name);
				if (!cn.ok) return { content: `❌ 插件名非法: ${cn.error.map((v) => v.detail).join("; ")}` };
				plugin = name;
			}
			const evidences = [];
			let bytesReclaimable = 0;
			for await (const ev of rt.scanner.scan({
				...plugin !== void 0 ? { plugin } : {},
				profile: cp.profile,
				strategy: include_temp ? "aggressive" : "safe",
				includeTemp: !!include_temp
			})) if (ev.type === "found") {
				evidences.push(ev.evidence);
				bytesReclaimable += ev.evidence.sizeBytes;
			}
			if (evidences.length === 0) {
				await rt.trend.record({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					trigger: "scan",
					profile: cp.profile,
					bytesReclaimable: 0,
					bytesFreed: 0,
					residualCount: 0,
					healthScore: -1
				});
				return { content: `✅ ${plugin_name ?? "全局扫描"} 无残留。` };
			}
			const ranked = rt.scorer.rank(evidences);
			await rt.trend.record({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				trigger: "scan",
				profile: cp.profile,
				bytesReclaimable,
				bytesFreed: 0,
				residualCount: evidences.length,
				healthScore: -1
			});
			const lines = ranked.map((e, i) => `  ${i + 1}. ${BAND_ICON[e.score.band] ?? "·"} [${e.score.total}分/${e.score.band}] ${e.description}\n     📍 ${e.location}  💾 ${fmtBytes(e.sizeBytes)}` + (e.referencedBy.length > 0 ? `  ⚠️ 仍被引用: ${e.referencedBy.join(", ")}` : "  ✅ 孤儿（无引用）"));
			return { content: `⚠️ 发现 ${evidences.length} 处残留，可回收 ${fmtBytes(bytesReclaimable)}：\n${lines.join("\n")}\n\n评分说明: 四因子加权（类型×访问衰减×层级×引用态），≥60 需人工确认后再清理。` };
		}
	});
	registerTool(ctx, {
		name: "nuke_deps",
		description: "依赖关系检测：哪些插件/profile 声明引用了目标插件（删除前必查）",
		parameters: {
			type: "object",
			properties: {
				plugin_names: {
					type: "array",
					items: { type: "string" }
				},
				profile: {
					type: "string",
					description: "限定单 profile 分析（省略 = 全 profile）"
				}
			},
			required: ["plugin_names"]
		},
		execute: async ({ plugin_names, profile }) => {
			const cp = checkPlugins(plugin_names);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			let prof;
			if (profile !== void 0) {
				const c = checkProfile(profile);
				if (!c.ok) return { content: `❌ ${c.error}` };
				prof = c.profile;
			}
			const g = await rt.analyzer.buildGraph(prof);
			if (!g.ok) return { content: `❌ ${g.error.message}` };
			const lines = [];
			for (const p of cp.plugins) {
				const deps = g.value.dependenciesOf(p);
				const dependents = g.value.dependentsOf(p);
				lines.push(`📦 ${p}`);
				lines.push(`   被依赖（删除会波及）: ${dependents.length > 0 ? dependents.join(", ") : "无"}`);
				lines.push(`   依赖（需要一起处理）: ${deps.length > 0 ? deps.join(", ") : "无"}`);
			}
			const blockers = await rt.analyzer.blockersOf(cp.plugins);
			if (blockers.ok && blockers.value.length > 0) {
				lines.push("", `🚨 阻断警告（同批删除后仍存在的外部依赖方）:`);
				for (const b of blockers.value) lines.push(`   ${b.plugin}: ${b.reason}`);
			}
			if (g.value.hasCycle()) lines.push("", `⚠️ 检测到依赖环: ${g.value.cycles().map((c) => c.join(" → ")).join("; ")}`);
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_orphans",
		description: "全局孤儿扫描：node_modules 未声明包 / 无主 storages-attachments / TEMP 过期条目",
		parameters: {
			type: "object",
			properties: { temp_max_age_days: {
				type: "number",
				description: "TEMP 条目过期天数，默认 7"
			} }
		},
		execute: async ({ temp_max_age_days = 7 }) => {
			const ageDays = Number(temp_max_age_days);
			if (!Number.isFinite(ageDays) || ageDays < 1) return { content: "❌ temp_max_age_days 必须为 ≥1 的数字（防止把刚写入的临时文件判为孤儿）" };
			const r = await rt.orphans.detect({ tempMaxAgeDays: ageDays });
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const { orphanPluginDirs, orphanDataDirs, tempOrphans, totalReclaimableBytes } = r.value;
			if (orphanPluginDirs.length + orphanDataDirs.length + tempOrphans.length === 0) return { content: "✅ 未发现孤儿残留。" };
			const lines = [`🗑️ 孤儿总计可回收 ${fmtBytes(totalReclaimableBytes)}`];
			if (orphanPluginDirs.length > 0) {
				lines.push("", `node_modules 孤儿包 (${orphanPluginDirs.length}):`);
				for (const d of orphanPluginDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`);
			}
			if (orphanDataDirs.length > 0) {
				lines.push("", `storages/attachments 无主目录 (${orphanDataDirs.length}):`);
				for (const d of orphanDataDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`);
			}
			if (tempOrphans.length > 0) {
				lines.push("", `TEMP 过期条目 (${tempOrphans.length}):`);
				for (const t of tempOrphans.slice(0, 20)) lines.push(`  ${t.path}  ${fmtBytes(t.sizeBytes)}  ${t.ageDays.toFixed(1)} 天`);
			}
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_health",
		description: "系统健康检查：config/dependency/runtime/residue 四组检查，输出健康度评分与阻断项",
		parameters: {
			type: "object",
			properties: { profile: {
				type: "string",
				description: "默认 \"web\""
			} }
		},
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const r = await rt.health.inspect(cp.profile);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const icon = (passed, severity) => passed ? "✅" : severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "❌";
			return { content: [
				`🏥 健康度 ${r.value.score}/100  ${r.value.blocking ? "🔴 存在阻断项（critical 失败，清理事务将被拒绝）" : "🟢 无阻断"}`,
				"",
				...r.value.results.map((x) => `  ${icon(x.passed, x.severity)} [${x.group}/${x.severity}] ${x.check}: ${x.message}${x.fix ? `\n     💡 ${x.fix}` : ""}`)
			].join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_strategies",
		description: "查看三级清理策略（safe/balanced/aggressive）及其动作集",
		parameters: {
			type: "object",
			properties: {}
		},
		execute: async () => {
			const desc = {
				safe: "仅标准卸载 + 配置引用摘除，不动任何目录（生产安全）",
				balanced: "safe + 物理回收 node_modules/storages/attachments（推荐）",
				aggressive: "balanced + pnpm store prune + TEMP 孤儿清理（需确认令牌）"
			};
			return { content: `可用清理策略：\n\n${Object.entries(STRATEGY_ACTIONS).map(([s, actions]) => `🛡️ ${s}\n  ${desc[s]}\n  动作: ${actions.join(", ")}`).join("\n\n")}\n\naggressive 二次确认令牌格式: CONFIRM:<profile>:<逗号排序插件清单>` };
		}
	});
	registerTool(ctx, {
		name: "nuke_clean",
		description: "事务化强力卸载：健康检查闸门 → 健康度阻断拒绝 → begin(独占锁) → plan(依赖/令牌校验) → [dry_run 预演 | commit 原子执行]。失败自动 Saga 回滚，全程审计",
		parameters: {
			type: "object",
			properties: {
				plugin_names: {
					type: "array",
					items: { type: "string" },
					description: "要卸载的插件名列表"
				},
				plugin_name: {
					type: "string",
					description: "单个插件名（plugin_names 简写）"
				},
				profile: {
					type: "string",
					description: "默认 \"web\""
				},
				strategy: {
					type: "string",
					description: "safe / balanced / aggressive，默认 balanced"
				},
				dry_run: {
					type: "boolean",
					description: "仅预演，默认 false"
				},
				confirmation_token: {
					type: "string",
					description: "aggressive 必填：CONFIRM:<profile>:<插件清单>"
				},
				skip_health: {
					type: "boolean",
					description: "跳过健康检查闸门，默认 false"
				},
				report_format: {
					type: "string",
					description: "报告格式 json / markdown / both / none，默认 markdown"
				},
				actor: {
					type: "string",
					description: "操作人标识（写入审计日志），默认 nuke-tool"
				}
			}
		},
		execute: async (args) => {
			const a = args ?? {};
			const { profile = "web", strategy = "balanced", dry_run = false, skip_health = false, report_format = "markdown", actor = "nuke-tool" } = a;
			const fmt = String(report_format);
			if (![
				"json",
				"markdown",
				"both",
				"none"
			].includes(fmt)) return { content: "❌ report_format 仅支持 json / markdown / both / none" };
			const cp = checkPlugins(Array.isArray(a.plugin_names) ? a.plugin_names.map(String) : typeof a.plugin_name === "string" && a.plugin_name ? [a.plugin_name] : []);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const cprof = checkProfile(profile);
			if (!cprof.ok) return { content: `❌ ${cprof.error}` };
			const strat = checkStrategy(strategy);
			if (!strat) return { content: "❌ 未知策略。可用: safe / balanced / aggressive" };
			if (!skip_health) {
				const h = await rt.health.inspect(cprof.profile);
				if (!h.ok) return { content: `🚫 健康检查本身失败，清理被拒绝（可用 skip_health 强制跳过，不建议）: ${h.error.message}` };
				if (h.value.blocking) return { content: `🚫 健康检查存在 critical 失败，清理被拒绝（可用 skip_health 强制跳过，不建议）:\n${h.value.results.filter((x) => !x.passed && x.severity === "critical").map((x) => `  🔴 ${x.check}: ${x.message}`).join("\n")}` };
			}
			const rpLines = [];
			if (!dry_run) {
				const rp = await rt.restorePoints.create({
					actor: String(actor),
					reason: `pre-clean:${strat}`,
					profile: cprof.profile
				});
				rpLines.push(rp.ok ? `🛡️ 配置还原点 ${rp.value.id}（${rp.value.files.length} 文件，nuke_restorepoint 可恢复）` : `⚠️ 还原点创建失败: ${rp.error.message}（事务级备份仍生效）`);
			}
			const begin = await rt.engine.begin({
				plugins: cp.plugins,
				profile: cprof.profile,
				strategy: strat,
				dryRun: !!dry_run,
				actor: String(actor),
				...typeof a.confirmation_token === "string" ? { confirmationToken: a.confirmation_token } : {}
			});
			if (!begin.ok) return { content: `❌ 事务开启失败 [${begin.error.code}]: ${begin.error.message}` };
			const session = begin.value;
			const planR = await rt.engine.plan(session);
			if (!planR.ok) {
				await rt.engine.rollback(session.txId);
				return { content: `❌ 计划编译失败 [${planR.error.code}]: ${planR.error.message}` };
			}
			const plan = planR.value;
			const policyCheck = rt.policy.check({
				plugins: cp.plugins,
				estimatedBytes: plan.estimatedBytesReclaimable
			});
			if (!policyCheck.ok) {
				await rt.engine.rollback(session.txId);
				return { content: `❌ 策略检查失败（事务已回滚释放）: ${policyCheck.error.message}` };
			}
			if (policyCheck.value.length > 0) {
				await rt.engine.rollback(session.txId);
				return { content: [
					`🛡️ 策略守卫拦截（事务已回滚释放）:`,
					...policyCheck.value.map((v) => `  ⛔ [${v.rule}] ${v.message}`),
					`策略文件: ${path.join(rt.nukeRoot, "policy.json")}（nuke_policy 可查看）`
				].join("\n") };
			}
			const out = [
				...rpLines,
				`🔧 事务 [${session.txId}]  ${dry_run ? "预演（dry-run）" : "执行"}`,
				`   插件: ${cp.plugins.join(", ")}  |  profile: ${cprof.profile}  |  策略: ${strat}`,
				`   预计可回收: ${fmtBytes(plan.estimatedBytesReclaimable)}  |  步骤数: ${plan.operations.length}`
			];
			for (const w of plan.warnings) out.push(`  ${w.blocking ? "⛔" : "⚠️"} ${w.message}`);
			let txCommitted = false;
			try {
				if (dry_run) {
					const dr = await rt.engine.dryRun(plan);
					if (dr.ok) {
						out.push("", "─ 预演明细 ─");
						for (const p of dr.value.plans) out.push(`  • ${p.summary}`);
						out.push("", `预计回收 ${fmtBytes(dr.value.estimatedBytesReclaimable)}。确认后去掉 dry_run 执行。`);
					} else out.push("", `❌ 预演失败 [${dr.error.code}]: ${dr.error.message}`);
					await rt.engine.rollback(session.txId);
					return { content: out.join("\n") };
				}
				const commit = await rt.engine.commit(plan);
				if (!commit.ok) {
					out.push("", `❌ 执行失败已自动回滚 [${commit.error.code}]: ${commit.error.message}`);
					return { content: out.join("\n") };
				}
				txCommitted = true;
				const tx = commit.value;
				out.push("", "─ 执行结果 ─");
				for (const s of tx.steps) {
					const mark = s.status === "done" ? "✅" : s.status === "skipped" ? "⏭️" : s.status === "undone" ? "↩️" : "❌";
					out.push(`  ${mark} [${s.index}] ${s.action} (${s.operationId})  ${s.status}${s.bytesFreed > 0 ? `  回收 ${fmtBytes(s.bytesFreed)}` : ""}`);
				}
				out.push("", `状态: ${tx.state}  |  实际回收: ${fmtBytes(tx.bytesFreedTotal)}`);
				await rt.trend.record({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					trigger: "clean",
					profile: cprof.profile,
					bytesReclaimable: 0,
					bytesFreed: tx.bytesFreedTotal,
					residualCount: 0,
					healthScore: -1
				});
				for (const s of tx.steps) {
					if (s.status !== "done" || s.bytesFreed <= 0) continue;
					await rt.ledger.record({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "freed",
						txId: session.txId,
						profile: cprof.profile,
						plugin: null,
						action: s.action,
						bytes: s.bytesFreed,
						note: `事务 ${session.txId} 步骤 ${s.index}`
					});
				}
				if (fmt !== "none") {
					const healthR = await rt.health.inspect(cprof.profile);
					const trail = await rt.audit.query({ txId: session.txId });
					const chain = await rt.audit.verify();
					const payload = {
						tx,
						health: healthR.ok ? healthR.value.results : [],
						auditTrail: trail,
						generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
						chainValid: chain.valid
					};
					const formats = fmt === "both" ? ["json", "markdown"] : [fmt === "json" ? "json" : "markdown"];
					for (const f of formats) {
						const r = await rt.reporter.export(f, payload);
						if (r.ok) out.push(`📄 ${f} 报告: ${r.value.path}`);
					}
				}
				return { content: out.join("\n") };
			} catch (e) {
				if (txCommitted) return { content: `⚠️ 事务已提交，但收尾阶段异常: ${errorToMessage(e)}` };
				try {
					await rt.engine.rollback(session.txId);
					return { content: `❌ 未预期异常（事务已回滚释放）: ${errorToMessage(e)}` };
				} catch (e2) {
					return { content: `❌ 未预期异常且回滚失败: ${errorToMessage(e)} / ${errorToMessage(e2)}（请立即运行 nuke_recover）` };
				}
			}
		}
	});
	registerTool(ctx, {
		name: "nuke_status",
		description: "查询事务状态（活跃/已终结，含步骤明细与回收统计）",
		parameters: {
			type: "object",
			properties: { tx_id: { type: "string" } },
			required: ["tx_id"]
		},
		execute: async ({ tx_id }) => {
			const id = String(tx_id);
			if (!/^[0-9a-f]{16}$/.test(id)) return { content: `❌ tx_id 非法（应为 16 位十六进制事务 ID）` };
			const s = await rt.engine.status(id);
			if (!s) return { content: `❌ 事务不存在: ${id}` };
			return { content: [
				`事务 ${s.txId}: ${s.state}`,
				`  开始: ${s.startedAt}${s.finishedAt ? `  完成: ${s.finishedAt}` : ""}`,
				`  回收总计: ${fmtBytes(s.bytesFreedTotal)}  步骤: ${s.steps.length}`,
				...s.steps.map((x) => `    [${x.index}] ${x.action} → ${x.status} (${fmtBytes(x.bytesFreed)})`)
			].join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_recover",
		description: "崩溃恢复：扫描未终结事务的 WAL，反向补偿恢复到执行前状态",
		parameters: {
			type: "object",
			properties: {}
		},
		execute: async () => {
			const r = await rt.engine.recover();
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			if (r.value.length === 0) return { content: "✅ 无需恢复：没有未终结事务。" };
			const lines = [`↩️ 已恢复 ${r.value.length} 个未终结事务:`];
			for (const s of r.value) lines.push(`  ${s.txId}: ${s.steps.length} 步已反向补偿`);
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_verify",
		description: "审计链完整性校验（hash chain 任何篡改均可定位）",
		parameters: {
			type: "object",
			properties: {}
		},
		execute: async () => {
			const v = await rt.audit.verify();
			if (v.valid) return { content: `✅ 审计链完整：${v.totalEntries} 条记录，hash 链校验通过。` };
			return { content: `🚨 审计链被篡改！共 ${v.totalEntries} 条，首个损坏点: seq=${v.firstBrokenSeq}` };
		}
	});
	registerTool(ctx, {
		name: "nuke_doctor",
		description: "一键全科体检：健康检查+残留扫描+孤儿检测+四因子评分 → 优先级处方（P1 立即/P2 建议/P3 可选）与建议清理策略",
		parameters: {
			type: "object",
			properties: { profile: {
				type: "string",
				description: "默认 \"web\""
			} }
		},
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const r = await rt.doctor.diagnose(cp.profile);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const d = r.value;
			const verdictIcon = {
				healthy: "✅",
				attention: "🟡",
				critical: "🔴"
			};
			const priorityLabel = {
				1: "🔴 P1 立即",
				2: "🟠 P2 建议",
				3: "🟢 P3 可选"
			};
			const lines = [
				`🩺 体检报告 [${cp.profile}]  ${verdictIcon[d.verdict] ?? "·"} ${d.verdict}`,
				`   健康度 ${d.healthScore}/100${d.blocking ? "  ⛔ 存在阻断项（清理事务将被拒绝）" : ""}`,
				`   潜在可回收: ${fmtBytes(d.totalReclaimableBytes)}  处方条目: ${d.recommendations.length}`
			];
			if (d.recommendations.length === 0) lines.push("", "✅ 环境干净，无需清理。");
			else {
				lines.push("", "─ 处方（按优先级）─");
				for (const rec of d.recommendations) lines.push(`  ${priorityLabel[rec.priority]} [${rec.evidence.score.total}分/${rec.evidence.score.band}] ${rec.evidence.description}`, `     💡 ${rec.reason} → 建议 ${rec.suggestedStrategy}`, `     📍 ${rec.evidence.location}  💾 ${fmtBytes(rec.evidence.sizeBytes)}`);
			}
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_dedup",
		description: "内容寻址去重：三级瀑布（尺寸分桶→头尾采样→全量 SHA-256）定位重复文件群；apply=true 时以硬链接实收（verify-then-link，需确认令牌）",
		parameters: {
			type: "object",
			properties: {
				min_size_bytes: {
					type: "number",
					description: "参与分析的最小文件尺寸，默认 4096"
				},
				apply: {
					type: "boolean",
					description: "将重复副本替换为硬链接实收空间（默认 false 只分析）"
				},
				confirm_token: {
					type: "string",
					description: "apply=true 时必填：LINK-DEDUP"
				}
			}
		},
		execute: async ({ min_size_bytes, apply, confirm_token }) => {
			let minSize;
			if (min_size_bytes !== void 0) {
				const n = Number(min_size_bytes);
				if (!Number.isInteger(n) || n < 1) return { content: "❌ min_size_bytes 必须为 ≥1 的整数" };
				minSize = n;
			}
			if (apply === true && confirm_token !== "LINK-DEDUP") return { content: "❌ apply=true 需要确认令牌 confirm_token=\"LINK-DEDUP\"（硬链接替换不可逆于权限语义）" };
			const r = await rt.dedup.analyze(minSize !== void 0 ? { minSizeBytes: minSize } : void 0);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const d = r.value;
			if (d.groups.length === 0) return { content: `✅ 未发现重复文件（扫描 ${d.filesScanned} 个 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms）。` };
			await rt.ledger.record({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				kind: "pending",
				txId: null,
				profile: "*",
				plugin: null,
				action: "dedup-potential",
				bytes: d.totalReclaimableBytes,
				note: `${d.groups.length} 组重复内容`
			});
			if (apply === true) {
				const ex = await rt.dedupExec.apply(d);
				if (!ex.ok) return { content: `❌ ${ex.error.message}` };
				const e = ex.value;
				await rt.ledger.record({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					kind: "freed",
					txId: null,
					profile: "*",
					plugin: null,
					action: "dedup-hardlink",
					bytes: e.bytesSaved,
					note: `${e.linkedFiles} 个副本硬链接化 / ${e.skipped.length} 跳过`
				});
				const lines = [
					`${e.cancelled ? "⏹️ 去重执行被中途取消（已完成部分已记 journal，可 undo）" : "♻️ 硬链接去重完成"}：${e.linkedFiles} 个副本已链接，实际回收 ${fmtBytes(e.bytesSaved)}`,
					`   （跳过 ${e.skipped.length} 项：复验失败/跨设备/已链接等）`,
					"",
					"  已链接样本："
				];
				for (const j of e.journal.slice(0, 8)) lines.push(`    • ${path.basename(j.victim)} → ${path.basename(j.canonical)} (${fmtBytes(j.sizeBytes)})`);
				if (e.skipped.length > 0) {
					lines.push("", "  跳过样本：");
					for (const s of e.skipped.slice(0, 5)) lines.push(`    • ${path.basename(s.path)}: ${s.reason}`);
				}
				return { content: lines.join("\n") };
			}
			const lines = [
				`♻️ 发现 ${d.groups.length} 组重复，合计可回收 ${fmtBytes(d.totalReclaimableBytes)}`,
				`   扫描 ${d.filesScanned} 文件 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms`,
				`   三级瀑布：尺寸淘汰 ${d.stages?.sizeEliminated ?? "—"} / 采样淘汰 ${d.stages?.sampleEliminated ?? "—"} / 全量哈希 ${d.stages?.fullHashed ?? "—"}（省读 ${fmtBytes(d.stages?.bytesSavedBySampling ?? 0)}）`,
				""
			];
			for (const g of d.groups.slice(0, 10)) {
				lines.push(`  • ${fmtBytes(g.sizeBytes)} × ${g.copies.length} 份`);
				for (const c of g.copies) lines.push(`      ${c.profile ?? "—"}/${path.basename(c.path)}`);
			}
			if (d.groups.length > 10) lines.push("", `  … 及另外 ${d.groups.length - 10} 组`);
			lines.push("", "💡 确认后可执行硬链接实收：apply=true + confirm_token=\"LINK-DEDUP\"");
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_restorepoint",
		description: "配置还原点管理：清理前自动快照关键配置，事故后一键恢复（list / create / restore / prune）",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: "list / create / restore / prune，默认 list"
				},
				id: {
					type: "string",
					description: "restore 目标还原点 id"
				},
				profile: {
					type: "string",
					description: "create 用，默认 \"web\""
				},
				reason: {
					type: "string",
					description: "create 用，默认 manual"
				},
				keep: {
					type: "number",
					description: "prune 用：保留最近几个，默认 5"
				},
				actor: {
					type: "string",
					description: "create 用，默认 nuke-tool"
				}
			}
		},
		execute: async ({ action = "list", id, profile = "web", reason = "manual", keep = 5, actor = "nuke-tool" }) => {
			if (action === "create") {
				const cp = checkProfile(profile);
				if (!cp.ok) return { content: `❌ ${cp.error}` };
				const r = await rt.restorePoints.create({
					actor: String(actor),
					reason: String(reason),
					profile: cp.profile
				});
				if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
				return { content: `🛡️ 还原点已创建: ${r.value.id}\n   文件 ${r.value.files.length} 个，快照于 ${r.value.createdAt}。` };
			}
			if (action === "restore") {
				if (!id) return { content: "❌ 请提供 id" };
				const r = await rt.restorePoints.restore(String(id));
				if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
				return { content: `↩️ 已恢复 ${r.value.files.length} 个配置文件到 ${r.value.createdAt} 时点（${r.value.id}）。` };
			}
			if (action === "prune") {
				const k = Number(keep);
				if (!Number.isInteger(k) || k < 1) return { content: "❌ keep 必须为 ≥1 的整数（不允许清空全部还原点）" };
				const r = await rt.restorePoints.prune(k);
				if (!r.ok) return { content: `❌ ${r.error.message}` };
				return { content: `🧹 已删除 ${r.value} 个旧还原点。` };
			}
			const all = rt.restorePoints.list();
			if (all.length === 0) return { content: "暂无还原点。" };
			const lines = [`🛡️ ${all.length} 个还原点（最新在前）:`];
			for (const m of all) lines.push(`  ${m.id}  ${m.createdAt}  ${m.files.length} 文件  by ${m.actor}  (${m.reason})`);
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_blastradius",
		description: "爆炸半径沙盘推演（what-if）：删除前预测传递闭包波及面 —— 谁会损坏、谁可级联、风险几级、如何降险。零副作用",
		parameters: {
			type: "object",
			properties: {
				plugin_names: {
					type: "array",
					items: { type: "string" }
				},
				profile: {
					type: "string",
					description: "限定单 profile 图（省略 = 全 profile）"
				}
			},
			required: ["plugin_names"]
		},
		execute: async ({ plugin_names, profile }) => {
			const cp = checkPlugins(plugin_names);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			let prof;
			if (profile !== void 0) {
				const c = checkProfile(profile);
				if (!c.ok) return { content: `❌ ${c.error}` };
				prof = c.profile;
			}
			const r = await rt.blastRadius.simulate(cp.plugins, prof);
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const b = r.value;
			const lines = [
				`💥 爆炸半径推演  ${{
					low: "🟢",
					medium: "🟡",
					high: "🟠",
					extreme: "🔴"
				}[b.riskLevel]} ${b.riskLevel.toUpperCase()}（风险分 ${b.riskScore}/100）`,
				`   目标: ${b.targets.join(", ")}`,
				`   预估可回收: ${fmtBytes(b.estimatedBytesReclaimable)}  |  配置引用: ${b.configRefs.length} 处`
			];
			if (b.brokenDependents.length > 0) lines.push("", `🚨 将损坏的插件 (${b.brokenDependents.length}): ${b.brokenDependents.join(", ")}`);
			else lines.push("", "✅ 无意外波及（删除集合外无依赖方）");
			if (b.cascadeRemovable.length > 0) lines.push(`📦 级联同删 (${b.cascadeRemovable.length}): ${b.cascadeRemovable.join(", ")}`);
			lines.push("", "─ 顾问建议 ─");
			for (const a of b.advisories) lines.push(`  💡 ${a}`);
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_trend",
		description: "历史趋势分析：可回收空间变化率（字节/天）、30 天线性外推、3σ 异常检测（插件失控写盘早期信号）",
		parameters: {
			type: "object",
			properties: { profile: {
				type: "string",
				description: "限定 profile（省略 = 全部）"
			} }
		},
		execute: async ({ profile }) => {
			let prof;
			if (profile !== void 0) {
				const cp = checkProfile(profile);
				if (!cp.ok) return { content: `❌ ${cp.error}` };
				prof = cp.profile;
			}
			const r = await rt.trend.analyze(prof);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const t = r.value;
			if (t.snapshotCount === 0) return { content: "暂无历史快照 —— 运行 nuke_scan / nuke_clean / nuke_doctor 后自动积累。" };
			const lines = [`📈 趋势分析（${t.snapshotCount} 个快照，${t.firstAt} → ${t.lastAt}）`, `   变化率: ${t.bytesPerDay >= 0 ? "+" : ""}${fmtBytes(Math.abs(t.bytesPerDay))}/天${t.bytesPerDay > 0 ? "（残留净增长）" : t.bytesPerDay < 0 ? "（净回收，趋势向好）" : ""}`];
			if (t.projected30dBytes !== null) lines.push(`   30 天外推: ${fmtBytes(t.projected30dBytes)} 可回收`);
			if (t.anomaly.detected) lines.push("", `🚨 异常: ${t.anomaly.detail}`);
			else if (t.snapshotCount >= 3) lines.push("   ✅ 无异常突变");
			if (t.latest) lines.push(`   最新快照: ${{
				scan: "扫描",
				clean: "清理",
				doctor: "体检"
			}[t.latest.trigger] ?? t.latest.trigger} @ ${t.latest.at}，可回收 ${fmtBytes(t.latest.bytesReclaimable)}`);
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_policy",
		description: "查看当前清理策略守卫配置（保护名单/批量上限/回收上限/磁盘下限/时间黑窗）。策略文件: <dshHome>/.nuke/policy.json",
		parameters: {
			type: "object",
			properties: {}
		},
		execute: async () => {
			const p = rt.policy.load();
			const lines = ["🛡️ 当前清理策略（policy.json）:"];
			lines.push(`  保护名单: ${p.protectedPlugins.length > 0 ? p.protectedPlugins.join(", ") : "（空）"}`);
			lines.push(`  单事务插件上限: ${p.maxPluginsPerTx ?? "无限制"}`);
			lines.push(`  单事务回收上限: ${p.maxReclaimBytesPerTx !== null ? fmtBytes(p.maxReclaimBytesPerTx) : "无限制"}`);
			lines.push(`  磁盘余量下限: ${p.minFreeDiskBytes !== null ? fmtBytes(p.minFreeDiskBytes) : "不检查"}`);
			lines.push(`  时间黑窗: ${p.blackout ? `${p.blackout.startHour}:00 - ${p.blackout.endHour}:00` : "无"}`);
			lines.push("", "说明: 策略文件缺失或损坏时默认全放行；保护名单同时以引擎 pre-hook 形式强制执行（纵深防御）。");
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_guardian",
		description: "守卫者巡检：一键主动运维 —— 磁盘写满倒计时/趋势异常/健康阻断/可回收积压/崩溃残留事务，输出带行动建议的分级告警",
		parameters: {
			type: "object",
			properties: { profile: {
				type: "string",
				description: "默认 \"web\""
			} }
		},
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const r = await rt.guardian.patrol({ profile: cp.profile });
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const g = r.value;
			const sevIcon = {
				critical: "🔴",
				warning: "🟡",
				info: "ℹ️"
			};
			const lines = [`🛡️ 守卫者巡检 @ ${g.patrolledAt}`];
			if (g.disk && g.disk.usedPct !== null) lines.push(`   磁盘: 已用 ${g.disk.usedPct}%` + (g.disk.daysUntilFull !== null ? `，按当前增速约 ${g.disk.daysUntilFull.toFixed(1)} 天后写满` : ""));
			if (g.partialFailures.length > 0) lines.push(`   ⚠️ 部分采集降级: ${g.partialFailures.join("; ")}`);
			if (g.alerts.length === 0) lines.push("", "✅ 一切正常，无需行动。");
			else {
				lines.push("", `发现 ${g.alerts.length} 条告警:`);
				for (const a of g.alerts) {
					lines.push(`  ${sevIcon[a.severity]} [${a.kind}] ${a.message}`);
					lines.push(`     → 建议调用 ${a.suggestedTool}`);
				}
			}
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_forecast",
		description: "磁盘写满预测：趋势回归 × 实时余量 → 写满倒计时（daysUntilFull）、30 天走势与分级建议",
		parameters: {
			type: "object",
			properties: {}
		},
		execute: async () => {
			const r = await rt.forecaster.forecast();
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const f = r.value;
			const lines = [`🔮 磁盘预测 @ ${f.sampledAt}  ${{
				ok: "🟢",
				watch: "🟡",
				warning: "🟠",
				critical: "🔴"
			}[f.severity]} ${f.severity}`];
			if (f.totalBytes !== null && f.freeBytes !== null) lines.push(`   容量 ${fmtBytes(f.totalBytes)} | 余量 ${fmtBytes(f.freeBytes)} | 已用 ${f.usedPct}%`);
			else lines.push("   磁盘采样不可用（statfs 无权限），仅输出趋势侧结论");
			if (f.growthBytesPerDay !== null) lines.push(`   残留增速: ${fmtBytes(f.growthBytesPerDay)}/天（依据 ${f.trendBasis?.snapshotCount ?? 0} 个快照）`);
			else lines.push("   残留增速: 尚不可测（趋势样本不足或正在净回收）");
			if (f.daysUntilFull !== null && f.projectedFullAt !== null) lines.push(`   ⏳ 写满倒计时: ${f.daysUntilFull.toFixed(1)} 天（预计 ${f.projectedFullAt}）`);
			lines.push("", `💡 ${f.recommendation}`);
			return { content: lines.join("\n") };
		}
	});
	registerTool(ctx, {
		name: "nuke_ledger",
		description: "空间台账：每字节回收可溯源 —— 按动作/profile/日聚合，已回收(freed)与待回收(pending)双轨统计",
		parameters: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					description: "freed / pending（省略 = 全部）"
				},
				profile: {
					type: "string",
					description: "限定 profile（省略 = 全部）"
				},
				days: {
					type: "number",
					description: "只统计最近 N 天（省略 = 全部）"
				}
			}
		},
		execute: async ({ kind, profile, days }) => {
			const filter = {};
			if (kind === "freed" || kind === "pending") filter.kind = kind;
			if (profile !== void 0) {
				const cp = checkProfile(profile);
				if (!cp.ok) return { content: `❌ ${cp.error}` };
				filter.profile = cp.profile;
			}
			if (days !== void 0) {
				const n = Number(days);
				if (!Number.isFinite(n) || n < 0) return { content: "❌ days 必须为 ≥0 的数字" };
				filter.since = (/* @__PURE__ */ new Date(Date.now() - n * 864e5)).toISOString();
			}
			const r = await rt.ledger.query(filter);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const s = r.value;
			if (s.entryCount === 0) return { content: "暂无台账记录 —— nuke_clean 执行后自动记账。" };
			const lines = [
				`📒 空间台账（${s.entryCount} 条）`,
				`   已回收: ${fmtBytes(s.totalFreed)}  |  待回收潜力: ${fmtBytes(s.totalPending)}`,
				"",
				"─ 按动作 ─",
				...s.byAction.slice(0, 8).map((b) => `  ${b.key}: ${fmtBytes(b.bytes)} × ${b.count} 次`),
				"",
				"─ 按 profile ─",
				...s.byProfile.map((b) => `  ${b.key}: ${fmtBytes(b.bytes)}`)
			];
			if (s.byDay.length > 1) {
				lines.push("", "─ 按日（回收趋势）─");
				for (const d of s.byDay.slice(-14)) lines.push(`  ${d.key}: ${fmtBytes(d.bytes)}`);
			}
			const recent = rt.ledger.entries(filter, 3);
			if (recent.length > 0) {
				lines.push("", "─ 最近记录 ─");
				for (const e of recent) lines.push(`  ${e.at}  ${e.kind === "freed" ? "✅" : "⏳"} ${e.action} ${fmtBytes(e.bytes)}${e.txId ? ` (${e.txId})` : ""}`);
			}
			return { content: lines.join("\n") };
		}
	});
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;

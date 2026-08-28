// src/infra/validator.ts — IInputValidator 实现：全量防注入校验
import type { AbsolutePath, PluginName, ProfileName } from '../contracts/base'
import { err, errorToMessage, ok } from '../contracts/base'
import type {
  IInputValidator, ValidationRequest, Violation, ViolationKind,
} from '../contracts/validation'

// npm 包名规范：[scope/]name，字符集 [a-z0-9-._~]，总长 ≤ 214
const PLUGIN_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
// profile 名与插件名同等白名单字符集 [a-z0-9-._~]（消除两套字符集规则的漂移面；
// 仍保留 profile 自身约束：无 @scope 前缀、总长 1~64、保留目录名拒绝）
const PROFILE_NAME_RE = /^[a-z0-9-][a-z0-9-._~]{0,63}$/
const RESERVED_PROFILES = new Set(['profiles', 'storages', 'attachments', 'sessions', 'node_modules', 'global'])
// 注入字符：命令替换/管道/分号/反引号 —— argv 数组模式本身无 shell，
// 此为纵深防御（万一某处实现失误把 argv 拼回 shell 字符串）。圆括号/尖括号无害，放行。
const SHELL_META_RE = /[;|&$`\n\r]/
// Windows 保留设备名
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
// ReDoS 静态特征：嵌套量词 / 量词修饰的捕获组内又含量词
const REDOS_PATTERNS = [
  /\((?:[^()\\]|\\.)*[+*]\)\s*[+*{]/,   // (...x+)+ / (...x+){
  /\((?:[^()\\]|\\.)*[+*]\s*\|/,
  /\\[bB]|\(\?<=/,                       // 显然回溯型结构（保守拦截）
]

function v(kind: ViolationKind, detail: string, field?: string): Violation {
  return { kind, detail, ...(field ? { field } : {}) }
}

function splitSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(s => s.length > 0)
}

export function createValidator(
  platform: 'windows' | 'macos' | 'linux' = 'linux',
): IInputValidator {
  const isWin = platform === 'windows'

  const validator: IInputValidator = {
    validatePluginName(input: string) {
      const violations: Violation[] = []
      if (!input || input.length === 0) return err([v('empty', '插件名为空', 'pluginName')])
      if (input.length > 214) violations.push(v('too-long', `长度 ${input.length} 超过 npm 上限 214`, 'pluginName'))
      if (input.includes('\0')) violations.push(v('nul-byte', '包含 NUL 字节', 'pluginName'))
      if (!PLUGIN_NAME_RE.test(input)) {
        violations.push(v('charset',
          `仅允许小写字母/数字/-/./_/~ 与可选 @scope/ 前缀，收到: "${input}"`, 'pluginName'))
      }
      if (SHELL_META_RE.test(input)) violations.push(v('shell-metachar', '包含 shell 元字符', 'pluginName'))
      return violations.length ? err(violations) : ok(input as PluginName)
    },

    validateProfileName(input: string) {
      const violations: Violation[] = []
      if (!input || input.length === 0) return err([v('empty', 'profile 名为空', 'profileName')])
      if (input.includes('\0')) violations.push(v('nul-byte', '包含 NUL 字节', 'profileName'))
      if (!PROFILE_NAME_RE.test(input)) {
        violations.push(v('charset', '仅允许 [a-z0-9-._~]（与插件名同等白名单字符集），首字符须为字母/数字/连字符，长度 1~64', 'profileName'))
      }
      if (RESERVED_PROFILES.has(input)) {
        violations.push(v('syntax', `"${input}" 是保留目录名`, 'profileName'))
      }
      if (SHELL_META_RE.test(input)) violations.push(v('shell-metachar', '包含 shell 元字符', 'profileName'))
      return violations.length ? err(violations) : ok(input as ProfileName)
    },

    validatePath(input: string, options: { mustBeAbsolute: boolean; strictWindows: boolean }) {
      const violations: Violation[] = []
      const field = 'path'
      if (!input || input.length === 0) return err([v('empty', '路径为空', field)])
      if (input.includes('\0')) violations.push(v('nul-byte', '包含 NUL 字节', field))
      if (input.length > 4096) violations.push(v('too-long', '路径超过 4096 字符', field))

      const segments = splitSegments(input)
      if (segments.includes('..')) violations.push(v('traversal', '包含 ".." 穿越段', field))

      if (options.mustBeAbsolute) {
        const absolute = input.startsWith('/') || (isWin && /^[a-zA-Z]:[\\/]/.test(input))
        if (!absolute) violations.push(v('absolute-required', '必须是绝对路径', field))
      }

      if (isWin && options.strictWindows) {
        if (input.startsWith('\\\\') || input.startsWith('//')) {
          violations.push(v('unc-path', 'Windows 严格模式拒绝 UNC 路径', field))
        }
        for (const seg of segments) {
          if (WIN_RESERVED.test(seg)) {
            violations.push(v('syntax', `Windows 保留设备名: "${seg}"`, field))
            break
          }
        }
      }

      if (/[\n\r]/.test(input)) {
        violations.push(v('shell-metachar', '路径含换行符', field))
      }

      return violations.length ? err(violations) : ok(input as AbsolutePath)
    },

    validateRegex(input: string) {
      const violations: Violation[] = []
      if (!input || input.length === 0) return err([v('empty', '正则为空', 'regex')])
      if (input.length > 512) violations.push(v('too-long', '正则长度超过 512', 'regex'))
      for (const pat of REDOS_PATTERNS) {
        if (pat.test(input)) {
          violations.push(v('regex-unsafe', `检测到回溯风险结构（匹配 ${pat}），拒绝编译`, 'regex'))
          break
        }
      }
      if (violations.length) return err(violations)
      try {
        return ok(new RegExp(input))
      } catch (e) {
        return err([v('syntax', `正则编译失败: ${errorToMessage(e)}`, 'regex')])
      }
    },

    validateCommandArgv(argv: readonly string[], allowBin: readonly string[]) {
      const violations: Violation[] = []
      if (argv.length === 0) return err([v('empty', 'argv 为空', 'command')])
      const bin = argv[0]!
      // 白名单绕过防御：argv[0] 含路径分隔符时，basename 过白名单但执行的是
      // 调用方指定的任意路径（如 /tmp/evil/node）—— 一律拒绝，只允许裸命令名。
      if (/[\\/]/.test(bin)) {
        violations.push(v('syntax', `argv[0] 不允许包含路径分隔符（防白名单绕过）: "${bin}"`, 'command'))
      }
      const base = bin.split(/[\\/]/).pop()!.replace(/\.exe$/i, '')
      if (!allowBin.includes(base)) {
        violations.push(v('syntax', `可执行文件 "${base}" 不在白名单 [${allowBin.join(', ')}]`, 'command'))
      }
      for (const [i, arg] of argv.entries()) {
        if (arg.includes('\0')) { violations.push(v('nul-byte', `argv[${i}] 含 NUL`, 'command')); break }
        if (SHELL_META_RE.test(arg)) {
          violations.push(v('shell-metachar', `argv[${i}]="${arg}" 含 shell 元字符（命令必须是 argv 数组，禁止 shell 字符串）`, 'command'))
          break
        }
      }
      return violations.length ? err(violations) : ok(argv)
    },

    validateAll(request: ValidationRequest) {
      // 批量模式：逐字段校验并汇总全部错误（而非首错即停），供上层一次性展示；
      // 缺省字段跳过该项校验
      const violations: Violation[] = []
      if (request.pluginName !== undefined) {
        const r = validator.validatePluginName(request.pluginName)
        if (!r.ok) violations.push(...r.error)
      }
      if (request.profileName !== undefined) {
        const r = validator.validateProfileName(request.profileName)
        if (!r.ok) violations.push(...r.error)
      }
      if (request.path !== undefined) {
        const opts = request.pathOptions ?? { mustBeAbsolute: false, strictWindows: false }
        const r = validator.validatePath(request.path, opts)
        if (!r.ok) violations.push(...r.error)
      }
      if (request.regex !== undefined) {
        const r = validator.validateRegex(request.regex)
        if (!r.ok) violations.push(...r.error)
      }
      if (request.commandArgv !== undefined) {
        const r = validator.validateCommandArgv(request.commandArgv, request.allowBin ?? [])
        if (!r.ok) violations.push(...r.error)
      }
      return violations.length ? err(violations) : ok(undefined)
    },

    sanitizeForDisplay(input: string): string {
      // 剥离 ANSI 转义序列与其余 C0 控制字符，防终端转义注入
      return input
        // eslint-disable-next-line no-control-regex -- 剥离 CSI 转义序列正是该正则的目的（防终端转义注入）
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        // eslint-disable-next-line no-control-regex -- OSC 序列以 BEL/ST 定界，控制字符是匹配语义的组成部分
        .replace(/\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    },
  }
  return validator
}

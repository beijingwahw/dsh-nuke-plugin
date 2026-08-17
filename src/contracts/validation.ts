// contracts/validation.ts — 子系统一：输入校验防注入
// 修正现有实现的三个注入面：
//  1. assertSafe 只覆盖 2 个字段 → 全部外部输入必经此接口
//  2. hooks 的 sh -c 任意命令执行 → 命令一律强制 argv 数组 + shell 元字符拒绝
//  3. 无路径校验 → 路径穿越/NUL/UNC/相对段全量检测

import type {
  AbsolutePath, PluginName, ProfileName, Result,
} from './base'

export type ViolationKind =
  | 'empty'            // 空输入
  | 'charset'          // 非法字符集
  | 'traversal'        // 含 ../ 等相对段
  | 'absolute-required'
  | 'nul-byte'         // 含 \0
  | 'unc-path'         // Windows UNC（\\server\share）易绕权限
  | 'shell-metachar'   // ; | & $ ` 等注入元字符
  | 'regex-unsafe'     // 正则回溯灾难（ReDoS）风险
  | 'too-long'
  | 'syntax'           // 不满足语法规范（如包名 BNF）

export interface Violation {
  readonly kind: ViolationKind
  readonly detail: string
  readonly field?: string
}

/** npm 包名 BNF 白名单：scope/name 仅允许 [a-z0-9-._~/@]，长度 ≤ 214 */
export interface IInputValidator {
  /** 插件名：npm 包名规范（支持 @scope/name），拒绝其余一切字符 */
  validatePluginName(input: string): Result<PluginName, readonly Violation[]>

  /** profile 名：仅 [a-z0-9-]，长度 1~64，保留字拒绝（如 'profiles' 本身） */
  validateProfileName(input: string): Result<ProfileName, readonly Violation[]>

  /**
   * 路径校验：
   *  - 必须 NUL-free、无穿越段（../、./）
   *  - mode='must-be-absolute' 时拒绝相对路径
   *  - windows 严格模式下拒绝 UNC 与保留设备名（CON/PRN/AUX/NUL/COM1..）
   */
  validatePath(input: string, options: {
    mustBeAbsolute: boolean
    strictWindows: boolean
  }): Result<AbsolutePath, readonly Violation[]>

  /**
   * 用户正则：静态分析回溯风险（嵌套量词、交替+量词叠加），
   * 复杂度超限拒绝；并限制长度，编译前先行 test 校验
   */
  validateRegex(input: string): Result<RegExp, readonly Violation[]>

  /**
   * 钩子命令校验：强制 argv 数组形态。
   * 拒绝任何含 shell 元字符（; | & $ ` > < ( ) 换行）的元素，
   * 可执行文件必须命中 allowBin 白名单（如 node/python/dsh/pnpm）
   */
  validateCommandArgv(argv: readonly string[], allowBin: readonly string[]):
    Result<readonly string[], readonly Violation[]>

  /** 展示层转义：剥离 ANSI/控制字符，防终端转义注入（恶意文件名操纵终端） */
  sanitizeForDisplay(input: string): string
}

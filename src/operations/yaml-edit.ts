// src/operations/yaml-edit.ts — YAML 插件块精确摘除（零依赖，行级结构感知）
// 支持三种引用形态（覆盖 dsh 全部配置文件风格）：
//   1. patch 列表项：  - id: <plugin>（连同其后更深缩进的属性行一起摘除）
//   2. 字符串列表项：  - <plugin> / - '<plugin>'（allowBuilds 等）
//   3. 映射键：        <plugin>: <任意值>（catalog/依赖表等）
// 返回 null 表示文件未引用该插件（调用方应跳过，不产生副作用）。
//
// V4 摘除纪律（字节级保持）：除被摘除的引用行外，其余内容（含注释、顺序、
// 空行分布与 EOF 换行约定）逐字节不变 ——
//   a. 块内空行只有在后面仍跟着块内属性行时才随块摘除；
//      与后续内容分隔的空行（块尾/文件尾）一律保留
//   b. 不做尾部空行收敛等"美化"重写（旧实现会把 3+ 换行折叠为 2 个，破坏字节级保持）
//   c. 原文件以 \n 结尾 → 结果以 \n 结尾；原文件没有 → 不补
export function removePluginFromYaml(content: string, plugin: string): string | null {
  const esc = plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const listItemRe = new RegExp(`^(\\s*)-\\s+id:\\s*${esc}\\s*$`)
  const stringItemRe = new RegExp(`^(\\s*)-\\s*['"]?${esc}['"]?\\s*$`)
  const mapKeyRe = new RegExp(`^(\\s*)['"]?${esc}['"]?\\s*:\\s*.*$`)

  const lines = content.split('\n')
  const keep: { line: string; drop: boolean }[] = []
  let dropDeeperThan: number | null = null   // 正在被摘除的列表项缩进
  let touched = false

  const indentOf = (line: string) => line.length - line.trimStart().length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // 缩进 = 前导空白长度（与 /^(\s*)/ 匹配等价，免正则免断言）
    const indent = indentOf(line)

    // 处于列表项摘除中：属性行（更深缩进）继续摘，直到缩进回落
    if (dropDeeperThan !== null) {
      if (line.trim() === '' || indent > dropDeeperThan) {
        // 空行归属判定（字节级保持的关键）：向后找第一个非空行——
        // 仍属本块（更深缩进）→ 空行在块内部，随块摘除；
        // 已回落/到文件尾 → 空行是分隔符或文件尾保留内容，必须保留
        if (line.trim() === '') {
          let j = i + 1
          while (j < lines.length && lines[j]!.trim() === '') j++
          const nextNonBlank = j < lines.length ? lines[j]! : undefined
          if (nextNonBlank === undefined || indentOf(nextNonBlank) <= dropDeeperThan) {
            keep.push({ line, drop: false })   // 分隔空行：保留，且本块到此结束
            dropDeeperThan = null
            continue
          }
        }
        keep.push({ line, drop: true })
        touched = true
        continue
      }
      dropDeeperThan = null   // 缩进回落 → 本行重新走匹配
    }

    const mId = line.match(listItemRe)
    if (mId) {
      dropDeeperThan = mId[1]?.length ?? 0
      keep.push({ line, drop: true })
      touched = true
      continue
    }
    if (stringItemRe.test(line)) { keep.push({ line, drop: true }); touched = true; continue }
    if (mapKeyRe.test(line)) { keep.push({ line, drop: true }); touched = true; continue }
    keep.push({ line, drop: false })
  }

  if (!touched) return null

  // 纯行级重组：不做任何美化重写（空行分布/缩进/注释全部原样透传）
  let out = keep.filter(k => !k.drop).map(k => k.line).join('\n')
  // EOF 换行约定保持：仅当原文件以换行结尾而摘除恰好吃掉了末尾换行时补回
  if (out.length > 0 && content.endsWith('\n') && !out.endsWith('\n')) out += '\n'
  return out
}

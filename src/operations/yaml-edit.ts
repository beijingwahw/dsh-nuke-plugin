// src/operations/yaml-edit.ts — YAML 插件块精确摘除（零依赖，行级结构感知）
// 支持三种引用形态（覆盖 dsh 全部配置文件风格）：
//   1. patch 列表项：  - id: <plugin>（连同其后更深缩进的属性行一起摘除）
//   2. 字符串列表项：  - <plugin> / - '<plugin>'（allowBuilds 等）
//   3. 映射键：        <plugin>: <任意值>（catalog/依赖表等）
// 返回 null 表示文件未引用该插件（调用方应跳过，不产生副作用）。
export function removePluginFromYaml(content: string, plugin: string): string | null {
  const esc = plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const listItemRe = new RegExp(`^(\\s*)-\\s+id:\\s*${esc}\\s*$`)
  const stringItemRe = new RegExp(`^(\\s*)-\\s*['"]?${esc}['"]?\\s*$`)
  const mapKeyRe = new RegExp(`^(\\s*)['"]?${esc}['"]?\\s*:\\s*.*$`)

  const lines = content.split('\n')
  const keep: { line: string; drop: boolean }[] = []
  let dropDeeperThan: number | null = null   // 正在被摘除的列表项缩进
  let touched = false

  for (const line of lines) {
    // 缩进 = 前导空白长度（与 /^(\s*)/ 匹配等价，免正则免断言）
    const indent = line.length - line.trimStart().length

    // 处于列表项摘除中：属性行（更深缩进）继续摘，直到缩进回落
    if (dropDeeperThan !== null) {
      if (line.trim() === '') { keep.push({ line, drop: true }); touched = true; continue }
      if (indent > dropDeeperThan) { keep.push({ line, drop: true }); touched = true; continue }
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

  let out = keep.filter(k => !k.drop).map(k => k.line).join('\n')
  // 尾部空行收敛：最多保留一个换行
  out = out.replace(/\n{3,}$/, '\n\n')
  if (out.trim().length > 0 && !out.endsWith('\n')) out += '\n'
  return out
}

/**
 * InitialVariables 的 YAML 子集解析（clean-room）。
 *
 * 支持的形态（覆盖 ST-Prompt-Template 文档示例的变量树场景）：
 * - 缩进嵌套 map（2 空格缩进为惯例，任意一致缩进均可）；
 * - `- item` 数组（标量项或 `- key: value` 起头的映射项）；
 * - 标量：`'...'` / `"..."` 字符串、数字、true/false/null、纯文本；
 * - 整行 `#` 注释与空行。
 *
 * 不支持：锚点/引用、多文档、flow 风格（`{}`/`[]`）、块标量（`|`/`>`）、标签。
 * JSON 之外的复杂 YAML 需求请直接用 JSON 格式。解析失败抛 YamlSubsetError。
 */

export class YamlSubsetError extends Error {
  constructor(message: string, readonly line: number) {
    super(`yaml subset parse error at line ${line}: ${message}`)
    this.name = 'YamlSubsetError'
  }
}

interface Line {
  indent: number
  text: string
  number: number
}

export function parseYamlSubset(source: string): unknown {
  const lines: Line[] = []
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    const stripped = raw.replace(/\t/g, '  ')
    const content = stripped.trim()
    if (content === '' || content.startsWith('#')) continue
    const indent = stripped.length - stripped.trimStart().length
    lines.push({ indent, text: content, number: i + 1 })
  }
  if (lines.length === 0) return {}
  const [value] = parseBlock(lines, 0, lines[0]!.indent)
  return value
}

/** 解析从 lines[pos] 起、缩进为 indent 的块；返回 [值, 下一个未消费位置]。 */
function parseBlock(lines: Line[], pos: number, indent: number): [unknown, number] {
  const first = lines[pos]!
  if (first.text.startsWith('- ') || first.text === '-') return parseArray(lines, pos, indent)
  return parseMap(lines, pos, indent)
}

function parseArray(lines: Line[], pos: number, indent: number): [unknown, number] {
  const out: unknown[] = []
  let i = pos
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlSubsetError('unexpected indentation', line.number)
    if (line.text === '-') {
      // `-` 独占一行：后续更深缩进是该项内容
      const next = lines[i + 1]
      if (next && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, i + 1, next.indent)
        out.push(value)
        i = consumed
      } else {
        out.push(null)
        i++
      }
      continue
    }
    if (!line.text.startsWith('- ')) break
    const rest = line.text.slice(2).trim()
    const inlineKey = matchKey(rest)
    if (inlineKey !== null) {
      // `- key: value` 映射项：本行首键 + 同缩进（indent+2）延续键
      const itemIndent = indent + 2
      const synthetic: Line[] = [{ indent: itemIndent, text: rest, number: line.number }]
      let j = i + 1
      while (j < lines.length && lines[j]!.indent >= itemIndent && !lines[j]!.text.startsWith('- ')) {
        synthetic.push(lines[j]!)
        j++
      }
      const [value] = parseMap(synthetic, 0, itemIndent)
      out.push(value)
      i = j
      continue
    }
    out.push(parseScalar(rest, line.number))
    i++
  }
  return [out, i]
}

function parseMap(lines: Line[], pos: number, indent: number): [unknown, number] {
  const out: Record<string, unknown> = {}
  let i = pos
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlSubsetError('unexpected indentation', line.number)
    const key = matchKey(line.text)
    if (key === null) throw new YamlSubsetError(`expected "key:" mapping, got "${line.text}"`, line.number)
    const rest = line.text.slice(key.length + 1).trim()
    if (rest !== '') {
      out[key] = parseScalar(rest, line.number)
      i++
      continue
    }
    // 值在更深的子块里
    const next = lines[i + 1]
    if (next && next.indent > indent) {
      const [value, consumed] = parseBlock(lines, i + 1, next.indent)
      out[key] = value
      i = consumed
    } else if (next && next.indent === indent && (next.text.startsWith('- ') || next.text === '-')) {
      // 同缩进数组（允许 `key:` 与 `- ` 同级）
      const [value, consumed] = parseArray(lines, i + 1, indent)
      out[key] = value
      i = consumed
    } else {
      out[key] = null
      i++
    }
  }
  return [out, i]
}

/** 行首 `key:` 或 `"quoted key":`；返回键名或 null。 */
function matchKey(text: string): string | null {
  const quoted = text.match(/^"([^"]+)"\s*:(?=\s|$)/) ?? text.match(/^'([^']+)'\s*:(?=\s|$)/)
  if (quoted) return quoted[1]!
  const plain = text.match(/^([^:\s][^:]*?)\s*:(?=\s|$)/)
  if (plain) return plain[1]!
  return null
}

function parseScalar(text: string, line: number): unknown {
  const value = text.trim()
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1)
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1)
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  if (value.startsWith('[') || value.startsWith('{') || value.startsWith('|') || value.startsWith('>')) {
    throw new YamlSubsetError(`unsupported yaml syntax: "${value}" (use JSON format for flow styles)`, line)
  }
  return value
}

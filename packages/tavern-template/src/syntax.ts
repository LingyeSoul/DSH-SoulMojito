/**
 * EJS 子集编译器（clean-room：按 https://ejs.co 公开语法规格实现，不依赖 ejs 包）。
 *
 * 支持：
 * - `<% code %>` 脚本块（多块之间共享词法作用域，支持 `<% if (a) { %>文本<% } %>` 跨块结构）；
 * - `<%= expr %>` HTML 转义输出；`<%- expr %>` 原样输出（表达式允许顶层 `await`）；
 * - `<%# comment %>` 注释块；
 * - `<%_` 吞噬标签前空白、`_%>` 吞噬标签后空白、`-%>` 吞噬标签后单个换行；
 * - `<%%` / `%%>` 字面量转义。
 *
 * 编译产物为异步函数体源码（引用外部注入的 `__append` / `__escape` 辅助）。
 */

export type TagMode = 'script' | 'escape' | 'raw' | 'comment'

export class TemplateSyntaxError extends Error {
  constructor(message: string, readonly source: string) {
    super(`template syntax error: ${message}`)
    this.name = 'TemplateSyntaxError'
  }
}

interface Tag {
  mode: TagMode
  code: string
  /** `-%>`：吞噬后续单个换行 */
  trimNewline: boolean
  /** `_%>`：吞噬后续全部空白 */
  slurpAfter: boolean
  /** `<%_`：吞噬前置全部空白 */
  slurpBefore: boolean
}

const OPEN = '<%'
const CLOSE = '%>'

/** 词法扫描：文本段与标签交替。 */
export function tokenize(source: string): Array<{ text: string } | { tag: Tag }> {
  const tokens: Array<{ text: string } | { tag: Tag }> = []
  let buf = ''
  let i = 0

  const flushText = () => {
    if (buf !== '') {
      tokens.push({ text: buf })
      buf = ''
    }
  }

  while (i < source.length) {
    // 字面量转义：<%% → 文本 <%；%%> → 文本 %>
    if (source.startsWith('<%%', i)) {
      buf += OPEN
      i += 3
      continue
    }
    if (source.startsWith('%%>', i)) {
      buf += CLOSE
      i += 3
      continue
    }
    if (!source.startsWith(OPEN, i)) {
      buf += source[i]!
      i++
      continue
    }

    flushText()
    const tag = readTag(source, i)
    if (tag.slurpBefore) {
      // 吞噬已积累文本的尾部空白（含换行）
      const last = tokens[tokens.length - 1]
      if (last && 'text' in last) last.text = last.text.replace(/\s+$/, '')
      else buf = ''
    }
    tokens.push({ tag })
    i = tag.end
    if (tag.slurpAfter) {
      while (i < source.length && /\s/.test(source[i]!)) i++
    } else if (tag.trimNewline) {
      if (source.startsWith('\r\n', i)) i += 2
      else if (source[i] === '\n') i += 1
    }
  }
  flushText()
  return tokens
}

/** 读取自 `<%` 起的完整标签。 */
function readTag(source: string, start: number): Tag & { end: number } {
  let i = start + OPEN.length
  let slurpBefore = false
  if (source[i] === '_') {
    slurpBefore = true
    i++
  }
  let mode: TagMode = 'script'
  const modeCh = source[i]
  if (modeCh === '=') {
    mode = 'escape'
    i++
  } else if (modeCh === '-') {
    mode = 'raw'
    i++
  } else if (modeCh === '#') {
    mode = 'comment'
    i++
  }

  let code = ''
  while (i < source.length) {
    if (source.startsWith('-%>', i)) {
      return { mode, code, trimNewline: true, slurpAfter: false, slurpBefore, end: i + 3 }
    }
    if (source.startsWith('_%>', i)) {
      return { mode, code, trimNewline: false, slurpAfter: true, slurpBefore, end: i + 3 }
    }
    if (source.startsWith(CLOSE, i)) {
      return { mode, code, trimNewline: false, slurpAfter: false, slurpBefore, end: i + 2 }
    }
    code += source[i]!
    i++
  }
  throw new TemplateSyntaxError(`unclosed tag starting at offset ${start} (mode=${mode})`, source)
}

/** 编译为异步函数体（调用方包裹 async 函数并提供 __append/__escape）。 */
export function compileTemplate(source: string): string {
  const tokens = tokenize(source)
  const parts: string[] = []
  for (const token of tokens) {
    if ('text' in token) {
      if (token.text !== '') parts.push(`__append(${JSON.stringify(token.text)});`)
      continue
    }
    const { mode, code } = token.tag
    if (mode === 'comment') continue
    if (mode === 'script') {
      if (code.trim() !== '') parts.push(`${code}\n`)
      continue
    }
    const expr = code.trim()
    if (expr === '') continue
    if (mode === 'escape') parts.push(`__append(__escape(String(await (${expr}))));`)
    else parts.push(`__append(await (${expr}));`)
  }
  parts.push('return __out;')
  return parts.join('\n')
}

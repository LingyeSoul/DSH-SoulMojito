/**
 * 美化前端 + 卡脚本拼接的运行时回归（2026-10-21 第二次修订）。
 *
 * 这是唯一会真正执行 client 侧拼接函数的测试：卡脚本是裸 JS，源码里大量出现
 * jQuery 的 `$`、模板字面量和 `$&`/`$'` 这类字符。如果把整段脚本作为
 * `String.prototype.replace` 的字符串替换值，`$&`、`$'`、`$1` 会被当成替换
 * 模式，脚本被改写后在 srcdoc 里抛 "Invalid or unexpected token"。这里直接
 * 从生成产物 `client/main.js` 里取出拼接函数并在 Node 里执行，锚定内容逐字
 * 保留。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')

interface CardScript {
  id?: string
  name?: string
  info?: string
  content: string
}

interface Composer {
  frontendCardScriptBlocks: (scripts: CardScript[]) => string
  frontendCardScriptHostIndex: (documents: string[]) => number
  frontendWithCardScripts: (html: string, scripts: CardScript[]) => string
}

function loadComposer(): Composer {
  const start = source.indexOf('const CARD_SCRIPTS_FONT_AWESOME =')
  const end = source.indexOf('function TavernFrontendPanel(', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const block = source.slice(start, end)
  const factory = new Function(`${block}\nreturn { frontendCardScriptBlocks, frontendCardScriptHostIndex, frontendWithCardScripts }`)
  return factory() as Composer
}

describe('frontend + card script composition', () => {
  it('runs scripts in the largest frontend document, not the first small frame', () => {
    const { frontendCardScriptHostIndex } = loadComposer()
    // 真实卡：行动栏 35,122 字节 + 状态总览 154,052 字节。脚本必须落在后者。
    expect(frontendCardScriptHostIndex(['x'.repeat(35122), 'x'.repeat(154052)])).toBe(1)
    expect(frontendCardScriptHostIndex(['small', 'large'.repeat(2)])).toBe(1)
    // 同长度取最后一个（主前端通常在后），单文档恒为 0。
    expect(frontendCardScriptHostIndex(['same', 'same'])).toBe(1)
    expect(frontendCardScriptHostIndex(['only'])).toBe(0)
  })

  it('keeps dollar replacement patterns in card script source byte-for-byte', () => {
    const { frontendWithCardScripts } = loadComposer()
    const content = "const probe = '$& $1 $$ $` $' $<name>'; window.__probe = probe;"
    const html = frontendWithCardScripts(
      '<!doctype html><html><head><title>x</title></head><body><div id="hud">HP</div></body></html>',
      [{ content }],
    )
    expect(html).toContain(content)
    expect(html).toContain('<div id="hud">HP</div>')
    expect(html).toContain('window.__dshTavernScriptScope')
    expect(html.endsWith('</script></body></html>')).toBe(true)
  })

  it('gives every shared-document script its own container scope', () => {
    const { frontendCardScriptBlocks } = loadComposer()
    const blocks = frontendCardScriptBlocks([
      { id: 'panel', name: 'GM', info: '{"x":1}', content: 'window.__ran = true' },
      { id: 'monitor', name: 'Monitor', info: '', content: 'window.__monitor = true' },
    ])
    expect(blocks).toContain('window.__dshTavernScriptScope({ scriptId: "panel", scriptName: "GM", scriptInfo: "{\\"x\\":1}" })')
    expect(blocks).toContain('window.__dshTavernScriptScope({ scriptId: "monitor", scriptName: "Monitor", scriptInfo: "" })')
    expect(blocks).toContain('const getScriptId = __dshTavernScope.getScriptId;')
    expect(blocks).toContain('const replaceScriptButtons = __dshTavernScope.replaceScriptButtons;')
    expect(blocks).toContain('window.__ran = true')
    expect(blocks).toContain('window.__monitor = true')
  })

  it('produces a syntactically valid module block with the injected scope', () => {
    const { frontendCardScriptBlocks } = loadComposer()
    const block = frontendCardScriptBlocks([
      { id: 'panel', name: 'GM', info: '', content: '(function () { window.__ran = getScriptId() === "panel" })()' },
    ])
    const code = block.slice(block.indexOf('>') + 1, block.lastIndexOf('</script>'))
    const scope = new Proxy({}, { get: () => () => 'panel' })
    const fakeWindow: Record<string, unknown> = { __dshTavernScriptScope: () => scope, __ran: false }
    // Top-level `const` bindings are module scope; Function is the closest
    // dependency-free way to catch a missing semicolon or bad identifier here.
    const factory = new Function('window', code)
    factory(fakeWindow)
    expect(fakeWindow.__ran).toBe(true)
  })

  it('keeps a script helper when the script declares the same name', () => {
    const { frontendCardScriptBlocks } = loadComposer()
    const blocks = frontendCardScriptBlocks([
      { id: 'own', name: 'Own', info: '', content: 'function getScriptId() { return "own" }\nwindow.__own = getScriptId()' },
    ])
    expect(blocks).not.toContain('const getScriptId = __dshTavernScope.getScriptId;')
    expect(blocks).toContain('const getScriptName = __dshTavernScope.getScriptName;')
    expect(blocks).toContain('function getScriptId() { return "own" }')
  })

  it('escapes closing script tags case-insensitively and leaves one wrapper tag', () => {
    const { frontendCardScriptBlocks } = loadComposer()
    const blocks = frontendCardScriptBlocks([{ content: 'const a = "</script>"; const b = "</SCRIPT>";' }])
    expect(blocks).toContain('const a = "<\\/script>"; const b = "<\\/script>";')
    expect(blocks.match(/<\/script/gi)?.length).toBe(1)
  })

  it('gives scripts a standalone canvas when the chat has no frontend document', () => {
    const { frontendWithCardScripts } = loadComposer()
    const html = frontendWithCardScripts('', [{ id: 'probe', name: 'Probe', info: '', content: 'window.__ran = true' }])
    expect(html).toContain('<div style="height:720px"></div>')
    expect(html).toContain('window.__ran = true')
    expect(html).toContain('window.__dshTavernScriptScope')
    expect(html).toContain('font-awesome')
  })

  it('adds Font Awesome once, and not at all when the card already ships it', () => {
    const { frontendWithCardScripts } = loadComposer()
    const added = frontendWithCardScripts(
      '<!doctype html><html><head><title>x</title></head><body></body></html>',
      [{ content: 'x()' }],
    )
    expect(added.match(/font-awesome/gi)?.length).toBe(1)
    const shipped = frontendWithCardScripts(
      '<html><head><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"></head><body></body></html>',
      [{ content: 'x()' }],
    )
    expect(shipped.match(/font-awesome/gi)?.length).toBe(1)
  })
})

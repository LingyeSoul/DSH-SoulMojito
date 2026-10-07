import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// fflate 是 tavern-format 的依赖（CHARX 解包同款）；它没有被提升到仓库根，插件
// 测试按相对文件路径借用（zipSync/strToU8 是纯 JS，browser 构建在 node 下可用），
// 不给插件引入新依赖。
import { strToU8, zipSync } from '../../tavern-format/node_modules/fflate/esm/browser.js'
import { apply } from '../src/index.js'
import {
  TavernStore,
  getScript,
  importScript,
  listScripts,
  parseEpubText,
} from '../../tavern-store/src/index.js'

const CHARACTER = 'Epub Scribe'

/** 最小合法 EPUB（OCF）：mimetype + container.xml + OPF（manifest/spine）+ 章节 XHTML。 */
const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const CHAPTER_ONE = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>One</title><style>p { color: red }</style></head>
<body>
<h1>Chapter One</h1>
<p>A &amp; B meet at the &lt;gate&gt; of &#x5317; and &#21335;.</p>
<p>Second &quot;paragraph&quot; with an&nbsp;odd space and &#39;quotes&#39;.</p>
</body>
</html>`

const CHAPTER_TWO = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Two</title></head>
<body>
<h2>Chapter Two</h2>
<p>The lantern procession passes.<br/>The crowd falls silent.</p>
<!-- a comment that must be dropped -->
<script>never(); appears()</script>
</body>
</html>`

function buildOpf(spine: string[]): string {
  const items = [
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="ch1" href="text/one.xhtml" media-type="application/xhtml+xml"/>',
    '<item id="ch2" href="text/two.xhtml" media-type="application/xhtml+xml"/>',
  ].join('\n')
  const itemrefs = spine.map((id) => `<itemref idref="${id}"/>`).join('\n')
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Moth Testament</dc:title></metadata>
  <manifest>${items}</manifest>
  <spine>${itemrefs}</spine>
</package>`
}

function buildEpub(spine: string[]): Uint8Array {
  return zipSync({
    // mimetype 按 OCF 约定不压缩置首；解析器不依赖该约定。
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(CONTAINER_XML),
    'OEBPS/content.opf': strToU8(buildOpf(spine)),
    'OEBPS/text/one.xhtml': strToU8(CHAPTER_ONE),
    'OEBPS/text/two.xhtml': strToU8(CHAPTER_TWO),
  })
}

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeGetRequest(url: string) {
  return { method: 'GET', url, on: () => undefined, destroy: () => {} }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

describe('Script Play EPUB import (proposal 0014 P2)', () => {
  let home: string
  let tavernRoot: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>

  const call = async (req: unknown) => {
    const res = makeResponse()
    await apiHandler(req, res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') as Record<string, any> }
  }
  const post = async (route: string, body: unknown) => call(makeRequest(body, `/api/dsh-tavern/${route}`))
  const get = async (url: string) => call(makeGetRequest(url))

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-epub-'))
    process.env.DSH_HOME = home
    tavernRoot = join(home, 'tavern')
    store = await TavernStore.open(tavernRoot)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'An epub import test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /* ---------------- 纯函数：EPUB 解析 ---------------- */

  it('extracts chapters in spine order, strips tags, and decodes entities after stripping', () => {
    const text = parseEpubText(buildEpub(['ch1', 'ch2']))
    // 章序 = spine 序：Chapter One 在 Chapter Two 之前
    const one = text.indexOf('Chapter One')
    const two = text.indexOf('Chapter Two')
    expect(one).toBeGreaterThanOrEqual(0)
    expect(two).toBeGreaterThan(one)
    // 章与章之间空行分隔
    expect(text.slice(one, two)).toContain('\n\n')

    // 剥标签：标签、head/style/script、注释、XML 声明全部消失
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('<h1>')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('never();')
    expect(text).not.toContain('a comment')
    expect(text).not.toContain('<?xml')

    // 实体在剥标签之后解码：&lt;gate&gt; 保留为字面 <gate>，不会被当标签剥掉
    expect(text).toContain('A & B meet at the <gate> of 北 and 南.') // 十六进制 &#x5317; 与十进制 &#21335;
    expect(text).toContain('Second "paragraph" with an odd space and \'quotes\'.') // &quot; &#39; &nbsp;→空格
    // <br/> 转换行：两句话都在，各自成行
    expect(text).toContain('The lantern procession passes.')
    expect(text).toContain('The crowd falls silent.')
    // h1/h2 文本保留为独立行（标题启发式裁剪：只保行，不识别章节结构）
    expect(text).toContain('\nChapter Two\n')
  })

  it('follows the spine order rather than the manifest or filename order', () => {
    const text = parseEpubText(buildEpub(['ch2', 'ch1']))
    expect(text.indexOf('Chapter Two')).toBeLessThan(text.indexOf('Chapter One'))
  })

  it('rejects non-zip bytes, corrupted zips, and broken container chains', () => {
    expect(() => parseEpubText(new TextEncoder().encode('hello epub'))).toThrow(/missing zip magic/)
    expect(() => parseEpubText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x7f, 0xff, 0x00])))
      .toThrow(/corrupted zip/)
    expect(() => parseEpubText(zipSync({ 'OEBPS/content.opf': strToU8(buildOpf(['ch1'])) })))
      .toThrow(/META-INF\/container\.xml/)
    expect(() => parseEpubText(zipSync({
      'META-INF/container.xml': strToU8('<container><rootfiles/></container>'),
    }))).toThrow(/no rootfile/)
    expect(() => parseEpubText(zipSync({
      'META-INF/container.xml': strToU8(CONTAINER_XML),
    }))).toThrow(/content\.opf.*not found/)
  })

  /* ---------------- 导入：store 直连 ---------------- */

  it('imports epub bytes as format epub and chunks the extracted text', async () => {
    const bytes = buildEpub(['ch1', 'ch2'])
    const record = await importScript(tavernRoot, 'Moth Testament', bytes)
    expect(record.source.format).toBe('epub')
    expect(record.chunks.length).toBeGreaterThanOrEqual(1)
    expect(record.chunks[0]!.text).toContain('Chapter One')
    // 章二内容在后面的块或同一块的后续段落里
    expect(record.chunks.map((chunk) => chunk.text).join('\n\n')).toContain('Chapter Two')

    // 读取/列表往返：format 'epub' 落库可回读
    const reloaded = await getScript(tavernRoot, 'Moth Testament')
    expect(reloaded!.source.format).toBe('epub')
    const mine = (await listScripts(tavernRoot)).find((summary) => summary.name === 'Moth Testament')
    expect(mine).toMatchObject({ chunkCount: record.chunks.length, format: 'epub' })

    // 空正文（spine 全是空章节）拒绝；字符串内容配 epub 拒绝；字节配非 epub 拒绝
    const emptyBody = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER_XML),
      'OEBPS/content.opf': strToU8(buildOpf(['ch1'])),
      'OEBPS/text/one.xhtml': strToU8('<html><body><p>   </p></body></html>'),
    })
    await expect(importScript(tavernRoot, 'blank-epub', emptyBody)).rejects.toThrow(/empty/)
    await expect(importScript(tavernRoot, 'mixed', 'plain text', 'epub')).rejects.toThrow(/binary content/)
    await expect(importScript(tavernRoot, 'mixed2', bytes, 'txt')).rejects.toThrow(/format 'epub'/)
  })

  /* ---------------- 路由：base64 传输 ---------------- */

  it('imports an epub through the API with base64 content and format epub', async () => {
    const base64 = Buffer.from(buildEpub(['ch1', 'ch2'])).toString('base64')
    const imported = await post('script/import', { name: 'Route EPUB', content: base64, format: 'epub' })
    expect(imported.status).toBe(200)
    expect(imported.body.ok).toBe(true)
    expect(imported.body.script.source.format).toBe('epub')
    expect(imported.body.script.chunks.length).toBeGreaterThanOrEqual(1)
    expect(imported.body.script.chunks[0].text).toContain('Chapter One')

    const listed = await get('/api/dsh-tavern/scripts')
    const mine = listed.body.scripts.find((summary: { name: string }) => summary.name === 'Route EPUB')
    expect(mine).toMatchObject({ format: 'epub' })

    // base64 解码后不是 zip → 400 TAVERN_SCRIPT；缺失内容同样 400
    const notZip = await post('script/import', { name: 'bad', content: 'not-a-zip!', format: 'epub' })
    expect(notZip.status).toBe(400)
    expect(notZip.body).toMatchObject({ ok: false, code: 'TAVERN_SCRIPT' })
    expect(notZip.body.message).toMatch(/zip magic/)
    const missing = await post('script/import', { name: 'none', format: 'epub' })
    expect(missing.status).toBe(400)
  })
})

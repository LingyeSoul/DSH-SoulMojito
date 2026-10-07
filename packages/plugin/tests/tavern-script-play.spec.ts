import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import {
  SCRIPT_ADVANCE_COVERAGE,
  TavernStore,
  boundScriptOf,
  chunkScriptText,
  formatScriptBlock,
  getScript,
  importScript,
  listScripts,
  normalizeScriptProgress,
  shouldAdvance,
} from '../../tavern-store/src/index.js'

// 角色名带空格：script 路径段必须经 decodeURIComponent 还原（与 guides 同款约定）。
const CHARACTER = 'Scribe of Moths'
const SCRIPT_NAME = 'Moth Testament'

// 每段 100 个唯一词（~13xx 字符 ≥1200 目标即自成一块），段首 marker 供注入断言。
const MARKERS = ['mothsigil', 'lanternvow', 'ashchorale'] as const
function markerParagraph(marker: string): string {
  const words = [marker]
  for (let index = 0; index < 100; index += 1) words.push(`${marker}w${index}`)
  return words.join(' ')
}
const SCRIPT_CONTENT = MARKERS.map((marker) => markerParagraph(marker)).join('\n\n')

function makeAgent(id: string) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const injections: unknown[] = []
  return {
    id,
    ctx: { id },
    injections,
    phase: { kind: 'idle', lastTurn: 0 },
    inject: (message: unknown) => { injections.push(message) },
    session: {
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        events.push(opts === undefined ? { type, data } : { type, data, opts })
      },
    },
  }
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

describe('Script Play (proposal 0014 P1)', () => {
  let home: string
  let tavernRoot: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let agents: Map<string, ReturnType<typeof makeAgent>>
  let llmRequests: Array<{ system?: string }>
  let llmReplyText: string

  const scriptUrl = (name: string) => `/api/dsh-tavern/script/${encodeURIComponent(name)}`
  const progressUrl = (character: string, chatId: string) =>
    `/api/dsh-tavern/script/progress/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`

  const call = async (req: unknown) => {
    const res = makeResponse()
    await apiHandler(req, res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') as Record<string, any> }
  }
  const post = async (route: string, body: unknown) => call(makeRequest(body, `/api/dsh-tavern/${route}`))
  const get = async (url: string) => call(makeGetRequest(url))

  const generate = async (chatId: string, message: string, sessionId: string) => {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, message, revision: snapshot!.revision, sessionId,
    }, '/api/dsh-tavern/generate'), res)
    expect(res.chunks.join('')).toContain('"type":"saved"')
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-script-'))
    process.env.DSH_HOME = home
    tavernRoot = join(home, 'tavern')
    store = await TavernStore.open(tavernRoot)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A script-play test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })

    agents = new Map()
    llmRequests = []
    llmReplyText = 'reply'
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
        stream: async function* (request: { system?: string }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: llmReplyText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: (id: string) => agents.get(id) },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /* ---------------- 分块（纯函数 + 导入拒绝） ---------------- */

  it('chunks by paragraph boundaries with a 1200 target and a 2000 hard cap', () => {
    // 段落聚合：900+2+400 仍未到目标，继续并入下一段 → 1304 ≥1200 成单块
    const merged = chunkScriptText(`${'a'.repeat(400)}\n\n${'b'.repeat(500)}\n\n${'c'.repeat(400)}`)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toHaveLength(1304)
    expect(merged[0]).toContain('\n\n')

    // 硬顶：1000+2+1000 = 2002 > 2000 → 段落边界强制分块
    const split = chunkScriptText(`${'a'.repeat(1000)}\n\n${'b'.repeat(1000)}`)
    expect(split).toEqual([`a`.repeat(1000), `b`.repeat(1000)])

    // 单段 ≥1200 即自成一块
    expect(chunkScriptText('a'.repeat(1300))).toEqual(['a'.repeat(1300)])

    // 超长段落（无句读边界可回切）硬切成 ≤2000 的块，内容无丢失
    const oversized = chunkScriptText(`head ${'a'.repeat(5000)} tail`)
    expect(oversized.length).toBeGreaterThanOrEqual(3)
    for (const chunk of oversized) expect(chunk.length).toBeLessThanOrEqual(2000)
    expect(oversized[0]).toContain('head')
    expect(oversized.at(-1)).toContain('tail')

    // 空白段落丢弃；全空白 → 空数组
    expect(chunkScriptText(`${'a'.repeat(100)}\n\n   \n\n \n \n${'b'.repeat(100)}`)).toHaveLength(1)
    expect(chunkScriptText('')).toEqual([])
    expect(chunkScriptText('  \n\n \t \n ')).toEqual([])
  })

  it('rejects empty content, blank names and unknown formats at import', async () => {
    await expect(importScript(tavernRoot, 'blank', '   \n\n  ')).rejects.toThrow(/empty/)
    await expect(importScript(tavernRoot, 'empty', '')).rejects.toThrow(/empty/)
    await expect(importScript(tavernRoot, '  ', 'text')).rejects.toThrow(/name/)
    await expect(importScript(tavernRoot, 'novel', 'text', 'pdf' as never)).rejects.toThrow(/format/)
  })

  it('imports and round-trips a script with paragraph chunks and format inference', async () => {
    const record = await importScript(tavernRoot, SCRIPT_NAME, SCRIPT_CONTENT)
    expect(record.source.format).toBe('txt')
    expect(record.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2])
    for (const chunk of record.chunks) expect(chunk.text.startsWith(MARKERS[chunk.index])).toBe(true)

    // .md 后缀缺省推断 md；显式 format 优先
    expect((await importScript(tavernRoot, 'notes.md', 'one\ntwo'))!.source.format).toBe('md')
    expect((await importScript(tavernRoot, 'plain.txt', 'one\ntwo', 'md'))!.source.format).toBe('md')

    const reloaded = await getScript(tavernRoot, SCRIPT_NAME)
    expect(reloaded!.chunks).toEqual(record.chunks)
    const summaries = await listScripts(tavernRoot)
    const mine = summaries.find((summary) => summary.name === SCRIPT_NAME)
    expect(mine).toMatchObject({ chunkCount: 3, format: 'txt' })
    expect(mine!.totalCharacters).toBe(SCRIPT_CONTENT.length - 4) // 三段去掉两个 \n\n 分隔
    expect(await getScript(tavernRoot, 'no-such-script')).toBeUndefined()
  })

  /* ---------------- 对齐推进（纯函数） ---------------- */

  it('advances on distinctive-token coverage at the 0.35 threshold', () => {
    const words = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ')
    const chunk = words('w', 20)
    // 恰好 7/20 = 0.35 → 判定对齐（阈值含等号）；6/20 = 0.3 → 不对齐
    expect(shouldAdvance(chunk, words('w', 7))).toBe(true)
    expect(shouldAdvance(chunk, words('w', 6))).toBe(false)
    expect(SCRIPT_ADVANCE_COVERAGE).toBe(0.35)
    // 完全无关 → 不对齐
    expect(shouldAdvance(chunk, 'totally unrelated answer')).toBe(false)
  })

  it('filters high-frequency chunk words and single-character tokens', () => {
    // the 出现 5 次（≥3）被视作高频非区分性词；alpha/beta 各一次是判定面
    const chunk = 'the the the the the alpha beta'
    expect(shouldAdvance(chunk, 'the the the')).toBe(false)
    expect(shouldAdvance(chunk, 'the alpha')).toBe(true)
    // 单字符词元不参与（长度 ≥2 才算）
    expect(shouldAdvance('a b c alpha', 'a b c')).toBe(false)
    expect(shouldAdvance('a b c alpha', 'alpha here')).toBe(true)
    // 全部词高频 → 无区分性词元 → 永不推进
    expect(shouldAdvance('ha ha ha', 'ha ha')).toBe(false)
    // Unicode 词元（CJK 连续段）同口径
    expect(shouldAdvance('月见山 雾灯 巷口 石阶', '月见山 雾灯')).toBe(true)
    expect(shouldAdvance('月见山 雾灯 巷口 石阶', '别的句子')).toBe(false)
  })

  /* ---------------- 注入块格式（纯函数） ---------------- */

  it('formats the injection block within the 2400 budget and marks truncation', () => {
    expect(formatScriptBlock([], 0)).toBeUndefined()
    expect(formatScriptBlock(['x'], -1)).toBeUndefined()
    expect(formatScriptBlock(['x'], 1)).toBeUndefined()

    const chunks = ['current body', 'next body']
    const block = formatScriptBlock(chunks, 0)!
    expect(block).toContain('Script reference — the novel segment near the current plot position')
    expect(block).toContain('the player may follow or deviate; this is reference, not a mandate')
    expect(block).toContain('Current segment 1/2:')
    expect(block).toContain('current body')
    expect(block).toContain('Next segment preview:')
    expect(block).toContain('next body')
    // 末块没有下一块预览段
    expect(formatScriptBlock(chunks, 1)).not.toContain('Next segment preview:')
    expect(formatScriptBlock(chunks, 1)).toContain('Current segment 2/2:')

    // 2000 字符的当前块 + 600 预览超预算 → 截断当前块尾部并标注
    const long = formatScriptBlock(['x'.repeat(2000), 'y'.repeat(1000)], 0)!
    expect(long.length).toBeLessThanOrEqual(2400)
    expect(long).toContain('[truncated]')
    // 下一块预览截到 600 字符
    expect(long).toContain('y'.repeat(600))
    expect(long).not.toContain('y'.repeat(601))
    // 预算内不标注截断
    expect(formatScriptBlock(['short', 'next'], 0)).not.toContain('[truncated]')
  })

  /* ---------------- 路由：导入 / 列表 / 读取 ---------------- */

  it('imports, lists and reads scripts through the API', async () => {
    const imported = await post('script/import', { name: 'Route Script', content: SCRIPT_CONTENT })
    expect(imported.status).toBe(200)
    expect(imported.body.script).toMatchObject({ name: 'Route Script', chunkCount: 3 })
    expect(imported.body.script.source.format).toBe('txt')
    expect(imported.body.script.chunks.map((chunk: { index: number }) => chunk.index)).toEqual([0, 1, 2])

    const listed = await get('/api/dsh-tavern/scripts')
    expect(listed.status).toBe(200)
    const route = listed.body.scripts.find((summary: { name: string }) => summary.name === 'Route Script')
    expect(route).toMatchObject({ chunkCount: 3, format: 'txt' })
    expect(listed.body.bindings).toEqual({}) // 尚无绑定

    // 名称带空格走 decodeURIComponent 还原
    const detail = await get(scriptUrl('Route Script'))
    expect(detail.status).toBe(200)
    expect(detail.body.script.name).toBe('Route Script')
    expect(detail.body.script.chunks).toHaveLength(3)

    expect((await get(scriptUrl('missing'))).status).toBe(404)
    expect((await post('script/import', { name: 'blank', content: '  \n\n ' })).status).toBe(400)
    expect((await post('script/import', {})).status).toBe(400)
    const badFormat = await post('script/import', { name: 'x', content: 'text', format: 'epub' })
    expect(badFormat.status).toBe(400)
    expect(badFormat.body).toMatchObject({ ok: false, code: 'TAVERN_SCRIPT' })
  })

  /* ---------------- 路由：绑定 / 解绑 ---------------- */

  it('binds and unbinds a script on the card with round-trip persistence', async () => {
    expect((await post('script/bind', { character: CHARACTER, scriptName: 'missing-script' })).status).toBe(404)
    expect((await post('script/bind', { character: 'Nobody', scriptName: 'Route Script' })).status).toBe(404)

    const bound = await post('script/bind', { character: CHARACTER, scriptName: 'Route Script' })
    expect(bound.status).toBe(200)
    expect(bound.body).toMatchObject({ ok: true, character: CHARACTER, scriptName: 'Route Script' })

    const card = (await store.getCharacter(CHARACTER))!.card
    expect(boundScriptOf(card)).toBe('Route Script')
    expect((card.data.extensions.agentTavern as Record<string, unknown>).scriptId).toBe('Route Script')

    const listed = await get('/api/dsh-tavern/scripts')
    expect(listed.body.bindings[CHARACTER]).toBe('Route Script')

    // 解绑：scriptId 摘除，agentTavern 变空连键一并清理
    const unbound = await post('script/unbind', { character: CHARACTER })
    expect(unbound.status).toBe(200)
    expect(unbound.body.scriptName).toBeNull()
    const fresh = (await store.getCharacter(CHARACTER))!.card
    expect(boundScriptOf(fresh)).toBeUndefined()
    expect(fresh.data.extensions.agentTavern).toBeUndefined()
    expect((await get('/api/dsh-tavern/scripts')).body.bindings).toEqual({})
    // 重复解绑幂等；未知角色 404
    expect((await post('script/unbind', { character: CHARACTER })).status).toBe(200)
    expect((await post('script/unbind', { character: 'Nobody' })).status).toBe(404)
  })

  /* ---------------- 生成链路：注入 + 对齐推进（一次至多 +1） ---------------- */

  it('injects the script block, advances at most one chunk per turn, and persists progress', async () => {
    await post('script/bind', { character: CHARACTER, scriptName: SCRIPT_NAME })
    const chunks = (await getScript(tavernRoot, SCRIPT_NAME))!.chunks.map((chunk) => chunk.text)

    const agent = makeAgent('session-script')
    agents.set(agent.id, agent)
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])

    // 第 1 轮：惰性初始化 chunkIndex=0，注入当前块全文 + 下一块预览（600 字符含段首 marker）
    llmReplyText = chunks[0]!
    await generate(chatId, 'Begin the tale', agent.id)
    let system = llmRequests.at(-1)?.system ?? ''
    expect(system).toContain('Script reference')
    expect(system).toContain('Current segment 1/3:')
    expect(system).toContain(MARKERS[0])
    expect(system).toContain(MARKERS[1]) // 下一块预览
    expect(system).not.toContain('Current segment 2/3:')
    let progress = normalizeScriptProgress((await store.getChatSnapshot(CHARACTER, chatId))!.chat.header.chat_metadata.scriptProgress)
    expect(progress).toMatchObject({ scriptName: SCRIPT_NAME, chunkIndex: 0 })

    // 第 2 轮：上一条助手楼层（= chunks[0] 全文）覆盖当前块 → 推进 0→1，注入新块
    llmReplyText = chunks.join('\n\n') // 覆盖全部三块的词元
    await generate(chatId, 'Continue', agent.id)
    system = llmRequests.at(-1)?.system ?? ''
    expect(system).toContain('Current segment 2/3:')
    expect(system).toContain(MARKERS[1])
    progress = normalizeScriptProgress((await store.getChatSnapshot(CHARACTER, chatId))!.chat.header.chat_metadata.scriptProgress)
    expect(progress).toMatchObject({ scriptName: SCRIPT_NAME, chunkIndex: 1 })

    // 第 3 轮：上一条楼层覆盖一切 → 一次至多 +1（停在 2，不跳块）
    await generate(chatId, 'Continue', agent.id)
    system = llmRequests.at(-1)?.system ?? ''
    expect(system).toContain('Current segment 3/3:')
    expect(system).not.toContain('Next segment preview:')
    progress = normalizeScriptProgress((await store.getChatSnapshot(CHARACTER, chatId))!.chat.header.chat_metadata.scriptProgress)
    expect(progress).toMatchObject({ scriptName: SCRIPT_NAME, chunkIndex: 2 })

    // 第 4 轮：末块即使被完全覆盖也不再推进
    await generate(chatId, 'Continue', agent.id)
    progress = normalizeScriptProgress((await store.getChatSnapshot(CHARACTER, chatId))!.chat.header.chat_metadata.scriptProgress)
    expect(progress!.chunkIndex).toBe(2)

    // 低覆盖回复不推进：新聊天，回复与块 0 词元零重叠 → 始终停在 0
    const stallChat = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    llmReplyText = 'the hero wandered elsewhere entirely'
    await generate(stallChat, 'Begin', agent.id)
    await generate(stallChat, 'Continue', agent.id)
    progress = normalizeScriptProgress((await store.getChatSnapshot(CHARACTER, stallChat))!.chat.header.chat_metadata.scriptProgress)
    expect(progress).toMatchObject({ scriptName: SCRIPT_NAME, chunkIndex: 0 })

    // 解绑后不再注入
    await post('script/unbind', { character: CHARACTER })
    await generate(chatId, 'Continue', agent.id)
    expect(llmRequests.at(-1)?.system ?? '').not.toContain('Script reference')
  })

  /* ---------------- 路由：进度 ---------------- */

  it('reports progress with bounded previews through the progress route', async () => {
    await post('script/bind', { character: CHARACTER, scriptName: SCRIPT_NAME })
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])

    // 尚未注入：进度未初始化，报告回落 chunkIndex 0
    const early = await get(progressUrl(CHARACTER, chatId))
    expect(early.status).toBe(200)
    expect(early.body).toMatchObject({ scriptName: SCRIPT_NAME, chunkIndex: 0, chunkCount: 3, alignedAt: null })
    expect(early.body.currentPreview.length).toBeLessThanOrEqual(400)
    expect(early.body.currentPreview).toContain(MARKERS[0])
    expect(early.body.nextPreview.length).toBeLessThanOrEqual(400)
    expect(early.body.nextPreview).toContain(MARKERS[1])

    // 生成一轮后进度落库（脚本块当前是 system 段头部，见上一用例）
    const agent = agents.get('session-script')!
    llmReplyText = 'plain reply'
    await generate(chatId, 'Hello', agent.id)
    const after = await get(progressUrl(CHARACTER, chatId))
    expect(after.body).toMatchObject({ scriptName: SCRIPT_NAME, chunkIndex: 0, chunkCount: 3 })
    expect(after.body.alignedAt).toEqual(expect.any(String))

    expect((await get(progressUrl(CHARACTER, 'missing.jsonl'))).status).toBe(404)
    expect((await get(progressUrl('Nobody', chatId))).status).toBe(404)

    // 未绑定角色 → 404
    await post('script/unbind', { character: CHARACTER })
    expect((await get(progressUrl(CHARACTER, chatId))).status).toBe(404)
  })
})

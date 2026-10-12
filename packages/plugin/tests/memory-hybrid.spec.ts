/**
 * B-2 混合记忆检索（提案 0016）——零网络测试面。
 *
 * 覆盖：embed 客户端（批量/重试/超时/维度校验/免密头/熔断 60s/探针）、
 * RRF 融合与 cosine（纯函数）、memory_search 全链路（混合排序/golden 降级/
 * 回填上限/查询 memoize）、写入路径（成功嵌/失败不阻塞/update 重嵌/forget 清理）。
 *
 * golden 纪律：无配置/熔断/查询嵌入失败/全部 stale 时，工具输出必须与 B-2 之前的
 * 词法组合（逐 scope search + 合并排序 + 截断）逐字节等价——用本文件内复刻的
 * 旧组合函数锚定，任何行为漂移即红。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { MemoryStore, MemoryVectorStore, TavernStore, memoryContentDigest, normalizeMemoryEmbedding } from '../../tavern-store/src/index.js'
import {
  EMBED_BREAKER_MS,
  EMBED_PROBE_TEXT,
  clearEmbedStatus,
  embedBreakerOpen,
  embedProbe,
  embedTexts,
  readEmbedStatus,
  recordEmbedFailure,
  recordEmbedSuccess,
  resolveApiKey,
  type EmbedRuntimeStatus,
} from '../src/memory-embed.js'
import { cosineSimilarity, rrfFuse } from '../../tavern-store/src/index.js'
import { hybridMemorySearch } from '../src/memory-hybrid.js'
import { localModelIdentity, resetLocalEmbedSessionCache, type LocalEmbedRuntime } from '../src/memory-embed-local.js'

const CHARACTER = 'Hybrid Memory Tester'
const CONFIG = {
  baseURL: 'http://embed.test/v1',
  apiKeyEnv: 'TEST_EMBED_KEY',
  model: 'test-embed',
  dims: 4,
  batchSize: 16,
  timeoutMs: 400,
} as const

/* ------------------------------ fetch 桩 ------------------------------ */

type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response
let calls: Array<{ url: string; init: RequestInit; input: string[] }> = []
let handler: FetchHandler = () => jsonResponse(embedBody([[0, 0, 0, 0]]))

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function embedBody(vectors: number[][]): unknown {
  return { data: vectors.map((vector, index) => ({ index, embedding: vector })) }
}

/** 确定性兜底向量：sha256(text) 前 4 字节映射到 [-1,1)。 */
function hashVector(text: string): number[] {
  const digest = createHash('sha256').update(text).digest()
  return Array.from({ length: 4 }, (_, index) => digest[index % digest.length]! / 127.5 - 1)
}

function installFetch(next: FetchHandler): void {
  handler = next
  calls = []
}

beforeEach(() => {
  vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => {
    const requestInit = (init ?? {}) as RequestInit
    const input = JSON.parse(String(requestInit.body ?? '{}')) as { input?: string[] }
    calls.push({ url: String(url), init: requestInit, input: Array.isArray(input.input) ? input.input : [] })
    return Promise.resolve(handler(String(url), requestInit))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* --------------------------- 客户端单元（独立 root） --------------------------- */

describe('embed 客户端（mock fetch，提案 0016 §客户端纪律）', () => {
  const clientRoot = mkdtempSync(join(tmpdir(), 'memory-embed-client-'))
  afterAll(() => rmSync(clientRoot, { recursive: true, force: true }))

  it('按 batchSize 分批顺序请求，携带 Bearer 头与 model', async () => {
    process.env.TEST_EMBED_KEY = 'secret-key'
    installFetch((_url, init) => {
      const input = JSON.parse(String(init.body ?? '{}')) as { input: string[] }
      return jsonResponse(embedBody(input.input.map((text) => hashVector(text))))
    })
    const vectors = await embedTexts({ ...CONFIG, batchSize: 2 }, ['a', 'b', 'c', 'd', 'e'])
    expect(vectors).toHaveLength(5)
    expect(calls.map((call) => call.input.length)).toEqual([2, 2, 1])
    expect(calls[0]!.url).toBe('http://embed.test/v1/embeddings')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer secret-key')
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('test-embed')
  })

  it('免密反代：apiKeyEnv 空串 / env 未设 / env 值为空 ⇒ 不发送 Authorization 头', async () => {
    installFetch(() => jsonResponse(embedBody([[0, 0, 0, 0]])))
    await embedTexts({ ...CONFIG, apiKeyEnv: '' }, ['t'])
    await embedTexts({ ...CONFIG, apiKeyEnv: 'TEST_EMBED_UNSET' }, ['t'])
    process.env.TEST_EMBED_BLANK = ''
    try {
      await embedTexts({ ...CONFIG, apiKeyEnv: 'TEST_EMBED_BLANK' }, ['t'])
    } finally {
      delete process.env.TEST_EMBED_BLANK
    }
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).authorization).toBeUndefined()
    }
    expect(resolveApiKey({ ...CONFIG, apiKeyEnv: 'TEST_EMBED_KEY' })).toBe('secret-key')
    expect(resolveApiKey({ ...CONFIG, apiKeyEnv: '' })).toBeUndefined()
  })

  it('429/5xx 重试一次后成功；4xx 不重试直接失败', async () => {
    let attempt = 0
    installFetch(() => {
      attempt += 1
      return attempt === 1 ? jsonResponse({ error: 'busy' }, 500) : jsonResponse(embedBody([[1, 0, 0, 0]]))
    })
    await embedTexts(CONFIG, ['retry-me'])
    expect(calls).toHaveLength(2)

    attempt = 0
    installFetch(() => {
      attempt += 1
      return jsonResponse({ error: 'rate' }, 429)
    })
    try {
      await embedTexts(CONFIG, ['retry-me-2'])
      expect.unreachable('429 should fail after retry')
    } catch (cause) {
      expect((cause as Error).message).toContain('429')
    }
    expect(calls).toHaveLength(2)

    installFetch(() => jsonResponse({ error: 'bad request' }, 400))
    await expect(embedTexts(CONFIG, ['no-retry'])).rejects.toThrow('400')
    expect(calls).toHaveLength(1)
  })

  it('超时：timeoutMs 内未响应即中断（含一次重试共两次尝试）', async () => {
    // 桩模拟真实 fetch 的 abort 语义：signal 中断即 reject。
    installFetch((_url, init) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(embedBody([[0, 0, 0, 0]]))), 500)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('This operation was aborted', 'AbortError'))
      })
    }))
    await expect(embedTexts({ ...CONFIG, timeoutMs: 60 }, ['slow']))
      .rejects.toThrow('timed out after 60ms')
    expect(calls).toHaveLength(2)
  })

  it('维度校验：与 expectedDims 不一致 / 批内不一致 ⇒ 报错', async () => {
    installFetch(() => jsonResponse(embedBody([[1, 2, 3]])))
    await expect(embedTexts(CONFIG, ['wrong-dims'], { expectedDims: 4 })).rejects.toThrow('expected 4')
    installFetch(() => jsonResponse(embedBody([[1, 2, 3, 4], [1, 2]])))
    await expect(embedTexts(CONFIG, ['mixed', 'batch'], { expectedDims: 4 })).rejects.toThrow('inconsistent')
  })

  it('熔断 60s：失败开窗、成功复位；lastError 保留为诊断历史', async () => {
    await recordEmbedFailure(clientRoot, 'endpoint exploded')
    const opened: EmbedRuntimeStatus = await readEmbedStatus(clientRoot)
    expect(opened.lastError).toBe('endpoint exploded')
    expect(opened.breakerUntil).toBeGreaterThan(Date.now())
    expect(opened.breakerUntil - Date.now()).toBeLessThanOrEqual(EMBED_BREAKER_MS)
    expect(embedBreakerOpen(opened)).toBe(true)
    await recordEmbedSuccess(clientRoot, { model: 'm', dims: 4 })
    const closed = await readEmbedStatus(clientRoot)
    expect(embedBreakerOpen(closed)).toBe(false)
    expect(closed.breakerUntil).toBe(0)
    expect(closed.lastError).toBe('endpoint exploded')
    expect(closed.dims).toBe(4)
  })

  it('探针：固定串嵌入返回 dims/latency/model 并复位熔断；失败落 lastError', async () => {
    await recordEmbedFailure(clientRoot, 'previous failure')
    installFetch(() => jsonResponse(embedBody([[0.1, 0.2, 0.3, 0.4]])))
    const result = await embedProbe(clientRoot, CONFIG)
    expect(result.model).toBe('test-embed')
    expect(result.dims).toBe(4)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(calls[0]!.input).toEqual([EMBED_PROBE_TEXT])
    expect(embedBreakerOpen(await readEmbedStatus(clientRoot))).toBe(false)

    installFetch(() => jsonResponse({ error: 'nope' }, 400))
    await expect(embedProbe(clientRoot, CONFIG)).rejects.toThrow('400')
    expect((await readEmbedStatus(clientRoot)).lastError).toContain('400')
  })
})

/* ------------------------------ 纯函数融合 ------------------------------ */

describe('RRF 融合与 cosine（纯函数）', () => {
  it('双通道等权 k=60：名次并列时按 rank 求和，单通道记录取该通道贡献', () => {
    const scores = rrfFuse(['a', 'b', 'c'], ['c', 'a'])
    expect(scores.get('a')).toBeCloseTo(1 / 61 + 1 / 62, 10)
    expect(scores.get('c')).toBeCloseTo(1 / 63 + 1 / 61, 10)
    expect(scores.get('b')).toBeCloseTo(1 / 62, 10)
    expect(scores.has('d')).toBe(false)
  })

  it('cosine：同向 1、正交 0、零向量 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 10)
  })
})

/* --------------------------- 工具面全链路 --------------------------- */

const QUERY = 'oath storm candle'
const L_CONTENT = 'The oath was sworn by candle during the storm.'
const M_CONTENT = 'The storm kept the harbor awake.'
const S_CONTENT = 'A vow made beneath thunder and rain, sealed by both families.'
const VECTOR_BY_TEXT = new Map<string, number[]>([
  [QUERY, [1, 0, 0, 0]],
  [L_CONTENT, [0.6, 0.8, 0, 0]],
  [M_CONTENT, [0, 1, 0, 0]],
  [S_CONTENT, [1, 0, 0, 0]],
])

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

describe('memory_search 混合检索（提案 0016 全链路）', () => {
  let home: string
  let root: string
  let store: TavernStore
  let chatId: string
  let tools: Map<string, RegisteredTool>
  const exec = { agent: { id: 'native' } }

  /** B-2 之前的词法组合（golden 锚）：与旧 agent.ts 逐字节同构。 */
  async function goldenSearch(query: string, limit = 10, maxTokens = 1200) {
    const memStore = await MemoryStore.open(root)
    const scopes: Array<{ scope: 'chat' | 'character' | 'agent' | 'global'; scopeId: string }> = [
      { scope: 'chat', scopeId: chatId },
      { scope: 'character', scopeId: CHARACTER },
      { scope: 'agent', scopeId: 'native' },
      { scope: 'global', scopeId: 'global' },
    ]
    const hits = (await Promise.all(scopes.map(({ scope, scopeId }) => memStore.search({ query, scope, scopeId, limit, maxTokens }))))
      .flat()
      .sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id))
      .slice(0, limit)
    return {
      hits: hits.map((hit) => ({
        id: hit.record.id,
        scope: hit.record.scope,
        content: hit.record.content,
        tags: hit.record.tags,
        score: Number(hit.score.toFixed(4)),
        revision: hit.record.revision,
        source: hit.record.source,
        truncated: hit.truncated,
      })),
      sourceCount: hits.length,
      truncated: hits.some((hit) => hit.truncated),
    }
  }

  async function enableEmbedding(overrides: Record<string, unknown> = {}): Promise<void> {
    await store.updateState(() => ({ memoryEmbedding: { ...CONFIG, ...overrides } }))
  }

  async function disableEmbedding(): Promise<void> {
    await store.updateState(() => ({ memoryEmbedding: undefined }))
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'memory-hybrid-'))
    process.env.DSH_HOME = home
    process.env.TEST_EMBED_KEY = 'secret-key'
    root = join(home, 'tavern')
    store = await TavernStore.open(root)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: 'Hybrid retrieval test character.',
        personality: 'Stable',
        scenario: 'A quiet harbor town.',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString() },
    })
    await store.updateState(() => ({
      sessionBindings: {
        native: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))
    tools = new Map()
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    delete process.env.TEST_EMBED_KEY
    rmSync(home, { recursive: true, force: true })
  })

  it('golden：无配置时工具输出与旧词法组合逐字节等价', async () => {
    // 语料：L 词法 3/3、M 1/3、S 0/3（freshness 差异远小于词法分差）。
    await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: L_CONTENT, importance: 0.2 }, exec)
    await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: M_CONTENT }, exec)
    await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: S_CONTENT }, exec)
    await disableEmbedding()
    const result = await tools.get('memory_search')!.execute({ query: QUERY, scope: 'chat' }, exec)
    const golden = await goldenSearch(QUERY)
    expect(result).toEqual(golden)
    // 词法基线序：L > M > S。
    expect(result.hits.map((hit: { content: string }) => hit.content)).toEqual([L_CONTENT, M_CONTENT, S_CONTENT])
  })

  it('混合：dense 通道把语义近邻（词法 0 命中）抬到第 2 位，score 字段仍是词法分', async () => {
    await clearEmbedStatus(root)
    await enableEmbedding()
    installFetch((url, init) => {
      const input = JSON.parse(String(init.body ?? '{}')) as { input: string[] }
      return jsonResponse(embedBody(input.input.map((text) => VECTOR_BY_TEXT.get(text) ?? hashVector(text))))
    })
    const result = await tools.get('memory_search')!.execute({ query: QUERY, scope: 'chat' }, exec)
    // 融合序 [L(词法1,dense2), S(词法3,dense1), M(词法2,dense3)]。
    expect(result.hits.map((hit: { content: string }) => hit.content)).toEqual([L_CONTENT, S_CONTENT, M_CONTENT])
    // score 语义不变：L 的分数与 golden 词法分一致。
    const golden = await goldenSearch(QUERY)
    expect(result.hits[0].score).toBe(golden.hits[0].score)
    // 懒回填已把三条向量落盘（digest = SHA-256([model, content])）。
    const vectors = await MemoryVectorStore.open(root)
    const entries = await vectors.list('chat', chatId)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map((entry) => entry.digest))).toEqual(new Set([
      memoryContentDigest('test-embed', L_CONTENT),
      memoryContentDigest('test-embed', M_CONTENT),
      memoryContentDigest('test-embed', S_CONTENT),
    ]))
  })

  it('查询 memoize：同查询串第二次检索零 embed 请求（含回填）', async () => {
    installFetch(() => jsonResponse(embedBody([[0, 0, 0, 0]])))
    const result = await tools.get('memory_search')!.execute({ query: QUERY, scope: 'chat' }, exec)
    expect(result.sourceCount).toBe(3)
    expect(calls).toHaveLength(0)
  })

  it('查询嵌入失败：熔断开窗 + 输出逐字节回落词法（golden）', async () => {
    await clearEmbedStatus(root)
    installFetch(() => jsonResponse({ error: 'down' }, 503))
    const result = await tools.get('memory_search')!.execute({ query: 'network outage probe', scope: 'chat' }, exec)
    expect(result).toEqual(await goldenSearch('network outage probe'))
    const status = await readEmbedStatus(root)
    expect(embedBreakerOpen(status)).toBe(true)
    expect(status.lastError).toContain('503')
    // 熔断窗口内后续检索保持纯词法（即使端点恢复）。
    installFetch(() => jsonResponse(embedBody([[1, 0, 0, 0]])))
    const stillGolden = await tools.get('memory_search')!.execute({ query: QUERY, scope: 'chat' }, exec)
    expect(stillGolden).toEqual(await goldenSearch(QUERY))
    await clearEmbedStatus(root)
  })

  it('全部 stale（模型变更且回填失败）：逐字节回落词法（golden）', async () => {
    await enableEmbedding({ model: 'test-embed-v2' })
    // 查询串本身嵌入成功，记录回填批量失败 ⇒ fresh 空 ⇒ undefined ⇒ golden。
    installFetch((url, init) => {
      const input = JSON.parse(String(init.body ?? '{}')) as { input: string[] }
      if (input.input[0] === 'stale model query') return jsonResponse(embedBody([[1, 0, 0, 0]]))
      return jsonResponse({ error: 'model gone' }, 500)
    })
    const result = await tools.get('memory_search')!.execute({ query: 'stale model query', scope: 'chat' }, exec)
    expect(result).toEqual(await goldenSearch('stale model query'))
    await clearEmbedStatus(root)
  })

  it('写路径：memory_write 成功后向量同步落盘；失败不阻塞返回且进 lastError', async () => {
    await enableEmbedding()
    await clearEmbedStatus(root)
    installFetch(() => jsonResponse(embedBody([[0.9, 0.1, 0, 0]])))
    const written = await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: '静海灯塔每晚亮到天明。' }, exec)
    expect(written.id).toBeTruthy()
    const vectors = await MemoryVectorStore.open(root)
    expect(await vectors.get(written.id, 'chat', chatId)).toMatchObject({
      digest: memoryContentDigest('test-embed', '静海灯塔每晚亮到天明。'),
      model: 'test-embed',
    })

    // 嵌入失败：工具照常返回、lastError 落账、向量缺位（后续懒补）。
    await clearEmbedStatus(root)
    installFetch(() => jsonResponse({ error: 'boom' }, 500))
    const failed = await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: 'Failure must not block the write.' }, exec)
    expect(failed.id).toBeTruthy()
    const status = await readEmbedStatus(root)
    expect(embedBreakerOpen(status)).toBe(true)
    expect(status.lastError).toContain('500')
    expect(await (await MemoryVectorStore.open(root)).get(failed.id, 'chat', chatId)).toBeUndefined()
    await clearEmbedStatus(root)
  })

  it('写路径：memory_update 内容变更后按新 digest 重嵌；memory_forget 清理向量', async () => {
    await clearEmbedStatus(root)
    installFetch(() => jsonResponse(embedBody([[0.5, 0.5, 0, 0]])))
    const created = await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: 'Revision target v1.' }, exec)
    const updated = await tools.get('memory_update')!.execute({
      id: created.id, scope: 'chat', expectedRevision: created.revision, content: 'Revision target v2 rewritten.',
    }, exec)
    const vectors = await MemoryVectorStore.open(root)
    expect(await vectors.get(updated.id, 'chat', chatId)).toMatchObject({
      digest: memoryContentDigest('test-embed', 'Revision target v2 rewritten.'),
    })
    await tools.get('memory_forget')!.execute({ id: updated.id, scope: 'chat', expectedRevision: updated.revision }, exec)
    expect(await (await MemoryVectorStore.open(root)).get(updated.id, 'chat', chatId)).toBeUndefined()
  })

  it('懒回填上限：单次检索最多回填 32 条（防首搜卡死）', async () => {
    // 关配置批量写入 40 条（纯词法路径，零 embed），再开启检索触发回填。
    await disableEmbedding()
    for (let index = 0; index < 40; index += 1) {
      await tools.get('memory_write')!.execute({ scope: 'chat', kind: 'semantic', content: `Backfill corpus entry ${index} about the harbor ledger.` }, exec)
    }
    await clearEmbedStatus(root)
    await enableEmbedding()
    installFetch((url, init) => {
      const input = JSON.parse(String(init.body ?? '{}')) as { input: string[] }
      return jsonResponse(embedBody(input.input.map((text) => VECTOR_BY_TEXT.get(text) ?? hashVector(text))))
    })
    const result = await tools.get('memory_search')!.execute({ query: 'backfill harbor ledger cap', scope: 'chat', limit: 5 }, exec)
    expect(result.sourceCount).toBeGreaterThan(0)
    // 非查询输入（回填文本）总数 = 32；其余 8 条下次检索再补。
    const backfillTexts = calls.flatMap((call) => call.input).filter((text) => text !== 'backfill harbor ledger cap')
    expect(backfillTexts).toHaveLength(32)
    const fresh = (await (await MemoryVectorStore.open(root)).list('chat', chatId))
      .filter((entry) => entry.model === 'test-embed')
    expect(fresh.length).toBe(32 + 4) // 40 新记录回填 32 + 前序 4 条（L/M/S + 静海灯塔）
  })
})

/* ---------------- 本地 ONNX provider（提案 0017）：身份锚 + 回填收敛 ---------------- */

describe('hybridMemorySearch 本地 provider（零网络，假运行时注入）', () => {
  let localRoot: string
  let localModelDir: string

  beforeEach(() => {
    localRoot = mkdtempSync(join(tmpdir(), 'hybrid-local-'))
    localModelDir = join(localRoot, 'model', 'bge-small-zh-v1.5')
    mkdirSync(join(localModelDir, 'onnx'), { recursive: true })
    writeFileSync(join(localModelDir, 'tokenizer.json'), '{}')
    writeFileSync(join(localModelDir, 'onnx', 'model_quantized.onnx'), 'weights-v1')
    resetLocalEmbedSessionCache()
  })

  afterEach(() => {
    rmSync(localRoot, { recursive: true, force: true })
    resetLocalEmbedSessionCache()
  })

  /** 假运行时：query 与含「alpha」的记录同向（dense 命中），其余固定旁向。 */
  function fakeRuntime(): { runtime: LocalEmbedRuntime; embeds: string[] } {
    const embeds: string[] = []
    return {
      embeds,
      runtime: {
        load: async () => ({
          embed: async (texts) => {
            embeds.push(...texts)
            return texts.map((text) => (text.includes('alpha') ? [1, 0, 0, 0] : [0, 1, 0, 0]))
          },
        }),
      },
    }
  }

  async function seedMemories(store: MemoryStore): Promise<void> {
    for (const [content, id] of [
      ['alpha raid cleared the debt', 'm-alpha'],
      ['beta baked bread at dawn', 'm-beta'],
    ] as const) {
      await store.put({
        id, scope: 'chat', scopeId: 'chat-1', kind: 'semantic', content,
        tags: [], importance: 0.8, confidence: 0.9, source: { kind: 'test' },
      })
    }
  }

  it('本地身份锚：向量以 local-onnx:<basename>@<指纹> 落库，检索走融合', async () => {
    const store = await MemoryStore.open(localRoot)
    const vectors = await MemoryVectorStore.open(localRoot)
    await seedMemories(store)
    const config = normalizeMemoryEmbedding({ provider: 'local', modelDir: localModelDir, dims: 4 })!
    const { runtime, embeds } = fakeRuntime()

    const hits = await hybridMemorySearch({
      root: localRoot, config, store, vectorStore: vectors,
      query: 'alpha', scopes: [{ scope: 'chat', scopeId: 'chat-1' }], limit: 5, maxTokens: 500,
      localRuntime: runtime,
    })

    expect(hits).toBeDefined()
    expect(hits![0]!.record.id).toBe('m-alpha')
    const identity = localModelIdentity({ modelDir: localModelDir })
    const entries = await vectors.list('chat', 'chat-1')
    expect(entries.map((entry) => entry.model)).toEqual([identity, identity])
    expect(entries.map((entry) => entry.digest))
      .toEqual(entries.map((entry) => memoryContentDigest(identity, entry.id === 'm-alpha' ? 'alpha raid cleared the debt' : 'beta baked bread at dawn')))
    // 回填发生：两条记录内容都过了假运行时
    expect(embeds.filter((text) => text.includes('alpha raid'))).toHaveLength(1)
  })

  it('换权重文件 ⇒ 指纹变化 ⇒ 旧向量 stale ⇒ 懒回填收敛到新身份', async () => {
    const store = await MemoryStore.open(localRoot)
    const vectors = await MemoryVectorStore.open(localRoot)
    await seedMemories(store)
    const config = normalizeMemoryEmbedding({ provider: 'local', modelDir: localModelDir, dims: 4 })!
    const { runtime } = fakeRuntime()

    await hybridMemorySearch({
      root: localRoot, config, store, vectorStore: vectors,
      query: 'alpha', scopes: [{ scope: 'chat', scopeId: 'chat-1' }], limit: 5, maxTokens: 500,
      localRuntime: runtime,
    })
    const firstIdentity = localModelIdentity({ modelDir: localModelDir })

    // 替换权重（目录指纹变化 ⇒ 身份变化 ⇒ 已存向量全 stale）
    writeFileSync(join(localModelDir, 'onnx', 'model_quantized.onnx'), 'weights-v2-replaced')
    const hits = await hybridMemorySearch({
      root: localRoot, config, store, vectorStore: vectors,
      query: 'alpha', scopes: [{ scope: 'chat', scopeId: 'chat-1' }], limit: 5, maxTokens: 500,
      localRuntime: runtime,
    })

    expect(hits).toBeDefined()
    const secondIdentity = localModelIdentity({ modelDir: localModelDir })
    expect(secondIdentity).not.toBe(firstIdentity)
    const entries = await vectors.list('chat', 'chat-1')
    expect(entries.map((entry) => entry.model)).toEqual([secondIdentity, secondIdentity])
  })

  it('本地运行失败 ⇒ 熔断开窗，后续检索逐字节回落纯词法（golden 纪律）', async () => {
    const store = await MemoryStore.open(localRoot)
    const vectors = await MemoryVectorStore.open(localRoot)
    await seedMemories(store)
    const config = normalizeMemoryEmbedding({ provider: 'local', modelDir: localModelDir, dims: 4 })!
    const broken: LocalEmbedRuntime = {
      load: async () => { throw new Error('model load exploded') },
    }

    const first = await hybridMemorySearch({
      root: localRoot, config, store, vectorStore: vectors,
      query: 'alpha', scopes: [{ scope: 'chat', scopeId: 'chat-1' }], limit: 5, maxTokens: 500,
      localRuntime: broken,
    })
    expect(first).toBeUndefined()
    const status = await readEmbedStatus(localRoot)
    expect(embedBreakerOpen(status)).toBe(true)
    expect(status.lastError).toContain('model load exploded')

    // 熔断窗内：不再尝试嵌入，直接词法回落
    const second = await hybridMemorySearch({
      root: localRoot, config, store, vectorStore: vectors,
      query: 'alpha', scopes: [{ scope: 'chat', scopeId: 'chat-1' }], limit: 5, maxTokens: 500,
      localRuntime: broken,
    })
    expect(second).toBeUndefined()
  })
})

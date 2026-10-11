import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MemoryVectorStore,
  decodeVector,
  encodeVector,
  memoryContentDigest,
  normalizeMemoryEmbedding,
} from '../src/index.js'

describe('memory-vectors：编码与摘要（提案 0016）', () => {
  it('encode/decode float32 LE base64 往返', () => {
    const values = [0.25, -1.5, 3, 0, 1e-7]
    const decoded = decodeVector(encodeVector(values))
    expect(decoded).toHaveLength(values.length)
    for (let index = 0; index < values.length; index += 1) {
      expect(decoded[index]).toBeCloseTo(values[index]!, 6)
    }
  })

  it('digest = SHA-256(JSON.stringify([model, content]))：content 或 model 变更即失效', () => {
    const base = memoryContentDigest('m1', '正文')
    expect(base).toHaveLength(64)
    expect(memoryContentDigest('m1', '正文')).toBe(base)
    expect(memoryContentDigest('m1', '正文改')).not.toBe(base)
    expect(memoryContentDigest('m2', '正文')).not.toBe(base)
  })
})

describe('memory-vectors：MemoryVectorStore CRUD（提案 0016）', () => {
  let dir: string
  let store: MemoryVectorStore

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'memory-vectors-'))
    store = await MemoryVectorStore.open(dir)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('put/get/list/delete 往返，scope 隔离', async () => {
    await store.put([
      { id: 'a', scope: 'chat', scopeId: 'chat-1', digest: 'd1', model: 'm', vector: encodeVector([1, 2]) },
      { id: 'b', scope: 'global', scopeId: 'global', digest: 'd2', model: 'm', vector: encodeVector([3, 4]) },
    ])
    expect(await store.get('a', 'chat', 'chat-1')).toEqual({ id: 'a', scope: 'chat', scopeId: 'chat-1', digest: 'd1', model: 'm', vector: encodeVector([1, 2]) })
    expect(await store.get('a', 'global', 'global')).toBeUndefined()
    expect((await store.list('chat', 'chat-1')).map((entry) => entry.id)).toEqual(['a'])
    expect((await store.list()).length).toBe(2)
    await store.delete('a', 'chat', 'chat-1')
    expect(await store.get('a', 'chat', 'chat-1')).toBeUndefined()
    expect((await store.list()).length).toBe(1)
  })

  it('同 id 重写覆盖（向量随内容更新而替换）', async () => {
    await store.put([{ id: 'c', scope: 'chat', scopeId: 'chat-1', digest: 'old', model: 'm', vector: encodeVector([9]) }])
    await store.put([{ id: 'c', scope: 'chat', scopeId: 'chat-1', digest: 'new', model: 'm2', vector: encodeVector([1]) }])
    const entry = await store.get('c', 'chat', 'chat-1')
    expect(entry).toMatchObject({ digest: 'new', model: 'm2' })
    expect(decodeVector(entry!.vector)).toEqual([1])
  })

  it('原子写：落盘文件是合法 JSON 且带换行结尾（tmp+rename 纪律）', async () => {
    await store.put([{ id: 'd', scope: 'agent', scopeId: 'agent-1', digest: 'x', model: 'm', vector: encodeVector([0]) }])
    const raw = readFileSync(join(dir, 'memory-vectors', 'agent', 'agent-1.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('损坏文件按空缓存处理，不抛错（可重建缓存语义）', async () => {
    mkdirSync(join(dir, 'memory-vectors', 'chat'), { recursive: true })
    writeFileSync(join(dir, 'memory-vectors', 'chat', 'chat-9.json'), '{broken')
    const store2 = await MemoryVectorStore.open(dir)
    expect(await store2.list('chat', 'chat-9')).toEqual([])
  })
})

describe('normalizeMemoryEmbedding：设置读取容错（提案 0016）', () => {
  const valid = { baseURL: 'https://e.test/v1/', apiKeyEnv: 'K', model: 'm' }

  it('合法配置：去尾斜杠、数值夹取', () => {
    expect(normalizeMemoryEmbedding({ ...valid, dims: 4, batchSize: 999, timeoutMs: 50 })).toEqual({
      baseURL: 'https://e.test/v1',
      apiKeyEnv: 'K',
      model: 'm',
      dims: 4,
      batchSize: 64,
      timeoutMs: 200,
    })
  })

  it('apiKeyEnv 空串 = 免密合法；非法 env 名整体作废', () => {
    expect(normalizeMemoryEmbedding({ ...valid, apiKeyEnv: '' })?.apiKeyEnv).toBe('')
    expect(normalizeMemoryEmbedding({ ...valid, apiKeyEnv: '9BAD' })).toBeUndefined()
    expect(normalizeMemoryEmbedding({ ...valid, apiKeyEnv: 'A-B' })).toBeUndefined()
  })

  it('缺三件套 / 非 http(s) / 非对象 ⇒ undefined', () => {
    expect(normalizeMemoryEmbedding(undefined)).toBeUndefined()
    expect(normalizeMemoryEmbedding(null)).toBeUndefined()
    expect(normalizeMemoryEmbedding({ apiKeyEnv: 'K', model: 'm' })).toBeUndefined()
    expect(normalizeMemoryEmbedding({ baseURL: 'ftp://e.test', apiKeyEnv: 'K', model: 'm' })).toBeUndefined()
  })
})

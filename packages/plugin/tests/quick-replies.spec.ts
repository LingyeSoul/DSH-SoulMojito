/**
 * Quick Replies（施工契约 2026-11-12 §2.6）：状态切片读取口径、全量替换
 * 写接口与 composer 的 `/qr <name>` 解析。夹具全部合成，不引用真实卡/聊天。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TavernStore, type TavernState } from '../../tavern-store/src/index.js'
import { HttpError } from '../src/http/errors.js'
import { handleQuickRepliesRoute, parseQuickReplySets } from '../src/http/quick-replies-routes.js'
import { findQuickReplySet, quickReplyScript, quickReplySetsForAutomation } from '../src/quick-replies.js'

const SAMPLE_STATE: Pick<TavernState, 'quickReplies'> = {
  quickReplies: [
    { id: 'a', name: 'Greeting', enabled: true, isGlobal: true, commands: ['/echo hi'] },
    { id: 'b', name: 'Scene Change', enabled: false, isGlobal: false, automationId: 'wi-1', commands: ['/sys "new scene"'] },
    { id: 'c', name: 'Auto Scene', enabled: true, isGlobal: false, automationId: 'wi-1', commands: ['/trigger'] },
    { id: 'd', name: 'Other Auto', enabled: true, isGlobal: false, automationId: 'wi-2', commands: ['/trigger'] },
  ],
}

function responseDouble() {
  const chunks: string[] = []
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 0,
    writableEnded: false,
    setHeader(name: string, value: string) { headers[name] = value },
    end(body?: string | Uint8Array) {
      if (body !== undefined) chunks.push(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))
      response.writableEnded = true
    },
    text: () => chunks.join(''),
  }
  return response
}

function requestDouble(body: unknown) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    headers: { 'content-type': 'application/json' },
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

describe('quick reply state readers', () => {
  it('按名查找大小写与空白不敏感，空名不匹配', () => {
    expect(findQuickReplySet(SAMPLE_STATE, ' greeting ')?.id).toBe('a')
    expect(findQuickReplySet(SAMPLE_STATE, 'SCENE CHANGE')?.id).toBe('b')
    expect(findQuickReplySet(SAMPLE_STATE, '')).toBeUndefined()
    expect(findQuickReplySet(SAMPLE_STATE, 'missing')).toBeUndefined()
    expect(findQuickReplySet({}, 'Greeting')).toBeUndefined()
  })

  it('停用集合仍可手动执行，但不参与 automationId 触发', () => {
    // 手动 /qr 是显式调用：ST 里停用只影响按钮行，不阻止用户执行。
    expect(findQuickReplySet(SAMPLE_STATE, 'Scene Change')?.enabled).toBe(false)
    expect(quickReplySetsForAutomation(SAMPLE_STATE, 'wi-1').map((set) => set.id)).toEqual(['c'])
    expect(quickReplySetsForAutomation(SAMPLE_STATE, 'wi-2').map((set) => set.id)).toEqual(['d'])
    expect(quickReplySetsForAutomation(SAMPLE_STATE, '  ')).toEqual([])
    expect(quickReplySetsForAutomation(SAMPLE_STATE, 'wi-9')).toEqual([])
  })

  it('集合展开成一条脚本：行序保留、空行丢弃、无内容返回 undefined', () => {
    expect(quickReplyScript({ id: 'x', name: 'X', enabled: true, isGlobal: false, commands: ['  /echo a  ', '   ', '/trigger'] }))
      .toBe('/echo a\n/trigger')
    expect(quickReplyScript({ id: 'y', name: 'Y', enabled: true, isGlobal: false, commands: ['', '  '] })).toBeUndefined()
    expect(quickReplyScript({ id: 'z', name: 'Z', enabled: true, isGlobal: false, commands: [] })).toBeUndefined()
  })
})

describe('quick reply write contract', () => {
  it('拒绝形状错误与重名/重 id（不静默归一）', () => {
    expect(() => parseQuickReplySets('nope')).toThrow(HttpError)
    expect(() => parseQuickReplySets([{ name: '  ', commands: [] }])).toThrow(/name is required/)
    expect(() => parseQuickReplySets([{ name: 'A', commands: 'nope' }])).toThrow(/commands must be an array/)
    expect(() => parseQuickReplySets([{ name: 'A', commands: [1] }])).toThrow(/commands\[0\] must be a string/)
    expect(() => parseQuickReplySets([{ name: 'A', enabled: 'yes', commands: [] }])).toThrow(/enabled must be a boolean/)
    expect(() => parseQuickReplySets([
      { id: 'same', name: 'A', commands: [] },
      { id: 'same', name: 'B', commands: [] },
    ])).toThrow(/duplicate quick reply id/)
    expect(() => parseQuickReplySets([
      { id: 'a', name: 'Same', commands: [] },
      { id: 'b', name: 'same', commands: [] },
    ])).toThrow(/duplicate quick reply name/)
  })

  it('保留行内空白、丢弃纯空行、缺 id 由名派生', () => {
    expect(parseQuickReplySets([
      { name: 'Greeting', commands: ['  /echo hi', '   ', '/setvar k v'], enabled: true, automationId: ' wi-3 ' },
    ])).toEqual([
      { id: 'qr-Greeting', name: 'Greeting', enabled: true, isGlobal: false, automationId: 'wi-3', commands: ['  /echo hi', '/setvar k v'] },
    ])
  })
})

describe('quick replies route', () => {
  let root: string
  let store: TavernStore

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'soulmojito-quick-replies-'))
    store = await TavernStore.open(root)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function call(method: string, body?: unknown) {
    const res = responseDouble()
    await handleQuickRepliesRoute(store, requestDouble(body) as never, res as never, method)
    return { status: res.statusCode, body: JSON.parse(res.text()) as Record<string, unknown> }
  }

  it('GET 空库返回空表与默认开启的总开关', async () => {
    const result = await call('GET')
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, quickReplies: [], quickRepliesEnabled: true })
  })

  it('PUT 全量替换后 GET 读回同一份（含总开关）', async () => {
    const put = await call('PUT', {
      quickReplies: [
        { id: 'g', name: 'Greeting', enabled: true, isGlobal: true, commands: ['/echo hi', '/trigger'] },
        { id: 's', name: 'Scene', enabled: false, isGlobal: false, automationId: 'wi-7', commands: ['/sys "scene"'] },
      ],
      quickRepliesEnabled: false,
    })
    expect(put.status).toBe(200)
    expect(put.body.quickRepliesEnabled).toBe(false)
    expect(put.body.quickReplies).toEqual([
      { id: 'g', name: 'Greeting', enabled: true, isGlobal: true, commands: ['/echo hi', '/trigger'] },
      { id: 's', name: 'Scene', enabled: false, isGlobal: false, automationId: 'wi-7', commands: ['/sys "scene"'] },
    ])
    const read = await call('GET')
    expect(read.body).toEqual(put.body)

    // 省略总开关 = 保持现值（不是隐式打开）。
    const kept = await call('PUT', { quickReplies: [] })
    expect(kept.body.quickRepliesEnabled).toBe(false)
    expect(kept.body.quickReplies).toEqual([])
  })

  it('PUT 坏 body 抛 400 级 HttpError，落盘不变', async () => {
    await expect(call('PUT', { quickReplies: [{ name: 'A', commands: 'nope' }] })).rejects.toThrow(HttpError)
    await expect(call('PUT', { quickReplies: [], quickRepliesEnabled: 'yes' })).rejects.toThrow(/quickRepliesEnabled must be a boolean/)
    expect((await call('GET')).body.quickReplies).toEqual([])
  })

  it('其它方法回 404，不静默落到 200', async () => {
    const result = await call('DELETE')
    expect(result.status).toBe(404)
    expect(result.body.ok).toBe(false)
  })
})

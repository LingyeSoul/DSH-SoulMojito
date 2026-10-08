import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 回归网（写卡 Agent 写入后无需手动刷新页面）：写路径落盘后必须存在可轮询的
// 变更水位；bootstrap 与 store-revision 两个读面给出同一个水位，资产写入推进
// 它——客户端据此在页面可见期间自动重取 bootstrap，而不是靠用户手动刷新。
describe('store change watermark', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>

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
      end: (chunk?: string) => { if (chunk) chunks.push(chunk); response.writableEnded = true },
      on: () => {},
    }
    return response
  }

  async function getJson(url: string) {
    const res = makeResponse()
    await apiHandler(makeGetRequest(url), res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('')) }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-watermark-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('bootstrap 与 store-revision 水位一致；资产写入推进、无写入稳定', async () => {
    const boot = await getJson('/api/dsh-tavern/bootstrap')
    expect(boot.status).toBe(200)
    const watermark = await getJson('/api/dsh-tavern/store-revision')
    expect(watermark.status).toBe(200)
    expect(typeof boot.body.storeRevision).toBe('string')
    expect(boot.body.storeRevision).not.toBe('')
    expect(watermark.body.revision).toBe(boot.body.storeRevision)

    // 模拟写卡 Agent 落盘：card_put / card_create / 面板批准最终都走同一条
    // store 写路径（saveCardValues / importCharacter）。
    const written = await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Agent Card', description: 'written by the card agent', personality: '', scenario: '', first_mes: 'Hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    expect(written.card.data.name).toBe('Agent Card')

    const after = await getJson('/api/dsh-tavern/store-revision')
    expect(after.body.revision).not.toBe(boot.body.storeRevision)
    const afterBoot = await getJson('/api/dsh-tavern/bootstrap')
    expect(afterBoot.body.storeRevision).toBe(after.body.revision)
    expect(afterBoot.body.characters).toContain('Agent Card')

    // 无新写入时水位稳定：客户端轮询到相同水位不会空转重取。
    const steady = await getJson('/api/dsh-tavern/store-revision')
    expect(steady.body.revision).toBe(after.body.revision)
  })
})

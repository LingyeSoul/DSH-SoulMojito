import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 回归网（无头像角色卡的默认替代头像）：json 卡 / 无内嵌图 charx / 无可用成员
// 群组 / 无 PNG persona 都不再是 404 碎图，而是按名字生成首字母色块 SVG；实体
// 不存在仍然 404——404 语义只保留给真正的错误，客户端 onError 隐藏兜底继续生效。
describe('avatar fallback', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>

  function makeGetRequest(url: string) {
    return { method: 'GET', url, on: () => undefined, destroy: () => {} }
  }

  function makeResponse() {
    const chunks: string[] = []
    const headers: Record<string, string> = {}
    const response = {
      chunks,
      headers,
      statusCode: 0,
      writableEnded: false,
      setHeader: (key: string, value: string) => { headers[key] = value },
      write: (chunk: string) => { chunks.push(chunk); return true },
      end: (chunk?: string) => { if (chunk) chunks.push(chunk); response.writableEnded = true },
      on: () => {},
    }
    return response
  }

  async function getBody(url: string) {
    const res = makeResponse()
    await apiHandler(makeGetRequest(url), res)
    return { status: res.statusCode, headers: res.headers, body: res.chunks.join('') }
  }

  async function importJsonCard(name: string) {
    const written = await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name, description: 'no avatar card', personality: '', scenario: '', first_mes: 'Hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    expect(written.card.data.name).toBe(name)
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-avatar-'))
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

  it('json 角色卡（无头像）：200 + image/svg+xml + 名字首字母；同名稳定、异名异色', async () => {
    await importJsonCard('Json Card')
    const first = await getBody('/api/dsh-tavern/avatar/Json%20Card')
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('image/svg+xml')
    expect(first.body).toContain('<svg')
    expect(first.body).toContain('>J</text>')

    const again = await getBody('/api/dsh-tavern/avatar/Json%20Card')
    expect(again.body).toBe(first.body)

    await importJsonCard('Bob')
    const other = await getBody('/api/dsh-tavern/avatar/Bob')
    expect(other.status).toBe(200)
    expect(other.body).toContain('>B</text>')
    expect(other.body).not.toBe(first.body)
  })

  it('CJK 名取首个码点（不是半个代理对）：首字母为原字符', async () => {
    await importJsonCard('阿尔托莉雅')
    const cjk = await getBody('/api/dsh-tavern/avatar/%E9%98%BF%E5%B0%94%E6%89%98%E8%8E%89%E9%9B%85')
    expect(cjk.status).toBe(200)
    expect(cjk.body).toContain('>阿</text>')
  })

  it('不存在的角色仍然 404：实体缺失是错误，不是缺图', async () => {
    const missing = await getBody('/api/dsh-tavern/avatar/Nobody')
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body).ok).toBe(false)
  })

  it('群组：成员有卡时回落成员替代头像；成员全缺失时给群组名替代头像', async () => {
    await store.putGroup({
      id: 'group-party', name: 'Party', members: ['Json Card'], allowSelfResponses: false,
      activationStrategy: 1, disabledMembers: [], chatId: '', chats: [], autoModeDelay: 3,
    })
    const viaMember = await getBody('/api/dsh-tavern/avatar/Party')
    expect(viaMember.status).toBe(200)
    expect(viaMember.body).toContain('>J</text>')

    await store.putGroup({
      id: 'group-empty', name: 'Empty Group', members: [], allowSelfResponses: false,
      activationStrategy: 1, disabledMembers: [], chatId: '', chats: [], autoModeDelay: 3,
    })
    const groupTile = await getBody('/api/dsh-tavern/avatar/Empty%20Group')
    expect(groupTile.status).toBe(200)
    expect(groupTile.body).toContain('>E</text>')
  })

  it('persona 无头像 PNG：存在即给替代头像；不存在 404', async () => {
    await store.putPersona({ name: 'Tester', description: '', position: 0 })
    const persona = await getBody('/api/dsh-tavern/persona-avatar/Tester')
    expect(persona.status).toBe(200)
    expect(persona.headers['content-type']).toBe('image/svg+xml')
    expect(persona.body).toContain('>T</text>')

    const missing = await getBody('/api/dsh-tavern/persona-avatar/Ghost')
    expect(missing.status).toBe(404)
  })
})

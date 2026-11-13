/**
 * Route-table hardening: the moved persona/group, asset import, preset, export,
 * frontend-surface and chat routes are driven through the real `apply()` web
 * handler, and wrong-method requests must fall through to the unchanged 404.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { STORE_ROUTES } from '../src/http/routes.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import type { ChatMessage } from '../../tavern-format/src/index.js'

const CHARACTER_A = 'Route Alpha'
const CHARACTER_B = 'Route Beta'
const CHARACTER_EXPORT = 'Route Export'

function card(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name, description: `${name} card`, personality: '', scenario: '', first_mes: 'Hello',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
    },
  }
}

describe('HTTP route table (moved routes)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let branchChatId: string
  let branchRevision: string

  interface ApiResult {
    status: number
    headers: Record<string, string>
    text: string
  }

  function makeRequest(body: unknown, url: string, method: string) {
    const listeners = new Map<string, (value?: unknown) => void>()
    return {
      method,
      url,
      on: (event: string, listener: (value?: unknown) => void) => {
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

  function makeGetRequest(url: string) {
    return { method: 'GET', url, on: () => undefined, destroy: () => {} }
  }

  function makeResponse() {
    const chunks: Uint8Array[] = []
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 0,
      writableEnded: false,
      setHeader: (key: string, value: string) => { headers[key] = value },
      write: (chunk: string) => { chunks.push(Buffer.from(chunk)); return true },
      end: (chunk?: string | Uint8Array) => {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        response.writableEnded = true
      },
      on: () => {},
    }
    return { response, chunks, headers }
  }

  async function call(method: string, url: string, body?: unknown): Promise<ApiResult> {
    const { response, chunks, headers } = makeResponse()
    const request = method === 'GET' ? makeGetRequest(url) : makeRequest(body, url, method)
    await apiHandler(request, response)
    return { status: response.statusCode, headers, text: Buffer.concat(chunks).toString('utf8') }
  }

  function json(result: ApiResult): Record<string, unknown> {
    return JSON.parse(result.text) as Record<string, unknown>
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-route-table-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter(card(CHARACTER_A))
    await store.importCharacter(card(CHARACTER_B))
    const now = new Date().toISOString()
    branchChatId = await store.createChat(CHARACTER_A, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{ name: CHARACTER_A, is_user: false, is_system: false, send_date: now, mes: 'opening' }])
    const snapshot = await store.getChatSnapshot(CHARACTER_A, branchChatId)
    if (snapshot === undefined) throw new Error('branch fixture chat was not persisted')
    branchRevision = snapshot.revision

    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: () => {} },
      llm: {
        listProviders: () => [{ id: 'test-provider', name: 'Test Provider' }],
        listModels: () => [{ id: 'test-model', name: 'Test Model' }],
        resolveModelInfo: async () => ({}),
        stream: async function* () {},
      },
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

  it('imports and updates a world book', async () => {
    const imported = await call('POST', '/api/dsh-soulmojito/import/world', {
      name: 'Route World',
      data: {
        entries: {
          '0': {
            uid: 0, key: [], keysecondary: [], comment: 'route', content: 'route lore',
            constant: true, selective: false, order: 100, position: 0, disable: false,
          },
        },
      },
    })
    expect(imported.status).toBe(200)
    expect(json(imported)).toMatchObject({ ok: true, name: 'Route World', entries: 1 })
  })

  it('creates, lists, updates and deletes a persona and a group', async () => {
    const persona = await call('POST', '/api/dsh-soulmojito/import/persona', {
      name: 'Route Persona',
      description: 'route persona',
    })
    expect(persona.status).toBe(200)

    const avatar = await call('GET', '/api/dsh-soulmojito/persona-avatar/Route%20Persona')
    expect(avatar.status).toBe(200)
    expect(avatar.headers['content-type']).toBe('image/svg+xml')

    const created = await call('POST', '/api/dsh-soulmojito/groups', {
      name: 'Route Group',
      members: [CHARACTER_A, CHARACTER_B],
    })
    expect(created.status).toBe(200)
    expect(json(created)).toMatchObject({ ok: true, group: { name: 'Route Group' } })

    const listed = await call('GET', '/api/dsh-soulmojito/groups')
    expect(listed.status).toBe(200)
    expect((json(listed)['groups'] as Array<{ name: string }>).map((group) => group.name)).toContain('Route Group')

    const updated = await call('PUT', '/api/dsh-soulmojito/group', {
      name: 'Route Group',
      members: [CHARACTER_A],
      allowSelfResponses: true,
    })
    expect(updated.status).toBe(200)
    expect(json(updated)).toMatchObject({ ok: true, group: { name: 'Route Group', members: [CHARACTER_A] } })

    const deleted = await call('DELETE', '/api/dsh-soulmojito/group?name=Route%20Group')
    expect(deleted.status).toBe(200)
    expect(json(deleted)['ok']).toBe(true)
  })

  it('writes and reads a preset through the table', async () => {
    const put = await call('PUT', '/api/dsh-soulmojito/preset/Route%20Preset', {
      name: 'Route Preset',
      data: { prompts: [], prompt_order: [] },
    })
    expect(put.status).toBe(200)
    expect(json(put)).toMatchObject({ ok: true, name: 'Route Preset' })

    const read = await call('GET', '/api/dsh-soulmojito/preset/Route%20Preset')
    expect(read.status).toBe(200)
    expect(json(read)).toMatchObject({ ok: true, name: 'Route Preset' })

    const missing = await call('GET', '/api/dsh-soulmojito/preset/Route%20Missing')
    expect(missing.status).toBe(404)
    expect(json(missing)).toEqual({ ok: false, message: 'preset not found' })
  })

  it('prunes bindings, model selections and IM peers to the live set', async () => {
    const now = new Date().toISOString()
    const binding = { architecture: 'st' as const, character: CHARACTER_A, chatId: branchChatId }
    await store.patchState({
      sessionBindings: { live: binding, dead: binding },
      modelSelections: {
        live: { provider: 'test-provider', model: 'test-model' },
        dead: { provider: 'test-provider', model: 'test-model' },
      },
      imPeers: {
        live: { sessionId: 'live', scope: 'private', boundBy: 'manual', createdAt: now },
        dead: { sessionId: 'dead', scope: 'private', boundBy: 'manual', createdAt: now },
      },
    })

    const pruned = await call('POST', '/api/dsh-soulmojito/bindings/prune', { sessionIds: ['live'] })
    expect(pruned.status).toBe(200)
    expect(json(pruned)['ok']).toBe(true)
    const state = await store.getState()
    expect(Object.keys(state.sessionBindings)).toEqual(['live'])
    expect(Object.keys(state.modelSelections)).toEqual(['live'])
    expect(Object.keys(state.imPeers ?? {})).toEqual(['live'])
  })

  it('branches a chat from a stored revision', async () => {
    const branched = await call('POST', '/api/dsh-soulmojito/branch', {
      character: CHARACTER_A,
      chatId: branchChatId,
      messageId: 0,
      revision: branchRevision,
      name: 'Route Branch',
    })
    expect(branched.status).toBe(200)
    const body = json(branched)
    expect(body['ok']).toBe(true)
    expect(typeof body['id']).toBe('string')
    expect(body['id']).not.toBe(branchChatId)
  })

  /* ---------------- 聊天文件（契约 2026-11-12 §2.5） ---------------- */

  function jsonl(messages: Array<Record<string, unknown>>, metadata: Record<string, unknown> = {}): string {
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: metadata }
    return [header, ...messages].map((line) => JSON.stringify(line)).join('\n') + '\n'
  }

  const THREE_MESSAGES: ChatMessage[] = [
    { name: CHARACTER_A, is_user: false, is_system: false, send_date: '2026-11-12 10:00', mes: 'line one' },
    { name: 'User', is_user: true, is_system: false, send_date: '2026-11-12 10:01', mes: 'line two' },
    { name: CHARACTER_A, is_user: false, is_system: false, send_date: '2026-11-12 10:02', mes: 'line three' },
  ]

  async function createThreeMessageChat(metadata: Record<string, unknown> = {}): Promise<{ chatId: string; revision: string }> {
    const chatId = await store.createChat(CHARACTER_A, {
      user_name: 'unused', character_name: 'unused', chat_metadata: metadata,
    }, THREE_MESSAGES)
    const snapshot = await store.getChatSnapshot(CHARACTER_A, chatId)
    if (snapshot === undefined) throw new Error('chat fixture was not persisted')
    return { chatId, revision: snapshot.revision }
  }

  it('imports a JSONL chat, exports it back and refuses to overwrite a name', async () => {
    const content = jsonl(THREE_MESSAGES, { note_prompt: '' })
    const imported = await call('POST', '/api/dsh-soulmojito/import/chat', {
      character: CHARACTER_A,
      name: 'Chat Imported',
      content,
    })
    expect(imported.status).toBe(200)
    const body = json(imported)
    expect(body).toMatchObject({ ok: true, chatId: 'Chat Imported.jsonl', name: 'Chat Imported', id: 'Chat Imported.jsonl' })
    expect(typeof body['revision']).toBe('string')

    const stored = await store.getChatSnapshot(CHARACTER_A, 'Chat Imported.jsonl')
    expect(stored?.chat.messages.length).toBe(3)
    expect(stored?.chat.messages[2]?.['mes']).toBe('line three')

    // 重名不覆盖：原文件内容必须原样保留。
    const replaced = jsonl([{ name: 'User', is_user: true, is_system: false, send_date: '2026-11-12 11:00', mes: 'replacement' }])
    const clash = await call('POST', '/api/dsh-soulmojito/import/chat', {
      character: CHARACTER_A,
      name: 'Chat Imported',
      content: replaced,
    })
    expect(clash.status).toBe(409)
    expect(json(clash)['message']).toBe("chat 'Chat Imported' already exists")
    expect((await store.getChatSnapshot(CHARACTER_A, 'Chat Imported.jsonl'))?.chat.messages.length).toBe(3)

    const exported = await call('GET', `/api/dsh-soulmojito/export/chat/${encodeURIComponent(CHARACTER_A)}/${encodeURIComponent('Chat Imported.jsonl')}`)
    expect(exported.status).toBe(200)
    expect(json(exported)).toEqual({ ok: true, name: 'Chat Imported.jsonl', content })

    const missing = await call('GET', `/api/dsh-soulmojito/export/chat/${encodeURIComponent(CHARACTER_A)}/${encodeURIComponent('Chat Absent.jsonl')}`)
    expect(missing.status).toBe(404)
    expect(json(missing)['message']).toBe("chat 'Chat Absent' not found")

    const unparsable = await call('POST', '/api/dsh-soulmojito/import/chat', {
      character: CHARACTER_A,
      name: 'Chat Broken',
      content: 'not json at all',
    })
    expect(unparsable.status).toBe(400)

    const shapeless = await call('POST', '/api/dsh-soulmojito/import/chat', {
      character: CHARACTER_A,
      name: 'Chat Broken',
      content: jsonl([{ name: 'User', is_user: true, is_system: false, send_date: '2026-11-12 10:00' }]),
    })
    expect(shapeless.status).toBe(400)
    expect(String(json(shapeless)['message'])).toContain("message 'mes' must be a string")
    expect(await store.listChats(CHARACTER_A)).not.toContain('Chat Broken.jsonl')

    const unknownCharacter = await call('POST', '/api/dsh-soulmojito/import/chat', {
      character: 'Route Ghost',
      name: 'Chat Ghost',
      content,
    })
    expect(unknownCharacter.status).toBe(404)
  })

  it('duplicates a whole chat and drops its bookmark link', async () => {
    const parent = await createThreeMessageChat({
      bookmark_link: { character: CHARACTER_A, chatId: 'Chat Imported.jsonl', messageId: 1 },
    })

    const duplicated = await call('POST', '/api/dsh-soulmojito/duplicate', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
    })
    expect(duplicated.status).toBe(200)
    const body = json(duplicated)
    expect(body['ok']).toBe(true)
    expect(body['chatId']).not.toBe(parent.chatId)
    expect(String(body['name'])).toContain(' - copy 1')

    const copy = await store.getChatSnapshot(CHARACTER_A, String(body['chatId']))
    expect(copy?.chat.messages.length).toBe(3)
    expect(copy?.chat.header.chat_metadata['bookmark_link']).toBeUndefined()
    // 父聊天不受影响。
    expect((await store.getChatSnapshot(CHARACTER_A, parent.chatId))?.chat.header.chat_metadata['bookmark_link'])
      .toBeDefined()

    // 同名副本再复制一次：自动递增，不覆盖已有副本。
    const again = await call('POST', '/api/dsh-soulmojito/duplicate', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
    })
    expect(again.status).toBe(200)
    expect(json(again)['chatId']).not.toBe(body['chatId'])
    expect(String(json(again)['name'])).toContain(' - copy 2')

    // 显式名字原样落盘；同名已存在时退化成 `- copy N`，仍不覆盖。
    const named = await call('POST', '/api/dsh-soulmojito/duplicate', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
      name: 'Chat Custom Copy',
    })
    expect(named.status).toBe(200)
    expect(json(named)['chatId']).toBe('Chat Custom Copy.jsonl')
    const namedClash = await call('POST', '/api/dsh-soulmojito/duplicate', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
      name: 'Chat Custom Copy',
    })
    expect(namedClash.status).toBe(200)
    expect(json(namedClash)['chatId']).toBe('Chat Custom Copy - copy 1.jsonl')

    const stale = await call('POST', '/api/dsh-soulmojito/duplicate', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: 'stale-revision',
    })
    expect(stale.status).toBe(409)
    expect(json(stale)['code']).toBe('CHAT_REVISION_CONFLICT')

    const noRevision = await call('POST', '/api/dsh-soulmojito/duplicate', {
      character: CHARACTER_A,
      chatId: parent.chatId,
    })
    expect(noRevision.status).toBe(400)
  })

  it('stores checkpoints of a prefix and lists them by parent', async () => {
    const parent = await createThreeMessageChat()

    const checkpoint = await call('POST', '/api/dsh-soulmojito/checkpoint', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
      messageId: 1,
    })
    expect(checkpoint.status).toBe(200)
    const body = json(checkpoint)
    expect(body['ok']).toBe(true)
    expect(String(body['name'])).toContain(' - checkpoint 1')

    const stored = await store.getChatSnapshot(CHARACTER_A, String(body['chatId']))
    expect(stored?.chat.messages.length).toBe(2)
    expect(stored?.chat.header.chat_metadata['checkpoint_parent']).toEqual({
      character: CHARACTER_A,
      chatId: parent.chatId,
      messageId: 1,
    })

    // 缺省 messageId 复制全部。
    const whole = await call('POST', '/api/dsh-soulmojito/checkpoint', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
    })
    expect(whole.status).toBe(200)
    const wholeSnapshot = await store.getChatSnapshot(CHARACTER_A, String(json(whole)['chatId']))
    expect(wholeSnapshot?.chat.messages.length).toBe(3)
    expect(wholeSnapshot?.chat.header.chat_metadata['checkpoint_parent']).toMatchObject({ messageId: 2 })

    const listed = await call('GET', `/api/dsh-soulmojito/checkpoints?character=${encodeURIComponent(CHARACTER_A)}&chatId=${encodeURIComponent(parent.chatId)}`)
    expect(listed.status).toBe(200)
    const entries = json(listed)['checkpoints'] as Array<{ chatId: string; name: string; messageId: number }>
    expect(entries.map((entry) => entry.messageId)).toEqual([1, 2])
    expect(entries.map((entry) => entry.chatId)).toEqual([String(body['chatId']), String(json(whole)['chatId'])])
    expect(entries.every((entry) => !entry.name.endsWith('.jsonl'))).toBe(true)

    const missingCharacter = await call('GET', '/api/dsh-soulmojito/checkpoints?chatId=whatever.jsonl')
    expect(missingCharacter.status).toBe(400)

    const outOfRange = await call('POST', '/api/dsh-soulmojito/checkpoint', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
      messageId: 9,
    })
    expect(outOfRange.status).toBe(400)

    // 显式名字被占时同样退化成编号命名，不覆盖既有文件。
    const namedClash = await call('POST', '/api/dsh-soulmojito/checkpoint', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: parent.revision,
      name: String(body['name']),
    })
    expect(namedClash.status).toBe(200)
    expect(json(namedClash)['chatId']).not.toBe(body['chatId'])
    expect(String(json(namedClash)['name'])).toContain(' - checkpoint')

    const stale = await call('POST', '/api/dsh-soulmojito/checkpoint', {
      character: CHARACTER_A,
      chatId: parent.chatId,
      revision: 'stale-revision',
    })
    expect(stale.status).toBe(409)
    expect(json(stale)['code']).toBe('CHAT_REVISION_CONFLICT')
  })

  it('switches the ST opening greeting and refuses on the agent architecture', async () => {
    const chatId = await store.createChat(CHARACTER_A, {
      user_name: 'unused', character_name: 'unused', chat_metadata: {},
    }, [{
      name: CHARACTER_A, is_user: false, is_system: false, send_date: '2026-11-12 10:00',
      mes: 'greeting zero', swipe_id: 0, swipes: ['greeting zero', 'greeting one', 'greeting two'],
      swipe_info: [{ send_date: 'a' }, { send_date: 'b' }, { send_date: 'c' }],
    }])
    const revision = (await store.getChatSnapshot(CHARACTER_A, chatId))?.revision ?? ''
    expect(revision).not.toBe('')

    const switched = await call('POST', '/api/dsh-soulmojito/greeting', {
      character: CHARACTER_A,
      chatId,
      revision,
      index: 2,
    })
    expect(switched.status).toBe(200)
    expect(json(switched)['mes']).toBe('greeting two')
    const afterSwitch = await store.getChatSnapshot(CHARACTER_A, chatId)
    expect(afterSwitch?.chat.messages[0]?.['swipe_id']).toBe(2)
    expect(afterSwitch?.chat.messages[0]?.['mes']).toBe('greeting two')
    expect(afterSwitch?.chat.messages[0]?.['swipes']).toEqual(['greeting zero', 'greeting one', 'greeting two'])

    const outOfRange = await call('POST', '/api/dsh-soulmojito/greeting', {
      character: CHARACTER_A,
      chatId,
      revision: afterSwitch?.revision ?? '',
      index: 7,
    })
    expect(outOfRange.status).toBe(400)
    expect(String(json(outOfRange)['message'])).toContain('out of range')

    const staleRevision = await call('POST', '/api/dsh-soulmojito/greeting', {
      character: CHARACTER_A,
      chatId,
      revision,
      index: 1,
    })
    expect(staleRevision.status).toBe(409)
    expect(json(staleRevision)['code']).toBe('CHAT_REVISION_CONFLICT')

    // Agent 架构：首楼是宿主会话投影，切 JSONL 无效，按架构冲突 409 拒绝。
    await store.patchState({
      sessionBindings: {
        'route-agent': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER_A, chatId },
      },
    })
    try {
      const agent = await call('POST', '/api/dsh-soulmojito/greeting', {
        character: CHARACTER_A,
        chatId,
        revision: afterSwitch?.revision ?? '',
        index: 1,
      })
      expect(agent.status).toBe(409)
      expect(json(agent)['code']).toBe('TAVERN_ARCHITECTURE_CONFLICT')
      expect(String(json(agent)['message'])).toContain('AgentTavern')
    } finally {
      await store.patchState({ sessionBindings: {} })
    }
  })

  it('exports an imported character with attachment headers', async () => {
    const imported = await call('POST', '/api/dsh-soulmojito/import/character', { card: card(CHARACTER_EXPORT) })
    expect(imported.status).toBe(200)

    const exported = await call('GET', '/api/dsh-soulmojito/export/character/Route%20Export')
    expect(exported.status).toBe(200)
    expect(exported.headers['content-type']).toBe('application/json')
    expect(exported.headers['content-disposition']).toContain('Route%20Export.json')
    expect(exported.text).toContain(CHARACTER_EXPORT)
  })

  it('keeps the explicit post-store route order', () => {
    expect(STORE_ROUTES.map((entry) => entry.name)).toEqual([
      'avatar',
      'character-read',
      'projection',
      'projection-replay',
      'compact',
      'guides',
      'script',
      'agent-tavern-audit',
      'body',
      'novels',
      'mods',
      'character-write',
      'character-delete',
      'character-export',
      'models',
      'model',
      'state',
      'character-import',
      'world-import',
      'preset-import',
      'preset-read',
      'preset-update',
      'persona-import',
      'persona-update',
      'persona-delete',
      'persona-avatar',
      'groups-list',
      'group-create',
      'group-update',
      'group-delete',
      'binding-create',
      'binding-delete',
      'bindings-prune',
      'chats-list',
      'chat-create',
      'branch',
      'chat-import',
      'chat-export',
      'chat-duplicate',
      'chat-checkpoint',
      'chat-checkpoints',
      'chat-greeting',
      'quick-replies-read',
      'quick-replies-update',
      'candidates',
      'preview',
      'mvu',
      'card-workbench',
      'memory-embed',
      'memory-maintenance',
      'prompts',
      'world-read',
      'world-update',
      'world-export',
      'world-delete',
      'preset-delete',
      'preset-export',
      'variables-read',
      'variables-update',
      'regex-read',
      'regex-update',
      'regex-import',
      'regex-sync-cards',
      'regex-sync-presets',
      'helper-bind',
      'helper-unbind',
      'helper',
      'frontend-generate',
      'card-scripts',
      'frontend-idb-get',
      'frontend-idb-put',
      'frontend-storage',
      'frontend-latest',
      'display',
      'chat',
      'generate',
      'script-run',
      'backup-export',
      'backup-import',
      'data-bank',
    ])
  })

  it('lists models and stores then clears a session selection', async () => {
    const models = await call('GET', '/api/dsh-soulmojito/models')
    expect(models.status).toBe(200)
    expect(json(models)).toMatchObject({
      ok: true,
      groups: [{ id: 'test-provider', name: 'Test Provider', models: [{ id: 'test-model', name: 'Test Model' }] }],
      failures: [],
    })

    const set = await call('POST', '/api/dsh-soulmojito/model', {
      sessionId: 'route-selection',
      selection: { provider: 'test-provider', model: 'test-model' },
    })
    expect(set.status).toBe(200)
    expect((await store.getState()).modelSelections['route-selection']).toEqual({
      provider: 'test-provider',
      model: 'test-model',
    })

    const cleared = await call('POST', '/api/dsh-soulmojito/model', {
      sessionId: 'route-selection',
      selection: null,
    })
    expect(cleared.status).toBe(200)
    expect((await store.getState()).modelSelections['route-selection']).toBeUndefined()
  })

  it('reads, exports and deletes a world book', async () => {
    const read = await call('GET', '/api/dsh-soulmojito/world/Route%20World')
    expect(read.status).toBe(200)
    expect(json(read)).toMatchObject({ ok: true, book: { name: 'Route World' } })

    const exported = await call('GET', '/api/dsh-soulmojito/export/world/Route%20World')
    expect(exported.status).toBe(200)
    expect(exported.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(exported.headers['content-disposition']).toContain('Route%20World.json')

    const deleted = await call('DELETE', '/api/dsh-soulmojito/world?name=Route%20World')
    expect(deleted.status).toBe(200)
    expect(json(deleted)['ok']).toBe(true)

    const missing = await call('GET', '/api/dsh-soulmojito/world/Route%20World')
    expect(missing.status).toBe(404)
    expect(json(missing)).toEqual({ ok: false, message: 'world not found' })
  })

  it('exports and deletes a preset', async () => {
    const put = await call('PUT', '/api/dsh-soulmojito/preset/Route%20ExportPreset', {
      name: 'Route ExportPreset',
      data: { prompts: [], prompt_order: [] },
    })
    expect(put.status).toBe(200)

    const exported = await call('GET', '/api/dsh-soulmojito/export/preset/Route%20ExportPreset')
    expect(exported.status).toBe(200)
    expect(exported.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(exported.headers['content-disposition']).toContain('Route%20ExportPreset.json')

    const deleted = await call('DELETE', '/api/dsh-soulmojito/preset?name=Route%20ExportPreset')
    expect(deleted.status).toBe(200)
    expect(json(deleted)['ok']).toBe(true)

    const missing = await call('GET', '/api/dsh-soulmojito/preset/Route%20ExportPreset')
    expect(missing.status).toBe(404)
    expect(json(missing)).toEqual({ ok: false, message: 'preset not found' })
  })

  it('reads and replaces global variables and regex scripts', async () => {
    const initialGlobals = await call('GET', '/api/dsh-soulmojito/variables')
    expect(initialGlobals.status).toBe(200)
    expect(json(initialGlobals)).toMatchObject({ ok: true, globals: {} })

    const putGlobals = await call('PUT', '/api/dsh-soulmojito/variables', {
      globals: { routeCounter: 1, routeFlag: true },
    })
    expect(putGlobals.status).toBe(200)
    expect(json(putGlobals)).toMatchObject({ ok: true, globals: { routeCounter: 1, routeFlag: true } })

    const initialRegex = await call('GET', '/api/dsh-soulmojito/regex')
    expect(initialRegex.status).toBe(200)
    expect(Array.isArray(json(initialRegex)['scripts'])).toBe(true)

    const putRegex = await call('PUT', '/api/dsh-soulmojito/regex', {
      scripts: [{ scriptName: 'route-filter', findRegex: 'foo', replaceString: 'bar', placement: [5] }],
    })
    expect(putRegex.status).toBe(200)
    expect((json(putRegex)['scripts'] as Array<{ scriptName: string }>).map((script) => script.scriptName)).toEqual(['route-filter'])

    const imported = await call('POST', '/api/dsh-soulmojito/import/regex', {
      data: [{ scriptName: 'route-import', findRegex: 'baz', replaceString: 'qux', placement: [5] }],
    })
    expect(imported.status).toBe(200)
    expect(json(imported)['imported']).toBe(1)
  })

  it('serves the frontend reading surface for a persisted chat', async () => {
    const storage = await call('GET', `/api/dsh-soulmojito/frontend/storage?character=${encodeURIComponent(CHARACTER_A)}`)
    expect(storage.status).toBe(200)
    expect(json(storage)).toEqual({ ok: true, storage: {} })

    const scripts = await call('GET', `/api/dsh-soulmojito/card/scripts?character=${encodeURIComponent(CHARACTER_A)}`)
    expect(scripts.status).toBe(200)
    expect(json(scripts)).toMatchObject({ ok: true, character: CHARACTER_A })

    const latest = await call('GET', `/api/dsh-soulmojito/frontend/latest?character=${encodeURIComponent(CHARACTER_A)}&chatId=${branchChatId}`)
    expect(latest.status).toBe(200)
    expect(json(latest)).toMatchObject({ ok: true, revision: branchRevision, messageCount: 1 })

    const display = await call('GET', `/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER_A)}&chatId=${branchChatId}&messageId=missing`)
    expect(display.status).toBe(200)
    expect(json(display)).toEqual({ ok: true, text: null })
  })

  it('binds and releases a helper token for a persisted chat', async () => {
    const bound = await call('POST', '/api/dsh-soulmojito/helper/bind', {
      character: CHARACTER_A,
      chatId: branchChatId,
    })
    expect(bound.status).toBe(200)
    const token = json(bound)['token']
    expect(typeof token).toBe('string')

    const unbound = await call('POST', '/api/dsh-soulmojito/helper/unbind', { token })
    expect(unbound.status).toBe(200)
    expect(json(unbound)).toEqual({ ok: true })
  })

  it('reads a chat through the chat prefix route', async () => {
    const read = await call('GET', `/api/dsh-soulmojito/chat/${branchChatId}?character=${encodeURIComponent(CHARACTER_A)}`)
    expect(read.status).toBe(200)
    expect(json(read)).toMatchObject({ ok: true, revision: branchRevision })
  })

  it('keeps wrong-method requests on the unchanged 404 path', async () => {
    const getBinding = await call('GET', '/api/dsh-soulmojito/binding')
    expect(getBinding.status).toBe(404)
    expect(json(getBinding)['message']).toBe('route not found: GET binding')

    const deleteChats = await call('DELETE', '/api/dsh-soulmojito/chats')
    expect(deleteChats.status).toBe(404)
    expect(json(deleteChats)['message']).toBe('route not found: DELETE chats')

    const getCandidates = await call('GET', '/api/dsh-soulmojito/candidates')
    expect(getCandidates.status).toBe(404)
    expect(json(getCandidates)['message']).toBe('route not found: GET candidates')

    const postPreset = await call('POST', '/api/dsh-soulmojito/preset/Route%20Preset', { name: 'Route Preset' })
    expect(postPreset.status).toBe(404)
    expect(json(postPreset)['message']).toBe('route not found: POST preset/Route%20Preset')

    const putModels = await call('PUT', '/api/dsh-soulmojito/models')
    expect(putModels.status).toBe(404)
    expect(json(putModels)['message']).toBe('route not found: PUT models')

    const getModel = await call('GET', '/api/dsh-soulmojito/model')
    expect(getModel.status).toBe(404)
    expect(json(getModel)['message']).toBe('route not found: GET model')

    const getWorld = await call('GET', '/api/dsh-soulmojito/world')
    expect(getWorld.status).toBe(404)
    expect(json(getWorld)['message']).toBe('route not found: GET world')

    const postPresetRoot = await call('POST', '/api/dsh-soulmojito/preset')
    expect(postPresetRoot.status).toBe(404)
    expect(json(postPresetRoot)['message']).toBe('route not found: POST preset')

    const deleteVariables = await call('DELETE', '/api/dsh-soulmojito/variables')
    expect(deleteVariables.status).toBe(404)
    expect(json(deleteVariables)['message']).toBe('route not found: DELETE variables')

    const postRegex = await call('POST', '/api/dsh-soulmojito/regex')
    expect(postRegex.status).toBe(404)
    expect(json(postRegex)['message']).toBe('route not found: POST regex')

    const getHelper = await call('GET', '/api/dsh-soulmojito/helper')
    expect(getHelper.status).toBe(404)
    expect(json(getHelper)['message']).toBe('route not found: GET helper')

    const postDisplay = await call('POST', '/api/dsh-soulmojito/display')
    expect(postDisplay.status).toBe(404)
    expect(json(postDisplay)['message']).toBe('route not found: POST display')

    const postChatPath = new URL(`/api/dsh-soulmojito/chat/${branchChatId}`, 'http://localhost')
      .pathname.slice('/api/dsh-soulmojito/'.length)
    const postChat = await call('POST', `/api/dsh-soulmojito/${postChatPath}?character=${encodeURIComponent(CHARACTER_A)}`)
    expect(postChat.status).toBe(404)
    expect(json(postChat)['message']).toBe(`route not found: POST ${postChatPath}`)

    const getGenerate = await call('GET', '/api/dsh-soulmojito/generate')
    expect(getGenerate.status).toBe(404)
    expect(json(getGenerate)['message']).toBe('route not found: GET generate')

    const getDuplicate = await call('GET', '/api/dsh-soulmojito/duplicate')
    expect(getDuplicate.status).toBe(404)
    expect(json(getDuplicate)['message']).toBe('route not found: GET duplicate')

    const putCheckpoints = await call('PUT', '/api/dsh-soulmojito/checkpoints')
    expect(putCheckpoints.status).toBe(404)
    expect(json(putCheckpoints)['message']).toBe('route not found: PUT checkpoints')

    const getImportChat = await call('GET', '/api/dsh-soulmojito/import/chat')
    expect(getImportChat.status).toBe(404)
    expect(json(getImportChat)['message']).toBe('route not found: GET import/chat')

    const postExportChat = await call('POST', '/api/dsh-soulmojito/export/chat/whatever')
    expect(postExportChat.status).toBe(404)
    expect(json(postExportChat)['message']).toBe('route not found: POST export/chat/whatever')
  })
})

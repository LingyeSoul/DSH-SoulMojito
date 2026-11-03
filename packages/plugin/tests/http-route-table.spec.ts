/**
 * Route-table hardening: the moved persona/group, asset import, preset, session
 * and export routes are driven through the real `apply()` web handler, and
 * wrong-method requests must fall through to the unchanged 404.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { STORE_ROUTES } from '../src/http/routes.js'
import { TavernStore } from '../../tavern-store/src/index.js'

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
      'candidates',
      'preview',
      'mvu',
      'card-workbench',
      'memory-embed',
      'memory-maintenance',
      'prompts',
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
  })
})

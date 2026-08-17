import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Native Character'

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

describe('AgentTavern native tools', () => {
  let home: string
  let tools: Map<string, RegisteredTool>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-tools-'))
    process.env.DSH_HOME = home
    const store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: 'A precise native AgentTavern character.',
        personality: 'Careful',
        scenario: 'A quiet test scene.',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { world: 'Native Lore' },
      },
    })
    await store.importWorldFile('Native Lore', {
      entries: {
        '0': {
          uid: 0, key: ['moon gate'], keysecondary: [], comment: 'Gate',
          content: 'The moon gate opens only at midnight.', constant: false,
          selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    await store.importWorldFile('Active Lore', {
      entries: {
        '0': {
          uid: 0, key: ['star archive'], keysecondary: [], comment: 'Archive',
          content: 'The star archive records every voyage.', constant: false,
          selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString() },
    })
    await store.updateState(() => ({
      activeWorlds: ['Active Lore'],
      sessionBindings: {
        native: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
        st: { architecture: 'st', character: CHARACTER, chatId },
      },
    }))

    tools = new Map()
    apply({
      agent: { id: 'native' },
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('registers only scope-derived tools without identity parameters', () => {
    expect([...tools.keys()]).toEqual([
      'tavern_character_get',
      'tavern_lore_search',
      'tavern_scene_get',
      'memory_search',
      'memory_write',
      'variable_get',
      'variable_set',
    ])
    for (const tool of tools.values()) {
      expect(tool.parameters.properties).not.toHaveProperty('sessionId')
      expect(tool.parameters.properties).not.toHaveProperty('scopeId')
      expect(tool.parameters.properties).not.toHaveProperty('character')
      expect(tool.parameters.properties).not.toHaveProperty('chatId')
    }
  })

  it('reads the bound character and scene from the executing agent', async () => {
    const exec = { agent: { id: 'native' } }
    const character = await tools.get('tavern_character_get')!.execute({}, exec)
    const scene = await tools.get('tavern_scene_get')!.execute({}, exec)
    expect(character).toMatchObject({
      character: CHARACTER,
      nickname: CHARACTER,
      source: { kind: 'character-card', id: CHARACTER, version: '2.0' },
      truncated: false,
    })
    expect(JSON.parse(JSON.stringify(character))).toEqual(character)
    expect(scene).toMatchObject({ character: CHARACTER, messageCount: 0, truncated: false })
  })

  it('searches the world book linked to the bound character', async () => {
    const result = await tools.get('tavern_lore_search')!.execute({
      query: 'moon gate', limit: 5, maxTokens: 200,
    }, { agent: { id: 'native' } })
    expect(result).toMatchObject({ sourceCount: 1, truncated: false })
    expect(result.hits[0]).toMatchObject({
      book: 'Native Lore', uid: 0, comment: 'Gate',
      content: 'The moon gate opens only at midnight.',
      source: { kind: 'world-book', id: 'Native Lore.0' },
    })
  })

  it('searches globally active world books', async () => {
    const result = await tools.get('tavern_lore_search')!.execute({
      query: 'star archive', limit: 5, maxTokens: 200,
    }, { agent: { id: 'native' } })
    expect(result.hits[0]).toMatchObject({
      book: 'Active Lore', comment: 'Archive', content: 'The star archive records every voyage.',
    })
  })

  it('enforces the lore result token budget', async () => {
    const result = await tools.get('tavern_lore_search')!.execute({
      query: 'moon gate', limit: 20, maxTokens: 1,
    }, { agent: { id: 'native' } })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].content.length).toBeLessThanOrEqual(4)
    expect(result.hits[0].truncated).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('writes and searches memory only through the derived scope', async () => {
    const exec = { agent: { id: 'native' } }
    const written = await tools.get('memory_write')!.execute({
      scope: 'chat', kind: 'semantic', content: 'The brass key opens the cellar.', tags: ['key'],
    }, exec)
    expect(written).toMatchObject({ scope: 'chat' })
    expect(written.source).toMatchObject({ kind: 'agent-tool', sessionId: 'native', character: CHARACTER })
    const result = await tools.get('memory_search')!.execute({ query: 'brass key', scope: 'chat' }, exec)
    expect(result.sourceCount).toBe(1)
    expect(result.hits[0]).toMatchObject({ id: written.id, scope: 'chat' })
  })

  it('keeps typed variables behind CAS revisions', async () => {
    const exec = { agent: { id: 'native' } }
    const first = await tools.get('variable_set')!.execute({ scope: 'agent', name: 'relationship', value: { trust: 2 } }, exec)
    await expect(tools.get('variable_set')!.execute({ scope: 'agent', name: 'relationship', value: { trust: 3 } }, exec))
      .rejects.toMatchObject({ code: 'VARIABLE_REVISION_CONFLICT' })
    const updated = await tools.get('variable_set')!.execute({
      scope: 'agent', name: 'relationship', value: { trust: 3 }, expectedRevision: first.revision,
    }, exec)
    expect(updated.value).toEqual({ trust: 3 })
    const read = await tools.get('variable_get')!.execute({ scope: 'agent', name: 'relationship' }, exec)
    expect(read).toMatchObject({ found: true, value: { trust: 3 }, revision: updated.revision })
  })

  it('rejects ST agents instead of silently using the native tool path', async () => {
    await expect(tools.get('tavern_character_get')!.execute({}, { agent: { id: 'st' } }))
      .rejects.toThrow('AgentTavern binding is unavailable')
  })
})

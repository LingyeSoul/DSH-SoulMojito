import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { MemoryStore, TavernStore, VariableStore } from '../../tavern-store/src/index.js'

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
    const emptyChat = await store.getChatSnapshot(CHARACTER, chatId)
    await store.saveChat(CHARACTER, chatId, {
      ...emptyChat!.chat,
      messages: [
        {
          name: 'User', is_user: true, is_system: false, send_date: '2026-08-01T10:00:00.000Z',
          mes: 'We agreed to meet at the moon gate at midnight.',
        },
        {
          name: CHARACTER, is_user: false, is_system: false, send_date: '2026-08-01T10:01:00.000Z',
          mes: 'The brass key stays hidden in the cellar behind the wine racks.',
        },
      ],
    }, emptyChat!.revision)
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
      'tavern_history_search',
      'memory_search',
      'memory_read',
      'memory_write',
      'memory_update',
      'memory_forget',
      'variable_get',
      'variable_set',
      'variable_patch',
      'variable_delete',
      'variable_list',
      'tavern_deduce',
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
    expect(scene).toMatchObject({ character: CHARACTER, messageCount: 2, truncated: false })
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

  it('searches chat history of the bound chat only by derived identity', async () => {
    const exec = { agent: { id: 'native' } }
    const result = await tools.get('tavern_history_search')!.execute({ query: 'brass key' }, exec)
    expect(result.sourceCount).toBe(1)
    expect(result.hits[0]).toMatchObject({
      name: CHARACTER,
      isUser: false,
      excerpt: 'The brass key stays hidden in the cellar behind the wine racks.',
      source: { kind: 'chat-history' },
    })
    const empty = await tools.get('tavern_history_search')!.execute({ query: 'nonexistent topic' }, exec)
    expect(empty).toMatchObject({ hits: [], sourceCount: 0, truncated: false })
    await expect(tools.get('tavern_history_search')!.execute({ query: '   ' }, exec))
      .rejects.toThrow('history query requires at least one word')
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

  it('reads, conditionally updates, and soft-forgets a memory by id and revision', async () => {
    const exec = { agent: { id: 'native' } }
    const written = await tools.get('memory_write')!.execute({
      scope: 'character', kind: 'episodic', content: 'The user fears deep water.', confidence: 0.6,
    }, exec)
    const read = await tools.get('memory_read')!.execute({ id: written.id, scope: 'character' }, exec)
    expect(read).toMatchObject({
      found: true, id: written.id, scope: 'character', content: 'The user fears deep water.', confidence: 0.6,
    })
    expect(read.revision).toBe(written.revision)
    await expect(tools.get('memory_update')!.execute({
      id: written.id, scope: 'character', expectedRevision: 'stale', content: 'changed',
    }, exec)).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    const updated = await tools.get('memory_update')!.execute({
      id: written.id, scope: 'character', expectedRevision: written.revision, content: 'The user overcame the fear of deep water.',
    }, exec)
    expect(updated.revision).not.toBe(written.revision)
    const reread = await tools.get('memory_read')!.execute({ id: written.id }, exec)
    expect(reread).toMatchObject({ found: true, content: 'The user overcame the fear of deep water.', confidence: 0.6 })
    await expect(tools.get('memory_update')!.execute({
      id: 'missing-memory', scope: 'character', expectedRevision: 'x', content: 'nope',
    }, exec)).rejects.toThrow('not found')
    const forgotten = await tools.get('memory_forget')!.execute({
      id: written.id, scope: 'character', expectedRevision: updated.revision,
    }, exec)
    expect(forgotten).toMatchObject({ id: written.id, scope: 'character', found: true })
    expect(await tools.get('memory_read')!.execute({ id: written.id, scope: 'character' }, exec))
      .toMatchObject({ found: false })
    const search = await tools.get('memory_search')!.execute({ query: 'deep water', scope: 'character' }, exec)
    expect(search.sourceCount).toBe(0)
  })

  it('patches, lists, and deletes variables behind CAS revisions', async () => {
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
    await expect(tools.get('variable_patch')!.execute({
      scope: 'agent',
      changes: [
        { name: 'mood', value: 'calm' },
        { name: 'relationship', value: { trust: 9 }, expectedRevision: 'stale' },
      ],
    }, exec)).rejects.toMatchObject({ code: 'VARIABLE_REVISION_CONFLICT' })
    const patched = await tools.get('variable_patch')!.execute({
      scope: 'agent',
      changes: [
        { name: 'mood', value: 'calm' },
        { name: 'relationship', value: { trust: 9 } },
      ],
    }, exec)
    expect(patched.variables).toHaveLength(2)
    const listed = await tools.get('variable_list')!.execute({ scope: 'agent', prefix: 'rel' }, exec)
    expect(listed.variables).toHaveLength(1)
    expect(listed.variables[0]).toMatchObject({ name: 'relationship', value: { trust: 9 } })
    const removed = await tools.get('variable_delete')!.execute({ scope: 'agent', name: 'mood' }, exec)
    expect(removed).toMatchObject({ found: true, scope: 'agent', name: 'mood' })
    expect(await tools.get('variable_get')!.execute({ scope: 'agent', name: 'mood' }, exec))
      .toMatchObject({ found: false })
    expect(await tools.get('variable_delete')!.execute({ scope: 'agent', name: 'mood' }, exec))
      .toMatchObject({ found: false })
  })

  it('expires turn-scoped variables only for the owning session', async () => {
    const exec = { agent: { id: 'native' } }
    await tools.get('variable_set')!.execute({ scope: 'turn', name: 'draft_line', value: 'once upon a time' }, exec)
    expect(await tools.get('variable_get')!.execute({ scope: 'turn', name: 'draft_line' }, exec))
      .toMatchObject({ found: true, value: 'once upon a time' })
    const variables = await VariableStore.open(join(home, 'tavern'))
    await variables.clear('turn', 'native')
    expect(await tools.get('variable_get')!.execute({ scope: 'turn', name: 'draft_line' }, exec))
      .toMatchObject({ found: false })
  })

  it('rejects global scope writes until the user enables them', async () => {
    const exec = { agent: { id: 'native' } }
    const store = await TavernStore.open(join(home, 'tavern'))
    await store.updateState(() => ({ agentTavernAllowGlobalWrites: false }))
    await expect(tools.get('memory_write')!.execute({
      scope: 'global', kind: 'semantic', content: 'global fact',
    }, exec)).rejects.toThrow('global scope writes are disabled')
    await expect(tools.get('variable_set')!.execute({
      scope: 'global', name: 'global_flag', value: true,
    }, exec)).rejects.toThrow('global scope writes are disabled')
    await store.updateState(() => ({ agentTavernAllowGlobalWrites: true }))
    const written = await tools.get('memory_write')!.execute({
      scope: 'global', kind: 'semantic', content: 'The user prefers concise replies.',
    }, exec)
    expect(written).toMatchObject({ scope: 'global' })
    await tools.get('variable_set')!.execute({ scope: 'global', name: 'global_flag', value: true }, exec)
    const search = await tools.get('memory_search')!.execute({ query: 'concise replies', scope: 'global' }, exec)
    expect(search.sourceCount).toBe(1)
    const memory = await MemoryStore.open(join(home, 'tavern'))
    await memory.forget(written.id, 'global', 'global', written.revision)
    await store.updateState(() => ({ agentTavernAllowGlobalWrites: false }))
  })

  it('rejects ST agents instead of silently using the native tool path', async () => {
    await expect(tools.get('tavern_character_get')!.execute({}, { agent: { id: 'st' } }))
      .rejects.toThrow('AgentTavern binding is unavailable')
  })

  it('fails the deduction tool loud when the deployment has no subagent runtime', async () => {
    await expect(tools.get('tavern_deduce')!.execute({
      scenario: 'The moon gate falls at midnight.',
      roles: [
        { name: 'Defender', brief: 'Holds the gate.' },
        { name: 'Besieger', brief: 'Wants the gate.' },
      ],
    }, { agent: { id: 'native' } })).rejects.toThrow('subagent runtime is unavailable')
  })
})

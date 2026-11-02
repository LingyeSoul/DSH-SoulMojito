/**
 * Variable Gateway / merge characterization: pure mirror flattening, JSON
 * normalization, the chat/character/global read+replace matrix, binding
 * collisions (character + chatId), empty-tree key removal and mirror
 * degradation. Real TavernStore + VariableStore, no HTTP layer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatRevisionConflictError,
  TavernStore,
  VariableStore,
  type JsonValue,
  type TavernSessionBinding,
} from '../../tavern-store/src/index.js'
import {
  createVariableGateway,
  type VariableGatewayDeps,
} from '../src/variable-gateway.js'
import { normalizeVariableTree, variableEntriesForMirror } from '../src/variable-merge.js'
import { overlayScopedVariables } from '../src/mvu.js'

const CHARACTER = 'Gateway Probe'

function cardData(name: string, variables: Record<string, unknown>) {
  return {
    name,
    description: `${name} card`,
    personality: '',
    scenario: '',
    first_mes: 'Hello',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: { variables },
  }
}

describe('variableEntriesForMirror', () => {
  it('keeps MVU stat trees whole, flattens leaves and skips $ controls', () => {
    const stat = { 主角: { '身份&职业': '学生' } }
    const previous = { 主角: { '身份&职业': '教师' } }
    expect(variableEntriesForMirror({
      stat_data: stat,
      previous_stat_data: previous,
      mvu: { favor: 1, $internal: true },
      $schema: { version: 1 },
      list: [1, 2],
      'bad name': 1,
    })).toEqual([
      { name: 'stat_data', value: stat },
      { name: 'previous_stat_data', value: previous },
      { name: 'mvu.favor', value: 1 },
      { name: 'list', value: [1, 2] },
    ])
  })
})

describe('normalizeVariableTree', () => {
  it('clones JSON trees and rejects non-JSON values with the offending path', () => {
    expect(normalizeVariableTree({ a: [1, { b: true }], c: null }, 'tree')).toEqual({ a: [1, { b: true }], c: null })
    expect(() => normalizeVariableTree({ a: undefined }, 'tree')).toThrow('tree.a is not a JSON value')
    expect(() => normalizeVariableTree({ a: Number.NaN }, 'tree')).toThrow('tree.a must be a finite number')
    expect(() => normalizeVariableTree({ a: new Date() }, 'tree')).toThrow('tree.a is not a JSON value')
  })

  it('rejects prototype-writing keys at any depth', () => {
    expect(() => normalizeVariableTree(JSON.parse('{"__proto__":{"polluted":true}}'), 'tree'))
      .toThrow('tree.__proto__ is not allowed')
    expect(() => normalizeVariableTree({ safe: JSON.parse('{"constructor":1}') }, 'tree'))
      .toThrow('tree.safe.constructor is not allowed')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('skips prototype-writing flat paths in the overlay', () => {
    expect(overlayScopedVariables({}, [{ name: '__proto__.polluted', value: true }])).toEqual({})
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('Variable Gateway (real stores)', () => {
  let home: string
  let store: TavernStore
  let variableStore: VariableStore
  let chatId: string
  let warnings: Array<{ message: string; fields: Record<string, JsonValue> }>

  const bindingOf: VariableGatewayDeps['bindingOf'] = async (character, forChatId) => {
    const state = await store.getState()
    return Object.values(state.sessionBindings).find((binding) =>
      binding.architecture === 'agent-tavern'
      && binding.character === character
      && binding.chatId === forChatId)
  }

  function makeGateway(
    resolveBinding: VariableGatewayDeps['bindingOf'],
    resolveVariables: VariableGatewayDeps['variables'],
  ) {
    warnings = []
    return createVariableGateway({
      store: async () => store,
      variables: resolveVariables,
      bindingOf: resolveBinding,
      logger: {
        warn: (message, fields) => { warnings.push({ message, fields }) },
      },
    })
  }

  async function bindAgentTavern(character: string, forChatId: string): Promise<void> {
    const binding: TavernSessionBinding = {
      architecture: 'agent-tavern',
      contextMode: 'dsh-native',
      character,
      chatId: forChatId,
    }
    await store.updateState((current) => ({
      sessionBindings: { ...current.sessionBindings, [`${character}\u0000${forChatId}`]: binding },
    }))
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-variable-gateway-'))
    const root = join(home, 'soulmojito')
    store = await TavernStore.open(root)
    variableStore = await VariableStore.open(root)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: cardData(CHARACTER, { affinity: 1 }),
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { variables: { seed: 1, stat_data: { hp: 1 } } },
    }, [])
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('overlays flat chat variables only when binding matches character + chatId', async () => {
    await variableStore.patch('chat', chatId, [
      { name: 'stat_data.hp', value: 99 },
      { name: 'overlay', value: 'flat' },
    ])
    const base = { seed: 1, stat_data: { hp: 1 } }

    const unbound = makeGateway(async () => undefined, async () => variableStore)
    expect(await unbound.read({ kind: 'chat', character: CHARACTER, chatId })).toEqual(base)

    await bindAgentTavern(CHARACTER, chatId)
    const bound = makeGateway(bindingOf, async () => variableStore)
    // The authoritative stat_data tree wins over stale flat stat_data.* entries.
    expect(await bound.read({ kind: 'chat', character: CHARACTER, chatId })).toEqual({ ...base, overlay: 'flat' })

    const mismatched = makeGateway(
      async () => ({ architecture: 'agent-tavern', contextMode: 'dsh-native', character: 'Other', chatId }),
      async () => variableStore,
    )
    expect(await mismatched.read({ kind: 'chat', character: CHARACTER, chatId })).toEqual(base)
  })

  it('writes the chat tree, mirrors stat_data whole, and removes the key for an empty tree', async () => {
    await bindAgentTavern(CHARACTER, chatId)
    await variableStore.patch('chat', chatId, [{ name: 'stale', value: 1 }])
    const gateway = makeGateway(bindingOf, async () => variableStore)
    const tree = normalizeVariableTree({
      stat_data: { '身份&职业': '学生' },
      fresh: 2,
    }, 'tree')

    const receipt = await gateway.replace({ kind: 'chat', character: CHARACTER, chatId }, tree)
    expect(receipt.mirror).toEqual({ status: 'ok' })
    expect(receipt.revision).toBeDefined()
    expect(receipt.floorCount).toBe(0)
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toEqual(tree)
    expect((await variableStore.listAll('chat', chatId)).map((entry) => ({ name: entry.name, value: entry.value })))
      .toEqual([
        { name: 'fresh', value: 2 },
        { name: 'stat_data', value: { '身份&职业': '学生' } },
      ])

    const cleared = await gateway.replace({ kind: 'chat', character: CHARACTER, chatId }, {})
    expect(cleared.mirror).toEqual({ status: 'ok' })
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toBeUndefined()
    expect(await variableStore.listAll('chat', chatId)).toEqual([])
  })

  it('does not mirror when the bound chat belongs to another character', async () => {
    await variableStore.patch('chat', chatId, [{ name: 'stale', value: 1 }])
    const gateway = makeGateway(
      async () => ({ architecture: 'agent-tavern', contextMode: 'dsh-native', character: 'Other', chatId }),
      async () => variableStore,
    )

    const receipt = await gateway.replace(
      { kind: 'chat', character: CHARACTER, chatId },
      normalizeVariableTree({ fresh: 1 }, 'tree'),
    )
    expect(receipt.mirror).toEqual({ status: 'not-applicable' })
    expect((await variableStore.listAll('chat', chatId)).map((entry) => entry.name)).toEqual(['stale'])
  })

  it('degrades the mirror explicitly while keeping the authoritative chat write', async () => {
    await bindAgentTavern(CHARACTER, chatId)
    let attempts = 0
    const gateway = makeGateway(bindingOf, async () => {
      attempts += 1
      throw new Error('variable store offline')
    })

    const receipt = await gateway.replace(
      { kind: 'chat', character: CHARACTER, chatId },
      normalizeVariableTree({ a: 1 }, 'tree'),
    )
    expect(receipt.mirror).toEqual({ status: 'degraded', reason: 'variable store offline' })
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toEqual({ a: 1 })
    expect(attempts).toBe(3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.fields).toMatchObject({ chatId, attempts: 3, reason: 'variable store offline' })
  })

  it('mirrors an already-saved tree without rewriting the chat and without deleting unrelated flat variables', async () => {
    await bindAgentTavern(CHARACTER, chatId)
    await variableStore.patch('chat', chatId, [{ name: 'keep', value: 7 }])
    const gateway = makeGateway(bindingOf, async () => variableStore)
    const before = (await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables ?? {}

    const mirror = await gateway.mirror(
      { kind: 'chat', character: CHARACTER, chatId },
      normalizeVariableTree({ mirrored: 1 }, 'tree'),
    )
    expect(mirror).toEqual({ status: 'ok' })
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toEqual(before)
    const entries = await variableStore.listAll('chat', chatId)
    expect(entries.map((entry) => entry.name)).toContain('mirrored')
    expect(entries.find((entry) => entry.name === 'keep')?.value).toBe(7)
  })

  it('degrades a mirror for a missing chat instead of writing orphan flat state', async () => {
    await bindAgentTavern(CHARACTER, chatId)
    const gateway = makeGateway(bindingOf, async () => variableStore)
    const outcome = await gateway.mirror(
      { kind: 'chat', character: CHARACTER, chatId: 'missing-chat.jsonl' },
      normalizeVariableTree({ orphan: 1 }, 'tree'),
    )
    expect(outcome).toEqual({ status: 'degraded', reason: "chat 'missing-chat.jsonl' not found" })
    expect(await variableStore.listAll('chat', 'missing-chat.jsonl')).toEqual([])
  })

  it('degrades when the binding probe fails after the chat save', async () => {
    const gateway = makeGateway(
      async () => { throw new Error('state offline') },
      async () => variableStore,
    )
    const receipt = await gateway.replace(
      { kind: 'chat', character: CHARACTER, chatId },
      normalizeVariableTree({ a: 1 }, 'tree'),
    )
    expect(receipt.mirror).toEqual({ status: 'degraded', reason: 'state offline' })
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toEqual({ a: 1 })
  })

  it('retries a chat CAS conflict by re-reading before the write', async () => {
    const original = store.saveChat.bind(store)
    let attempts = 0
    const spy = vi.spyOn(store, 'saveChat').mockImplementation(async (...args) => {
      attempts += 1
      if (attempts === 1) throw new ChatRevisionConflictError('stale', 'actual')
      return original(...args)
    })
    try {
      const gateway = makeGateway(async () => undefined, async () => variableStore)
      const receipt = await gateway.replace(
        { kind: 'chat', character: CHARACTER, chatId },
        normalizeVariableTree({ a: 1 }, 'tree'),
      )
      expect(attempts).toBe(2)
      expect(receipt.mirror).toEqual({ status: 'not-applicable' })
      expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toEqual({ a: 1 })
    } finally {
      spy.mockRestore()
    }
  })

  it('routes character overlays and global state through updateState', async () => {
    const gateway = makeGateway(async () => undefined, async () => variableStore)
    expect(await gateway.read({ kind: 'character', character: CHARACTER })).toEqual({ affinity: 1 })
    expect(await gateway.read({ kind: 'character', character: 'Missing' })).toEqual({})

    const characterReceipt = await gateway.replace(
      { kind: 'character', character: CHARACTER },
      normalizeVariableTree({ affinity: 2 }, 'tree'),
    )
    expect(characterReceipt.mirror).toEqual({ status: 'not-applicable' })
    expect(await gateway.read({ kind: 'character', character: CHARACTER })).toEqual({ affinity: 2 })

    const globalReceipt = await gateway.replace({ kind: 'global' }, normalizeVariableTree({ g: 2 }, 'tree'))
    expect(globalReceipt.mirror).toEqual({ status: 'not-applicable' })
    expect(await gateway.read({ kind: 'global' })).toEqual({ g: 2 })
  })
})

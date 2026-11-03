/**
 * Variable Gateway undo: staged body undo purity, the schema screen, and the
 * panel undo delegation to the ST / AgentTavern cores. Real TavernStore +
 * VariableStore, no HTTP layer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TavernStore,
  VariableStore,
  type JsonValue,
  type TavernSessionBinding,
} from '../../tavern-store/src/index.js'
import {
  MvuUndoRefusalError,
  appendMvuReceipt,
  readMvuReceipts,
  type MvuReceipt,
} from '../src/mvu.js'
import {
  applyVariableUndo,
  createVariableGateway,
  stageChatVariables,
  type VariableGatewayDeps,
} from '../src/variable-gateway.js'

const CHARACTER = 'Gateway Undo Probe'

function cardData(name: string) {
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
    extensions: {},
  }
}

function receiptOf(before: unknown, after: unknown): MvuReceipt {
  return {
    at: '2026-11-02T00:00:00.000Z',
    turnKey: '1',
    status: 'updated',
    changes: [{ name: 'mvu.favor', before, after }],
    failures: [],
  }
}

describe('Variable Gateway undo (real stores)', () => {
  let home: string
  let store: TavernStore
  let variableStore: VariableStore
  let warnings: Array<{ message: string; fields: Record<string, JsonValue> }>

  function makeGateway(resolveBinding: VariableGatewayDeps['bindingOf']) {
    warnings = []
    return createVariableGateway({
      store: async () => store,
      variables: async () => variableStore,
      bindingOf: resolveBinding,
      logger: {
        warn: (message, fields) => { warnings.push({ message, fields }) },
      },
    })
  }

  async function craftChat(
    variables: Record<string, unknown> | undefined,
    receipts: readonly MvuReceipt[],
  ): Promise<string> {
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: variables === undefined ? {} : { variables },
    }, [])
    if (receipts.length === 0) return chatId
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error(`crafted chat '${chatId}' disappeared`)
    for (const receipt of receipts) appendMvuReceipt(snapshot.chat, receipt)
    await store.saveChat(CHARACTER, chatId, snapshot.chat, snapshot.revision)
    return chatId
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-variable-gateway-undo-'))
    const root = join(home, 'soulmojito')
    store = await TavernStore.open(root)
    variableStore = await VariableStore.open(root)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: cardData(CHARACTER),
    })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('stages the undo on a new chat, marks receipts, and restores variables', async () => {
    const chatId = await craftChat({ mvu: { favor: 20 } }, [receiptOf(10, 20)])
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('chat missing')
    const input = snapshot.chat
    const before = structuredClone(input)

    const staged = applyVariableUndo(input, readMvuReceipts(input), {
      schema: undefined,
      currentOf: () => 20,
    })

    expect(staged.chat).not.toBe(input)
    expect(input).toEqual(before)
    expect(staged.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 10 } })
    expect(staged.restores).toEqual([{ path: 'mvu.favor', value: 10 }])
    expect(staged.receipts).toHaveLength(1)
    expect(typeof staged.receipts[0]?.undoneAt).toBe('string')
  })

  it('refuses on schema drift and leaves the input chat untouched', async () => {
    const chatId = await craftChat({ mvu: { favor: 100 } }, [receiptOf(80, 100)])
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('chat missing')
    const input = snapshot.chat
    const before = structuredClone(input)

    expect(() => applyVariableUndo(input, readMvuReceipts(input), {
      schema: { mvu: { favor: { $range: [0, 50] } } },
      currentOf: () => 100,
    })).toThrow(MvuUndoRefusalError)
    expect(input).toEqual(before)
  })

  it('stages a normalized tree and removes the key for an empty tree', async () => {
    const chatId = await craftChat(undefined, [])
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('chat missing')
    const chat = snapshot.chat

    stageChatVariables(chat, { mvu: { favor: 10 }, tags: ['a', 'b'], nested: { ok: true } })
    expect(chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 10 }, tags: ['a', 'b'], nested: { ok: true } })
    expect(JSON.parse(JSON.stringify(chat.header.chat_metadata.variables)))
      .toEqual({ mvu: { favor: 10 }, tags: ['a', 'b'], nested: { ok: true } })

    const before = structuredClone(chat.header.chat_metadata.variables)
    expect(() => stageChatVariables(chat, { bad: Number.NaN })).toThrow(/finite number/)
    expect(chat.header.chat_metadata.variables).toEqual(before)

    stageChatVariables(chat, {})
    expect('variables' in chat.header.chat_metadata).toBe(false)
  })

  it('undo delegates to the ST core for an unbound chat and restores the JSONL tree', async () => {
    const chatId = await craftChat({ mvu: { favor: 20 } }, [receiptOf(10, 20)])
    const gateway = makeGateway(async () => undefined)

    const result = await gateway.undo({ kind: 'chat', character: CHARACTER, chatId })

    expect(result.receipt.turnKey).toBe('1')
    expect(typeof result.receipt.undoneAt).toBe('string')
    expect(result.restores).toEqual([{ path: 'mvu.favor', value: 10 }])
    expect(typeof result.revision).toBe('string')
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables)
      .toEqual({ mvu: { favor: 10 } })
    expect(warnings).toEqual([])
  })

  it('undo delegates to the Agent core for an agent-tavern binding and restores the flat store', async () => {
    const chatId = await craftChat(undefined, [receiptOf(10, 20)])
    const binding: TavernSessionBinding = {
      architecture: 'agent-tavern',
      contextMode: 'dsh-native',
      character: CHARACTER,
      chatId,
    }
    await store.updateState((current) => ({
      sessionBindings: { ...current.sessionBindings, [`${CHARACTER}\u0000${chatId}`]: binding },
    }))
    await variableStore.patch('chat', chatId, [{ name: 'mvu.favor', value: 20 }])
    const gateway = makeGateway(async (character, forChatId) => {
      const state = await store.getState()
      return Object.values(state.sessionBindings).find((entry) =>
        entry.architecture === 'agent-tavern'
        && entry.character === character
        && entry.chatId === forChatId)
    })

    const result = await gateway.undo({ kind: 'chat', character: CHARACTER, chatId })

    expect(result.restores).toEqual([{ path: 'mvu.favor', value: 10 }])
    expect(await variableStore.get('chat', chatId, 'mvu.favor')).toMatchObject({ value: 10 })
    // The Agent core writes the flat store, not the JSONL mirror.
    expect((await store.getChatSnapshot(CHARACTER, chatId))?.chat.header.chat_metadata.variables).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('throws a clear error when the chat snapshot is missing', async () => {
    const gateway = makeGateway(async () => undefined)
    const missing = '20990101000000000.jsonl'

    await expect(gateway.undo({ kind: 'chat', character: CHARACTER, chatId: missing }))
      .rejects.toThrow(`chat '${missing}' of character '${CHARACTER}' not found; undoing variables requires a persisted chat snapshot`)
  })
})

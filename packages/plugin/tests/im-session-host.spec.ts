import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import {
  ImSessionError,
  bindImChat,
  ensureImSession,
  inspectImSessionCapabilities,
  type ImSessionDeps,
} from '../src/im/session-host.js'

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-session-'))
  db = await TavernStore.open(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Harness {
  deps: ImSessionDeps
  created: Array<Record<string, unknown>>
  resumed: Array<Record<string, unknown>>
  binds: Array<{ sessionId: string; character: string; chatId: string }>
  live: Map<string, unknown>
}

function harness(options: { withResume?: boolean; withPresets?: boolean } = {}): Harness {
  const created: Harness['created'] = []
  const resumed: Harness['resumed'] = []
  const binds: Harness['binds'] = []
  const live = new Map<string, unknown>()
  const agents: NonNullable<ImSessionDeps['agents']> = {
    get: (sessionId) => live.get(sessionId),
    create: async (args) => {
      created.push(args)
      const agent = { id: args['sessionId'], followup: async () => {} }
      live.set(String(args['sessionId']), agent)
      return { agent }
    },
  }
  if (options.withResume !== false) {
    agents.resume = async (args) => {
      resumed.push(args)
      throw new Error(`no persisted session ${String(args['resumeSessionId'])}`)
    }
  }
  const deps: ImSessionDeps = {
    db,
    agents,
    presets: options.withPresets === false ? undefined : { mount: async () => ({}) },
    presetId: 'agent-tavern',
    ensurePreset: async () => {},
    workspace: async () => root,
    bind: async (sessionId, character, chatId) => {
      binds.push({ sessionId, character, chatId })
    },
    presetChanged: async () => {},
  }
  return { deps, created, resumed, binds, live }
}

async function seedCharacterAndChat(character: string): Promise<string> {
  await db.importCharacter({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character,
      description: '',
      personality: '',
      scenario: '',
      first_mes: '你好。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
    },
  })
  return db.createChat(character, { user_name: 'unused', character_name: 'unused', chat_metadata: {} }, [])
}

describe('inspectImSessionCapabilities', () => {
  it('requires an agents service and a mountable preset', () => {
    expect(inspectImSessionCapabilities(undefined, undefined).available).toBe(false)
    expect(inspectImSessionCapabilities({ get: () => undefined }, { mount: async () => ({}) }).reasons)
      .toContain('the host agents service exposes neither create nor resume')
    expect(inspectImSessionCapabilities({ create: async () => ({ agent: {} }) }, {}).available).toBe(false)
    expect(inspectImSessionCapabilities({ create: async () => ({ agent: {} }) }, { mount: async () => ({}) }).available).toBe(true)
  })
})

describe('bindImChat', () => {
  it('creates a session for an existing chat and binds it to AgentTavern', async () => {
    const chatId = await seedCharacterAndChat('Example')
    const h = harness()
    const result = await bindImChat(h.deps, { character: 'Example', chatId }, undefined)
    expect(result.sessionId).toMatch(/^session-/)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]?.['meta']).toMatchObject({ agentPreset: 'agent-tavern', cwd: root })
    expect(h.binds).toEqual([{ sessionId: result.sessionId, character: 'Example', chatId }])
  })

  it('reuses the given session id and never creates a second one', async () => {
    const chatId = await seedCharacterAndChat('Example')
    const h = harness()
    h.live.set('session-existing', { id: 'session-existing' })
    const result = await bindImChat(h.deps, { character: 'Example', chatId }, 'session-existing')
    expect(result.sessionId).toBe('session-existing')
    expect(h.created).toHaveLength(0)
  })

  it('refuses a chat that no longer exists', async () => {
    const h = harness()
    await expect(bindImChat(h.deps, { character: 'Missing', chatId: 'gone.jsonl' }, undefined))
      .rejects.toBeInstanceOf(ImSessionError)
  })

  it('fails closed when the host cannot mount a preset', async () => {
    const chatId = await seedCharacterAndChat('Example')
    const h = harness({ withPresets: false })
    await expect(bindImChat(h.deps, { character: 'Example', chatId }, undefined))
      .rejects.toThrow(/IM sessions are unavailable/)
  })
})

describe('ensureImSession', () => {
  it('independent mode creates a fresh chat from the source character', async () => {
    const sourceChatId = await seedCharacterAndChat('Example')
    const h = harness()
    const result = await ensureImSession(h.deps, {
      mode: 'independent',
      peerKey: 'qq:acct:private:peer-a',
      sourceChat: { character: 'Example', chatId: sourceChatId },
    })
    expect(result.chatId).not.toBe(sourceChatId)
    const snapshot = await db.getChatSnapshot('Example', result.chatId)
    expect(snapshot?.chat.messages[0]?.mes).toBe('你好。')
    expect(h.created).toHaveLength(1)
  })

  it('shared mode binds the very same chat and session', async () => {
    const chatId = await seedCharacterAndChat('Example')
    const h = harness()
    const first = await ensureImSession(h.deps, {
      mode: 'shared',
      peerKey: 'qq:acct:private:peer-a',
      sharedChat: { character: 'Example', chatId },
    })
    h.live.set(first.sessionId, { id: first.sessionId })
    const second = await ensureImSession(h.deps, {
      mode: 'shared',
      peerKey: 'qq:acct:group:g1',
      sharedChat: { character: 'Example', chatId },
      existingSessionId: first.sessionId,
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.chatId).toBe(chatId)
    expect(h.created).toHaveLength(1)
  })

  it('imports history only after the binding is written', async () => {
    const sourceChatId = await seedCharacterAndChat('Example')
    const events: Array<{ type: string; data: unknown }> = []
    let binds = 0
    let bindingCountAtFirstAppend = -1
    const agent = {
      id: 'session-import-order',
      phase: { kind: 'idle', lastTurn: 0 },
      session: {
        events,
        append: (type: string, data: unknown) => {
          if (bindingCountAtFirstAppend < 0) bindingCountAtFirstAppend = binds
          events.push({ type, data })
        },
      },
      followup: async () => {},
    }
    const deps: ImSessionDeps = {
      db,
      agents: { get: () => undefined, create: async () => ({ agent }) },
      presets: { mount: async () => ({}) },
      presetId: 'agent-tavern',
      ensurePreset: async () => {},
      workspace: async () => root,
      bind: async () => { binds += 1 },
      presetChanged: async () => {},
    }
    const result = await ensureImSession(deps, {
      mode: 'independent',
      peerKey: 'qq:acct:private:peer-a',
      sourceChat: { character: 'Example', chatId: sourceChatId },
    })
    // 绑定先落盘，导入才被投影器认作本会话；顺序反了就会写成无主楼层。
    expect(bindingCountAtFirstAppend).toBe(1)
    expect(events.some((event) => event.type === 'turn/start')).toBe(true)
    expect(result.chatId).not.toBe(sourceChatId)
  })

  it('reports a missing source chat instead of inventing one', async () => {
    const h = harness()
    await expect(ensureImSession(h.deps, {
      mode: 'independent',
      peerKey: 'qq:acct:private:peer-a',
      sourceChat: { character: 'Missing', chatId: 'gone.jsonl' },
    })).rejects.toThrow(/no longer exists/)
  })
})

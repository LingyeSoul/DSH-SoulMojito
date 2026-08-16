import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = '露西'

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function makeAgent(id: string) {
  const events: Array<{ type: string; data: unknown }> = []
  return {
    id,
    session: {
      events,
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  }
}

function turnStarts(agent: ReturnType<typeof makeAgent>) {
  return agent.session.events.filter((event) => event.type === 'turn/start')
}

describe('/tavern command host-session occupation', () => {
  let home: string
  let store: TavernStore
  let handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }>
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-occupy-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    chatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])

    let definition: { handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }> } | undefined
    apply({
      systemPrompt: { section: () => {} },
      commands: { register: (def) => { definition = def } },
      webServer: { register: () => () => {} },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(definition).toBeDefined()
    handler = definition!.handler
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('appends an occupation turn pair when the host session has no turn/start', async () => {
    const agent = makeAgent('session-a')
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(result.kind).toBe('success')
    expect((await store.getState()).sessionBindings['session-a']).toEqual({ character: CHARACTER, chatId })
    const starts = turnStarts(agent)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.data).toEqual({ turn: 1 })
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('is idempotent: repairing an already-occupied session appends no further turns', async () => {
    const agent = makeAgent('session-a')
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(turnStarts(agent)).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'user/message')).toHaveLength(0)
  })

  it('does not pollute a session that already has real host turns', async () => {
    const agent = makeAgent('session-b')
    agent.session.append('turn/start', { turn: 7 })
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(turnStarts(agent)).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'turn/end')).toHaveLength(0)
  })
})

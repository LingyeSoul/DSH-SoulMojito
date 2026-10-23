/**
 * Frontend generation world-info scan (2026-10-23).
 *
 * Synthetic card/world fixtures only: this suite must not carry any third-party
 * card text, remote frontend URL or real user data. It proves that scan-only
 * JSR injects are resolved from the chat world books and that a session copy
 * wins over the shared asset; no base asset is written.
 */
import { describe, expect, it } from 'vitest'
import { decodeCharacterCard, type WorldBookIR } from '../../tavern-format/src/index.js'
import type { TavernState, TavernStore } from '../../tavern-store/src/index.js'
import { applyFrontendWorldbookScan } from '../src/frontend-generation-context.js'

const CHARACTER = 'ExampleCard'
const CHAT_ID = 'example-chat'
const WORLD = 'Example World'

function card() {
  return decodeCharacterCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER,
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      character_book: { entries: [] },
      extensions: { world: WORLD },
    },
  })
}

function world(content: string): WorldBookIR {
  return {
    name: WORLD,
    entries: [{
      uid: 0,
      key: ['[TAG:EXAMPLE]'],
      keysecondary: [],
      comment: 'example contract',
      content,
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: false,
      order: 100,
      position: 0,
      disable: false,
      ignoreBudget: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: true,
      depth: 4,
      outletName: '',
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      triggers: [],
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
    }],
  }
}

function fakeStore(base: WorldBookIR | undefined, session: WorldBookIR | undefined): TavernStore {
  return {
    getCharacter: async () => ({ card: card() }),
    getWorld: async () => base,
    getChatWorld: async () => session,
    getPersona: async () => undefined,
  } as unknown as TavernStore
}

const state = {
  activeWorlds: [],
  worldFollowsCharacter: true,
  disabledAutoWorlds: [],
  activePersona: undefined,
} as unknown as TavernState

function config() {
  return {
    user_input: 'Generate the example payload.',
    injects: [
      { role: 'system', content: '<user_input>Example instruction</user_input>', position: 'in_chat', depth: 0 },
      { role: 'system', content: '[TAG:EXAMPLE]', position: 'none', depth: 0, should_scan: true },
    ],
  }
}

describe('applyFrontendWorldbookScan', () => {
  it('injects the session-copy contract and drops the scan-only trigger', async () => {
    const base = world('<example_contract>BASE_ONLY</example_contract>')
    const session = world('<example_contract>SESSION_ONLY</example_contract>')
    const input = config()
    const result = await applyFrontendWorldbookScan(fakeStore(base, session), state, CHARACTER, CHAT_ID, input) as typeof input
    expect(result).not.toBe(input)
    expect(result.injects).toHaveLength(2)
    expect(result.injects[0]).toMatchObject({ role: 'system', position: 'in_chat' })
    expect(result.injects[0]?.content).toContain('SESSION_ONLY')
    expect(result.injects[0]?.content).not.toContain('BASE_ONLY')
    expect(result.injects[1]).toMatchObject({ content: '<user_input>Example instruction</user_input>' })
    expect(input.injects[1]).toMatchObject({ should_scan: true })
  })

  it('falls back to the shared asset when the chat has no session copy', async () => {
    const base = world('<example_contract>BASE_ONLY</example_contract>')
    const input = config()
    const result = await applyFrontendWorldbookScan(fakeStore(base, undefined), state, CHARACTER, CHAT_ID, input) as typeof input
    expect(result.injects[0]?.content).toContain('BASE_ONLY')
  })

  it('leaves the request untouched when no scan source is present', async () => {
    const input = { user_input: 'plain request' }
    const result = await applyFrontendWorldbookScan(fakeStore(undefined, undefined), state, CHARACTER, CHAT_ID, input)
    expect(result).toBe(input)
  })
})

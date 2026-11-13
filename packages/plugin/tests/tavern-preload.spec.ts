import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgentTavernPreloadSnapshot } from '../src/tavern-assets.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Preload Character'

describe('AgentTavern session preload snapshot', () => {
  let home: string
  let store: TavernStore

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-preload-'))
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: 'FULL DESCRIPTION TEXT',
        personality: 'FULL PERSONALITY TEXT',
        scenario: 'FULL SCENARIO TEXT',
        first_mes: 'FIRST MESSAGE TEXT',
        mes_example: 'EXAMPLE DIALOGUE TEXT',
        creator_notes: '',
        system_prompt: 'CARD SYSTEM PROMPT TEXT',
        post_history_instructions: 'CARD POST HISTORY TEXT',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
      },
    })
    await store.importWorldFile('Preload World', {
      entries: {
        '1': {
          uid: 1, key: [], keysecondary: [], comment: 'static', content: 'STATIC CONSTANT LORE',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
        '2': {
          uid: 2, key: [], keysecondary: [], comment: 'ejs', content: '<% const hp = 1; %>EJS CONSTANT LORE',
          constant: true, selective: false, order: 90, position: 0, disable: false,
        },
        '3': {
          uid: 3, key: [], keysecondary: [], comment: 'disabled', content: 'DISABLED CONSTANT LORE',
          constant: true, selective: false, order: 80, position: 0, disable: true,
        },
        '4': {
          uid: 4, key: ['trigger'], keysecondary: [], comment: 'keyword', content: 'KEYWORD LORE',
          constant: false, selective: false, order: 70, position: 0, disable: false,
        },
      },
    })
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps the full card but skips preset-owned fields and raw EJS constants', async () => {
    const character = await store.getCharacter(CHARACTER)
    expect(character).toBeDefined()
    const text = await buildAgentTavernPreloadSnapshot(
      store,
      { activeWorlds: ['Preload World'], worldFollowsCharacter: true },
      CHARACTER,
      character!,
    )

    // Full card reference text stays in the one-time snapshot.
    expect(text).toContain('FULL DESCRIPTION TEXT')
    expect(text).toContain('FULL PERSONALITY TEXT')
    expect(text).toContain('FULL SCENARIO TEXT')
    expect(text).toContain('FIRST MESSAGE TEXT')
    expect(text).toContain('EXAMPLE DIALOGUE TEXT')
    // Constant lore is owned here (except EJS and disabled entries).
    expect(text).toContain('STATIC CONSTANT LORE')
    expect(text).not.toContain('<%')
    expect(text).not.toContain('EJS CONSTANT LORE')
    expect(text).not.toContain('DISABLED CONSTANT LORE')
    expect(text).not.toContain('KEYWORD LORE')
    // Preset projection owns the card's main/jailbreak overrides.
    expect(text).not.toContain('CARD SYSTEM PROMPT TEXT')
    expect(text).not.toContain('CARD POST HISTORY TEXT')
  })
})

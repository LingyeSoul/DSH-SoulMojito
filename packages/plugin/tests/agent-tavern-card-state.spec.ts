import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatCardStateMessage, registerAgentTavernCardState, renderCardStateSections } from '../src/agent-tavern/card-state.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Card State Probe'
const SESSION = 'card-state-session'
let home: string
let store: TavernStore
let chatId: string

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-card-state-'))
  process.env.DSH_HOME = home
  store = await TavernStore.open(join(home, 'tavern'))
  await store.importCharacter({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
      character_version: '',
      extensions: {
        tavern_helper: { scripts: [{ type: 'script', content: "import 'https://x/MagVarUpdate/bundle.js'" }] },
        regex_scripts: [{
          id: 'placeholder', scriptName: 'status placeholder', findRegex: '<StatusPlaceHolderImpl\\/>',
          replaceString: '<StatusPlaceHolderREADY/>', trimStrings: [], placement: [2], disabled: false,
          markdownOnly: true, promptOnly: false,
        }],
      },
      character_book: {
        name: 'Card State Book',
        entries: [
          {
            keys: [], content: "<%_ const stat = getvar('stat_data'); _%>phase: <%- _.get(stat, '进程.阶段', 'none') %>",
            enabled: true, insertion_order: 10, constant: true, comment: 'phase',
          },
          {
            keys: [], content: "<% if (_.get(getvar('stat_data'), '系统状态.主角创建完毕') === true) { %>created<% } else { %>creating<% } %>",
            enabled: true, insertion_order: 20, constant: true, comment: 'creation',
          },
          {
            keys: [], content: '<% [1, 2].forEach((value) => { %>item <%= value %>;<% }) %>',
            enabled: true, insertion_order: 30, constant: true, comment: 'callback',
          },
          {
            keys: [], content: '<%_ if (_.random(1, 6) > 0) { _%>rolled:<%- _.sample(["a", "b"]) %>;<%- _.sampleSize(["x", "y", "z"], 2).join("+") %><%_ } _%>',
            enabled: true, insertion_order: 40, constant: true, comment: 'lodash',
          },
          {
            keys: [], content: 'disabled should not render',
            enabled: false, insertion_order: 50, constant: true, comment: 'disabled',
          },
        ],
      },
    },
  })
  chatId = await store.createChat(CHARACTER, {
    user_name: 'User',
    character_name: CHARACTER,
    chat_metadata: {
      variables: {
        initialized_lorebooks: true,
        stat_data: { 进程: { 阶段: '幕间休息' }, 系统状态: { 主角创建完毕: true } },
      },
    },
  }, [{ name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'greeting' }])
  await store.updateState(() => ({
    sessionBindings: {
      [SESSION]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
    },
    activePersona: 'User',
    activeWorlds: [],
    scriptGlobals: {},
    worldFollowsCharacter: true,
  }))
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('AgentTavern card state rendering', () => {
  it('renders constant EJS entries with live variables and lodash helpers', async () => {
    const state = await store.getState()
    const character = await store.getCharacter(CHARACTER)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const rendered = await renderCardStateSections(store, state, CHARACTER, character!, snapshot!.chat, chatId)
    expect(rendered).toBeDefined()
    expect(rendered!.warnings).toEqual([])
    const byComment = new Map(rendered!.sections.map((section) => [section.comment, section.text]))
    expect(byComment.get('phase')).toBe('phase: 幕间休息')
    expect(byComment.get('creation')).toBe('created')
    expect(byComment.get('callback')).toBe('item 1;item 2;')
    expect(byComment.get('lodash')).toMatch(/^rolled:[ab];[xyz]\+[xyz]$/)
    expect(byComment.has('disabled')).toBe(false)
  })

  it('injects the rendered card state at step 1 through the pre-step listener', async () => {
    let listener: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    registerAgentTavernCardState(
      {
        on: (event, registered) => {
          if (event === 'agent/pre-step') listener = registered as never
          return () => {}
        },
      },
      { openStore: async () => store },
    )
    expect(listener).toBeDefined()
    const decision = await listener!(
      { agent: { session: { id: SESSION } }, turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    ) as { kind: string; messages: Array<{ source: unknown; content: Array<{ text: string }> }> }
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0]!.content[0]!.text).toContain('<tavern-card-state>')
    expect(decision.messages[0]!.content[0]!.text).toContain('phase: 幕间休息')
    expect(decision.messages[0]!.source).toBeDefined()

    const skipped = await listener!(
      { agent: { session: { id: SESSION } }, turn: 1, step: 2 },
      async () => ({ kind: 'enter', messages: [] }),
    ) as { messages: unknown[] }
    expect(skipped.messages).toEqual([])
  })

  it('keeps embedded card rules when worldFollowsCharacter is off', async () => {
    const state = { ...(await store.getState()), worldFollowsCharacter: false }
    const character = await store.getCharacter(CHARACTER)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const rendered = await renderCardStateSections(store, state, CHARACTER, character!, snapshot!.chat, chatId)
    expect(rendered).toBeDefined()
    expect(rendered!.sections.map((section) => section.comment)).toContain('phase')
  })

  it('formats a complete injectable block and a change-only block', async () => {
    const state = await store.getState()
    const character = await store.getCharacter(CHARACTER)
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    const rendered = await renderCardStateSections(store, state, CHARACTER, character!, snapshot!.chat, chatId)
    const full = formatCardStateMessage(rendered!.sections)
    expect(full.startsWith('<tavern-card-state>')).toBe(true)
    expect(full).toContain('### phase')
    expect(full).toContain('phase: 幕间休息')
    const changed = formatCardStateMessage([rendered!.sections[0]!], 'Only changed sections are repeated.')
    expect(changed).toContain('Only changed sections are repeated.')
    expect(changed).toContain('phase: 幕间休息')
    expect(changed).not.toContain('### creation')
  })
})

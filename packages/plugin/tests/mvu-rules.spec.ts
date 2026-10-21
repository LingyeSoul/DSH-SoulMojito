import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { apply as applyAgentTavern } from '../src/agent-tavern/agent.js'
import { readMvuAudit } from '../src/agent-tavern/projector.js'
import { diffVariables, readMvuReceipts, type MvuReceipt } from '../src/mvu.js'
import { stripMvuControl } from '../src/mvu-guard.js'
import {
  MVU_RULE_ROUNDS,
  mergeMvuRuleNotes,
  readMvuRules,
  runMvuRules,
} from '../src/mvu-rules.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'

// C-2 MVU 条件规则引擎（2026-10-11）：卡内 $rules 声明的确定性条件规则，在
// 变量结算（模板写穿 + $schema 守卫）之后做二次计算（派生值/阈值触发/连锁
// 修正），产物进同一回执管线（reason 标 rule:<name>）。语义参考 LWB varevent，
// 见 decisions/2026-10-11-mvu-rules.md。

const RULES_CHARACTER = '阮月'
const PLAIN_CHARACTER = '白榆'
const AGENT_RULES_CHARACTER = 'Rule Agent Character'
const AGENT_PLAIN_CHARACTER = 'Plain Agent Character'
const AGENT_CLAMP_CHARACTER = 'Clamp Agent Character'

const THRESHOLD_RULES = [
  { name: 'favor-unlock', when: "getvar('mvu.favor') >= 80", then: { 'mvu.flags.trusted': 'true' } },
  { name: 'debt-relief', when: "vars.mvu.debt > 150", then: { 'mvu.debt': "Math.floor(getvar('mvu.debt') * 0.5)" } },
]

/* ---------------------------- 纯函数：读取 / 求值核 ---------------------------- */

describe('readMvuRules (pure)', () => {
  const chatOf = (variables: unknown, initial?: unknown) => ({
    header: { user_name: 'u', character_name: 'c', chat_metadata: { variables, initial_variables: initial } },
    messages: [],
  }) as never
  const cardOf = (initialVariables: unknown) => ({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { extensions: { agentTavern: { initialVariables } } },
  }) as never

  it('resolves rules from the chat tree first, then the card, then initial variables', () => {
    const chat = chatOf({ $rules: [{ name: 'from-chat', when: 'true', then: { a: '1' } }] }, { $rules: [{ name: 'from-initial', when: 'true', then: { a: '1' } }] })
    const card = cardOf({ $rules: [{ name: 'from-card', when: 'true', then: { a: '1' } }] })
    expect(readMvuRules(chat, card)).toEqual({ rules: [expect.objectContaining({ name: 'from-chat' })] })
    expect(readMvuRules(chatOf({ mvu: { favor: 1 } }), card)).toEqual({ rules: [expect.objectContaining({ name: 'from-card' })] })
    expect(readMvuRules(chatOf({ mvu: { favor: 1 } }, { $rules: [{ name: 'from-initial', when: 'true', then: { a: '1' } }] }), undefined))
      .toEqual({ rules: [expect.objectContaining({ name: 'from-initial' })] })
    expect(readMvuRules(chatOf({}), undefined)).toBeUndefined()
  })

  it('skips an empty $rules array to the next source (same discipline as readMvuSchema)', () => {
    const chat = chatOf({ $rules: [] })
    const card = cardOf({ $rules: [{ name: 'from-card', when: 'true', then: { a: '1' } }] })
    expect(readMvuRules(chat, card)).toEqual({ rules: [expect.objectContaining({ name: 'from-card' })] })
  })

  it('rejects malformed shapes as invalid for the whole card (non-array, missing name, empty then)', () => {
    expect(readMvuRules(chatOf({ $rules: 'garbage' }), undefined)).toMatchObject({ invalid: expect.stringContaining('$rules must be an array') })
    expect(readMvuRules(chatOf({ $rules: [{ when: 'true', then: { a: '1' } }] }), undefined))
      .toMatchObject({ invalid: expect.stringContaining('requires a non-empty name') })
    expect(readMvuRules(chatOf({ $rules: [{ name: 'x', when: 'true', then: {} }] }), undefined))
      .toMatchObject({ invalid: expect.stringContaining('non-empty then map') })
    expect(readMvuRules(chatOf({ $rules: [{ name: 'x', when: 'true', then: { a: '1' } }, 'junk'] }), undefined))
      .toMatchObject({ invalid: expect.stringContaining('rule #1 is not an object') })
  })
})

describe('runMvuRules (pure core)', () => {
  it('fires threshold rules with nested-tree reads (getvar + vars) and records rule-attributed writes', async () => {
    const tree = { mvu: { favor: 85, debt: 200 } }
    const result = await runMvuRules(THRESHOLD_RULES, { tree })
    expect(result.failures).toEqual([])
    expect(tree).toEqual({ mvu: { favor: 85, debt: 100, flags: { trusted: true } } })
    expect(result.notes).toEqual({ 'mvu.flags.trusted': 'rule:favor-unlock', 'mvu.debt': 'rule:debt-relief' })
    expect(result.writes).toEqual([
      { path: 'mvu.flags.trusted', value: true, rule: 'favor-unlock' },
      { path: 'mvu.debt', value: 100, rule: 'debt-relief' },
    ])
  })

  it('chains within a round: an earlier rule effect is visible to later rules; idempotent rules converge without hitting the cap', async () => {
    const tree = { mvu: { favor: 75 } }
    const rules = [
      { name: 'warm-up', when: "getvar('mvu.favor') >= 75 && getvar('mvu.favor') < 80", then: { 'mvu.favor': "getvar('mvu.favor') + 10" } },
      { name: 'unlock', when: "getvar('mvu.favor') >= 80", then: { 'mvu.flags.trusted': 'true' } },
    ]
    const result = await runMvuRules(rules, { tree })
    expect(result.failures).toEqual([])
    expect(tree).toEqual({ mvu: { favor: 85, flags: { trusted: true } } })
    expect(result.notes).toEqual({
      'mvu.favor': 'rule:warm-up',
      'mvu.flags.trusted': 'rule:unlock',
    })
  })

  it('bounds self re-triggering at 3 rounds and reports the cap as a failure', async () => {
    const tree = { mvu: { counter: 0 } }
    const result = await runMvuRules([{ name: 'tick', when: 'true', then: { 'mvu.counter': "getvar('mvu.counter') + 1" } }], { tree })
    expect(tree.mvu.counter).toBe(MVU_RULE_ROUNDS)
    expect(result.failures).toEqual([expect.stringContaining(`fixed-point iteration hit the ${MVU_RULE_ROUNDS}-round cap`)])
  })

  it('shades nondeterministic globals: Date.now / Math.random / setTimeout throw and skip the rule with a warning', async () => {
    const tree = { mvu: { favor: 10 } }
    const rules = [
      { name: 'clock', when: 'Date.now() > 0', then: { 'mvu.a': '1' } },
      { name: 'dice', when: 'Math.random() < 2', then: { 'mvu.b': '1' } },
      { name: 'timer', when: 'setTimeout(() => 0, 10)', then: { 'mvu.c': '1' } },
      { name: 'safe', when: "Math.floor(getvar('mvu.favor') / 5) === 2", then: { 'mvu.d': 'Math.max(1, 2)' } },
    ]
    const result = await runMvuRules(rules, { tree })
    expect(tree).toEqual({ mvu: { favor: 10, d: 2 } })
    expect(result.failures).toEqual([
      expect.stringContaining("rule 'clock': when evaluation failed"),
      expect.stringContaining("rule 'dice': when evaluation failed"),
      expect.stringContaining("rule 'timer': when evaluation failed"),
    ])
  })

  it('skips the whole rule atomically when a then expression throws; records the path', async () => {
    const tree = { mvu: { favor: 10 } }
    const result = await runMvuRules([{ name: 'broken', when: 'true', then: { 'mvu.a': '1', 'mvu.b': 'missing_identifier' } }], { tree })
    expect(tree).toEqual({ mvu: { favor: 10 } })
    expect(result.failures).toEqual([expect.stringContaining("then evaluation failed for 'mvu.b'")])
  })

  it('refuses writes into the $schema / $rules control subtrees', async () => {
    const tree = { mvu: { favor: 10 } }
    const result = await runMvuRules([{ name: 'hijack', when: 'true', then: { '$rules': '[]' } }], { tree })
    expect(tree).toEqual({ mvu: { favor: 10 } })
    expect(result.failures).toEqual([expect.stringContaining("$rules: rule 'hijack': guard readonly")])
  })

  it('guards rule outputs: clamp lands with a merged note, reject becomes a rule-attributed failure', async () => {
    const schema = { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['calm', 'tense'] } } }
    const tree = { mvu: { favor: 50, mood: 'calm' } }
    const result = await runMvuRules([
      { name: 'bribe', when: 'true', then: { 'mvu.favor': '150' } },
      { name: 'flare', when: 'true', then: { 'mvu.mood': '"angry"' } },
    ], { schema, tree })
    expect(tree).toEqual({ mvu: { favor: 100, mood: 'calm' } })
    expect(result.notes).toEqual({ 'mvu.favor': 'rule:bribe; mvu.favor: guard clamp: 150 -> 100' })
    expect(result.failures).toEqual([expect.stringContaining("mvu.mood: rule 'flare': guard enum-violation")])
  })

  it('evaluates against a per-call deep clone: mutating vars in an expression never writes the tree', async () => {
    const tree = { mvu: { favor: 10 } }
    const result = await runMvuRules([{ name: 'mutator', when: 'vars.mvu.favor = 999, true', then: { 'mvu.probe': 'vars.mvu.favor' } }], { tree })
    expect(tree).toEqual({ mvu: { favor: 10, probe: 10 } })
    expect(result.failures).toEqual([])
  })
})

describe('strip / merge plumbing (pure)', () => {
  it('strips only the $schema/$rules control subtrees and keeps other $-prefixed keys', () => {
    expect(stripMvuControl({ a: 1, $schema: { x: 1 }, $rules: [1], $other: 2 })).toEqual({ a: 1, $other: 2 })
    const untouched = { a: 1 }
    expect(stripMvuControl(untouched)).toBe(untouched)
  })

  it('diffVariables never reports $rules paths as variable changes', () => {
    const before = { $rules: [{ name: 'a', when: 'true', then: {} }], mvu: { favor: 10 } }
    const after = { $rules: [{ name: 'b', when: 'true', then: {} }], mvu: { favor: 50 } }
    expect(diffVariables(before, after)).toEqual([{ name: 'mvu.favor', before: 10, after: 50 }])
  })

  it('merges guard notes with rule notes per path', () => {
    expect(mergeMvuRuleNotes({ 'mvu.favor': 'guard-note' }, { 'mvu.favor': 'rule:x', 'mvu.debt': 'rule:y' })).toEqual({
      'mvu.favor': 'guard-note; rule:x',
      'mvu.debt': 'rule:y',
    })
  })
})

/* ---------- 端到端：ST 生成/重试/投影/撤销 + AgentTavern settle（同场） ---------- */

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (event: string, listener: (value?: unknown) => void) => void>()
  return {
    method: url.includes('/mvu/status/') ? 'GET' : 'POST',
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

function cardData(name: string, extensions: Record<string, unknown> = {}) {
  return {
    name, description: `${name}的描述。`, personality: '', scenario: '', first_mes: '你好。', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions,
  }
}

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

describe('MVU $rules settlement (integration)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmReply = ''
  let tools: Map<string, RegisteredTool>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-mvu-rules-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData(RULES_CHARACTER, {
        agentTavern: { statusTemplate: '<div class="mvu-status">好感：<%- getvar("mvu.favor") ?? 0 %>|心境：<%- getvar("mvu.mood") ?? "" %></div>' },
      }),
    })
    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(PLAIN_CHARACTER) })
    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(AGENT_RULES_CHARACTER, {
      agentTavern: {
        initialVariables: {
          $schema: { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['calm', 'tense'] }, debt: 0, flags: {} } },
          $rules: structuredClone(THRESHOLD_RULES),
          mvu: { favor: 50, debt: 200, mood: 'calm' },
        },
      },
    }) })
    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(AGENT_PLAIN_CHARACTER) })
    await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(AGENT_CLAMP_CHARACTER, {
      agentTavern: {
        initialVariables: {
          $schema: { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['calm', 'tense'] } } },
          $rules: [
            { name: 'bribe', when: 'true', then: { 'mvu.favor': '150' } },
            { name: 'flare', when: 'true', then: { 'mvu.mood': '"angry"' } },
          ],
          mvu: { favor: 50, mood: 'calm' },
        },
      },
    }) })

    const now = new Date().toISOString()
    // AgentTavern 侧聊天：种子树带初值，规则/schema 在卡上（flat store 持有权威
    // 值的聊天不依赖聊天树里的 $rules——readMvuRules 回退卡源）。
    const agentRulesChat = await store.createChat(AGENT_RULES_CHARACTER, {
      user_name: 'User', character_name: AGENT_RULES_CHARACTER,
      chat_metadata: { createdAt: now, variables: { mvu: { favor: 50, debt: 200, mood: 'calm' } } },
    }, [
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: 'We share a meal.' },
      { name: AGENT_RULES_CHARACTER, is_user: false, is_system: false, send_date: now, mes: 'The favor warms.' },
    ])
    const agentPlainChat = await store.createChat(AGENT_PLAIN_CHARACTER, {
      user_name: 'User', character_name: AGENT_PLAIN_CHARACTER,
      chat_metadata: { createdAt: now },
    }, [
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: 'Hi' },
      { name: AGENT_PLAIN_CHARACTER, is_user: false, is_system: false, send_date: now, mes: 'Hello' },
    ])
    const agentClampChat = await store.createChat(AGENT_CLAMP_CHARACTER, {
      user_name: 'User', character_name: AGENT_CLAMP_CHARACTER,
      chat_metadata: { createdAt: now, variables: { mvu: { favor: 50, mood: 'calm' } } },
    }, [
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: 'A tense night.' },
    ])
    await store.updateState(() => ({
      sessionBindings: {
        native: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: AGENT_RULES_CHARACTER, chatId: agentRulesChat },
        plain: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: AGENT_PLAIN_CHARACTER, chatId: agentPlainChat },
        clamp: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: AGENT_CLAMP_CHARACTER, chatId: agentClampChat },
      },
    }))

    tools = new Map()
    const ctx = {
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: (tool: RegisteredTool) => { tools.set(tool.name, tool) } },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: llmReply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn: () => void) => { fn(); return () => {} },
    } as never
    await apply(ctx)
    await applyAgentTavern(ctx)
    expect(apiHandler).toBeDefined()
    expect(tools.has('tavern_variable_settle')).toBe(true)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const craftChat = async (character: string, variables: Record<string, unknown> | undefined) => {
    const now = new Date().toISOString()
    return store.createChat(character, {
      user_name: 'User', character_name: character,
      chat_metadata: { createdAt: now, timedWorldInfo: {}, ...(variables !== undefined ? { variables: structuredClone(variables) } : {}) },
    }, [])
  }

  async function generate(character: string, chatId: string) {
    const snapshot = await store.getChatSnapshot(character, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character, chatId, message: 'hello', revision: snapshot!.revision }, '/api/dsh-soulmojito/generate'), res)
    expect(res.writableEnded).toBe(true)
    const events = res.chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
    return events.find((event) => event.type === 'saved')
  }

  const settle = (agent: string, changes: unknown[]) =>
    tools.get('tavern_variable_settle')!.execute({ changes }, { agent: { id: agent } })

  async function undoCall(character: string, chatId: string) {
    const res = makeResponse()
    await apiHandler(makeRequest({ character, chatId }, '/api/dsh-soulmojito/mvu/receipts/undo'), res)
    expect(res.writableEnded).toBe(true)
    const text = res.chunks.join('')
    return { status: res.statusCode, body: text === '' ? undefined : JSON.parse(text) }
  }

  async function statusCall(character: string, chatId: string) {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-soulmojito/mvu/status/${encodeURIComponent(character)}/${chatId}`), res)
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.chunks.join(''))
  }

  /* ------------------------------ ST 路径 ------------------------------ */

  it('keeps $rules-less cards byte-identical in behavior (ST golden)', async () => {
    const chatId = await craftChat(PLAIN_CHARACTER, { mvu: { favor: 10 } })
    llmReply = `<% setvar('mvu.favor', getvar('mvu.favor') + 5) -%>正文`
    const saved = await generate(PLAIN_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 15 } })
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ status: 'updated', changes: [{ name: 'mvu.favor', before: 10, after: 15 }], failures: [] })
    expect('reason' in receipts[0]!.changes[0]!).toBe(false)
  })

  it('runs threshold rules after the guard pass: derived values land with rule reasons in the same receipt', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      // 规则写入的路径（debt / flags.trusted）必须在 schema 模板内声明——
      // 规则产出同样受结构锁定（C-1 守卫交互）
      $schema: { mvu: { favor: { $range: [0, 100] }, debt: 0, flags: { trusted: false } } },
      $rules: THRESHOLD_RULES,
      mvu: { favor: 75, debt: 200, mood: 'calm' },
    })
    llmReply = `<% setvar('mvu.favor', getvar('mvu.favor') + 10) -%>好感上升。`
    const saved = await generate(RULES_CHARACTER, chatId)
    const variables = saved.chat.header.chat_metadata.variables
    expect(variables.mvu).toEqual({ favor: 85, debt: 100, mood: 'calm', flags: { trusted: true } })
    // $rules 契约原样保留（不是变量，不进结算/渲染/投影）
    expect(variables.$rules).toEqual(THRESHOLD_RULES)
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts.at(-1)).toMatchObject({ status: 'updated', failures: [] })
    expect(receipts.at(-1)!.changes).toEqual([
      { name: 'mvu.debt', before: 200, after: 100, reason: 'rule:debt-relief' },
      { name: 'mvu.favor', before: 75, after: 85 },
      { name: 'mvu.flags.trusted', after: true, reason: 'rule:favor-unlock' },
    ])
  })

  it('guards rule outputs on the ST path: clamp keeps the change with rule+guard reason, reject rolls back to a failure', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $schema: { mvu: { favor: { $range: [0, 100] }, mood: { $enum: ['calm', 'tense'] } } },
      $rules: [
        { name: 'bribe', when: 'true', then: { 'mvu.favor': '150' } },
        { name: 'flare', when: 'true', then: { 'mvu.mood': '"angry"' } },
      ],
      mvu: { favor: 50, mood: 'calm' },
    })
    llmReply = '正文不写变量。'
    const saved = await generate(RULES_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 100, mood: 'calm' })
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts.at(-1)!.status).toBe('failed')
    expect(receipts.at(-1)!.changes).toEqual([
      { name: 'mvu.favor', before: 50, after: 100, reason: 'rule:bribe; mvu.favor: guard clamp: 150 -> 100' },
    ])
    expect(receipts.at(-1)!.failures).toEqual([expect.stringContaining("mvu.mood: rule 'flare': guard enum-violation")])
  })

  it('bounds chained re-triggering at 3 rounds with an honest cap warning', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $rules: [{ name: 'tick', when: 'true', then: { 'mvu.counter': "getvar('mvu.counter') + 1" } }],
      mvu: { counter: 0 },
    })
    llmReply = '正文不写变量。'
    const saved = await generate(RULES_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables.mvu.counter).toBe(MVU_RULE_ROUNDS)
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts.at(-1)!.changes).toEqual([
      { name: 'mvu.counter', before: 0, after: MVU_RULE_ROUNDS, reason: 'rule:tick' },
    ])
    expect(receipts.at(-1)!.failures).toEqual([expect.stringContaining('fixed-point iteration hit the 3-round cap')])
  })

  it('skips rules whose expressions throw (determinism shades included) and warns instead of failing the settlement values', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $rules: [
        { name: 'clock', when: 'Date.now() > 0', then: { 'mvu.a': '1' } },
        { name: 'half-broken', when: 'true', then: { 'mvu.b': '1', 'mvu.c': 'missing_identifier' } },
        { name: 'ok', when: "getvar('mvu.favor') >= 10", then: { 'mvu.d': 'Math.min(3, 5)' } },
      ],
      mvu: { favor: 10 },
    })
    llmReply = '正文不写变量。'
    const saved = await generate(RULES_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 10, d: 3 })
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts.at(-1)!.status).toBe('failed')
    expect(receipts.at(-1)!.changes).toEqual([{ name: 'mvu.d', after: 3, reason: 'rule:ok' }])
    expect(receipts.at(-1)!.failures).toEqual([
      expect.stringContaining("rule 'clock': when evaluation failed"),
      expect.stringContaining("then evaluation failed for 'mvu.c'"),
    ])
  })

  it('disables the whole card rule set on a malformed $rules shape, with a warning and no rule side effects', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $rules: [{ name: 'no-then', when: 'true' }],
      mvu: { favor: 10 },
    })
    llmReply = `<% setvar('mvu.favor', getvar('mvu.favor') + 5) -%>正文`
    const saved = await generate(RULES_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 15 })
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts.at(-1)!.status).toBe('failed')
    expect(receipts.at(-1)!.failures).toEqual([expect.stringContaining("$rules: rule 'no-then' requires a non-empty then map")])
    expect(receipts.at(-1)!.changes).toEqual([{ name: 'mvu.favor', before: 10, after: 15 }])
  })

  it('rolls back a template attempt to rewrite the $rules subtree itself (contract is read-only)', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $rules: THRESHOLD_RULES,
      mvu: { favor: 85, debt: 10 },
    })
    llmReply = `<% setvar('$rules', '[]') -%>正文`
    const saved = await generate(RULES_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables.$rules).toEqual(THRESHOLD_RULES)
    const receipts: MvuReceipt[] = saved.chat.header.chat_metadata.mvu.receipts
    expect(receipts.at(-1)!.failures).toEqual([expect.stringContaining('$rules: guard readonly')])
  })

  it('hides $rules from the status payload and the rendered status bar', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $rules: THRESHOLD_RULES,
      mvu: { favor: 42, mood: 'calm' },
    })
    const payload = await statusCall(RULES_CHARACTER, chatId)
    expect(payload.variables).toEqual({ mvu: { favor: 42, mood: 'calm' } })
    expect(payload.renderedHtml).toContain('好感：42')
    expect(payload.renderedHtml).not.toContain('$rules')
    const snapshot = await store.getChatSnapshot(RULES_CHARACTER, chatId)
    expect(snapshot!.chat.header.chat_metadata.variables.$rules).toEqual(THRESHOLD_RULES)
  })

  it('runs the rules on mvu/retry and strips $rules from the response variables', async () => {
    const now = new Date().toISOString()
    const chatId = await store.createChat(RULES_CHARACTER, {
      user_name: 'User', character_name: RULES_CHARACTER,
      chat_metadata: {
        createdAt: now, timedWorldInfo: {},
        variables: { $rules: [{ name: 'favor-unlock', when: "getvar('mvu.favor') >= 80", then: { 'mvu.flags.trusted': 'true' } }], mvu: { favor: 42 } },
      },
    }, [{
      name: RULES_CHARACTER, is_user: false, is_system: false, send_date: now,
      mes: `<% setvar('mvu.favor', 99) -%>正文保持原样`,
    }])
    const snapshot = await store.getChatSnapshot(RULES_CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: RULES_CHARACTER, chatId, revision: snapshot!.revision }, '/api/dsh-soulmojito/mvu/retry'), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.chunks.join(''))
    expect(payload.receipt).toMatchObject({ turnKey: '0', status: 'updated' })
    expect(payload.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 42, after: 99 },
      { name: 'mvu.flags.trusted', after: true, reason: 'rule:favor-unlock' },
    ])
    // retry 不产生 failed 状态（既有约定），规则产物走正常变更
    expect(payload.receipt.failures).toEqual([])
    expect(payload.variables).toEqual({ mvu: { favor: 99, flags: { trusted: true } } })
    const after = await store.getChatSnapshot(RULES_CHARACTER, chatId)
    expect(after!.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 99, flags: { trusted: true } })
  })

  it('undoes rule-produced changes to their before values and re-triggers on the next settlement', async () => {
    const chatId = await craftChat(RULES_CHARACTER, {
      $rules: [{ name: 'favor-unlock', when: "getvar('mvu.favor') >= 80", then: { 'mvu.flags.trusted': 'true' } }],
      mvu: { favor: 75 },
    })
    llmReply = `<% setvar('mvu.favor', getvar('mvu.favor') + 10) -%>好感上升。`
    const saved = await generate(RULES_CHARACTER, chatId)
    expect(saved.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 85, flags: { trusted: true } })

    // 撤销：规则产生的 flags 变更同样是回执变更——恢复 before 值（新增键删除）
    const undone = await undoCall(RULES_CHARACTER, chatId)
    expect(undone.status).toBe(200)
    expect(undone.body.restored).toEqual([{ path: 'mvu.favor', value: 75 }, { path: 'mvu.flags.trusted' }])
    const snapshot = await store.getChatSnapshot(RULES_CHARACTER, chatId)
    expect(snapshot!.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 75 })

    // 条件仍满足的路径：下一次结算规则重触发（语义正确行为）
    const again = await generate(RULES_CHARACTER, chatId)
    expect(again.chat.header.chat_metadata.variables.mvu).toEqual({ favor: 85, flags: { trusted: true } })
    const receipts = readMvuReceipts((await store.getChatSnapshot(RULES_CHARACTER, chatId))!.chat)
    expect(receipts).toHaveLength(2)
    expect(receipts.at(-1)!.changes).toEqual([
      { name: 'mvu.favor', before: 75, after: 85 },
      { name: 'mvu.flags.trusted', after: true, reason: 'rule:favor-unlock' },
    ])
  })

  /* -------------------------- AgentTavern settle -------------------------- */

  it('keeps $rules-less chats byte-identical in behavior (settle golden)', async () => {
    const result = await settle('plain', [{ name: 'mvu.x', value: 1, reason: 'plain write' }])
    expect(result.applied).toEqual(['mvu.x'])
    expect(result.failed).toEqual([])
    expect(result.receipt).toMatchObject({ status: 'updated', failures: [] })
    expect(result.receipt.changes).toEqual([{ name: 'mvu.x', after: 1 }])
  })

  it('runs card rules on the post-flat tree snapshot: derived writes land in the receipt, the store and the audit line', async () => {
    const result = await settle('native', [{ name: 'mvu.favor', value: 85, reason: 'gift accepted' }])
    expect(result.applied).toEqual(['mvu.favor'])
    expect(result.failed).toEqual([])
    expect(result.receipt).toMatchObject({ status: 'updated', failures: [] })
    // favor: 种子 before 50 → flat 写入 85（请求项）；规则按声明序追加：
    // favor-unlock 先（flags.trusted）、debt-relief 后（debt 200 → 100）
    expect(result.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 50, after: 85 },
      { name: 'mvu.flags.trusted', after: true, reason: 'rule:favor-unlock' },
      { name: 'mvu.debt', before: 200, after: 100, reason: 'rule:debt-relief' },
    ])
    const variables = await VariableStore.open(join(home, 'soulmojito'))
    expect(await variables.get('chat', (await store.getState()).sessionBindings.native!.chatId, 'mvu.flags.trusted')).toMatchObject({ value: true })
    expect(await variables.get('chat', (await store.getState()).sessionBindings.native!.chatId, 'mvu.debt')).toMatchObject({ value: 100 })
    // 审计线带规则变更（回执管线同源）
    const audit = await readMvuAudit(join(home, 'soulmojito'))
    expect(audit.at(-1)!.changes).toEqual([
      { name: 'mvu.favor', reason: 'gift accepted', before: 50, after: 85 },
      { name: 'mvu.flags.trusted', reason: 'rule:favor-unlock', after: true },
      { name: 'mvu.debt', reason: 'rule:debt-relief', before: 200, after: 100 },
    ])
  })

  it('guards rule writes on the settle path: clamp merges the guard note, reject becomes a rule failure entry', async () => {
    const result = await settle('clamp', [{ name: 'mvu.mood', value: 'tense', reason: 'the night thickens' }])
    expect(result.applied).toEqual(['mvu.mood'])
    expect(result.receipt.status).toBe('failed')
    expect(result.receipt.changes).toEqual([
      { name: 'mvu.mood', before: 'calm', after: 'tense' },
      { name: 'mvu.favor', before: 50, after: 100, reason: 'rule:bribe; mvu.favor: guard clamp: 150 -> 100' },
    ])
    expect(result.receipt.failures).toEqual([expect.stringContaining("mvu.mood: rule 'flare': guard enum-violation")])
  })

  it('undoes rule-produced settle changes and re-triggers them on the next settle', async () => {
    const state = await store.getState()
    const chatId = state.sessionBindings.native!.chatId
    // 撤销上一条 settle 回执：favor/debt 恢复种子 before 值，规则新增键删除
    const undone = await undoCall(AGENT_RULES_CHARACTER, chatId)
    expect(undone.status).toBe(200)
    const variables = await VariableStore.open(join(home, 'soulmojito'))
    expect(await variables.get('chat', chatId, 'mvu.flags.trusted')).toBeUndefined()
    expect(await variables.get('chat', chatId, 'mvu.favor')).toMatchObject({ value: 50 })
    expect(await variables.get('chat', chatId, 'mvu.debt')).toMatchObject({ value: 200 })

    // 条件仍满足：下次结算规则重触发（flat 权威值被撤销恢复后从头再来）
    const first = await settle('native', [{ name: 'mvu.favor', value: 90, reason: 'a warm evening' }])
    expect(first.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 50, after: 90 },
      { name: 'mvu.flags.trusted', after: true, reason: 'rule:favor-unlock' },
      { name: 'mvu.debt', before: 200, after: 100, reason: 'rule:debt-relief' },
    ])

    // 再撤销再结算：同样重触发——撤销恢复的是 before 值，不是「规则不再跑」
    const undoneAgain = await undoCall(AGENT_RULES_CHARACTER, chatId)
    expect(undoneAgain.status).toBe(200)
    expect(await variables.get('chat', chatId, 'mvu.flags.trusted')).toBeUndefined()
    const second = await settle('native', [{ name: 'mvu.favor', value: 95, reason: 'again' }])
    expect(second.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 50, after: 95 },
      { name: 'mvu.flags.trusted', after: true, reason: 'rule:favor-unlock' },
      { name: 'mvu.debt', before: 200, after: 100, reason: 'rule:debt-relief' },
    ])
  })
})

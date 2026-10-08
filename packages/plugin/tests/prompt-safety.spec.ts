import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply as applyPlugin } from '../src/index.js'
import { apply as applyAgentTavern, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { createHostPromptExpander, hostPromptSafe } from '../src/prompt-safety.js'
import { GUIDES_BLOCK_HEADER } from '../src/guides.js'
import {
  TavernStore,
  applyScriptBinding,
  importScript,
} from '../../tavern-store/src/index.js'

/**
 * 0.4.1 线上故障回归：角色卡里的 ST 宏（{{user}}/{{char}}/...）以原文流进
 * 宿主 systemPrompt 上下文，宿主 @deepseek-ai/dsh-system-prompt 的 interpolate()
 * 把 {{...}} 当自己的模板变量渲染（注册表只有 provider/model/cwd），未注册名
 * 直接抛 "unknown prompt variable" 中止本轮运行。
 *
 * 下面的 hostInterpolate 是按宿主 lib/index.js 逐行复刻的最小复刻：第一组断言
 * 先证明复刻忠于故障（{{user}} 必炸），后续断言证明各通道产物不再含任何
 * 宿主会扫描的 "{{"。
 */

// —— 宿主 interpolate() 最小复刻（lib/index.js，逐行对齐）——
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const GROUP_AT = /^\{\{([^{}]*)\}\}/
const HOST_VARIABLES = { provider: 'test-provider', model: 'test-model', cwd: '/tmp' }

function hostInterpolate(text: string, variables: Record<string, string>): string {
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…"`)
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) throw new Error(`malformed prompt variable reference "{{${name}}}"`)
    if (!Object.hasOwn(variables, name)) throw new Error(`unknown prompt variable "{{${name}}}"`)
    result += text.slice(last, open) + variables[name]
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** 通道产物的验收标准：零 "{{"（宿主扫描的起爆点），且按宿主规则渲染不抛错。 */
function expectHostSafe(text: string): void {
  expect(text).not.toContain('{{')
  expect(() => hostInterpolate(text, HOST_VARIABLES)).not.toThrow()
}

describe('hostPromptSafe (unit)', () => {
  it('replica reproduces the 0.4.1 crash: raw {{user}} hits the host and throws', () => {
    expect(() => hostInterpolate('Character identity summary: loves {{user}}.', HOST_VARIABLES))
      .toThrow(/unknown prompt variable "\{\{user\}\}"/)
  })

  it('neutralizes every {{...}} shape the host would reject', () => {
    // 未注册宏名（unknown prompt variable 类）
    expect(hostPromptSafe('a {{mystery}} b')).toBe('a { {mystery}} b')
    // 大写名字（malformed 类：宿主变量名只允许小写）
    expect(hostPromptSafe('a {{USER}} b')).toBe('a { {USER}} b')
    // 名字带空格（malformed 类）
    expect(hostPromptSafe('a {{ user }} b')).toBe('a { { user }} b')
    // 宏带参数（malformed 类：冒号不在宿主变量名 charset 里）
    expect(hostPromptSafe('a {{getvar::x}} b')).toBe('a { {getvar::x}} b')
    // 宿主已注册的变量也一并中性化：这些通道不依赖宿主插值
    expect(hostPromptSafe('a {{model}} {{provider}} {{cwd}} b')).toBe('a { {model}} { {provider}} { {cwd}} b')
    // 三括号残留不留死角
    expect(hostPromptSafe('{{{nested}}}')).toBe('{ { {nested}}}')
  })

  it('expands ST macros before neutralizing leftovers', () => {
    const expand = createHostPromptExpander('宏之测试者', '夜行者')
    expect(hostPromptSafe('devoted to {{user}}; wary of {{char}}', expand))
      .toBe('devoted to 夜行者; wary of 宏之测试者')
    // ST 宏大小写不敏感
    expect(hostPromptSafe('shouts {{USER}}', expand)).toBe('shouts 夜行者')
    // 单括号/尖括号 legacy 标签同属 ST 宏
    expect(hostPromptSafe('legacy {user} and <USER>', expand)).toBe('legacy 夜行者 and 夜行者')
    // ST 变量宏：未设置的变量展开为空串
    expect(hostPromptSafe('get [{{getvar::slot}}] end', expand)).toBe('get [] end')
    // 未知宏保留语义但拆掉起爆引信
    expect(hostPromptSafe('marks {{mystery-rune}} doors', expand)).toBe('marks { {mystery-rune}} doors')
    // 展开值自身带 {{ 也能兜住（persona 名注入场景）
    const injected = createHostPromptExpander('Char', '{{evil}}')
    expect(hostPromptSafe('hi {{user}}', injected)).toBe('hi { {evil}}')
  })

  it('leaves prose untouched', () => {
    expect(hostPromptSafe('')).toBe('')
    expect(hostPromptSafe('plain prose, no macros')).toBe('plain prose, no macros')
    // 落单的 } / }} 不是宿主扫描的起爆点，保持原样
    expect(hostPromptSafe('lone } and }} closers')).toBe('lone } and }} closers')
    expect(hostPromptSafe('single { brace')).toBe('single { brace')
  })
})

describe('systemPrompt channels stay host-safe with macro-laden assets (integration)', () => {
  const CHARACTER = '宏之测试者 Macro Muse'
  const PERSONA = '夜行者 Night Walker'
  const AGENT_FACTS = 'ps-facts'
  const AGENT_GUIDES = 'ps-guides'
  const AGENT_SCRIPT = 'ps-script'
  const SCRIPT_NAME = 'Rite of {{Dawn}}'
  const DESCRIPTION = 'Devoted to {{user}}; wary of {{char}} cult; marks {{mystery-rune}} doors; shouts {{USER}}; spaced {{ user }} end.'

  let home: string
  let store: TavernStore
  let contexts: Map<string, { name: string; order: number; text: unknown }>
  let sections: Map<string, { name: string; order: number; text: unknown }>
  const contextText = (name: string, agentId: string): string => {
    const def = contexts.get(name) as
      | { text: (assembly?: { agent?: { id?: string } }) => string }
      | undefined
    return def!.text({ agent: { id: agentId } })
  }

  const sectionText = (name: string): string => {
    const def = sections.get(name) as { text: string | (() => string) } | undefined
    if (def === undefined) return ''
    return typeof def.text === 'function' ? def.text() : def.text
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-prompt-safety-'))
    process.env.DSH_HOME = home
    const tavernRoot = join(home, 'tavern')
    store = await TavernStore.open(tavernRoot)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: DESCRIPTION,
        personality: `Keeps {{user}}'s secrets`,
        scenario: 'A {{mystery-rune}} test scene',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    await importScript(tavernRoot, SCRIPT_NAME, 'dawn vow '.repeat(200))
    await applyScriptBinding(store, CHARACTER, SCRIPT_NAME)

    const header = () => ({
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString() },
    })
    const factsChat = await store.createChat(CHARACTER, header(), [])
    const guidesChat = await store.createChat(CHARACTER, header(), [])
    const scriptChat = await store.createChat(CHARACTER, header(), [])

    // 指引直接种进 chat_metadata（本 spec 不测 API 层，省掉 HTTP mock 全套）
    const guidesSnapshot = await store.getChatSnapshot(CHARACTER, guidesChat)
    await store.saveChat(CHARACTER, guidesChat, {
      ...guidesSnapshot!.chat,
      header: {
        ...guidesSnapshot!.chat.header,
        chat_metadata: {
          ...guidesSnapshot!.chat.header.chat_metadata,
          guides: [{ id: 'g1', text: 'Remember {{user}} hates {{mystery}} sigils', createdAt: new Date().toISOString() }],
        },
      },
    }, guidesSnapshot!.revision)

    await store.updateState((state) => ({
      activePersona: PERSONA,
      nativeAgentPersona: true,
      activeCharacter: CHARACTER,
      sessionBindings: {
        [AGENT_FACTS]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: factsChat },
        [AGENT_GUIDES]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: guidesChat },
        [AGENT_SCRIPT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: scriptChat },
      },
    }))

    sections = new Map()
    contexts = new Map()
    applyPlugin({
      systemPrompt: {
        section: (def: { name: string; order: number; text: unknown }) => { sections.set(def.name, def) },
        context: (def: { name: string; order: number; text: unknown }) => { sections.set(def.name, def) },
      },
      commands: { register: () => {} },
      webServer: { register: () => {} },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    applyAgentTavern({
      systemPrompt: {
        section: (def: { name: string; order: number; text: unknown }) => { contexts.set(def.name, def) },
        context: (def: { name: string; order: number; text: unknown }) => { contexts.set(def.name, def) },
      },
      tools: { register: () => {} },
      effect: (fn) => { fn(); return () => {} },
    } as unknown as AgentContextLike)
  }, 30000)

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('agent-facts: card macros expand to persona/character names, leftovers are neutralized', async () => {
    expect(contextText('dsh-tavern:agent-facts', AGENT_FACTS)).toBe('')
    await vi.waitFor(() => {
      expect(contextText('dsh-tavern:agent-facts', AGENT_FACTS)).toContain(PERSONA)
    })
    const text = contextText('dsh-tavern:agent-facts', AGENT_FACTS)
    expect(text).toContain(`Current Tavern character: ${CHARACTER}`)
    expect(text).toContain(`Devoted to ${PERSONA}; wary of ${CHARACTER} cult`)
    expect(text).toContain('marks { {mystery-rune}} doors')
    expect(text).toContain(`Personality summary: Keeps ${PERSONA}'s secrets`)
    expectHostSafe(text)
    // 未绑定 agent 仍为空串（既有语义不回归）
    expect(contextText('dsh-tavern:agent-facts', 'unbound-agent')).toBe('')
  })

  it('agent-guides: user-authored guides survive the host engine too', async () => {
    await vi.waitFor(() => {
      expect(contextText('dsh-tavern:agent-guides', AGENT_GUIDES)).toContain(GUIDES_BLOCK_HEADER)
    })
    const text = contextText('dsh-tavern:agent-guides', AGENT_GUIDES)
    expect(text).toContain(`Remember ${PERSONA} hates { {mystery}} sigils`)
    expectHostSafe(text)
  })

  it('agent-script: script names with {{...}} cannot abort assembly', async () => {
    await vi.waitFor(() => {
      expect(contextText('dsh-tavern:agent-script', AGENT_SCRIPT)).toContain('Bound script:')
    })
    const text = contextText('dsh-tavern:agent-script', AGENT_SCRIPT)
    expect(text).toContain('Bound script: Rite of { {Dawn}}')
    expectHostSafe(text)
  })

  it('active-character section: the legacy native-mode channel gets the same protection', async () => {
    await vi.waitFor(() => {
      expect(sectionText('dsh-tavern:active-character')).toContain(PERSONA)
    })
    const text = sectionText('dsh-tavern:active-character')
    expect(text).toContain(`Active roleplay character: ${CHARACTER}`)
    expect(text).toContain('marks { {mystery-rune}} doors')
    expect(text).toContain(`Personality: Keeps ${PERSONA}'s secrets`)
    expectHostSafe(text)
  })

  it('kernels pass through the guard unchanged (no braces today, no corruption by the wrap)', () => {
    const kernel = contexts.get('dsh-tavern:agent-kernel')?.text as string
    expect(kernel).toContain('AgentTavern running inside the DSH native AgentLoop')
    expectHostSafe(kernel)
  })
})

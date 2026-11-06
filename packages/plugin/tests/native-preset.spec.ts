import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

/**
 * 标准 DSH Agent 会话的激活预设投影（src/native-preset.ts，2026-11-01 用户需求
 * 「在标准 DSH Agent 会话中使用当前预设」）：开关门控（默认关）、无 Tavern 绑定
 * 门控（绑定会话走各自的预设通道）、宏展开与 {{...}} 中性化、开关与激活预设变化
 * 的写穿，以及「无激活预设不回落内置默认 RP 预设」。
 */

const CHARACTER = 'Native Character'
const STANDARD_AGENT = 'standard-agent'
const NEW_STANDARD_AGENT = 'new-standard-agent'
const RP_AGENT = 'rp-agent'
const WORKBENCH_AGENT = 'workbench-agent'

const PRESET = {
  temperature: 0.9,
  prompts: [
    { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'Write {{char}}\'s next reply addressing {{user}}.', system_prompt: true },
    { name: 'Style', identifier: 'style', role: 'system', content: 'Terse prose only.', system_prompt: true },
    { name: 'Slot Off', identifier: 'slotOff', role: 'system', content: 'SHOULD NOT APPEAR (slot disabled).', system_prompt: true },
  ],
  prompt_order: [{
    character_id: 100001,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'style', enabled: true },
      { identifier: 'slotOff', enabled: false },
    ],
  }],
}

interface MockRequest {
  method: string
  url: string
  destroy: () => void
  on: (event: string, listener: (value?: unknown) => void) => undefined
}

function makeRequest(body: unknown, url: string, method = 'POST'): MockRequest {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
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

describe('standard DSH Agent preset projection', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let section: { name: string; order: number; text: (context: unknown) => string } | undefined
  const agentCreatedListeners: Array<(payload: { agent: { id: string } }) => Promise<void> | void> = []

  const textOf = (agentId: string | undefined) =>
    section!.text(agentId === undefined ? undefined : { agent: { id: agentId } })

  const patchState = async (body: Record<string, unknown>) => {
    const res = makeResponse()
    await apiHandler(makeRequest(body, '/api/dsh-soulmojito/state'), res)
    expect(res.statusCode).toBe(200)
    return res
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-native-preset-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.putPreset('Native Preset', structuredClone(PRESET))
    await store.updateState(() => ({
      activeCharacter: CHARACTER,
      activePreset: 'Native Preset',
      activePersona: 'Rin',
      sessionBindings: {
        [RP_AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: 'rp-chat' },
        [WORKBENCH_AGENT]: { architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: CHARACTER, sourceChatId: '', createdCard: '' },
      },
    }))

    let apiHandlerRef: ((req: unknown, res: unknown) => Promise<void>) | undefined
    apply({
      systemPrompt: {
        section: (def: { name: string; order: number; text: unknown }) => {
          if (def.name === 'dsh-soulmojito:native-preset') section = def as typeof section
        },
        context: () => {},
      },
      commands: { register: () => {} },
      on: (event: string, listener: unknown) => {
        if (event === 'agent/created') agentCreatedListeners.push(listener as (payload: { agent: { id: string } }) => Promise<void> | void)
      },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandlerRef = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { list: () => [{ id: STANDARD_AGENT }], get: () => undefined },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
    apiHandler = apiHandlerRef!
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('registers the projection section at -75 and stays empty while the switch is off', async () => {
    expect(section?.name).toBe('dsh-soulmojito:native-preset')
    expect(section?.order).toBe(-75)
    textOf(STANDARD_AGENT)
    // 等待懒装载落定再断言，排除在途竞态
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toBe('')
      expect(textOf(RP_AGENT)).toBe('')
    })
  })

  it('projects the active preset for unbound sessions once the switch is on', async () => {
    await patchState({ nativeAgentPreset: true })
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toContain('Write Native Character\'s next reply addressing Rin.')
    })
    const text = textOf(STANDARD_AGENT)
    // 跟随式框架：预设栈在这里是生效中的提示词
    expect(text.startsWith('Active chat completion preset')).toBe(true)
    // 启用过滤（slot off 不出现）+ 宏展开无 {{ 残留
    expect(text).toContain('Terse prose only.')
    expect(text).not.toContain('SHOULD NOT APPEAR')
    expect(text).not.toContain('{{')
    // 绑定门控：AgentTavern 与写卡工作台的绑定各有专属通道，不吃标准会话投影
    expect(textOf(RP_AGENT)).toBe('')
    expect(textOf(WORKBENCH_AGENT)).toBe('')
  })

  it('keeps the block byte-stable across write-through reloads (frozen clock and rng)', async () => {
    const CLOCKED = {
      temperature: 0.8,
      prompts: [
        { name: 'Clock', identifier: 'clock', role: 'system', content: 'Scene time {{datetimeformat::HH:mm:ss}}; accent {{random:gold,silver}} for {{char}}.', system_prompt: true },
      ],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'clock', enabled: true }] }],
    }
    const put = makeResponse()
    await apiHandler(makeRequest({ name: 'Native Clock Preset', data: CLOCKED }, `/api/dsh-soulmojito/preset/${encodeURIComponent('Native Clock Preset')}`, 'PUT'), put)
    expect(put.statusCode).toBe(200)
    await patchState({ activePreset: 'Native Clock Preset' })
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toContain('Scene time')
    })
    const first = textOf(STANDARD_AGENT)
    // 跨过秒边界再无输入变化写穿（同内容 PUT）：动态宏若按实时钟求值必然换值
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const rewrite = makeResponse()
    await apiHandler(makeRequest({ name: 'Native Clock Preset', data: structuredClone(CLOCKED) }, `/api/dsh-soulmojito/preset/${encodeURIComponent('Native Clock Preset')}`, 'PUT'), rewrite)
    expect(rewrite.statusCode).toBe(200)
    expect(textOf(STANDARD_AGENT)).toBe(first)
    // 收尾：恢复原激活预设
    await patchState({ activePreset: 'Native Preset' })
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toContain('Terse prose only.')
    })
  })

  it('does not fall back to the built-in RP preset when no preset is active', async () => {
    await patchState({ activePreset: null })
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toBe('')
    })
    await patchState({ activePreset: 'Native Preset' })
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toContain('Terse prose only.')
    })
  })

  it('preheats a newly created standard agent before its first assembly', async () => {
    expect(agentCreatedListeners.length).toBeGreaterThan(0)
    // agent/created 是宿主在 loop start 前 await 的串行事件：监听返回时投影必须
    // 已在缓存里，第一次装配不能再拿到空串。测试里按宿主语义跑完全部监听。
    for (const listener of agentCreatedListeners) await listener({ agent: { id: NEW_STANDARD_AGENT } })
    expect(textOf(NEW_STANDARD_AGENT)).toContain('Terse prose only.')
  })

  it('clears the preheated projection when the new session becomes bound', async () => {
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: new Date().toISOString() },
    }, [])
    const res = makeResponse()
    await apiHandler(makeRequest({
      sessionId: NEW_STANDARD_AGENT,
      character: CHARACTER,
      chatId,
    }, '/api/dsh-soulmojito/binding'), res)
    expect(res.statusCode).toBe(200)
    expect(textOf(NEW_STANDARD_AGENT)).toBe('')
  })

  it('restores the projection when the session is unbound again', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ sessionId: NEW_STANDARD_AGENT }, '/api/dsh-soulmojito/binding', 'DELETE'), res)
    expect(res.statusCode).toBe(200)
    expect(textOf(NEW_STANDARD_AGENT)).toContain('Terse prose only.')
  })

  it('clears the projection through the switch-off write-through', async () => {
    await patchState({ nativeAgentPreset: false })
    await vi.waitFor(() => {
      expect(textOf(STANDARD_AGENT)).toBe('')
    })
  })
})

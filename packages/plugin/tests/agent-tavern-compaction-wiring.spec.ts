/**
 * curator 接线回归（2026-09-18 真机故障）：58c2d11 把 resolveCuratorTarget 改成
 * async 后，summarizeStoryCheckpoint 调用点漏了 await，target 变成 Promise，
 * provider 字段取值为 undefined，宿主 llm.stream 立刻抛
 * `no adapter registered for provider "undefined"`——AgentNovel 作者会话每步
 * 压缩尝试全部静默失败（105 次，会话涨到 84% 无压缩）。本 spec 直接实例化
 * TavernCompactionCurator 走真实 summarize 接线，假 llm 强制执行宿主的
 * adapter 注册契约：provider 未注册（含 undefined）必须抛 NO_ADAPTER。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TavernStore } from '../../tavern-store/src/index.js'

vi.mock('../../bind/src/index.js', () => {
  class LlmError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  }
  class BlockAssembler {
    private text = ''
    finish: { kind: string } = { kind: 'stop' }
    usage: unknown
    push(chunk: { type: string; text?: string }): void {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') this.text += chunk.text
    }
    blocks(): Array<{ type: 'text'; text: string }> {
      return [{ type: 'text', text: this.text }]
    }
  }
  class BasicCompactionEngine {
    static inject = ['llm', 'tokenMeter', 'sessions']
    ctx: unknown
    config: Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(ctx: unknown, config: Record<string, unknown> = {}) {
      this.ctx = ctx
      this.config = config
    }
    async compactIfNeeded(): Promise<unknown> {
      return null
    }
    async summarize(): Promise<never> {
      throw new Error('host default summarize must not run for a story session')
    }
  }
  return {
    importHostPackage: async (name: string) => {
      if (name === '@deepseek-ai/dsh-compaction-basic') return { BasicCompactionEngine }
      if (name === '@deepseek-ai/dsh-llm') {
        return {
          BlockAssembler,
          createUserMessage: (options: { content: unknown; source: unknown }) => ({ role: 'user', ...options }),
          contentHasImage: () => false,
          LlmError,
        }
      }
      throw new Error(`unexpected host package import: ${name}`)
    },
  }
})

const { TavernCompactionCurator } = await import('../src/compaction/curator.js')

/** 与宿主一致：只有注册过的 provider 才放行，其余（含 undefined）抛 NO_ADAPTER。 */
const registeredProviders = new Set(['siliconflow', 'minimax-cn', 'runtime-p'])
const streamCalls: Array<Record<string, unknown>> = []
function freshCtx(): { llm: { stream: (options: Record<string, unknown>) => AsyncIterable<unknown> } } {
  streamCalls.length = 0
  return {
    llm: {
      stream(options: Record<string, unknown>) {
        streamCalls.push(options)
        const provider = options.provider
        if (typeof provider !== 'string' || !registeredProviders.has(provider)) {
          throw new (class extends Error {
            code = 'NO_ADAPTER'
          })(`no adapter registered for provider "${provider}"`)
        }
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '## Story So Far\n- checkpoint' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
}

function storyAgent(): {
  session: { id: string; requestHeader(): { config?: { provider?: string; model?: string } } }
} {
  return { session: { id: 'session-1', requestHeader: () => ({ config: { provider: 'minimax-cn', model: 'MiniMax-M3' } }) } }
}

const storyInput = { messages: [{ role: 'user', content: [{ type: 'text', text: '早' }] }] }

describe('curator summarize wiring (regression: unawaited async target resolution)', () => {
  let home: string
  let restoreHome: string | undefined

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'compaction-wiring-'))
  })

  beforeEach(async () => {
    restoreHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const tavern = await TavernStore.open(join(home, 'tavern'))
    await tavern.updateState(() => ({
      sessionBindings: {
        'session-1': { architecture: 'agent-novel', novelId: 'nvl-1' },
        'session-2': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: 'x', chatId: 'c' },
        'session-3': { architecture: 'agent-novel', novelId: '' },
      },
    }))
  })

  afterEach(() => {
    if (restoreHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = restoreHome
  })

  it('resolves the routed target for a bound novel author session (undefined provider = regression)', async () => {
    const curator = new TavernCompactionCurator(freshCtx(), {})
    // 旧代码在此抛 no adapter registered for provider "undefined"。
    const result = await curator.summarize(storyInput as never, storyAgent() as never)
    expect(streamCalls[0]).toMatchObject({ provider: 'minimax-cn', model: 'MiniMax-M3', purpose: 'compaction', sessionId: 'session-1', maxTokens: 8192 })
    expect(result.provider).toBe('minimax-cn')
    expect(result.llmStreamCall).toBe(true)
    expect(result.summary[0]?.text).toContain('Story So Far')
  })

  it('prefers the deployment row config target over the session route', async () => {
    const curator = new TavernCompactionCurator(freshCtx(), { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    await curator.summarize(storyInput as never, storyAgent() as never)
    expect(streamCalls[0]).toMatchObject({ provider: 'siliconflow', model: 'zai-org/GLM-5.2' })
  })

  it('awaits the panel runtime override written into the tavern store', async () => {
    const tavern = await TavernStore.open(join(home, 'tavern'))
    await tavern.updateState(() => ({ compaction: { curatorProvider: 'runtime-p', curatorModel: 'runtime-m' } }))
    const curator = new TavernCompactionCurator(freshCtx(), { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    // resolveCuratorTarget 读存储是 async：漏 await 时该层永远不生效。
    await curator.summarize(storyInput as never, storyAgent() as never)
    expect(streamCalls[0]).toMatchObject({ provider: 'runtime-p', model: 'runtime-m' })
    await tavern.updateState(() => ({ compaction: undefined }))
  })

  it('sends the RP checkpoint instruction as the trailing user message', async () => {
    const curator = new TavernCompactionCurator(freshCtx(), { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    await curator.summarize(storyInput as never, storyAgent() as never)
    const options = streamCalls[0]!
    const messages = options.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    const last = messages.at(-1)!
    expect(last.role).toBe('user')
    expect(last.content[0]?.text).toContain('compaction curator for this AgentTavern roleplay session')
    expect(options.system).toBeUndefined()
  })

  it('routes AgentTavern roleplay sessions through the story checkpoint too', async () => {
    const curator = new TavernCompactionCurator(freshCtx(), { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    const agent = { session: { id: 'session-2', requestHeader: () => ({ config: { provider: 'minimax-cn', model: 'MiniMax-M3' } }) } }
    await curator.summarize(storyInput as never, agent as never)
    expect(streamCalls[0]).toMatchObject({ provider: 'siliconflow' })
  })

  it('falls back to the host default summarizer for incomplete novel bindings', async () => {
    const curator = new TavernCompactionCurator(freshCtx(), { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    const agent = { session: { id: 'session-3', requestHeader: () => ({ config: { provider: 'minimax-cn', model: 'MiniMax-M3' } }) } }
    await expect(curator.summarize(storyInput as never, agent as never)).rejects.toThrow('host default summarize must not run')
  })
})

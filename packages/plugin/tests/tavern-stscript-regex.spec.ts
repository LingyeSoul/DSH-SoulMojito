import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { parseRegexScripts } from '../../tavern-format/src/index.js'

// STscript /regex 命令（决策 2026-10-10-group-nudge-and-regex-slash）：SLASH_COMMAND
// placement=3 的唯一应用点。ST runRegexCallback 语义：脚本名大小写不敏感；未找到/
// 禁用原样返回输入不中断；本实现额外要求 placement 位含 3 才生效。
const CHARACTER = 'RegexTester'

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
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

describe('STscript /regex command (SLASH_COMMAND placement application point)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string

  async function runScriptLine(script: string): Promise<{ ok: boolean; output: string; chatChanged: boolean }> {
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, script }, '/api/dsh-tavern/script'), res)
    return JSON.parse(res.chunks.join(''))
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-stregex-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
      },
    })
    await store.patchState({
      regexScripts: parseRegexScripts([
        { scriptName: 'Shout', findRegex: 'hello', replaceString: 'HELLO', placement: [3] },
        { scriptName: 'SaveOnly', findRegex: 'hello', replaceString: 'GOODBYE', placement: [2] },
        { scriptName: 'Silent', findRegex: 'hello', replaceString: 'LOUD', placement: [3], disabled: true },
      ]),
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: { createdAt: new Date().toISOString() },
    }, [])

    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent, presetId) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
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
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('applies a SLASH_COMMAND script and returns the replaced text', async () => {
    const result = await runScriptLine('/regex name=Shout hello world')
    expect(result.ok).toBe(true)
    expect(result.output).toBe('HELLO world')
    expect(result.chatChanged).toBe(false)
  })

  it('matches the script name case-insensitively', async () => {
    const result = await runScriptLine('/regex name=shout well hello')
    expect(result.output).toBe('well HELLO')
  })

  it('leaves input unchanged for scripts without the SLASH_COMMAND placement bit', async () => {
    const result = await runScriptLine('/regex name=SaveOnly hello')
    expect(result.output).toBe('hello')
  })

  it('leaves input unchanged for disabled scripts and unknown names without failing', async () => {
    expect((await runScriptLine('/regex name=Silent hello')).output).toBe('hello')
    expect((await runScriptLine('/regex name=Missing hello')).output).toBe('hello')
  })

  it('accepts piped text as the input', async () => {
    const result = await runScriptLine('/echo hello | /regex name=Shout')
    expect(result.output).toBe('HELLO')
  })

  it('supports the script name as the first positional argument', async () => {
    const result = await runScriptLine('/regex Shout hello there')
    expect(result.output).toBe('HELLO there')
  })
})

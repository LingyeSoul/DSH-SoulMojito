/**
 * 旧目录兼容（2026-10-21）：$DSH_HOME/tavern 的存量库必须继续被真实 HTTP 面
 * 读取，且内部工作区仍指向旧路径——宿主 workspace 注册表与原生 session 目录
 * 都钉在旧路径上，搬目录会让存量 Tavern 会话失联。独立文件：index.ts 的 apply
 * memoization 绑定首个 DSH_HOME。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Legacy Root Probe'

describe('legacy $DSH_HOME/tavern compatibility', () => {
  let home: string
  let apiHandler: (req: unknown, res: unknown) => Promise<void>

  function makeRequest(url: string) {
    const listeners = new Map<string, (value?: unknown) => void>()
    return {
      method: 'GET',
      url,
      on: (event: string, listener: (value?: unknown) => void) => {
        listeners.set(event, listener)
        if (event === 'end') listener()
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
      headersSent: false,
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

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-legacy-root-'))
    process.env.DSH_HOME = home
    // 模拟 2026-10-21 之前的安装：数据全在 tavern/ 下，soulmojito/ 不存在。
    const store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'legacy store card', personality: '', scenario: '', first_mes: 'Hi',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('serves the legacy store through bootstrap and keeps the old workspace path', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest('/api/dsh-soulmojito/bootstrap'), res)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.chunks.join('')) as {
      characters: string[]
      internalWorkspace: { path: string }
      workbenchWorkspace: { path: string }
    }
    expect(body.characters).toContain(CHARACTER)
    expect(body.internalWorkspace.path).toBe(join(home, 'tavern', 'workspace'))
    expect(body.workbenchWorkspace.path).toBe(join(home, 'tavern', 'workbench'))
    // 旧库存在时不顺手造一个新库，避免两份事实来源。
    expect(existsSync(join(home, 'soulmojito'))).toBe(false)
  })
})

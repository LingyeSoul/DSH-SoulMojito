import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 2026-11-02 实测：bootstrap 每次面板打开都会重取，正则表曾占整包的七成。
// 契约：bootstrap 只带轻状态并声明 stateSlices；大表按分区首次挂载时从
// state-slices 单独取。frontendStorage 客户端从不从 bootstrap 读，直接不下发。
describe('bootstrap state slices', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>

  function makeGetRequest(url: string) {
    return { method: 'GET', url, on: () => undefined, destroy: () => {} }
  }

  function makeResponse() {
    const chunks: string[] = []
    const response = {
      chunks,
      statusCode: 0,
      writableEnded: false,
      setHeader: () => {},
      write: (chunk: string) => { chunks.push(chunk); return true },
      end: (chunk?: string) => { if (chunk) chunks.push(chunk); response.writableEnded = true },
      on: () => {},
    }
    return response
  }

  async function getJson(url: string) {
    const res = makeResponse()
    await apiHandler(makeGetRequest(url), res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('')) as Record<string, unknown> }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-bootstrap-slices-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      get: () => undefined,
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()

    await store.patchState({
      activeCharacter: 'ExampleCard',
      // Unowned (global) script: bootstrap's `ensureRegexScriptOwners` prunes
      // card-owned scripts whose card no longer exists, so a fixture script with
      // an owner would be gone before the slice is read.
      regexScripts: [
        { id: 'rx-1', scriptName: 'strip', findRegex: 'x', replaceString: 'y', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null },
      ],
      frontendStorage: { ExampleCard: { 'probe:key': 'value' } },
    })
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('bootstrap carries the light state and advertises the sliced keys', async () => {
    const boot = await getJson('/api/dsh-soulmojito/bootstrap')
    expect(boot.status).toBe(200)
    const state = boot.body.state as Record<string, unknown>
    expect(state.activeCharacter).toBe('ExampleCard')
    expect(Object.hasOwn(state, 'sessionBindings')).toBe(true)
    expect(Object.hasOwn(state, 'regexScripts')).toBe(false)
    expect(Object.hasOwn(state, 'regexScriptOwners')).toBe(false)
    expect(Object.hasOwn(state, 'regexScriptPresetOwners')).toBe(false)
    expect(Object.hasOwn(state, 'frontendStorage')).toBe(false)
    expect(boot.body.stateSlices).toEqual(['regexScripts'])
  })

  it('state-slices serves the regex table with its ownership maps', async () => {
    const slices = await getJson('/api/dsh-soulmojito/state-slices')
    expect(slices.status).toBe(200)
    expect(slices.body.regexScripts).toEqual([
      expect.objectContaining({ id: 'rx-1', scriptName: 'strip' }),
    ])
    expect(slices.body.regexScriptOwners).toEqual({})
    // 前端虚拟存储不随这个端点下发：客户端按角色走 frontend/storage。
    expect(Object.hasOwn(slices.body, 'frontendStorage')).toBe(false)
  })
})

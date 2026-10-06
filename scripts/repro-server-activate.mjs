// 临时诊断：用真实 packages/plugin/index.mjs + 忠实 ctx/agent 模拟跑
// 「新建会话 → agent-tavern 激活」的完整服务端链路，抓真实抛栈。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVER = fileURLToPath(new URL('../packages/plugin/index.mjs', import.meta.url))
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tavern-repro-'))
process.env.DSH_HOME = join(tempRoot, 'dsh-home')
process.env.DSH_TAVERN_DISABLE_UPDATE_CHECK = '1'

const routes = []
let commandHandler = null
const sessionLog = []

const agent = {
  id: 's-1',
  ctx: { effect: (fn) => { fn(); return () => {} } },
  session: {
    header: { version: 4, id: 's-1', createdAt: 0, isSeeded: false, delegationDepth: 0 },
    log: sessionLog,
    snapshotEvents: () => Object.freeze([...sessionLog]),
    append: (type, data, options) => {
      sessionLog.push({ type, seq: sessionLog.length, time: Date.now(), data, ...options })
    },
  },
  inject: (message) => { sessionLog.push({ type: 'user/message', seq: sessionLog.length, time: Date.now(), data: message }) },
  phase: { kind: 'idle', lastTurn: 0 },
}

const ctx = {
  logger: { info: () => {}, warn: (...args) => console.log('[warn]', ...args), error: (...args) => console.log('[error]', ...args) },
  commands: { register: (value) => { if (value.name === 'dsh-tavern-session') commandHandler = value.handler; return () => {} } },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
  webServer: { register: (value) => { routes.push(value); return () => {} } },
  effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
  llm: { stream: async function* () {}, listProviders: () => [], currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  agents: { get: (id) => (id === 's-1' ? agent : undefined) },
  agentPresets: {
    mount: async (agentContext, presetId) => ({ id: presetId }),
    recompose: async (agentContext, presetId) => {
      console.log('[host] agentPresets.recompose presetId=', presetId, 'agentContext keys=', Object.keys(agentContext ?? {}))
      return { id: presetId }
    },
    compositionInventory: async () => [{ id: 'agent-tavern' }, { id: 'agent-novel' }],
  },
  tools: { register: () => () => {} },
  compaction: { registerStrategy: () => () => {} },
  get: () => undefined,
  on: () => () => {},
}

const mod = await import(pathToFileURL(SERVER).href)
mod.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 200))

// ---- route driver ----
const route = routes.find((value) => value.kind === 'prefix' && value.path === '/api/dsh-tavern')
if (!route) throw new Error('prefix route missing')
async function callRoute(method, path, body) {
  const url = new URL(`http://localhost/api/dsh-tavern/${path}`)
  const res = {
    writableEnded: false,
    writeHead: (status) => { res.status = status },
    end: (payload) => { res.writableEnded = true; res.body = payload },
    setHeader: () => {},
  }
  const listeners = {}
  const req = {
    method, url: url.pathname + url.search, headers: { 'content-type': 'application/json' },
    on: (event, listener) => {
      ;(listeners[event] ??= []).push(listener)
      return req
    },
    destroy: () => {},
  }
  const settled = route.handler(req, res).then(() => res.writableEnded || true)
  await new Promise((resolve) => setImmediate(resolve))
  for (const listener of listeners.data ?? []) listener(Buffer.from(body === undefined ? '' : JSON.stringify(body)))
  for (const listener of listeners.end ?? []) listener()
  await settled
  const text = String(res.body ?? '')
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}

const card = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Alice',
    description: 'A test character.',
    personality: '', scenario: '', first_mes: '你好，旅行者。', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    character_book: null, tags: [], creator: '', character_version: '', extensions: {},
  },
}
console.log('[repro] import character:', JSON.stringify((await callRoute('POST', 'import/character', { card })).body).slice(0, 120))
const chat = await callRoute('POST', 'chats', { character: 'Alice' })
console.log('[repro] create chat:', JSON.stringify(chat.body).slice(0, 120))
const chatId = chat.body.id

// ---- bridge command（agent-tavern 默认架构） ----
const payload = Buffer.from(JSON.stringify({
  character: 'Alice', chatId, architecture: 'st',
})).toString('base64url')
try {
  const result = await commandHandler({ agent, rawInput: payload })
  console.log('[repro] bridge result:', JSON.stringify(result))
} catch (error) {
  console.log('\n[repro] BRIDGE THREW:\n', error.stack)
}
console.log('[repro] session events:', sessionLog.map((event) => event.type).join(', '))
console.log('[repro] agent.phase after:', JSON.stringify(agent.phase))

rmSync(tempRoot, { recursive: true, force: true })

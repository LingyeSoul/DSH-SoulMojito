// 临时诊断 harness：在 Node VM 里加载构建产物 client/index.js，用忠实于
// DSH 0.2.0-rc.2 的宿主面模拟驱动「新建会话」按钮，复现
// "Cannot read properties of undefined (reading 'sessionId')"。
// 诊断用途，不入库不入 gates。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const CLIENT_PATH = resolve(import.meta.dirname, '../packages/plugin/client/index.js')
const code = readFileSync(CLIENT_PATH, 'utf8')

// ---------- capture ----------
const hostCalls = []
const stateLog = []
const errors = []
const log = (entry) => { hostCalls.push(entry); if (process.env.VERBOSE) console.log('[host]', entry.kind, JSON.stringify(entry).slice(0, 300)) }

// ---------- faithful 0.2.0-rc.2 sessions controller ----------
let sessionSeq = 0
const scopes = new Map() // id -> { binding, refcount, retainedBy }
const catalog = { ids: [], byId: {} }
let mainReference = null
const selection = { sessionId: undefined }

function makeSessionFace(id) {
  return {
    command: async (line) => { log({ kind: 'session.command', id, line: line.slice(0, 40) }); return { ok: true, value: { matched: true } } },
    rename: async (title) => { log({ kind: 'session.rename', id, title }); catalog.byId[id].title = title; return { ok: true, value: { title } } },
    handleBlank: (blank) => { log({ kind: 'session.handleBlank', id, blank }); catalog.byId[id].blank = blank },
    append: async (type, data) => { log({ kind: 'session.append', id, type }); return { ok: true } },
  }
}

const sessions = {
  list: {
    getSnapshot: () => catalog,
    subscribe: () => () => {},
  },
  create: async (opts = {}) => {
    const id = opts.sessionId ?? `s-${++sessionSeq}`
    if (!(id in catalog.byId)) {
      catalog.ids.push(id)
      catalog.byId[id] = { id, blank: true, cwd: '/repo/.dsh-tavern-workspace', running: false, retainedBy: {}, displayTitle: id, updatedAt: 0, title: undefined }
    }
    log({ kind: 'sessions.create', id })
    return id
  },
  retain: (target, options) => {
    if (typeof target !== 'string') throw new Error('repro: subagent target not simulated')
    const id = target
    if (!(id in catalog.byId)) throw new Error(`sessions.retain: unknown session ${id}`)
    let record = scopes.get(id)
    if (record === undefined) {
      const binding = { sessionId: id, session: makeSessionFace(id), eventSource: {}, ctx: { effect: (fn) => { fn(); return () => {} } } }
      record = { binding, refcount: 0, retainedBy: {} }
      scopes.set(id, record)
    }
    record.refcount += 1
    record.retainedBy[options.source] = (record.retainedBy[options.source] ?? 0) + 1
    catalog.byId[id].retainedBy = { ...record.retainedBy }
    log({ kind: 'sessions.retain', id, source: options.source, refcount: record.refcount })
    const reference = {
      sessionId: id,
      get binding() {
        if (record.refcount === 0) throw new Error(`Session reference "${id}" is released`)
        return record.binding
      },
      ready: Promise.resolve(record.binding),
      release() {
        record.refcount -= 1
        record.retainedBy[options.source] = Math.max(0, (record.retainedBy[options.source] ?? 1) - 1)
        catalog.byId[id].retainedBy = { ...record.retainedBy }
        log({ kind: 'reference.release', id, source: options.source, refcount: record.refcount })
        if (record.refcount === 0) scopes.delete(id)
      },
    }
    return reference
  },
  binding: (id) => {
    const value = scopes.get(id)?.binding
    log({ kind: 'sessions.binding', id, hit: value !== undefined })
    return value
  },
}

// uiWorkspace.connectWorkspace → reuseOrCreateBlank（0.2.0 语义：不 retain）
const uiWorkspace = {
  connectWorkspace: async (workspaceId) => {
    log({ kind: 'uiWorkspace.connectWorkspace', workspaceId })
    for (const id of catalog.ids) {
      const summary = catalog.byId[id]
      if (!summary?.blank || summary.cwd !== '/repo/.dsh-tavern-workspace') continue
      return sessions.create({ workspaceId, sessionId: id })
    }
    return sessions.create({ workspaceId })
  },
  openSession: (target) => {
    log({ kind: 'uiWorkspace.openSession', target })
    const reference = sessions.retain(target, { source: 'mainView' })
    selection.sessionId = reference.sessionId
    const previous = mainReference
    mainReference = reference
    previous?.release()
  },
}

const workspaces = {
  create: async ({ path }) => { log({ kind: 'workspaces.create', path }); return { workspaceId: 'w-tavern', path, title: '' } },
  rename: async (workspaceId, title) => ({ workspaceId, title }),
  archiveSession: async (id) => { log({ kind: 'workspaces.archiveSession', id }) },
  list: { getSnapshot: () => ({ items: [{ workspaceId: 'w-tavern', path: '/repo/.dsh-tavern-workspace', title: 'Tavern', sessionIds: catalog.ids }], archivedSessionIds: [] }), subscribe: () => () => {} },
}

// ---------- fetch router ----------
let chatSeq = 0
const BOOTSTRAP = {
  ok: true,
  state: { activeCharacter: 'Alice', defaultArchitecture: 'agent-tavern', defaultContextMode: 'dsh-native', sessionBindings: {}, chats: {} },
  characters: ['Alice'],
  worlds: [], presets: [], presetKinds: {}, personas: [], groups: [],
  activeCard: null,
  model: { provider: 'stub', model: 'stub' },
  version: '0.0.0-repro', commit: 'repro',
  internalWorkspace: { path: '/repo/.dsh-tavern-workspace', title: 'Tavern' },
  agentTavern: { native: { available: true, missing: [], reasons: [] }, managed: { available: true, missing: [], reasons: [] } },
  agentNovel: { available: false, missing: [], reasons: [] },
  update: { status: 'unknown', reason: '', checkedAt: null, nextCheckAt: null, error: '', source: 'none', repository: '', ref: '', local: { version: '', commit: '' }, remote: null, spec: '', install: { running: false, phase: 'idle', strategy: null, startedAt: null, finishedAt: null, message: '', restartRequired: false, installed: null, log: [] } },
}
const CHAT = { messages: [], next_mes: 0 }
const stateAfterBind = () => ({ ...BOOTSTRAP.state, sessionBindings: { ...BOOTSTRAP.state.sessionBindings } })

async function routeFetch(url, options = {}) {
  const target = new URL(url, 'http://localhost')
  const path = target.pathname.replace(/^\/api\/dsh-tavern\/?/, '')
  const method = options.method ?? 'GET'
  log({ kind: 'fetch', method, path })
  const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value })
  if (method === 'GET' && path === 'bootstrap') return json(BOOTSTRAP)
  if (method === 'GET' && path === 'chats') return json({ ok: true, chats: [] })
  if (method === 'POST' && path === 'chats') return json({ ok: true, id: `chat-${++chatSeq}.jsonl`, chat: CHAT, revision: `r${chatSeq}` })
  if (method === 'POST' && path === 'binding') {
    const body = JSON.parse(options.body)
    BOOTSTRAP.state.sessionBindings[body.sessionId] = { character: body.character, chatId: body.chatId, ...(body.group ? { group: true } : {}), ...(body.architecture ? { architecture: body.architecture, contextMode: body.contextMode } : {}) }
    return json({ ok: true, state: stateAfterBind(), binding: BOOTSTRAP.state.sessionBindings[body.sessionId] })
  }
  if (method === 'DELETE' && path === 'binding') return json({ ok: true })
  return json({ ok: true })
}

// ---------- React stub with functional useState ----------
function callableStub(label = 'stub') {
  const target = function stub() {}
  return new Proxy(target, {
    apply: () => undefined,
    construct: () => ({}),
    get: (_target, key) => {
      if (key === Symbol.toStringTag) return label
      if (key === 'then') return undefined
      return callableStub(`${label}.${String(key)}`)
    },
  })
}
const stateStore = new Map()
const renderStack = []
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  cloneElement: (element, props, ...children) => ({ ...element, props: { ...element?.props, ...props }, children }),
  createContext: (value) => ({ Provider: callableStub('Provider'), Consumer: callableStub('Consumer'), _currentValue: value }),
  forwardRef: (render) => render,
  memo: (component) => component,
  useCallback: (fn) => fn,
  useContext: (context) => context?._currentValue,
  useEffect: () => {},
  useId: () => 'repro-id',
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useReducer: (_reducer, initial) => [initial, () => {}],
  useRef: (value) => ({ current: value }),
  useState: (init) => {
    const key = renderStack[renderStack.length - 1]
    const store = stateStore.get(key) ?? []
    stateStore.set(key, store)
    const index = store.length
    if (!(index in store)) store[index] = typeof init === 'function' ? init() : init
    const setState = (value) => {
      store[index] = typeof value === 'function' ? value(store[index]) : value
      stateLog.push({ key: key?.name ?? String(key), index, value: store[index] })
    }
    return [store[index], setState]
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
React.default = React
function renderComponent(fn, props) {
  renderStack.push(fn)
  try {
    return fn(props)
  } finally {
    renderStack.pop()
  }
}

// ---------- slots / locale / ctx ----------
const registrations = []
const slots = {
  inject: (name, callback) => {
    const returned = callback()
    const iterable = typeof returned?.[Symbol.iterator] === 'function' ? returned : [returned]
    for (const entry of iterable) registrations.push({ name, entry })
  },
  register: (options, component) => ({ options, component }),
  entries: () => [],
  getVersion: () => 0,
  subscribe: () => () => {},
}
const context = {
  effect: (callback) => { callback(); return () => {} },
  get: (serviceId) => (serviceId === 'uiWorkspace' ? uiWorkspace : undefined),
  locale: {
    bind: () => (key) => key,
    register: () => {},
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => {},
  },
  slots,
  sessions,
  workspaces,
}

// ---------- load client ----------
const sandbox = {
  AbortController, Blob: globalThis.Blob, Buffer, URL, URLSearchParams,
  clearInterval, clearTimeout, console,
  TextEncoder, TextDecoder,
  btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
  atob: (text) => Buffer.from(text, 'base64').toString('binary'),
  fetch: routeFetch,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  navigator: { language: 'en-US' },
  queueMicrotask, setInterval, setTimeout, structuredClone,
  document: {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
  },
}
sandbox.globalThis = sandbox
sandbox.window = sandbox
sandbox.location = { href: 'http://localhost/', origin: 'http://localhost' }
let handoff = null
sandbox.__ModuleLoader__ = { load: (value) => { handoff = value } }
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client/index.js', timeout: 5_000 })
const requireTable = {
  react: React,
  'react/jsx-runtime': { Fragment: React.Fragment, jsx: (type, props, key) => ({ type, props: props ?? {}, key }), jsxs: (type, props, key) => ({ type, props: props ?? {}, key }) },
  'react-dom': { createPortal: (node) => node },
  'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
  '@deepseek-ai/cordis': callableStub('cordis'),
  '@deepseek-ai/dsh-client-store': callableStub('store'),
  '@deepseek-ai/dsh-client-ui-slots': callableStub('slots'),
  '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: (_t, name) => callableStub(`p.${String(name)}`) }),
  '@deepseek-ai/dsh-client-ui-dockkit': callableStub('dockkit'),
}
const module = handoff.factory((specifier) => {
  if (!(specifier in requireTable)) throw new Error(`repro rejected require('${specifier}')`)
  return requireTable[specifier]
})
module.apply(context)
await new Promise((resolve) => setTimeout(resolve, 20))
console.log('[repro] bootstrap loaded, registrations:', registrations.map((r) => r.entry?.options?.name ?? r.name))

// ---------- drive: PanelHost → TavernPanel(chats) → TavernSidebar ----------
const useSessions = (selector) => selector({ ids: catalog.ids, byId: catalog.byId, phase: 'ready', current: selection.sessionId })
const panelHost = registrations.find((r) => r.entry?.options?.name === 'shell.overlay')?.entry?.component
if (typeof panelHost !== 'function') throw new Error('PanelHost component not found')
const panelTree = renderComponent(panelHost, { useSessions })

function walk(node, visit) {
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (node && typeof node === 'object' && 'type' in node) {
    visit(node)
    walk(node.children, visit)
    const injected = node.props?.children
    if (injected !== undefined) walk(injected, visit)
  }
}
function findElement(tree, predicate) {
  let found = null
  walk(tree, (node) => { if (found === null && predicate(node)) found = node })
  return found
}
const tavernPanelElement = findElement(panelTree, (node) => typeof node.type === 'function' && node.type.name === 'TavernPanel')
if (tavernPanelElement === null) throw new Error('TavernPanel not found in PanelHost tree')
console.log('[repro] TavernPanel element found')

// switch panel section to 'chats' via nav button click
const panelOnce = renderComponent(tavernPanelElement.type, { ctx: context, useSessions })
const navCell = findElement(panelOnce, (node) => node.type === 'button'
  && typeof node.props?.className === 'string' && node.props.className.includes('dt-panel-navcell')
  && Array.isArray(node.children) && node.children.some((child) => child?.props !== undefined
    ? walk(child, () => {}) === undefined && false : child === 'panel.section.chats'))
// 直接按 span 文本匹配
const navCellChats = findElement(panelOnce, (node) => {
  if (node.type !== 'button' || typeof node.props?.onClick !== 'function') return false
  let match = false
  walk(node.children, (child) => {
    if (child?.type === 'span' && Array.isArray(child.children) && child.children.includes('panel.section.chats')) match = true
  })
  return match
})
const target = navCellChats ?? navCell
if (target) { target.props.onClick({ preventDefault: () => {} }) }

const panelTwice = renderComponent(tavernPanelElement.type, { ctx: context, useSessions })
const sidebarElement = findElement(panelTwice, (node) => typeof node.type === 'function' && node.type.name === 'TavernSidebar')
if (sidebarElement === null) throw new Error('TavernSidebar not found (section switch failed?)')
console.log('[repro] TavernSidebar rendered')

const sidebarTree = renderComponent(sidebarElement.type, { ctx: context, useSessions })
const newChatButton = findElement(sidebarTree, (node) => node.type === 'button' && node.props?.title === 'nav.newChat')
if (newChatButton === null) throw new Error('new-chat button (title nav.newChat) not found')
console.log('[repro] clicking new-chat button …')
newChatButton.props.onClick({ preventDefault: () => {} })

await new Promise((resolve) => setTimeout(resolve, 300))

const sidebarErrors = stateLog.filter((entry) => typeof entry.value === 'string' && entry.value.length > 0)
console.log('\n[repro] state updates:', stateLog.length, 'errors:', JSON.stringify(sidebarErrors, null, 2))
console.log('\n[repro] host call tail:')
for (const entry of hostCalls.slice(-25)) console.log(' ', JSON.stringify(entry))
if (errors.length > 0) console.log('\n[repro] captured errors:', errors)

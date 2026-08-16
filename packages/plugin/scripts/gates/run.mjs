#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..')
const PACKAGE_PATH = join(PLUGIN_ROOT, 'package.json')
const VERSION_PATH = join(PLUGIN_ROOT, 'version.json')
const PATCH_PATH = join(PLUGIN_ROOT, 'cordis.patch.yml')
const SOURCE_PATH = join(PLUGIN_ROOT, 'src', 'index.ts')
const SERVER_PATH = join(PLUGIN_ROOT, 'index.mjs')
const CLIENT_PATH = join(PLUGIN_ROOT, 'client', 'index.js')
const PLUGIN_NAME = 'dsh-tavern'
const API_PREFIX = '/api/dsh-tavern'

const REQUIRED_SERVER_ROUTES = [
  'bootstrap',
  'state',
  'models',
  'model',
  'import/character',
  'character/',
  'export/character/',
  'export/world/',
  'export/preset/',
  'import/world',
  'world/',
  'import/preset',
  'preset/',
  'import/persona',
  'import/regex',
  'persona',
  'persona-avatar/',
  'groups',
  'group',
  'binding',
  'bindings/prune',
  'chats',
  'chat/',
  'branch',
  'regex',
  'script',
  'tc/check',
  'generate',
]

// DSH client-web's platform module table. Third-party plugin values must flow
// through injected services, not through client-side package imports.
const CLIENT_STATIC_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function declaredPathExists(value) {
  return typeof value === 'string' && existsSync(resolve(PLUGIN_ROOT, value))
}

function checkPackageObject(pkg, checkFiles = false) {
  const problems = []
  if (pkg.name !== PLUGIN_NAME) problems.push(`package name must be '${PLUGIN_NAME}'`)
  if (pkg.type !== 'module') problems.push("package type must be 'module'")
  if (pkg.main !== './index.mjs') problems.push("main must be './index.mjs'")
  if (pkg.exports?.['.'] !== './index.mjs') problems.push("exports['.'] must be './index.mjs'")
  if (pkg.exports?.['./client'] !== './client/index.js') {
    problems.push("exports['./client'] must be './client/index.js'")
  }
  if (pkg.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
    problems.push("exports['./cordis.patch.yml'] must be './cordis.patch.yml'")
  }
  if (pkg.exports?.['./package.json'] !== './package.json') {
    problems.push("exports['./package.json'] must be './package.json'")
  }
  if (!Array.isArray(pkg.files)) {
    problems.push('files must be an array')
  } else {
    for (const entry of ['index.mjs', 'version.json', 'client', 'cordis.patch.yml', 'README.md']) {
      if (!pkg.files.includes(entry)) problems.push(`files must include '${entry}'`)
    }
  }
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push("dsh.bundle.patch must be './cordis.patch.yml'")
  }
  if (pkg.dsh?.client?.platform !== 'web') problems.push("dsh.client.platform must be 'web'")
  if (!Array.isArray(pkg.dsh?.client?.inject) || !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime')) {
    problems.push("dsh.client.inject must include '@deepseek-ai/dsh-client-runtime'")
  }

  if (checkFiles) {
    for (const [label, value] of [
      ['main', pkg.main],
      ["exports['.']", pkg.exports?.['.']],
      ["exports['./client']", pkg.exports?.['./client']],
      ["exports['./cordis.patch.yml']", pkg.exports?.['./cordis.patch.yml']],
      ["exports['./package.json']", pkg.exports?.['./package.json']],
      ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
    ]) {
      if (typeof value === 'string' && !declaredPathExists(value)) {
        problems.push(`${label} target does not exist: ${value}`)
      }
    }
  }
  return problems
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (trimmed[0] === "'" || trimmed[0] === '"') && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === quote && line[index - 1] !== '\\') quote = null
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '#') {
      return line.slice(0, index)
    }
  }
  return line
}

function parsePatchEntries(text) {
  const lines = text.split(/\r?\n/).map(stripYamlComment)
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+id:\s*(.*?)\s*$/.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const entry = { id: unquoteYamlScalar(match[2]), name: undefined }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      const lineIndent = /^\s*/.exec(line)[0].length
      if (lineIndent <= indent) break
      const nameMatch = /^\s*name:\s*(.*?)\s*$/.exec(line)
      if (nameMatch !== null) entry.name = unquoteYamlScalar(nameMatch[1])
    }
    entries.push(entry)
  }
  return entries
}

function checkPatchText(text) {
  const problems = []
  if (!/^\s*-\s+insert:\s*$/m.test(text)) problems.push('patch must contain a top-level insert list')
  const entries = parsePatchEntries(text)
  if (!entries.some((entry) => entry.id === PLUGIN_NAME && entry.name === PLUGIN_NAME)) {
    problems.push(`patch must insert id/name '${PLUGIN_NAME}'`)
  }
  return problems
}

function exportedNames(text) {
  const names = new Set()
  for (const match of text.matchAll(/\bexport\s*\{([\s\S]*?)\}/g)) {
    for (const item of match[1].split(',')) {
      const clean = item.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (clean === '') continue
      const parts = clean.split(/\s+as\s+/)
      names.add((parts.at(-1) ?? '').trim())
    }
  }
  return names
}

function checkServerText(text) {
  const problems = []
  const exports = exportedNames(text)
  for (const name of ['name', 'inject', 'apply']) {
    if (!exports.has(name)) problems.push(`server bundle does not export ${name}`)
  }
  if (!/\b(?:const|var)\s+name\s*=\s*['"]dsh-tavern['"]/.test(text)) {
    problems.push(`server bundle name is not '${PLUGIN_NAME}'`)
  }
  if (!/\bfunction\s+apply\s*\(/.test(text)) problems.push('server bundle has no apply function')
  if (!/\b(?:const|var)\s+inject\s*=\s*\[/.test(text)) problems.push('server bundle has no inject array')
  if (!text.includes(API_PREFIX)) problems.push(`server bundle is missing API prefix ${API_PREFIX}`)
  for (const route of REQUIRED_SERVER_ROUTES) {
    if (!text.includes(`"${route}"`) && !text.includes(`'${route}'`)) {
      problems.push(`server bundle is missing API route marker '${route}'`)
    }
  }
  if (!/\bversion:\s*[A-Za-z_$][\w$]*/.test(text)) {
    problems.push('bootstrap payload must carry a runtime version stamp from version.json')
  }
  if (!/\bcommit:\s*[A-Za-z_$][\w$]*/.test(text)) {
    problems.push('bootstrap payload must carry a runtime-resolved commit stamp')
  }
  if (!text.includes('rev-parse') || !text.includes('--show-toplevel')) {
    problems.push('server bundle must resolve the commit from its own Git checkout at runtime')
  }
  if (!text.includes('version.json')) {
    problems.push('server bundle must read generated version.json')
  }
  return problems
}

function checkVersionFile() {
  if (!existsSync(VERSION_PATH)) return ['generated packages/plugin/version.json does not exist']
  let value
  try {
    value = readJson(VERSION_PATH)
  } catch {
    return ['generated packages/plugin/version.json is not valid JSON']
  }
  const problems = []
  if (typeof value?.version !== 'string' || value.version.trim() === '') {
    problems.push('generated version.json must contain a non-empty version')
  } else if (value.version !== readJson(PACKAGE_PATH).version) {
    problems.push('generated version.json version must match package.json')
  }
  if (typeof value?.commit !== 'string' || value.commit.trim() === '') {
    problems.push('generated version.json must contain a non-empty commit')
  } else if (value.commit !== 'unknown' && !/^[0-9a-f]{7,40}$/i.test(value.commit)) {
    problems.push('generated version.json commit must be a Git SHA or unknown')
  }
  return problems
}

function checkServerFreshness(sourceMtime, bundleMtime) {
  return bundleMtime >= sourceMtime
    ? []
    : [`server bundle is stale (${new Date(bundleMtime).toISOString()} < ${new Date(sourceMtime).toISOString()})`]
}

function checkVersionFreshness(sourceMtime, versionMtime) {
  return versionMtime >= sourceMtime
    ? []
    : [`version.json is stale (${new Date(versionMtime).toISOString()} < ${new Date(sourceMtime).toISOString()})`]
}

function checkClientText(text) {
  const problems = []
  if (!/window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(\s*\{/.test(text)) {
    problems.push('client bundle must call window.__ModuleLoader__.load({...})')
  }
  if (!/(?:factory\s*:\s*(?:\(\s*require\s*\)|require)\s*=>|factory\s*\(\s*require\s*\)\s*\{)/.test(text)) {
    problems.push('client loader handoff must provide factory(require)')
  }

  for (const match of text.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
    const argument = match[1].trim()
    const literal = /^(['"])([^'"]+)\1$/.exec(argument)
    if (literal === null) {
      problems.push(`client bundle contains non-literal require(${argument})`)
    } else if (!CLIENT_STATIC_MODULES.has(literal[2])) {
      problems.push(`client bundle requires non-platform module '${literal[2]}'`)
    }
  }

  if (!/exports\.name\s*=\s*['"]dsh-tavern['"]/.test(text)) {
    problems.push(`client bundle must export name '${PLUGIN_NAME}'`)
  }
  if (!/exports\.inject\s*=/.test(text)) problems.push('client bundle must export inject')
  if (!/exports\.apply\s*=/.test(text)) problems.push('client bundle must export apply')
  for (const marker of ['revision', 'CHAT_REVISION_CONFLICT', 'bindings/prune']) {
    if (!text.includes(marker)) problems.push(`client bundle is missing state-safety marker '${marker}'`)
  }
  if (text.includes('data-conversation-composer-overlay')) {
    problems.push('Tavern composer must use the native scroll layout, not composer overlay mode')
  }
  return problems
}

function checkFrontendRuntimeText(text) {
  const problems = []
  for (const marker of [
    'function extractFrontendDocuments',
    'function buildFrontendDocument',
    'dsh-tavern:frontend-height',
    "sandbox: 'allow-scripts'",
    "connect-src 'none'",
    'event.source !== frameRef.current?.contentWindow',
    'message.streaming',
  ]) {
    if (!text.includes(marker)) problems.push(`frontend runtime is missing marker '${marker}'`)
  }
  return problems
}

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

function makeReactStub() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    cloneElement: (element, props, ...children) => ({ ...element, props: { ...element?.props, ...props }, children }),
    createContext: (value) => ({ Provider: callableStub('Provider'), Consumer: callableStub('Consumer'), _currentValue: value }),
    forwardRef: (render) => render,
    memo: (component) => component,
    useCallback: (fn) => fn,
    useContext: (context) => context?._currentValue,
    useEffect: () => {},
    useId: () => 'gate-id',
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useReducer: (_reducer, initial) => [initial, () => {}],
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  React.default = React
  return React
}

function makeClientRequire() {
  const React = makeReactStub()
  const primitives = new Proxy({}, {
    get: (_target, name) => callableStub(`primitives.${String(name)}`),
  })
  const generic = callableStub('platform')
  const modules = {
    react: React,
    'react/jsx-runtime': {
      Fragment: React.Fragment,
      jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
      jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
    },
    'react-dom': { createPortal: (node) => node },
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/cordis': generic,
    '@deepseek-ai/dsh-client-ui-slots': generic,
    '@deepseek-ai/dsh-client-web-react': generic,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-ui-attachment': generic,
    '@deepseek-ai/dsh-client-schema-form': generic,
  }
  return (specifier) => {
    if (!CLIENT_STATIC_MODULES.has(specifier) || !(specifier in modules)) {
      throw new Error(`client VM rejected require('${specifier}')`)
    }
    return modules[specifier]
  }
}

function makeFetchStub() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      state: { activeWorlds: [], chats: {} },
      characters: [],
      worlds: [],
      presets: [],
      personas: [],
      activeCard: null,
      model: { provider: 'stub', model: 'stub' },
    }),
    text: async () => '',
  })
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
  }
}

function loadClientModule(code) {
  let handoff = null
  const sandbox = {
    AbortController,
    Blob: globalThis.Blob,
    Buffer,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    fetch: makeFetchStub(),
    localStorage: memoryStorage(),
    navigator: { language: 'en-US' },
    queueMicrotask,
    setInterval,
    setTimeout,
    structuredClone,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.location = { href: 'http://localhost/', origin: 'http://localhost' }
  sandbox.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild: () => {} },
    createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  }
  sandbox.__ModuleLoader__ = { load: (value) => { handoff = value } }

  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client/index.js', timeout: 2_000 })
  if (handoff === null) throw new Error('client did not hand a module to __ModuleLoader__.load')
  if (handoff.id !== PLUGIN_NAME) throw new Error(`client loader id must be '${PLUGIN_NAME}', got '${handoff.id}'`)
  if (typeof handoff.factory !== 'function') throw new Error('client loader handoff has no factory function')
  const module = handoff.factory(makeClientRequire())
  if (module === null || typeof module !== 'object' || typeof module.then === 'function') {
    throw new Error('client factory must synchronously return module exports')
  }
  return module
}

function iterableEntries(value) {
  if (value === null || value === undefined) return []
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') return [...value]
  return [value]
}

async function checkClientExecution(code) {
  const problems = []
  let module
  try {
    module = loadClientModule(code)
  } catch (error) {
    return [`client VM load failed: ${error.message}`]
  }
  if (module.name !== PLUGIN_NAME) problems.push(`client runtime name must be '${PLUGIN_NAME}'`)
  if (!Array.isArray(module.inject)) problems.push('client runtime inject must be an array')
  else {
    if (!module.inject.includes('slots')) problems.push("client runtime inject must include 'slots'")
    if (!module.inject.includes('locale')) problems.push("client runtime inject must include 'locale' (DSH language following)")
  }
  if (typeof module.apply !== 'function') return [...problems, 'client runtime apply must be a function']

  const registrations = []
  const injections = []
  const localeRegistrations = []
  const localeBinds = []
  const slots = {
    inject: (name, callback) => {
      injections.push(name)
      for (const entry of iterableEntries(callback())) {
        if (entry !== undefined && entry !== null && !registrations.includes(entry)) registrations.push(entry)
      }
    },
    register: (options, component) => {
      const entry = { options, component }
      registrations.push(entry)
      return entry
    },
    entries: () => [],
    getVersion: () => 0,
    subscribe: () => () => {},
  }
  const serviceFallback = callableStub('ctx')
  const context = new Proxy({
    effect: (callback) => callback(),
    locale: {
      bind: (ns) => { localeBinds.push(ns); return (key) => key },
      register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }) },
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    },
    slots,
  }, {
    get: (target, key) => key in target ? target[key] : serviceFallback,
  })

  try {
    module.apply(context)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  } catch (error) {
    return [...problems, `client apply failed in VM: ${error.message}`]
  }

  const requiredSlots = [
    ['settings.section', PLUGIN_NAME],
    ['conversation.view', 'tavern'],
    ['conversation.composer', undefined],
    ['conversation.session.header.actions', PLUGIN_NAME],
    ['shell.overlay', 'dsh-tavern-panel'],
    ['sidebar.footer.action', 'dsh-tavern-panel'],
  ]
  for (const [name, id] of requiredSlots) {
    if (!injections.includes(name)) problems.push(`client apply did not inject the '${name}' slot`)
    const entry = registrations.find((candidate) => {
      const options = candidate?.options ?? candidate?.opts
      return options?.name === name && (id === undefined || options?.id === id)
    })
    if (entry === undefined) problems.push(`client apply did not register ${name}${id === undefined ? '' : ` id '${id}'`}`)
  }
  const localeRegistration = localeRegistrations.find((entry) => entry?.ns === PLUGIN_NAME)
  if (localeRegistration === undefined) {
    problems.push(`client apply must register '${PLUGIN_NAME}' dictionaries via ctx.locale.register`)
  } else {
    const zh = localeRegistration.dicts?.zh
    const en = localeRegistration.dicts?.en
    const zhKeys = Object.keys(zh ?? {}).sort()
    const enKeys = Object.keys(en ?? {}).sort()
    if (zhKeys.length === 0) problems.push('locale dictionaries must not be empty')
    if (zhKeys.join(' ') !== enKeys.join(' ')) {
      const missingInEn = zhKeys.filter((key) => !(key in (en ?? {})))
      const missingInZh = enKeys.filter((key) => !(key in (zh ?? {})))
      problems.push(`locale zh/en dictionaries diverge (missing in en: ${missingInEn.join(', ') || 'none'}; missing in zh: ${missingInZh.join(', ') || 'none'})`)
    } else {
      for (const key of zhKeys) {
        const zhParams = [...String(zh[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
        const enParams = [...String(en[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
        if (zhParams !== enParams) {
          problems.push(`locale key '${key}' must use the same {param} placeholders in zh and en`)
        }
      }
    }
  }
  if (!localeBinds.includes(PLUGIN_NAME)) {
    problems.push(`client apply must bind the '${PLUGIN_NAME}' locale namespace via ctx.locale.bind`)
  }
  const settings = registrations.find((candidate) => (candidate?.options ?? candidate?.opts)?.name === 'settings.section')
  const settingsSource = settings?.component ? String(settings.component) : ''
  if (/generateFor|dt-transcript|MessageRow/.test(settingsSource)) {
    problems.push('settings.section must not own the Tavern transcript or generation workflow')
  }
  return problems
}

function canResolveOfficialDependenciesFromRepo() {
  const require = createRequire(PACKAGE_PATH)
  try {
    require.resolve('@deepseek-ai/dsh-llm')
    require.resolve('@deepseek-ai/dsh-home-paths')
    return true
  } catch {
    return false
  }
}

function npmGlobalRoot() {
  const env = { ...process.env }
  for (const key of ['npm_config_prefix', 'npm_config_local_prefix', 'npm_config_global']) delete env[key]
  const result = spawnSync('npm root -g', [], {
    encoding: 'utf8',
    env,
    shell: true,
    timeout: 10_000,
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function hasOfficialDependencies(root) {
  return root !== null
    && existsSync(join(root, '@deepseek-ai', 'dsh-llm', 'package.json'))
    && existsSync(join(root, '@deepseek-ai', 'dsh-home-paths', 'package.json'))
}

function locateOfficialDependencyRoot() {
  const candidates = []
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(entry, join(entry, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  const globalRoot = npmGlobalRoot()
  if (globalRoot !== null) {
    candidates.push(globalRoot, join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  return candidates.find(hasOfficialDependencies) ?? null
}

const NODE_MOUNT_SCRIPT = String.raw`
const entry = process.env.DSH_TAVERN_GATE_ENTRY
if (!entry) throw new Error('missing DSH_TAVERN_GATE_ENTRY')
const mod = await import(entry)
const sections = []
const registrations = []
const effects = []
const ctx = {
  commands: { register: (value) => { registrations.push({ kind: 'command', name: value.name, handlerType: typeof value.handler }); return () => {} } },
  systemPrompt: { section: (value) => { sections.push(value) } },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback, label) => { effects.push(label); return callback() },
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
}
mod.apply(ctx)
console.log('DSH_TAVERN_GATE_RESULT=' + JSON.stringify({
  name: mod.name,
  inject: mod.inject,
  applyType: typeof mod.apply,
  sections: sections.map(({ name, order, text }) => ({ name, order, textType: typeof text })),
  registrations: registrations.map(({ kind, path, name, handler, handlerType }) => ({ kind, path, name, handlerType: handlerType ?? typeof handler })),
  effects,
}))
`

function checkNodeMountResult(result) {
  const problems = []
  if (result.name !== PLUGIN_NAME) problems.push(`Node module name must be '${PLUGIN_NAME}'`)
  if (result.applyType !== 'function') problems.push('Node module apply export must be a function')
  if (!Array.isArray(result.inject)) {
    problems.push('Node module inject export must be an array')
  } else {
    for (const service of ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands']) {
      if (!result.inject.includes(service)) problems.push(`Node module inject must include '${service}'`)
    }
  }
  const section = result.sections?.find((value) => value.name === 'dsh-tavern:active-character')
  if (section === undefined) problems.push('Node apply did not register the dsh-tavern systemPrompt section')
  else if (section.textType !== 'function' && section.textType !== 'string') {
    problems.push('Node systemPrompt section text must be a function or string')
  }
  const route = result.registrations?.find((value) => value.kind === 'prefix' && value.path === API_PREFIX)
  if (route === undefined) problems.push(`Node apply did not register webServer prefix ${API_PREFIX}`)
  else if (route.handlerType !== 'function') problems.push('Node webServer prefix has no handler function')
  const command = result.registrations?.find((value) => value.kind === 'command' && value.name === 'tavern')
  if (command === undefined) problems.push("Node apply did not register the '/tavern' activation command")
  else if (command.handlerType !== 'function') problems.push("Node '/tavern' command has no handler function")
  return problems
}

function runNodeMount() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tavern-gate-'))
  try {
    let entryPath = SERVER_PATH
    let dependencyRoot = null
    if (!canResolveOfficialDependenciesFromRepo()) {
      dependencyRoot = locateOfficialDependencyRoot()
      if (dependencyRoot === null) {
        return ['official @deepseek-ai dependencies are not resolvable from the repo, NODE_PATH, or global DSH install']
      }
      entryPath = join(tempRoot, 'index.mjs')
      copyFileSync(SERVER_PATH, entryPath)
      copyFileSync(VERSION_PATH, join(tempRoot, 'version.json'))
      symlinkSync(dependencyRoot, join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    }

    const dshHome = join(tempRoot, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', NODE_MOUNT_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_TAVERN_GATE_ENTRY: pathToFileURL(entryPath).href,
        ...(dependencyRoot === null ? {} : { NODE_PATH: dependencyRoot }),
      },
      timeout: 20_000,
      windowsHide: true,
    })
    if (child.error) return [`Node mount subprocess failed: ${child.error.message}`]
    if (child.status !== 0) {
      const detail = (child.stderr || child.stdout).trim().split(/\r?\n/).at(-1) ?? `exit ${child.status}`
      return [`Node mount subprocess exited ${child.status}: ${detail}`]
    }
    const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith('DSH_TAVERN_GATE_RESULT='))
    if (line === undefined) return ['Node mount subprocess returned no result record']
    return checkNodeMountResult(JSON.parse(line.slice('DSH_TAVERN_GATE_RESULT='.length)))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

const gates = [
  {
    name: 'package-contract',
    selfTest: () => {
      const valid = {
        name: PLUGIN_NAME,
        type: 'module',
        main: './index.mjs',
        exports: {
          '.': './index.mjs',
          './client': './client/index.js',
          './cordis.patch.yml': './cordis.patch.yml',
          './package.json': './package.json',
        },
        files: ['index.mjs', 'version.json', 'client', 'cordis.patch.yml', 'README.md'],
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] },
        },
      }
      const bad = structuredClone(valid)
      bad.dsh.client.platform = 'node'
      return checkPackageObject(valid).length === 0 && checkPackageObject(bad).length > 0
        ? []
        : ['package contract bad sample was not distinguished from the valid sample']
    },
    check: () => checkPackageObject(readJson(PACKAGE_PATH), true),
  },
  {
    name: 'patch-reference',
    selfTest: () => {
      const good = "- insert:\n    - id: dsh-tavern\n      name: 'dsh-tavern'\n"
      const bad = "- insert:\n    - id: other\n      name: 'other'\n"
      return checkPatchText(good).length === 0 && checkPatchText(bad).length > 0
        ? []
        : ['patch reference bad sample was not rejected']
    },
    check: () => checkPatchText(readFileSync(PATCH_PATH, 'utf8')),
  },
  {
    name: 'server-bundle',
    selfTest: () => {
      const routeMarkers = REQUIRED_SERVER_ROUTES.map((route) => `"${route}"`).join('\n')
      const versionReader = 'readFileSync("version.json", "utf8"); var BUILD_INFO = { version: "0.0.0", commit: "stub" };'
      const commitResolver = 'function resolveCommit() { execFileSync("git", ["rev-parse", "--show-toplevel"]); return "stub"; } var TAVERN_COMMIT = resolveCommit();'
      const good = `var name = "dsh-tavern"; var inject = []; function apply() {}\n${routeMarkers}\n"${API_PREFIX}"\n${versionReader}\n${commitResolver}\nvar bootstrap = { ok: true, version: BUILD_INFO.version, commit: TAVERN_COMMIT };\nexport { name, inject, apply };`
      const badRoute = good.replace('"generate"', '"missing"')
      const badStamp = good.replace('version: BUILD_INFO.version, ', '')
      const hardcodedCommit = good.replace('commit: TAVERN_COMMIT', 'commit: "stub"')
      return checkServerText(good).length === 0
        && checkServerText(badRoute).length > 0
        && checkServerText(badStamp).length > 0
        && checkServerText(hardcodedCommit).length > 0
        && checkServerFreshness(10, 10).length === 0
        && checkServerFreshness(11, 10).length > 0
        ? []
        : ['server bundle bad samples were not rejected']
    },
    check: () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      const versionProblems = checkVersionFile()
      const packageStat = statSync(PACKAGE_PATH)
      const newestSource = Math.max(statSync(SOURCE_PATH).mtimeMs, packageStat.mtimeMs)
      const serverStat = statSync(SERVER_PATH)
      return [
        ...checkServerFreshness(newestSource, serverStat.mtimeMs),
        ...versionProblems,
        ...(versionProblems.length === 0
          ? checkVersionFreshness(packageStat.mtimeMs, statSync(VERSION_PATH).mtimeMs)
          : []),
        ...checkServerText(readFileSync(SERVER_PATH, 'utf8')),
      ]
    },
  },
  {
    name: 'client-bundle',
    selfTest: () => {
      const good = "window.__ModuleLoader__.load({ id: 'dsh-tavern', factory: (require) => { var module = { exports: {} }; var exports = module.exports; require('react'); require('@deepseek-ai/dsh-client-ui-primitives'); const markers = ['revision', 'CHAT_REVISION_CONFLICT', 'bindings/prune']; exports.name = 'dsh-tavern'; exports.inject = ['slots']; exports.apply = () => markers; return module.exports; } });"
      const bad = good.replace("require('react')", "require('@deepseek-ai/not-platform')")
      return checkClientText(good).length === 0 && checkClientText(bad).length > 0
        ? []
        : ['client static bad sample was not rejected']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkClientText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'frontend-runtime',
    selfTest: () => {
      const good = [
        'function extractFrontendDocuments() {}',
        'function buildFrontendDocument() {}',
        'dsh-tavern:frontend-height',
        "sandbox: 'allow-scripts'",
        "connect-src 'none'",
        'event.source !== frameRef.current?.contentWindow',
        'message.streaming',
      ].join('\n')
      const bad = good.replace("sandbox: 'allow-scripts'", "sandbox: 'allow-forms'")
      return checkFrontendRuntimeText(good).length === 0 && checkFrontendRuntimeText(bad).length > 0
        ? []
        : ['frontend runtime marker self-test did not distinguish an unsafe sample']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkFrontendRuntimeText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'client-vm-mount',
    selfTest: async () => {
      const localeWiring = "ctx.effect(() => ctx.locale.register('dsh-tavern', { zh: { 'nav.title': '酒馆' }, en: { 'nav.title': 'Tavern' } })); ctx.locale.bind('dsh-tavern');"
      const good = `window.__ModuleLoader__.load({ id: 'dsh-tavern', factory: (require) => { var module = { exports: {} }; var exports = module.exports; require('react'); exports.name = 'dsh-tavern'; exports.inject = ['slots', 'locale']; exports.apply = (ctx) => { ${localeWiring} const entries = [['settings.section','dsh-tavern'],['conversation.view','tavern'],['conversation.composer',null],['conversation.session.header.actions','dsh-tavern'],['shell.overlay','dsh-tavern-panel'],['sidebar.footer.action','dsh-tavern-panel']]; for (const [name,id] of entries) ctx.slots.inject(name, () => ctx.slots.register({ name, ...(id ? { id } : {}), ...(name === 'conversation.composer' ? { select: () => null } : {}) }, () => null)); }; return module.exports; } });`
      const badSlot = good.replace("['conversation.view','tavern'],", '')
      const badLocale = good.replace("exports.inject = ['slots', 'locale']", "exports.inject = ['slots']")
      const badParity = good.replace("en: { 'nav.title': 'Tavern' }", "en: {}")
      const goodProblems = await checkClientExecution(good)
      const failureCounts = (await Promise.all([badSlot, badLocale, badParity].map((sample) => checkClientExecution(sample))))
        .filter((problems) => problems.length > 0).length
      return goodProblems.length === 0 && failureCounts === 3
        ? []
        : ['client VM bad samples were not rejected']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkClientExecution(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'node-half-mount',
    selfTest: () => {
      const good = {
        name: PLUGIN_NAME,
        inject: ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands'],
        applyType: 'function',
        sections: [{ name: 'dsh-tavern:active-character', textType: 'function' }],
        registrations: [
          { kind: 'prefix', path: API_PREFIX, handlerType: 'function' },
          { kind: 'command', name: 'tavern', handlerType: 'function' },
        ],
      }
      const bad = { ...good, registrations: [] }
      return checkNodeMountResult(good).length === 0 && checkNodeMountResult(bad).length > 0
        ? []
        : ['Node mount bad sample was not rejected']
    },
    check: () => existsSync(SERVER_PATH) ? runNodeMount() : ['generated packages/plugin/index.mjs does not exist'],
  },
]

const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1]
if (onlyIndex !== -1 && (!only || !gates.some((gate) => gate.name === only))) {
  console.error(`[FAIL] unknown gate '${only ?? ''}'`)
  console.error(`Available gates: ${gates.map((gate) => gate.name).join(', ')}`)
  process.exit(2)
}

let failures = 0
for (const gate of gates) {
  if (only !== null && gate.name !== only) continue
  let selfProblems
  try {
    selfProblems = await gate.selfTest()
  } catch (error) {
    selfProblems = [error instanceof Error ? error.stack ?? error.message : String(error)]
  }
  if (selfProblems.length > 0) {
    failures += 1
    console.error(`[FAIL] ${gate.name} self-test`)
    for (const item of selfProblems) console.error(`  - ${item}`)
    continue
  }

  let problems
  try {
    problems = await gate.check()
  } catch (error) {
    problems = [error instanceof Error ? error.stack ?? error.message : String(error)]
  }
  if (problems.length === 0) {
    console.log(`[PASS] ${gate.name}`)
  } else {
    failures += 1
    console.error(`[FAIL] ${gate.name}`)
    for (const item of problems) console.error(`  - ${item}`)
  }
}

if (failures > 0) {
  console.error(`\nGate result: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('\nGate result: PASS')

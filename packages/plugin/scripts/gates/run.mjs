#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { build as esbuildBuild } from 'esbuild'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..')
const PACKAGE_PATH = join(PLUGIN_ROOT, 'package.json')
const VERSION_PATH = join(PLUGIN_ROOT, 'version.json')
const PATCH_PATH = join(PLUGIN_ROOT, 'cordis.patch.yml')
const SOURCE_PATH = join(PLUGIN_ROOT, 'src', 'index.ts')
const SERVER_PATH = join(PLUGIN_ROOT, 'index.mjs')
const AGENT_PATH = join(PLUGIN_ROOT, 'agent.mjs')
const NOVEL_PATH = join(PLUGIN_ROOT, 'novel.mjs')
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
  'agent-tavern/audit',
  'projection',
  'projection/replay',
  'regex',
  'script',
  'generate',
  'novels',
  'novels/pause',
  'novels/resume',
  'novels/stop',
  'novels/update-outline',
  'novels/approve-outline',
  'novels/export',
  'novels/outline',
  'novels/body',
  'update',
  'update/check',
  'update/install',
]

// DSH client-web's platform module table, mirrored from the host web shell's
// staticModules seed (verified against DSH 0.2.0-rc.2's dsh-web-frontend).
// Third-party plugin values must flow through injected services, not through
// client-side package imports. The host dropped web-react / schema-form /
// ui-attachment and added client-store / ui-dockkit between 0.1.0-rc.6 and
// 0.1.5-rc.2 — re-sync this copy whenever the verification baseline moves
// (the seed is unchanged from 0.1.5-rc.2 through 0.2.0-rc.2).
const CLIENT_STATIC_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
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
  if (pkg.exports?.['./novel'] !== './novel.mjs') {
    problems.push("exports['./novel'] must be './novel.mjs'")
  }
  if (pkg.exports?.['./package.json'] !== './package.json') {
    problems.push("exports['./package.json'] must be './package.json'")
  }
  if (!Array.isArray(pkg.files)) {
    problems.push('files must be an array')
  } else {
    for (const entry of ['index.mjs', 'novel.mjs', 'version.json', 'client', 'cordis.patch.yml', 'README.md']) {
      if (!pkg.files.includes(entry)) problems.push(`files must include '${entry}'`)
    }
  }
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push("dsh.bundle.patch must be './cordis.patch.yml'")
  }
  if (pkg.dsh?.manifestVersion !== 1) {
    problems.push('dsh.manifestVersion must be 1')
  }
  // 注：不要在这里加 @deepseek-ai/dsh* 的 peerDependencies 版本护栏。宿主的
  // evaluatePluginCompatibility 确实只按名字模式 + semver 读取它，但 pnpm v11
  // 的 autoInstallPeer 会无视 optional 元数据把整棵宿主运行时（node-pty/koffi
  // 等原生构建）拖进每个安装现场，pnpm check 已实证撞 ERR_PNPM_IGNORED_BUILDS。
  // 版本边界由本 gate 集与 .npm-cache 运行时基线共同守护。
  if (pkg.dsh?.client?.platform !== 'web') problems.push("dsh.client.platform must be 'web'")
  if (!Array.isArray(pkg.dsh?.client?.inject) || !pkg.dsh.client.inject.every((value) => typeof value === 'string')) {
    problems.push('dsh.client.inject must be an array of package-name strings')
  }

  if (checkFiles) {
    for (const [label, value] of [
      ['main', pkg.main],
      ["exports['.']", pkg.exports?.['.']],
      ["exports['./client']", pkg.exports?.['./client']],
      ["exports['./cordis.patch.yml']", pkg.exports?.['./cordis.patch.yml']],
      ["exports['./novel']", pkg.exports?.['./novel']],
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

/**
 * client.inject edges name host client packages the boot wire must load before
 * this plugin's client half arrives. A name the host no longer ships (DSH
 * 0.1.5-rc.2 removed dsh-client-runtime) leaves a dangling wire edge — the
 * current loader skips it silently, but that is host grace, not a contract.
 * Guard it here so a stale manifest fails the gate instead of the browser.
 * Degrades to a no-op when no official dependency root is locatable, matching
 * the restricted-environment pattern of runNodeMount.
 */
function checkClientInjectPackagesResolvable(pkg) {
  const inject = pkg?.dsh?.client?.inject
  if (!Array.isArray(inject) || inject.length === 0) return []
  const root = locateOfficialDependencyRoot()
  if (root === null) return []
  const problems = []
  for (const name of inject) {
    if (typeof name !== 'string') continue
    const segments = name.split('/')
    const resolvable = existsSync(join(root, ...segments, 'package.json'))
      || existsSync(join(root, '@deepseek-ai', 'dsh', 'node_modules', ...segments, 'package.json'))
    if (!resolvable) {
      problems.push(`dsh.client.inject entry '${name}' does not resolve in the official DSH install (dangling client edge)`)
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
      // 只取 id 后的第一个 name：preset 行的 config.plugins 子块里还有更深的
      // `- id / name` 对，后扫描的浅层 name 不能被子条目覆盖。
      if (nameMatch !== null && entry.name === undefined) entry.name = unquoteYamlScalar(nameMatch[1])
    }
    entries.push(entry)
  }
  return entries
}

/** ST 生成轨迹的词汇表 tripwire：assistant/chunk 是 v0 词汇，v4 加载整件拒收。 */
function serverAppendsAssistantChunk(text) {
  return /append\(\s*['"]assistant\/chunk['"]/.test(text)
}

function checkPatchText(text) {
  const problems = []
  if (!/^\s*-\s+insert:\s*$/m.test(text)) problems.push('patch must contain a top-level insert list')
  const entries = parsePatchEntries(text)
  if (!entries.some((entry) => entry.id === PLUGIN_NAME && entry.name === PLUGIN_NAME)) {
    problems.push(`patch must insert id/name '${PLUGIN_NAME}'`)
  }
  // 两个 Agent preset 声明行（DSH 0.2.0 起 preset 的唯一投递方式）：行在、
  // 目标包名对、config.id 与 bundle 内常量一致。config.id 是会话日志里的
  // agent-preset/selected 持久值——改 id 会让旧会话的 preset 恢复被宿主拒绝
  // （"rejects a missing definition"），所以这里同时锁定 patch 与产物两侧。
  for (const [rowId, presetId] of [['preset-agent-tavern', 'agent-tavern'], ['preset-agent-novel', 'agent-novel']]) {
    if (!entries.some((entry) => entry.id === rowId && entry.name === '@deepseek-ai/dsh-agent-preset')) {
      problems.push(`patch must insert preset row '${rowId}' targeting @deepseek-ai/dsh-agent-preset`)
    }
    if (!new RegExp(`id:\\s*['"]?${presetId}['"]?\\s*$`, 'm').test(text)) {
      problems.push(`patch preset row '${rowId}' must declare config.id '${presetId}'`)
    }
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
  if (!text.includes('assertStGenerationBinding')) {
    problems.push('server bundle must guard the ST generation route by architecture')
  }
  return problems
}


/**
 * 构建期 stamp 断言：esbuild define 必须把 __TAVERN_VERSION__ /
 * __TAVERN_COMMIT__ 全部替换成字面量。未替换的标识符在运行期 typeof 判断为
 * undefined，会让自更新退化成「commit 未知、只能比版本号」——静默失效比报错更
 * 难查，所以在 gate 里硬断言。
 */
function checkBuildStamps(text, version, commit) {
  const problems = []
  for (const stamp of ['__TAVERN_VERSION__', '__TAVERN_COMMIT__']) {
    if (text.includes(stamp)) {
      problems.push(`server bundle still contains the unstamped ${stamp} identifier (build through scripts/build-plugin.mjs)`)
    }
  }
  if (typeof version === 'string' && version !== '' && !text.includes(JSON.stringify(version))) {
    problems.push(`server bundle must carry the built version literal '${version}'`)
  }
  if (typeof commit === 'string' && commit !== '' && commit !== 'unknown' && !text.includes(JSON.stringify(commit))) {
    problems.push(`server bundle must carry the built commit literal '${commit}'`)
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

function checkNativeHeaderAdapterText(text) {
  const problems = []
  for (const marker of [
    'AgentPresetLabel.module.css',
    'function useNativeAgentPresetLabelFilter',
    'dshTavernAgentPresetHiddenState',
    'data-dsh-tavern-agent-preset-hidden',
    'useNativeAgentPresetLabelFilter(Boolean(active && binding && architecture === \'st\'))',
  ]) {
    if (!text.includes(marker)) problems.push(`native Tavern header adapter is missing marker '${marker}'`)
  }
  return problems
}

function checkClientArchitectureText(text) {
  const problems = []
  for (const marker of [
    'function newChatPolicy(group = false',
    "if (group) return { architecture: 'st', contextMode: 'dsh-native' }",
    ": state.defaultArchitecture === 'st' ? 'st' : 'agent-tavern'",
    "state.defaultContextMode === 'agent-managed'",
    "useNativeSessionTreeFilter(bindingIds, PanelHost.context",
    "const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})",
    "useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))",
    "if (policy.architecture === 'st') clickTavernTab(0)",
    'function reserveTavernSession(ctx, sessionId)',
    // 0.2.0-rc.2 契约：connectWorkspace 内部走 sessions.create，不隐式保留
    // 作用域；借 binding() 前必须显式 retain（ISessions.create 文档："retain
    // it before borrowing its binding"）。
    'DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)',
    'heldSession.release()',
    'select: selectTavernComposer',
    "disabled: bootstrap.agentTavern?.managed?.available !== true",
    'checked: bootstrap.state.agentTavernPreloadAssets === true',
    'existing[1].initializationPending === true',
  ]) {
    if (!text.includes(marker)) problems.push(`client architecture split is missing marker '${marker}'`)
  }
  return problems
}

function checkInternalWorkspaceText(serverText, clientText) {
  const problems = []
  for (const marker of [
    'internalWorkspace',
    'workbenchWorkspace',
    'TAVERN_WORKSPACE_TITLE',
    'TAVERN_WORKBENCH_WORKSPACE_TITLE',
    'dshHomePath("tavern", "workspace")',
    'dshHomePath("tavern", "workbench")',
  ]) {
    if (!serverText.includes(marker)) problems.push(`server internal workspace is missing marker '${marker}'`)
  }
  for (const marker of [
    'function ensureTavernWorkspace(ctx)',
    'function ensureWorkbenchWorkspace(ctx)',
    'ctx.workspaces.create({ path: config.path })',
        'function connectTavernWorkspace(ctx, workspaceId)',
    'uiWorkspace.connectWorkspace(workspaceId)',
    'ctx.workspaces.connectWorkspace(workspaceId)',
    'function pluginWorkspaceSnapshots(ctx)',
    'normalizeWorkspacePath(item?.path) === expectedPath',
    'function nativeTreeNodeMatchesWorkspace(node, workspace, titleFallback)',
    "items.filter((item) => item?.title === workspace.title).length === 1",
    "markNativeTreeRow(nativeTreeWorkspaceGroup(header, tree), 'internal-workspace')",
  ]) {
    if (!clientText.includes(marker)) problems.push(`client internal workspace is missing marker '${marker}'`)
  }
  if (clientText.includes('function currentWorkspace(ctx)')) {
    problems.push('client must not route Tavern sessions through the current native workspace')
  }
  return problems
}

function checkAgentTavernIsolation(sourceFiles, serverText) {
  const problems = []
  for (const [name, text] of sourceFiles) {
    for (const [label, pattern] of [
      ['llm.stream', /\bllm\.stream\b/],
      ['runGeneration', /\brunGeneration\b/],
      ['ST prompt pipeline', /\bassemble(?:Prompt|TextCompletion)\b|\bpipelineMode\b/],
    ]) {
      if (pattern.test(text)) problems.push(`AgentTavern module '${name}' references ${label}`)
    }
  }
  for (const marker of ['agent-tavern/audit', 'assertStGenerationBinding(state, body.sessionId)']) {
    if (!serverText.includes(marker)) problems.push(`server architecture isolation is missing marker '${marker}'`)
  }
  return problems
}

function agentTavernSourceFiles() {
  // Native-execution isolation covers both agent architectures (proposal
  // 0005 §18 host isolation): agent-tavern and agent-novel sources must stay
  // free of plugin-side LLM loops and ST prompt pipeline calls.
  const files = []
  for (const dir of ['agent-tavern', 'agent-novel']) {
    const root = join(PLUGIN_ROOT, 'src', dir)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
        files.push([`${dir}/${entry.name}`, readFileSync(join(root, entry.name), 'utf8')])
      }
    }
  }
  return files
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

function makeClientRequire(primitives) {
  const React = makeReactStub()
  // The host's UI primitive table is the parity baseline: when it is readable the
  // stub exposes exactly those names, so a primitive the plugin asks for but the
  // host does not export stays undefined here just like it would in the browser.
  // Only the unreachable-host fallback keeps the permissive stub.
  const primitivesModule = primitives === null
    ? new Proxy({}, { get: (_target, name) => callableStub(`primitives.${String(name)}`) })
    : Object.fromEntries([...primitives].map((name) => [name, callableStub(`primitives.${name}`)]))
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
    '@deepseek-ai/dsh-client-store': generic,
    '@deepseek-ai/dsh-client-ui-slots': generic,
    '@deepseek-ai/dsh-client-ui-primitives': primitivesModule,
    '@deepseek-ai/dsh-client-ui-dockkit': generic,
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

function loadClientModule(code, options = {}) {
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
  const module = handoff.factory(makeClientRequire(options.primitives ?? null))
  if (module === null || typeof module !== 'object' || typeof module.then === 'function') {
    throw new Error('client factory must synchronously return module exports')
  }
  return { module, sandbox }
}

function iterableEntries(value) {
  if (value === null || value === undefined) return []
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') return [...value]
  return [value]
}

/**
 * The client half resolves host UI atoms through @dsh-tavern/bind, which records
 * what it could actually serve. Anything the host cannot serve is either an icon
 * degraded to a null renderer (invisible button glyph) or a missing layout atom
 * (slot crashes on render) — both must fail the gate, which is what keeps a host
 * icon-set rename from shipping as a runtime React #130.
 */
function checkPrimitiveParity(trace) {
  const shape = trace?.uiPrimitives
  if (shape === undefined) {
    return ['client bundle must report host UI primitive resolution (window.__DSH_TAVERN_BIND__.uiPrimitives)']
  }
  if (!Array.isArray(shape.synthesized) || !Array.isArray(shape.missing)) {
    return ['client shape trace must expose synthesized/missing UI primitive lists']
  }
  const problems = []
  if (shape.synthesized.length > 0) {
    problems.push(`host ${PRIMITIVES_PACKAGE} cannot serve these icons: ${shape.synthesized.join(', ')} (the 0.2.0-rc.2 set is stroke-suffixed, e.g. IconSparkleRegular/IconSparkleMedium)`)
  }
  if (shape.missing.length > 0) {
    problems.push(`host ${PRIMITIVES_PACKAGE} does not export: ${shape.missing.join(', ')}`)
  }
  return problems
}


const REQUIRED_UPDATE_KEYS = [
  'update.title',
  'update.current',
  'update.latest',
  'update.check',
  'update.checking',
  'update.now',
  'update.installing',
  'update.confirm',
  'update.restartHint',
  'update.restartHintWeb',
  'update.checkedAt',
  'update.notes',
  'update.remoteError',
  'update.status.available',
  'update.status.upToDate',
  'update.status.localAhead',
  'update.status.restartRequired',
  'update.status.unknown',
]

async function checkClientExecution(code, options = {}) {
  const problems = []
  let module
  let sandbox
  try {
    ({ module, sandbox } = loadClientModule(code, options))
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
    if (zhKeys.join('\u0000') !== enKeys.join('\u0000')) {
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
  if (options.requireUpdateWiring === true) {
    for (const marker of ['update/check', 'update/install']) {
      if (!code.includes(marker)) problems.push(`client bundle must call the host '${marker}' route`)
    }
    if (!/\bUpdateBand\b/.test(code)) problems.push('client bundle must render the UpdateBand surface')
    for (const key of REQUIRED_UPDATE_KEYS) {
      if (!(key in (localeRegistration?.dicts?.zh ?? {}))) problems.push(`zh dictionary is missing '${key}'`)
      if (!(key in (localeRegistration?.dicts?.en ?? {}))) problems.push(`en dictionary is missing '${key}'`)
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
  const composer = registrations.find((candidate) => (candidate?.options ?? candidate?.opts)?.name === 'conversation.composer')
  const selectComposer = (composer?.options ?? composer?.opts)?.select
  if (typeof selectComposer !== 'function') {
    problems.push('conversation.composer must expose a select function')
  } else {
    const stMarker = {
      key: 'marker',
      kind: 'context',
      data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', tavernState: 'open' } },
    }
    const agentPreload = {
      key: 'preload',
      kind: 'context',
      data: { source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'context' } },
    }
    const stSelected = selectComposer({ session: { chat: { order: ['marker'], nodes: new Map([['marker', stMarker]]) } } })
    const agentSelected = selectComposer({ session: { chat: { order: ['preload'], nodes: new Map([['preload', agentPreload]]) } } })
    const nativeSelected = selectComposer({ session: { chat: { order: [], nodes: new Map() } } })
    if (stSelected === null || stSelected === undefined) problems.push('legacy ST session must select the Tavern composer')
    if (agentSelected !== null) problems.push('AgentTavern preload context must keep the native composer')
    if (nativeSelected !== null) problems.push('native session must keep the native composer')
  }
  if (options.requirePrimitiveParity === true) {
    problems.push(...checkPrimitiveParity(sandbox.window?.__DSH_TAVERN_BIND__))
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
  const candidates = [
    // Keep the vendored runtime copied into the workspace usable in restricted
    // environments where the global npm installation is not readable.
    join(REPO_ROOT, '.npm-cache', 'dsh-runtime', 'node_modules'),
  ]
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(entry, join(entry, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  const globalRoot = npmGlobalRoot()
  if (globalRoot !== null) {
    candidates.push(globalRoot, join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  return candidates.find(hasOfficialDependencies) ?? null
}

const PRIMITIVES_PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The host's runtime export names for the UI primitive table. DSH 0.2.0-rc.2
 * renamed the whole product icon set from size suffixes (IconSparkle16) to
 * stroke suffixes (IconSparkleRegular/Medium); a plugin that still asks for the
 * old names destructures undefined and renders React #130 into every slot that
 * mounts the icon, so the client VM gate compares against this table instead of
 * handing out a stub for any name.
 */
function hostPrimitiveExports() {
  const root = locateOfficialDependencyRoot()
  if (root === null) return null
  const entry = [
    join(root, PRIMITIVES_PACKAGE, 'lib', 'index.js'),
    join(root, '@deepseek-ai', 'dsh', 'node_modules', PRIMITIVES_PACKAGE, 'lib', 'index.js'),
  ].find((candidate) => existsSync(candidate))
  if (entry === undefined) return null
  const names = new Set()
  for (const block of readFileSync(entry, 'utf8').matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const part of block[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return names.size > 0 ? names : null
}

const NODE_MOUNT_SCRIPT = String.raw`
const entry = process.env.DSH_TAVERN_GATE_ENTRY
if (!entry) throw new Error('missing DSH_TAVERN_GATE_ENTRY')
const mod = await import(entry)
const sections = []
const registrations = []
const effects = []
const ctx = {
  commands: { register: (value) => { registrations.push({ kind: 'command', name: value.name, handlerType: typeof value.handler }); if (value.name === 'dsh-tavern-session') commandHandler = value.handler; return () => {} } },
  systemPrompt: { section: (value) => { sections.push(value) } },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback, label) => { effects.push(label); return callback() },
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
}
let commandHandler = null
mod.apply(ctx)
// Novel-open payload parse probe (proposal 0005 §4.2 bridge): an unknown novel
// must produce a handled error, never the invalid-payload rejection.
let novelOpen = { kind: null, invalidPayload: true }
if (typeof commandHandler === 'function') {
  try {
    const sessionLog = []
    const novelAgent = {
      id: 'gate-novel-probe',
      ctx: {},
      session: {
        log: sessionLog,
        snapshotEvents: () => Object.freeze([...sessionLog]),
        append: (type, data) => { sessionLog.push({ type, seq: sessionLog.length, time: 0, data }) },
      },
    }
    const payload = Buffer.from(JSON.stringify({ action: 'novel-open', novelId: 'gate-probe' })).toString('base64url')
    const outcome = await commandHandler({ agent: novelAgent, rawInput: payload })
    novelOpen = { kind: outcome?.kind ?? null, invalidPayload: outcome?.text === 'Invalid Tavern activation payload.' }
  } catch (error) {
    novelOpen = { kind: 'threw', invalidPayload: true, message: String(error?.message ?? error) }
  }
}
console.log('DSH_TAVERN_GATE_RESULT=' + JSON.stringify({
  name: mod.name,
  inject: mod.inject,
  applyType: typeof mod.apply,
  sections: sections.map(({ name, order, text }) => ({ name, order, textType: typeof text })),
  registrations: registrations.map(({ kind, path, name, handler, handlerType }) => ({ kind, path, name, handlerType: handlerType ?? typeof handler })),
  effects,
  novelOpen,
}))
`

function checkNodeMountResult(result) {
  const problems = []
  if (result.name !== PLUGIN_NAME) problems.push(`Node module name must be '${PLUGIN_NAME}'`)
  if (result.applyType !== 'function') problems.push('Node module apply export must be a function')
  if (!Array.isArray(result.inject)) {
    problems.push('Node module inject export must be an array')
  } else {
    // 与 src/index.ts 的 inject 声明同步的宿主服务全集（0.2.0-rc.2 审计后从 6
    // 项补齐到 9 项）：宿主移除任一服务时这里必须报警，而不是等运行期抛错。
    for (const service of ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction']) {
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
  const command = result.registrations?.find((value) => value.kind === 'command' && value.name === 'dsh-tavern-session')
  if (command === undefined) problems.push("Node apply did not register the internal Tavern session bridge")
  else if (command.handlerType !== 'function') problems.push('Node Tavern session bridge has no handler function')
  if (result.registrations?.some((value) => value.kind === 'command' && value.name === 'tavern')) {
    problems.push("Node apply must not expose the public '/tavern' activation command")
  }
  if (result.novelOpen?.invalidPayload !== false) {
    problems.push('internal session bridge must parse novel-open payloads (expected a handled unknown-novel error)')
  }
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


const UPDATE_ROUTE_SCRIPT = String.raw`
const entry = process.env.DSH_TAVERN_GATE_ENTRY
if (!entry) throw new Error('missing DSH_TAVERN_GATE_ENTRY')
const mod = await import(entry)
const registrations = []
const installedSpecs = []
const installBundleOptions = []
let installLogHandler = null
const pluginManagerStub = {
  installBundle: (spec, options) => {
    installedSpecs.push(spec)
    installBundleOptions.push(options || {})
    if (typeof installLogHandler === 'function') {
      installLogHandler({ requestId: options?.requestId, jobId: 'gate', argv: ['pnpm', 'add', spec], cwd: process.cwd(), stream: 'stdout', text: 'Progress: resolved 1, added 1' })
    }
    return Promise.resolve({ changed: true, application: 'restart-required', stage: 'install', target: spec, bundle: 'dsh-tavern' })
  },
}
const ctx = {
  commands: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback) => callback(),
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  get: (name) => (name === 'pluginManager' ? pluginManagerStub : undefined),
  on: (event, handler) => { if (event === 'plugin-manager/install-log') installLogHandler = handler; return () => {} },
}
mod.apply(ctx)
const UPDATE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
globalThis.fetch = async (url) => {
  const target = String(url)
  const reply = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) })
  if (target.includes('api.github.com') && target.includes('/commits/')) return reply({ sha: UPDATE_SHA, commit: { message: 'feat: update', author: { date: '2026-10-05T00:00:00Z' } } })
  if (target.includes('api.github.com') && target.includes('/compare/')) return reply({ commits: [{ sha: UPDATE_SHA, commit: { message: 'feat: update' } }], files: [{ filename: 'packages/plugin/index.mjs' }] })
  if (target.includes('raw.githubusercontent.com')) return reply({ version: '9.9.9' })
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
}
const route = registrations.find((value) => value.kind === 'prefix' && value.path === '/api/dsh-tavern')
function callRoute(method, url, body) {
  return new Promise((resolve, reject) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      on: (event, handler) => { if (event === 'data') for (const chunk of chunks) handler(chunk); if (event === 'end') handler(); return req },
    }
    const res = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader: () => {},
      write: () => {},
      end: (payload) => {
        res.writableEnded = true
        try { resolve({ status: res.statusCode, body: payload === undefined ? null : JSON.parse(payload) }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
const probe = { reachable: false }
if (route !== undefined && typeof route.handler === 'function') {
  const checked = await callRoute('GET', '/api/dsh-tavern/update?refresh=1')
  const checkedUpdate = checked.body && checked.body.update ? checked.body.update : {}
  const changelog = checked.body && Array.isArray(checked.body.changelog) ? checked.body.changelog : []
  const missing = await callRoute('GET', '/api/dsh-tavern/update/nope')
  const installed = await callRoute('POST', '/api/dsh-tavern/update/install', { wait: false })
  const startedFlag = installed.body ? installed.body.started === true : false
  let afterInstall = installed.body && installed.body.update ? installed.body.update : {}
  for (let attempt = 0; attempt < 40 && afterInstall.install && afterInstall.install.running === true; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const polled = await callRoute('GET', '/api/dsh-tavern/update')
    afterInstall = polled.body && polled.body.update ? polled.body.update : afterInstall
  }
  const installState = afterInstall.install || {}
  const log = Array.isArray(installState.log) ? installState.log : []
  probe.reachable = true
  probe.checkStatus = checkedUpdate.status || null
  probe.checkCommit = checkedUpdate.remote ? checkedUpdate.remote.commit || null : null
  probe.checkVersion = checkedUpdate.remote ? checkedUpdate.remote.version || null : null
  probe.localVersion = checkedUpdate.local ? checkedUpdate.local.version || null : null
  probe.spec = checkedUpdate.spec || null
  probe.changelog = changelog
  probe.missingRouteStatus = missing.status
  probe.installStarted = startedFlag
  probe.installPhase = installState.phase || null
  probe.installStrategy = installState.strategy || null
  probe.installRestartRequired = installState.restartRequired === true
  probe.installLogTail = log.length > 0 ? log[log.length - 1] : ''
  probe.installedSpecs = installedSpecs
  probe.installRequestId = typeof installBundleOptions[0]?.requestId === 'string'
}
console.log('DSH_TAVERN_GATE_RESULT=' + JSON.stringify(probe))
`

function checkUpdateRouteResult(result) {
  const problems = []
  if (result?.reachable !== true) {
    problems.push('update routes did not answer through the webServer prefix handler')
    return problems
  }
  if (result.checkStatus !== 'update-available') problems.push('update check must report update-available for a newer remote build')
  if (result.checkCommit !== 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678') problems.push('update check must carry the remote commit')
  if (result.checkVersion !== '9.9.9') problems.push('update check must read the remote package.json version')
  if (typeof result.localVersion !== 'string' || result.localVersion === '') problems.push('update check must report the local build version')
  if (result.spec !== 'github:LingyeSoul/dsh-tavern#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin') {
    problems.push('update snapshot must expose a pinned pnpm git spec')
  }
  if (!Array.isArray(result.changelog) || result.changelog.length === 0) problems.push('update check must return a changelog')
  if (result.missingRouteStatus !== 404) problems.push('unknown update subroutes must answer 404')
  if (result.installStarted !== true) problems.push('update install must acknowledge the started job')
  if (result.installPhase !== 'done') problems.push('update install must finish in the done phase when the plugin manager succeeds')
  if (result.installStrategy !== 'plugin-manager') problems.push('update install must report which落地 strategy ran')
  if (result.installRestartRequired !== true) problems.push('a plugin-manager package replacement must report restart-required')
  if (!result.installLogTail.includes('Progress: resolved 1')) problems.push('pnpm install-log chunks must reach the update snapshot')
  if (result.installRequestId !== true) problems.push('installBundle must receive a requestId so pnpm output can be correlated')
  const specs = Array.isArray(result.installedSpecs) ? result.installedSpecs : []
  if (specs.length !== 1 || !String(specs[0]).includes('#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin')) {
    problems.push('installBundle must be called once with the pinned subdirectory spec')
  }
  return problems
}

function runUpdateRouteProbe() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tavern-update-gate-'))
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
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', UPDATE_ROUTE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_PROFILE: 'desktop',
        // 让 CLI 落地路径确定性失败（文件不存在），把安装逼到 plugin-manager 替身上。
        DSH_TAVERN_DSH_CLI: join(tempRoot, 'missing-cli.js'),
        DSH_TAVERN_GATE_ENTRY: pathToFileURL(entryPath).href,
        ...(dependencyRoot === null ? {} : { NODE_PATH: dependencyRoot }),
      },
      timeout: 30_000,
      windowsHide: true,
    })
    if (child.error) return ['update route subprocess failed: ' + child.error.message]
    if (child.status !== 0) {
      const detail = (child.stderr || child.stdout).trim().split(/\r?\n/).at(-1) ?? 'exit ' + child.status
      return ['update route subprocess exited ' + child.status + ': ' + detail]
    }
    const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith('DSH_TAVERN_GATE_RESULT='))
    if (line === undefined) return ['update route subprocess returned no result record']
    return checkUpdateRouteResult(JSON.parse(line.slice('DSH_TAVERN_GATE_RESULT='.length)))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

const gates = [
  {
    name: 'update-routes',
    selfTest: () => {
      const good = {
        reachable: true,
        checkStatus: 'update-available',
        checkCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        checkVersion: '9.9.9',
        localVersion: '0.3.8',
        spec: 'github:LingyeSoul/dsh-tavern#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin',
        changelog: ['a1b2c3d feat: update'],
        missingRouteStatus: 404,
        installStarted: true,
        installPhase: 'done',
        installStrategy: 'plugin-manager',
        installRestartRequired: true,
        installLogTail: '12:00:00 pnpm stdout: Progress: resolved 1, added 1',
        installedSpecs: ['github:LingyeSoul/dsh-tavern#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin'],
        installRequestId: true,
      }
      const badSamples = [
        { ...good, reachable: false },
        { ...good, checkStatus: 'up-to-date' },
        { ...good, spec: 'github:LingyeSoul/dsh-tavern#main&path:/packages/plugin' },
        { ...good, installPhase: 'failed' },
        { ...good, installStrategy: 'checkout' },
        { ...good, installRestartRequired: false },
        { ...good, installLogTail: '' },
        { ...good, installRequestId: false },
        { ...good, installedSpecs: [] },
        { ...good, changelog: [] },
        { ...good, missingRouteStatus: 200 },
      ]
      const rejected = badSamples.filter((sample) => checkUpdateRouteResult(sample).length > 0).length
      return checkUpdateRouteResult(good).length === 0 && rejected === badSamples.length
        ? []
        : ['update route bad samples were not rejected']
    },
    check: () => existsSync(SERVER_PATH) ? runUpdateRouteProbe() : ['generated packages/plugin/index.mjs does not exist'],
  },
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
          './novel': './novel.mjs',
          './package.json': './package.json',
        },
        files: ['index.mjs', 'novel.mjs', 'version.json', 'client', 'cordis.patch.yml', 'README.md'],
        dsh: {
          manifestVersion: 1,
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: [] },
        },
      }
      const bad = structuredClone(valid)
      bad.dsh.client.platform = 'node'
      const badManifest = structuredClone(valid)
      delete badManifest.dsh.manifestVersion
      return checkPackageObject(valid).length === 0 && checkPackageObject(bad).length > 0 && checkPackageObject(badManifest).length > 0
        ? []
        : ['package contract bad samples were not distinguished from the valid sample']
    },
    check: () => {
      const pkg = readJson(PACKAGE_PATH)
      return [...checkPackageObject(pkg, true), ...checkClientInjectPackagesResolvable(pkg)]
    },
  },
  {
    name: 'patch-reference',
    selfTest: () => {
      const good = '- insert:\n'
        + '    - id: dsh-tavern\n      name: \'dsh-tavern\'\n'
        + '    - id: preset-agent-tavern\n      name: \'@deepseek-ai/dsh-agent-preset\'\n      config:\n        id: agent-tavern\n'
        + '    - id: preset-agent-novel\n      name: \'@deepseek-ai/dsh-agent-preset\'\n      config:\n        id: agent-novel\n'
      const bad = "- insert:\n    - id: other\n      name: 'other'\n"
      const badPresetId = good.replace('id: agent-tavern', 'id: agent-tavern-x')
      return checkPatchText(good).length === 0 && checkPatchText(bad).length > 0 && checkPatchText(badPresetId).length > 0
        ? []
        : ['patch reference bad samples were not rejected']
    },
    check: () => {
      const problems = checkPatchText(readFileSync(PATCH_PATH, 'utf8'))
      // patch 声明的 config.id 必须与构建产物内的常量同值（见 checkPatchText 注释）。
      if (existsSync(SERVER_PATH)) {
        const server = readFileSync(SERVER_PATH, 'utf8')
        if (!server.includes('agent-tavern')) problems.push('built server bundle lost the agent-tavern preset id constant')
      }
      for (const [path, presetId] of [[AGENT_PATH, 'agent-tavern'], [NOVEL_PATH, 'agent-novel']]) {
        if (!existsSync(path)) {
          problems.push(`generated ${path} does not exist`)
          continue
        }
        if (!readFileSync(path, 'utf8').includes(presetId)) {
          problems.push(`built ${basename(path)} lost the '${presetId}' preset id constant`)
        }
      }
      return problems
    },
  },
  {
    name: 'server-bundle',
    selfTest: () => {
      const routeMarkers = REQUIRED_SERVER_ROUTES.map((route) => `"${route}"`).join('\n')
      const versionReader = 'readFileSync("version.json", "utf8"); var BUILD_INFO = { version: "0.0.0", commit: "stub" };'
      const commitResolver = 'function resolveCommit() { execFileSync("git", ["rev-parse", "--show-toplevel"]); return "stub"; } var TAVERN_COMMIT = resolveCommit();'
      const good = `var name = "dsh-tavern"; var inject = []; function apply() {} function assertStGenerationBinding() {}\n${routeMarkers}\n"${API_PREFIX}"\n${versionReader}\n${commitResolver}\nvar bootstrap = { ok: true, version: BUILD_INFO.version, commit: TAVERN_COMMIT };\nexport { name, inject, apply };`
      const badRoute = good.replace('"generate"', '"missing"')
      const badStamp = good.replace('version: BUILD_INFO.version, ', '')
      const hardcodedCommit = good.replace('commit: TAVERN_COMMIT', 'commit: "stub"')
      return checkServerText(good).length === 0
        && checkServerText(badRoute).length > 0
        && checkServerText(badStamp).length > 0
        && checkServerText(hardcodedCommit).length > 0
        && checkServerFreshness(10, 10).length === 0
        && checkBuildStamps('var built = { version: "0.0.0", commit: "abc1234" };', '0.0.0', 'abc1234').length === 0
        && checkBuildStamps('var built = { version: __TAVERN_VERSION__, commit: __TAVERN_COMMIT__ };', '0.0.0', 'abc1234').length > 0
        && checkBuildStamps('var built = { version: "0.0.0", commit: "abc1234" };', '9.9.9', 'abc1234').length > 0
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
        ...checkBuildStamps(readFileSync(SERVER_PATH, 'utf8'), readJson(PACKAGE_PATH).version, readJson(VERSION_PATH).commit),
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
    name: 'native-header-adapter',
    selfTest: () => {
      const good = [
        'AgentPresetLabel.module.css',
        'function useNativeAgentPresetLabelFilter() {}',
        'dshTavernAgentPresetHiddenState',
        'data-dsh-tavern-agent-preset-hidden',
        "useNativeAgentPresetLabelFilter(Boolean(active && binding && architecture === 'st'))",
      ].join('\n')
      const bad = good.replace("Boolean(active && binding && architecture === 'st')", 'true')
      return checkNativeHeaderAdapterText(good).length === 0
        && checkNativeHeaderAdapterText(bad).length > 0
        ? []
        : ['native header adapter self-test did not distinguish a globally enabled sample']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkNativeHeaderAdapterText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'client-architecture-split',
    selfTest: () => {
      const good = [
        'function newChatPolicy(group = false',
        "if (group) return { architecture: 'st', contextMode: 'dsh-native' }",
        ": state.defaultArchitecture === 'st' ? 'st' : 'agent-tavern'",
        "state.defaultContextMode === 'agent-managed'",
        'useNativeSessionTreeFilter(bindingIds, PanelHost.context',
        "const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})",
        "useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))",
        "if (policy.architecture === 'st') clickTavernTab(0)",
        'function reserveTavernSession(ctx, sessionId)',
        'DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)',
        'heldSession.release()',
        'select: selectTavernComposer',
        "disabled: bootstrap.agentTavern?.managed?.available !== true",
        'checked: bootstrap.state.agentTavernPreloadAssets === true',
        'existing[1].initializationPending === true',
      ].join('\n')
      const badTree = good.replace('useNativeSessionTreeFilter(bindingIds, PanelHost.context', 'useNativeSessionTreeFilter([], PanelHost.context')
      const badTab = good.replace("bindingArchitecture(currentBinding) === 'st'", 'true')
      return checkClientArchitectureText(good).length === 0
        && checkClientArchitectureText(badTree).length > 0
        && checkClientArchitectureText(badTab).length > 0
        ? []
        : ['client architecture split self-test did not protect the native tree and tab routing']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkClientArchitectureText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'internal-workspace',
    selfTest: () => {
      const server = [
        'internalWorkspace workbenchWorkspace',
        'TAVERN_WORKSPACE_TITLE TAVERN_WORKBENCH_WORKSPACE_TITLE',
        'dshHomePath("tavern", "workspace") dshHomePath("tavern", "workbench")',
      ].join('\n')
      const client = [
        'function ensureTavernWorkspace(ctx)',
        'function ensureWorkbenchWorkspace(ctx)',
        'ctx.workspaces.create({ path: config.path })',
                'function connectTavernWorkspace(ctx, workspaceId)',
        'uiWorkspace.connectWorkspace(workspaceId)',
        'ctx.workspaces.connectWorkspace(workspaceId)',
        'function pluginWorkspaceSnapshots(ctx)',
        'normalizeWorkspacePath(item?.path) === expectedPath',
        'function nativeTreeNodeMatchesWorkspace(node, workspace, titleFallback)',
        "items.filter((item) => item?.title === workspace.title).length === 1",
        "markNativeTreeRow(nativeTreeWorkspaceGroup(header, tree), 'internal-workspace')",
      ].join('\n')
      const bad = `${client}\nfunction currentWorkspace(ctx) {}`
      const titleOnly = [
        'function ensureTavernWorkspace(ctx)',
        'function ensureWorkbenchWorkspace(ctx)',
        'ctx.workspaces.create({ path: config.path })',
                'function connectTavernWorkspace(ctx, workspaceId)',
        'uiWorkspace.connectWorkspace(workspaceId)',
        'ctx.workspaces.connectWorkspace(workspaceId)',
        "if (node.textContent === 'Tavern (internal)') node.hidden = true",
      ].join('\n')
      return checkInternalWorkspaceText(server, client).length === 0
        && checkInternalWorkspaceText(server, bad).length > 0
        && checkInternalWorkspaceText(server, titleOnly).length > 0
        && checkInternalWorkspaceText('', client).length > 0
        ? []
        : ['internal workspace self-test did not reject native-workspace routing']
    },
    check: () => existsSync(SERVER_PATH) && existsSync(CLIENT_PATH)
      ? checkInternalWorkspaceText(readFileSync(SERVER_PATH, 'utf8'), readFileSync(CLIENT_PATH, 'utf8'))
      : ['internal workspace gate requires both server and client bundles'],
  },
  {
    name: 'agent-tavern-isolation',
    selfTest: () => {
      const good = checkAgentTavernIsolation([
        ['runtime.ts', 'export function runAgentLoop() {}'],
        ['tools.ts', 'export function tool() {}'],
      ], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)')
      const bad = checkAgentTavernIsolation([
        ['runtime.ts', 'ctx.llm.stream()'],
      ], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)')
      return good.length === 0 && bad.length > 0
        ? []
        : ['AgentTavern isolation self-test did not reject ST generation calls']
    },
    check: () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      return checkAgentTavernIsolation(agentTavernSourceFiles(), readFileSync(SERVER_PATH, 'utf8'))
    },
  },
  {
    name: 'client-vm-mount',
    selfTest: async () => {
      const localeWiring = "ctx.effect(() => ctx.locale.register('dsh-tavern', { zh: { 'nav.title': '酒馆' }, en: { 'nav.title': 'Tavern' } })); ctx.locale.bind('dsh-tavern');"
      const good = `window.__ModuleLoader__.load({ id: 'dsh-tavern', factory: (require) => { var module = { exports: {} }; var exports = module.exports; require('react'); exports.name = 'dsh-tavern'; exports.inject = ['slots', 'locale']; exports.apply = (ctx) => { ${localeWiring} const entries = [['settings.section','dsh-tavern'],['conversation.view','tavern'],['conversation.composer',null],['conversation.session.header.actions','dsh-tavern'],['shell.overlay','dsh-tavern-panel'],['sidebar.footer.action','dsh-tavern-panel']]; for (const [name,id] of entries) ctx.slots.inject(name, () => ctx.slots.register({ name, ...(id ? { id } : {}), ...(name === 'conversation.composer' ? { select: (owner) => owner?.session?.chat?.order?.some((key) => owner.session.chat.nodes.get(key)?.data?.source?.form === 'notice') ? {} : null } : {}) }, () => null)); }; return module.exports; } });`
      const badSlot = good.replace("['conversation.view','tavern'],", '')
      const badLocale = good.replace("exports.inject = ['slots', 'locale']", "exports.inject = ['slots']")
      const badParity = good.replace("en: { 'nav.title': 'Tavern' }", "en: {}")
      const badComposer = good.replace("owner.session.chat.nodes.get(key)?.data?.source?.form === 'notice'", 'true')
      const goodProblems = await checkClientExecution(good)
      const failureCounts = (await Promise.all([badSlot, badLocale, badParity, badComposer].map((sample) => checkClientExecution(sample))))
        .filter((problems) => problems.length > 0).length
      const parityShape = { uiPrimitives: { direct: 30, aliased: { IconSparkle16: 'IconSparkleRegular' }, synthesized: [], missing: [] } }
      const parityBad = [
        { uiPrimitives: { direct: 29, aliased: {}, synthesized: ['IconSparkle16'], missing: [] } },
        { uiPrimitives: { direct: 29, aliased: {}, synthesized: [], missing: ['Modal'] } },
        { uiPrimitives: { direct: 30, aliased: {} } },
        undefined,
      ]
      const parityRejected = parityBad.filter((sample) => checkPrimitiveParity(sample).length > 0).length
      const traced = good.replace(
        'exports.apply = (ctx) => {',
        `window.__DSH_TAVERN_BIND__ = ${JSON.stringify(parityShape)}; exports.apply = (ctx) => {`,
      )
      const wiringOk = (await checkClientExecution(traced, { requirePrimitiveParity: true })).length === 0
      const wiringRejectsUntraced = (await checkClientExecution(good, { requirePrimitiveParity: true })).length > 0
      const updateZh = "{ 'update.title': '插件更新', 'update.current': '已安装 v{version}（{commit}）', 'update.latest': 'GitHub v{version}（{commit}）', 'update.check': '检查更新', 'update.checking': '检查中…', 'update.now': '立即更新', 'update.installing': '更新中…', 'update.confirm': '安装 v{version}？', 'update.restartHint': '重启生效', 'update.restartHintWeb': '重启并刷新', 'update.checkedAt': '上次 {at}', 'update.notes': '改动', 'update.remoteError': '查询失败 {error}', 'update.status.available': '有 v{version}', 'update.status.upToDate': '最新', 'update.status.localAhead': '本地更新', 'update.status.restartRequired': '需重启', 'update.status.unknown': '未知' }"
      const updateEn = "{ 'update.title': 'Plugin update', 'update.current': 'Installed v{version} ({commit})', 'update.latest': 'GitHub v{version} ({commit})', 'update.check': 'Check', 'update.checking': 'Checking…', 'update.now': 'Update now', 'update.installing': 'Updating…', 'update.confirm': 'Install v{version}?', 'update.restartHint': 'Restart', 'update.restartHintWeb': 'Restart and reload', 'update.checkedAt': 'Checked {at}', 'update.notes': 'Changes', 'update.remoteError': 'Lookup failed {error}', 'update.status.available': 'v{version} available', 'update.status.upToDate': 'Up to date', 'update.status.localAhead': 'Local newer', 'update.status.restartRequired': 'Restart', 'update.status.unknown': 'Unknown' }"
      const updateMissing = updateEn.replace("'update.now': 'Update now', ", '')
      const goodWithUpdate = good
        .replace("zh: { 'nav.title': '酒馆' }", `zh: { 'nav.title': '酒馆', ${updateZh.slice(1, -1)} }`)
        .replace("en: { 'nav.title': 'Tavern' }", `en: { 'nav.title': 'Tavern', ${updateEn.slice(1, -1)} }`)
        .replace('exports.apply = (ctx) => {', "exports.apply = (ctx) => { const updateMarkers = ['update/check', 'update/install']; const UpdateBand = () => null; void updateMarkers; void UpdateBand; ")
      const badUpdateKeys = goodWithUpdate.replace(updateEn.slice(1, -1), updateMissing.slice(1, -1))
      const updateWiringOk = (await checkClientExecution(goodWithUpdate, { requireUpdateWiring: true })).length === 0
      const updateWiringRejectsPlain = (await checkClientExecution(good, { requireUpdateWiring: true })).length > 0
      const updateWiringRejectsMissingKey = (await checkClientExecution(badUpdateKeys, { requireUpdateWiring: true })).length > 0
      const updateWiringRejectsNoMarker = (await checkClientExecution(goodWithUpdate.replace("'update/check', 'update/install'", "'update/check'"), { requireUpdateWiring: true })).length > 0
      return goodProblems.length === 0
        && failureCounts === 4
        && checkPrimitiveParity(parityShape).length === 0
        && parityRejected === parityBad.length
        && wiringOk
        && wiringRejectsUntraced
        && updateWiringOk
        && updateWiringRejectsPlain
        && updateWiringRejectsMissingKey
        && updateWiringRejectsNoMarker
        ? []
        : ['client VM bad samples were not rejected']
    },
    check: () => {
      if (!existsSync(CLIENT_PATH)) return ['generated packages/plugin/client/index.js does not exist']
      const primitives = hostPrimitiveExports()
      if (primitives === null) {
        return [`${PRIMITIVES_PACKAGE} is not resolvable from the repo, NODE_PATH, or global DSH install`]
      }
      return checkClientExecution(readFileSync(CLIENT_PATH, 'utf8'), { primitives, requirePrimitiveParity: true, requireUpdateWiring: true })
    },
  },
  {
    name: 'node-half-mount',
    selfTest: () => {
      const good = {
        name: PLUGIN_NAME,
        inject: ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction'],
        applyType: 'function',
        sections: [{ name: 'dsh-tavern:active-character', textType: 'function' }],
        registrations: [
          { kind: 'prefix', path: API_PREFIX, handlerType: 'function' },
          { kind: 'command', name: 'dsh-tavern-session', handlerType: 'function' },
        ],
        novelOpen: { kind: 'error', invalidPayload: false },
      }
      const bad = { ...good, registrations: [] }
      return checkNodeMountResult(good).length === 0 && checkNodeMountResult(bad).length > 0
        ? []
        : ['Node mount bad sample was not rejected']
    },
    check: () => existsSync(SERVER_PATH) ? runNodeMount() : ['generated packages/plugin/index.mjs does not exist'],
  },
  {
    // v4 会话准入回归网（0.2.0-rc.2 审计产出）：插件的每类会话写入序列都必须
    // 通过真实宿主校验——词汇表（事件类型 ∈ KNOWN_SESSION_EVENT_TYPES）与
    // turn/step 关系（assertReleasedV4Relationships）。历史导入序列直接跑真实
    // 的 historyImportAppends（esbuild 现场打包 src，杜绝 gate 镜像漂移）；
    // ST 生成轨迹与 notice 是 recordTavernSessionAssistant 等内部函数的静态
    // 镜像（未导出），加 assistant/chunk 落盘 tripwire 兜底。负样本（旧裸
    // turn:0 导入形状）必须被拒——证明 gate 接的是真校验器而非橡皮图章。
    name: 'v4-session-admission',
    selfTest: () => {
      const dirty = 'trace.session.append(\'assistant/chunk\', { turn: 1 })'
      const clean = 'trace.session.append(\'assistant/message\', { turn: 1, stream: [] })'
      return serverAppendsAssistantChunk(dirty) && !serverAppendsAssistantChunk(clean)
        ? []
        : ['assistant/chunk tripwire failed its self samples']
    },
    check: async () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      const problems = []
      if (serverAppendsAssistantChunk(readFileSync(SERVER_PATH, 'utf8'))) {
        problems.push("server bundle still appends 'assistant/chunk' — v0 vocabulary the v4 loader refuses the whole artifact for")
      }
      const runtime = locateOfficialDependencyRoot()
      if (runtime === null) return problems
      const migrationEntry = join(runtime, '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js')
      const sessionEntry = join(runtime, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
      const v3to4 = await import(pathToFileURL(migrationEntry).href)
      const dshSession = await import(pathToFileURL(sessionEntry).href)
      const known = dshSession.KNOWN_SESSION_EVENT_TYPES
      const assertRelationships = v3to4.assertReleasedV4Relationships

      const header = { version: 4, id: 'gate-v4-admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
      const toEvents = (rows) => rows.map((row, index) => ({
        type: row.type,
        seq: index,
        time: 1000 + index,
        data: row.data,
        ...(row.surfaceOp === undefined ? {} : { surfaceOp: row.surfaceOp }),
      }))
      const admissionProblems = (label, rows) => {
        const events = toEvents(rows)
        for (const event of events) {
          if (!known.has(event.type)) return [`${label}: event type '${event.type}' is outside the host KNOWN vocabulary`]
        }
        for (const event of events) {
          if (event.type === 'assistant/message' && !Array.isArray(event.data?.stream)) {
            return [`${label}: assistant/message lacks the settlement stream array (load-boundary seed check throws)`]
          }
        }
        try {
          assertRelationships({ header, events, inheritedEventCount: 0 }, known)
        } catch (error) {
          return [`${label}: real v4 relationship admission rejected the stream: ${error.message}`]
        }
        return []
      }

      // 1) 历史导入序列：真实 historyImportAppends 输出（现有闭合 turn 1 的 v4 会话）。
      const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tavern-gate-v4-'))
      try {
        const bundle = await esbuildBuild({
          entryPoints: [join(PLUGIN_ROOT, 'src', 'agent-tavern', 'projector.ts')],
          bundle: true,
          format: 'esm',
          platform: 'node',
          sourcemap: false,
          write: false,
        })
        const modulePath = join(tempRoot, 'projector.mjs')
        writeFileSync(modulePath, bundle.outputFiles[0].text, 'utf8')
        const { historyImportAppends } = await import(pathToFileURL(modulePath).href)
        const chat = {
          header: { user_name: 'Alice', character_name: 'Gate Character', chat_metadata: {} },
          messages: [
            { name: 'Gate Character', is_user: false, is_system: false, send_date: '', mes: 'Greeting.' },
            { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Hello.' },
          ],
        }
        // 导入契约面向空白会话（激活流程保证），turn 号从 1 起步。
        const session = { header: { version: 4 } }
        const importRows = historyImportAppends(chat, 'gate-session', [], undefined, session)
        problems.push(...admissionProblems('history import', importRows))

        // 负控：旧形状（剥掉边界 + turn:0 裸消息 + 无 stream）必须被真实校验拒绝。
        const legacyShape = importRows
          .filter((row) => row.type !== 'turn/start' && row.type !== 'turn/end' && row.type !== 'step/start' && row.type !== 'step/end')
          .map((row) => row.type === 'assistant/message' ? { ...row, data: { turn: 0, step: 1 } } : row)
        let rejected = true
        try {
          assertRelationships({
            header,
            events: toEvents(legacyShape).map((event) => event.type === 'assistant/message' ? { ...event, data: { ...event.data, stream: [] } } : event),
            inheritedEventCount: 0,
          }, known)
          rejected = false
        } catch {
          rejected = true
        }
        if (!rejected) problems.push('negative control passed: the bare turn:0 import shape was NOT rejected — admission wiring is broken')
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }

      // 2) ST 生成轨迹（recordTavernSessionAssistant 等内部函数的静态镜像）。
      const traceRows = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { id: 'gate-user', role: 'user', content: [{ type: 'text', text: 'Write' }], source: { kind: 'user' } }, surfaceOp: 'append' },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'gate-assistant', role: 'assistant', content: [{ type: 'text', text: 'Reply' }], source: { kind: 'model', provider: 'gate', model: 'gate' } }, stream: [] }, surfaceOp: 'append' },
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      problems.push(...admissionProblems('ST generation trace', traceRows))

      // 3) notice（插件 producer-owned source 的 user/message）。
      const noticeRows = [
        { type: 'user/message', data: { id: 'gate-notice', role: 'user', content: [{ type: 'text', text: 'Tavern roleplay chat.' }], source: { kind: 'plugin:dsh-tavern', form: 'notice', summary: 'Tavern' } }, surfaceOp: 'append' },
      ]
      problems.push(...admissionProblems('activation notice', noticeRows))

      return problems
    },
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

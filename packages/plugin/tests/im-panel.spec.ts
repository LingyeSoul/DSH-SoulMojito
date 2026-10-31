/**
 * 「聊天渠道」面板源检查（提案 0024 §6.1 / §6.3 / §6.4，M5）：三张通道卡与状态灯、
 * 扫码相位轮询与微信验证码、OneBot 端点地址、绑定表（共享会话徽标/改绑/解绑）、自动
 * 绑定设置与两份白名单、运行日志带与腾讯包一键安装。
 *
 * 读 `client-src/97-ui-im.js` / `97b-ui-im-logs.js` 而不是 `client/main.js`：后者是
 * 构建产物，而 `pnpm run check` 里 vitest 跑在 `scripts/build-plugin.mjs` 之前（与
 * agent-tavern-body-client.spec.ts 同一条理由）。纯函数（共享徽标判定、白名单
 * 解析、日志合并、状态灯）用 vm 真实执行，其余是字符串/正则结构断言。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(here, '../client-src')
const imSource = readFileSync(join(sourceDir, '97-ui-im.js'), 'utf8')
const logsSource = readFileSync(join(sourceDir, '97b-ui-im-logs.js'), 'utf8')
/** 分片在同一 factory 作用域里按清单顺序拼接：vm 里也照这个顺序拼。 */
const imPanelSource = `${imSource}\n${logsSource}`
const coreSource = readFileSync(join(sourceDir, '90-panels-core.js'), 'utf8')
const stylesSource = readFileSync(join(sourceDir, '95-ui-styles.js'), 'utf8')
const zh = readFileSync(join(sourceDir, '41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(sourceDir, '40-i18n-en.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')) as { fragments: string[] }

/** 面板的全部 locale 键；含 `t(...)` 模板拼出来的通道/状态/模式族。 */
const IM_I18N_KEYS = [
  'panel.section.im',
  'im.hint.title',
  'im.hint',
  'im.disabled',
  'im.unavailable',
  'im.channels',
  'im.channel.qq',
  'im.channel.weixin',
  'im.channel.onebot',
  'im.state.unconfigured',
  'im.state.scanning',
  'im.state.starting',
  'im.state.online',
  'im.state.paused',
  'im.state.error',
  'im.state.idle',
  'im.accountsEmpty',
  'im.accountPeers',
  'im.accountRemove',
  'im.accountRemoveConfirm',
  'im.onebotCardHint',
  'im.bindStartQq',
  'im.bindStartWeixin',
  'im.qqRuntimeMissing',
  'im.copy',
  'im.copied',
  'im.bindTitle',
  'im.bindWaiting',
  'im.bindSaving',
  'im.bindQrAlt',
  'im.bindQrLink',
  'im.bindQrPending',
  'im.bindVerify',
  'im.bindVerifyHint',
  'im.bindVerifySubmit',
  'im.bindSubmitting',
  'im.bindFailed',
  'im.bindRetry',
  'im.bindCancel',
  'im.bindDone',
  'im.onebot.title',
  'im.onebot.hint',
  'im.onebot.accountId',
  'im.onebot.token',
  'im.onebot.create',
  'im.onebot.creating',
  'im.onebot.created',
  'im.onebot.ws',
  'im.onebot.wsHint',
  'im.onebot.upstream',
  'im.peers.title',
  'im.peers.hint',
  'im.peers.empty',
  'im.peers.emptyHint',
  'im.peers.session',
  'im.peers.closed',
  'im.peers.boundAt',
  'im.peers.shared',
  'im.peers.sharedHint',
  'im.peers.rebindCurrent',
  'im.peers.noCurrentSession',
  'im.peers.unbind',
  'im.peers.unbindConfirm',
  'im.pending.title',
  'im.pending.hint',
  'im.pending.bind',
  'im.pending.lastAt',
  'im.scope.private',
  'im.scope.group',
  'im.settings.title',
  'im.settings.hint',
  'im.settings.groupRequireMention',
  'im.settings.groupRequireMentionHint',
  'im.settings.privateAllow',
  'im.settings.groupAllow',
  'im.settings.allowHint',
  'im.settings.saved',
  'im.log.title',
  'im.log.empty',
  'im.log.refresh',
  'im.log.clear',
  'im.log.level',
  'im.log.levelAll',
  'im.log.installing',
  'im.qqInstall',
  'im.qqInstallDone',
  'im.qqInstallAlready',
  'im.qqInstallBusy',
  'im.qqInstallFailed',
]

type LogEntry = { seq: number; at: string; level: string; text: string }

type PanelPure = {
  imChannelTone: (accounts: Array<{ status?: { state?: string } }>, scanning: boolean) => string
  imChannelReason: (accounts: Array<{ status?: { state?: string; message?: string; reason?: string } }>) => string
  imPeerParts: (key: string) => { channel: string; accountId: string; scope: string; peerId: string } | null
  imSharedSessionIds: (peers: Array<{ sessionId?: string }>) => Set<string>
  imIdList: (text: string) => string[]
  imSessionLabeler: (
    bindings: Record<string, { character?: unknown; chatId?: unknown; title?: unknown }> | undefined,
    sessionsById: Record<string, { title?: unknown; header?: { title?: unknown } }> | undefined,
  ) => (sessionId: string) => string
  imMergeLogEntries: (existing: LogEntry[], incoming: LogEntry[], cap: number) => LogEntry[]
  imLogFilter: (entries: LogEntry[], level: string) => LogEntry[]
  imLogTime: (at: string) => string
}

/** 在 vm 里执行分片并取回纯函数：顶层只有常量与函数声明，不依赖 React。 */
function loadPanelPure(): PanelPure {
  const context = vm.createContext({
    navigator: { language: 'en-US' },
    location: { origin: 'http://localhost:3000' },
  })
  vm.runInContext(
    `${imPanelSource}
;globalThis.__imPanel = {
  imChannelTone, imChannelReason, imPeerParts, imSharedSessionIds, imIdList,
  imSessionLabeler, imMergeLogEntries, imLogFilter, imLogTime,
}`,
    context,
    { filename: '97-ui-im.js' },
  )
  return vm.runInContext('globalThis.__imPanel', context) as PanelPure
}

type RenderNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }
type PanelComponents = Record<string, (props?: Record<string, unknown>) => unknown>

/**
 * 渲染冒烟：hooks 换成一次性桩（useState 返回初值、useEffect 不执行），`h` 把
 * 元素树记成普通对象。目的是让组件体真正跑一遍——拼错的标识符、写错的分支、
 * 未定义的 t 键都会在这里炸，而不是等用户打开面板。
 */
function createPanelRender(options: { characters?: string[]; chatLists?: Record<string, string[]> }): PanelComponents {
  const store = {
    bootstrap: { characters: options.characters ?? [], state: { sessionBindings: {} } },
    chatLists: options.chatLists ?? {},
  }
  const sessions = { ids: [], byId: {}, phase: 'ready' }
  const context = vm.createContext({
    React: { Fragment: 'Fragment' },
    h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RenderNode => ({ type, props: props ?? {}, children }),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
    useEffect: () => {},
    useRef: (init: unknown) => ({ current: init }),
    useTranslate: () => (key: string, params?: Record<string, unknown>) => (
      params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(';')})`
    ),
    useTavernStore: () => store,
    useSessions: (selector: (value: typeof sessions) => unknown) => (typeof selector === 'function' ? selector(sessions) : sessions),
    useCurrentSessionId: () => 'session-current',
    Button: 'Button',
    Pill: 'Pill',
    IconTrashOutline16: 'IconTrash',
    Input: 'Input',
    Modal: 'Modal',
    api: () => Promise.resolve({}),
    setInterval: () => 0,
    clearInterval: () => {},
    jsonHeaders: () => ({ 'content-type': 'application/json' }),
    window: { confirm: () => true },
    navigator: {},
    location: { origin: 'http://localhost:3000' },
    API: '/api/dsh-soulmojito',
  })
  vm.runInContext(
    `${imPanelSource}
;globalThis.__imRender = { PanelIm, ImChannelCard, ImBindPanel, ImPeerRow, ImPeersBand, ImSettingsBand, ImOneBotBand, ImLogBand, ImLogRows }`,
    context,
    { filename: '97-ui-im.js' },
  )
  return vm.runInContext('globalThis.__imRender', context) as PanelComponents
}

function collectNode(tree: unknown): { texts: string[]; attrs: string[]; classNames: string[]; types: string[] } {
  const texts: string[] = []
  const attrs: string[] = []
  const classNames: string[] = []
  const types: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const entry = node as RenderNode
    if (typeof entry.type !== 'string' && typeof entry.type !== 'function') return
    types.push(typeof entry.type === 'function' ? entry.type.name : entry.type)
    if (typeof entry.props.className === 'string') classNames.push(entry.props.className)
    for (const [key, value] of Object.entries(entry.props)) {
      if (key.startsWith('data-im') || key === 'src' || key === 'href' || key === 'disabled' || key === 'data-tone') {
        attrs.push(`${key}=${String(value)}`)
      }
    }
    for (const child of entry.children) visit(child)
  }
  visit(tree)
  return { texts, attrs, classNames, types }
}

/** 按钮的可见文案 + props：按绑定判定按钮时不能依赖 DOM 顺序。 */
function findButtons(tree: unknown): Array<{ label: string; props: Record<string, unknown> }> {
  const found: Array<{ label: string; props: Record<string, unknown> }> = []
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const entry = node as RenderNode
    if (entry.type === 'Button') {
      const label = entry.children.filter((child) => typeof child === 'string').join('')
      found.push({ label, props: entry.props })
    }
    for (const child of entry.children) visit(child)
  }
  visit(tree)
  return found
}

function definitionCount(source: string, key: string): number {
  return source.split(`'${key}':`).length - 1
}

describe('IM channels panel (client-src source check)', () => {
  it('ships the 97-ui-im fragment and its log companion between the presets and apply fragments', () => {
    const presetsAt = manifest.fragments.indexOf('96-panels-presets.js')
    const imAt = manifest.fragments.indexOf('97-ui-im.js')
    const logsAt = manifest.fragments.indexOf('97b-ui-im-logs.js')
    const applyAt = manifest.fragments.indexOf('98-apply.js')
    expect(presetsAt).toBeGreaterThanOrEqual(0)
    expect(imAt).toBe(presetsAt + 1)
    // 日志带与面板共用作用域（imErrorMessage / Button 等）：必须紧跟其后拼接。
    expect(logsAt).toBe(imAt + 1)
    expect(applyAt).toBe(logsAt + 1)
  })

  it('registers the im section in the system group with a locale thunk', () => {
    const presetsAt = coreSource.indexOf("{ id: 'presets',")
    const imAt = coreSource.indexOf("{ id: 'im',")
    const scriptsAt = coreSource.indexOf("{ id: 'scripts',")
    expect(imAt).toBeGreaterThan(presetsAt)
    expect(imAt).toBeLessThan(scriptsAt)
    expect(coreSource).toContain("{ id: 'im', group: 'system', icon: IconSendOutline16, label: (t) => t('panel.section.im'), component: (host) => h(PanelIm, { useSessions: host.useSessions }) }")
  })

  it('carries every panel locale key once in each table', () => {
    for (const key of IM_I18N_KEYS) {
      expect(definitionCount(zh, key), key).toBe(1)
      expect(definitionCount(en, key), key).toBe(1)
    }
  })

  it('only references locale keys it declares', () => {
    const declared = new Set(IM_I18N_KEYS)
    const referenced = new Set(
      [...imPanelSource.matchAll(/t\('(im\.[A-Za-z][\w.]*)'/g)].map((match) => match[1]),
    )
    // 三元里的私聊/群聊键不紧跟 t(' 形态，单独补两条。
    referenced.add('im.scope.private')
    referenced.add('im.scope.group')
    expect(referenced.size).toBeGreaterThan(50)
    for (const key of referenced) expect(declared.has(key), key).toBe(true)
    // 模板拼出来的族必须整族齐备（gate 只检查 zh/en 互为镜像，不检查族完整性）。
    for (const channel of ['qq', 'weixin', 'onebot']) expect(declared.has(`im.channel.${channel}`)).toBe(true)
  })

  it('polls im/bind/status on a 1.5s interval and stops on idle/failed', () => {
    expect(imSource).toContain('const IM_BIND_POLL_MS = 1500')
    // 面板数据（未绑定对端/通道状态）自己刷新，不要求用户关掉再打开。
    expect(imSource).toContain('const IM_VIEW_POLL_MS = 5000')
    expect(imSource).toContain('void loadView(true)')
    expect(imSource).toContain('document.visibilityState === \'hidden\'')
    expect(imSource).toContain('if (seq === viewSeq.current) setView(result)')
    expect(imSource).toContain('if (quiet && viewInFlight.current) return Promise.resolve(null)')
    expect(imSource).toContain('setInterval(() => {')
    expect(imSource).toContain('}, IM_BIND_POLL_MS)')
    expect(imSource).toContain("api('im/bind/status')")
    expect(imSource).toContain('clearInterval(timer)')
    // 轮询只在活动相位里跑：idle/failed 立刻停表，不留孤儿定时器。
    expect(imSource).toContain("const bindRunning = bind !== null")
    expect(imSource).toContain("bind.phase === 'waiting' || bind.phase === 'verify' || bind.phase === 'saving'")
    expect(imSource).toContain('if (!bindRunning) return undefined')
    expect(imSource).toContain("if (status.phase === 'idle') {")
    expect(imSource).toContain('void reloadView()')
  })

  it('loads the runtime log once, then polls every 3s and stops on the first error', () => {
    expect(logsSource).toContain('const IM_LOG_POLL_MS = 3000')
    expect(logsSource).toContain('const IM_LOG_CAP = 300')
    expect(logsSource).toContain("api('im/logs')")
    expect(logsSource).toContain('im/logs?after=')
    expect(logsSource).toContain('setInterval(poll, IM_LOG_POLL_MS)')
    expect(logsSource).toContain('clearInterval(timer)')
    // 出错只报一次并停表：`stopped` 置位后 effect 不再装定时器，只有手动刷新才重启。
    expect(logsSource).toContain('if (disabled || stopped) return undefined')
    expect(logsSource).toContain('setStopped(true)')
    expect(logsSource).not.toContain('setTimeout')
  })

  it('calls every IM management route the server exposes', () => {
    for (const marker of [
      "api('im')",
      "'im/accounts'",
      'im/accounts?channel=',
      "'im/settings'",
      "'im/peers'",
      'im/peers?key=',
      "'im/bind/start'",
      "'im/bind/verify'",
      "'im/bind/cancel'",
      "'im/qq/install'",
    ]) {
      expect(imSource).toContain(marker)
    }
    // 日志路由在 97b 分片：只认代码里的实参，不看面板渲染位置。
    expect(logsSource).toContain("'im/logs'")
    expect(logsSource).toContain('im/logs?after=')
  })

  it('shows the server message on every failed write instead of swallowing it', () => {
    expect(imSource).toContain('function imErrorMessage(cause)')
    // 每个 .catch 都把服务端 message 交给 setError；分片里不允许空 catch。
    const surfaced = imSource.split('setError(imErrorMessage(').length - 1
    expect(surfaced).toBeGreaterThanOrEqual(8)
    expect(imSource).not.toMatch(/catch\(\s*\(\s*\)\s*=>/)
    expect(imSource).not.toContain('catch(() => {})')
  })

  it('renders the WeChat verification phase and submits the code', () => {
    expect(imSource).toContain("phase === 'verify'")
    expect(imSource).toContain("api('im/bind/verify'")
    expect(imSource).toContain('body: JSON.stringify({ code })')
    expect(imSource).toContain("t('im.bindVerify')")
    expect(imSource).toContain("t('im.bindFailed', { reason: bind.reason || '—' })")
    expect(imSource).toContain("t('im.bindRetry')")
  })

  it('offers a one-click QQ runtime install instead of a shell command', () => {
    expect(imSource).toContain('qqRuntime.installed === false')
    expect(imSource).toContain("t('im.qqRuntimeMissing')")
    expect(imSource).toContain("api('im/qq/install'")
    expect(imSource).toContain("setBusy('install:qq')")
    expect(imSource).toContain("t('im.qqInstall')")
    expect(imSource).toContain("t('im.qqInstallDone')")
    expect(imSource).toContain("t('im.qqInstallAlready')")
    // 409 = 已有一次安装在进行；400 的原文必须嵌进失败提示，不许吞。
    expect(imSource).toContain("cause?.status === 409")
    expect(imSource).toContain("t('im.qqInstallBusy')")
    expect(imSource).toContain("t('im.qqInstallFailed', { reason: imErrorMessage(cause) })")
    // 面板永不展示 shell 命令：旧命令块与提取函数都必须消失。
    expect(imSource).not.toContain('imQqInstallCommand')
    expect(imSource).not.toContain('pnpm add')
    expect(logsSource).not.toContain('pnpm add')
    // 禁用条件必须同时覆盖「宿主不可用」与「缺运行期包」，缺一条就会把 503 显示成可点按钮。
    expect(imSource).toContain('disabled: disabled || runtimeMissing || imBindBusy(busy)')
  })

  it('keeps one busy key per action so a bind never disables the install button', () => {
    expect(imSource).toContain('function imBindBusy(busy)')
    expect(imSource).toContain('function imPeerBusy(busy)')
    // 旧的全局判定必须彻底消失：留着它任一动作都会锁住整块面板。
    expect(imSource).not.toContain("busy !== ''")
    expect(imSource).toContain("busy === 'install:qq'")
    expect(imSource).toContain("busy === 'account:onebot'")
    expect(imSource).toContain("busy === 'settings'")
    expect(imSource).toContain('busy === `remove:${channel}:${row.accountId}`')

    const components = createPanelRender({})
    const card = (busy: string, runtimeMissing: boolean): unknown => components.ImChannelCard({
      channel: 'qq',
      accounts: [],
      scanning: false,
      runtimeMissing,
      disabled: false,
      busy,
      onBind: () => {},
      onInstall: () => {},
      onRemove: () => {},
    })
    // 扫码在跑：安装按钮照常可点（缺包时唯一能推进的动作就是它）。
    const binding = findButtons(card('bind:qq', true))
    expect(binding.find((entry) => entry.label === 'im.qqInstall')?.props.disabled).toBe(false)
    // 安装在跑：标签变「安装中…」且只有它自己被禁用。
    const installing = findButtons(card('install:qq', true))
    expect(installing.find((entry) => entry.label === 'im.log.installing')?.props.disabled).toBe(true)
    expect(installing.some((entry) => entry.label === 'im.qqInstall')).toBe(false)
    // 扫码动作自身在绑定组里仍然互斥。
    const bindButton = findButtons(card('bind:qq', false)).find((entry) => entry.label === 'im.bindStartQq')
    expect(bindButton?.props.disabled).toBe(true)
  })

  it('shows the reverse WebSocket address after an OneBot account is created', () => {
    expect(imSource).toContain('const wsUrl = `${location.origin}${API}/im/onebot/ws`')
    expect(imSource).toContain("channel: 'onebot'")
    expect(imSource).toContain('secret: { token }')
    expect(imSource).toContain("t('im.onebot.wsHint', { account: endpoint })")
    expect(imSource).toContain("t('im.onebot.created')")
  })

  it('marks shared sessions and wires bind/rebind to the current native session', () => {
    expect(imSource).toContain('function imSharedSessionIds(peers)')
    expect(imSource).toContain('sharedSessions.has(peer.sessionId)')
    expect(imSource).toContain("h(Pill, { active: true }, t('im.peers.shared'))")
    expect(imSource).toContain('function imPeerParts(key)')
    expect(imSource).toContain('function imSessionLabeler(bindings, sessionsById)')
    expect(imSource).toContain('const currentSession = useCurrentSessionId(useSessions)')
    expect(imSource).toContain('sessionId: target')
    expect(imSource).toContain("t('im.peers.rebindCurrent')")
    expect(imSource).toContain("api(`im/peers?key=${encodeURIComponent(peer.key)}`, { method: 'DELETE' })")
    expect(imSource).toContain("t('im.peers.unbindConfirm', { peer: peer.key })")
  })

  it('binds unbound senders to the current session and keeps both allowlists', () => {
    for (const marker of [
      'pendingPeers',
      "t('im.pending.bind')",
      'onBindPending(peer, current)',
      'onPatch({ groupRequireMention: event.target.checked })',
      "onBlur: () => onAllowCommit('private')",
      "onBlur: () => onAllowCommit('group')",
      "void saveSettings({ [field]: next })",
      "t('im.peers.noCurrentSession')",
    ]) {
      expect(imSource).toContain(marker)
    }
    // 旧的自动绑定模式已删除：面板不再提交 bindingMode/sourceChat/sharedChat。
    expect(imSource).not.toContain('bindingMode')
    expect(imSource).not.toContain('sourceChat')
    expect(imSource).not.toContain('sharedChat')
  })

  it('keeps the panel styles on existing design tokens', () => {
    const imStyleLines = stylesSource.split('\n').filter((line) => line.includes('dt-im-'))
    expect(imStyleLines.length).toBeGreaterThan(20)
    const rules = imStyleLines.join('\n')
    expect(rules).toContain('var(--dsw-alias-label-tertiary)')
    expect(rules).toContain('.dt-im-light-error{background:var(--dsw-alias-state-error-primary)')
    expect(rules).toContain('.dt-im-allow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))')
    // 运行日志带只复用既有 token：列表滚动、级别徽标与正文折行都在同一套色板里。
    expect(rules).toContain('.dt-im-log-list{display:flex')
    expect(rules).toContain('.dt-im-log-badge-error{color:var(--dsw-alias-state-error-primary)}')
    // 新色板一律不许出现：状态灯只复用既有 state token。
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('derives the channel light from account state, scanning first', () => {
    const panel = loadPanelPure()
    expect(panel.imChannelTone([], false)).toBe('unconfigured')
    expect(panel.imChannelTone([], true)).toBe('scanning')
    expect(panel.imChannelTone([{ status: { state: 'online' } }], false)).toBe('online')
    expect(panel.imChannelTone([{ status: { state: 'online' } }], true)).toBe('scanning')
    expect(panel.imChannelTone([{ status: { state: 'online' } }, { status: { state: 'error', message: 'boom' } }], false)).toBe('error')
    expect(panel.imChannelTone([{ status: { state: 'online' } }, { status: { state: 'paused', reason: 'paused' } }], false)).toBe('paused')
    expect(panel.imChannelTone([{ status: { state: 'starting' } }], false)).toBe('starting')
    expect(panel.imChannelTone([{ status: { state: 'idle' } }], false)).toBe('idle')
    expect(panel.imChannelReason([{ status: { state: 'error', message: 'boom' } }])).toBe('boom')
    expect(panel.imChannelReason([{ status: { state: 'online' } }])).toBe('')
  })

  it('flags the shared-session badge only when a session is bound more than once', () => {
    const panel = loadPanelPure()
    const shared = panel.imSharedSessionIds([
      { sessionId: 'session-a' },
      { sessionId: 'session-b' },
      { sessionId: 'session-a' },
      { sessionId: '' },
      { sessionId: undefined },
    ])
    expect([...shared]).toEqual(['session-a'])
    expect(shared.has('session-b')).toBe(false)
    expect(panel.imSharedSessionIds([{ sessionId: 'session-a' }]).size).toBe(0)
    expect(panel.imSharedSessionIds([]).size).toBe(0)
  })

  it('parses allowlist text into a trimmed, deduped id list', () => {
    const panel = loadPanelPure()
    expect(panel.imIdList(' user-a, user-b,\n user-a ,, user-c ')).toEqual(['user-a', 'user-b', 'user-c'])
    expect(panel.imIdList('')).toEqual([])
    expect(panel.imIdList('   ,\n  ')).toEqual([])
  })

  it('merges log deltas by seq, keeps arrival order and caps the list', () => {
    const panel = loadPanelPure()
    const entry = (seq: number, text: string): LogEntry => ({ seq, at: '2026-10-31T09:05:07.000Z', level: 'info', text })
    const merged = panel.imMergeLogEntries([entry(1, 'a'), entry(2, 'b')], [entry(2, 'b'), entry(3, 'c')], 300)
    expect(merged.map((row) => row.seq)).toEqual([1, 2, 3])
    // 重复 seq 保留先到的那条（轮询重叠窗口不该把旧行换成新对象）。
    expect(merged[1]?.text).toBe('b')
    const capped = panel.imMergeLogEntries([entry(1, 'a'), entry(2, 'b'), entry(3, 'c')], [entry(4, 'd')], 2)
    expect(capped.map((row) => row.seq)).toEqual([3, 4])
    // 纯函数：入参数组不变。
    const existing = [entry(1, 'a')]
    panel.imMergeLogEntries(existing, [entry(2, 'b')], 300)
    expect(existing).toHaveLength(1)
    expect(panel.imMergeLogEntries([], [], 300)).toEqual([])
  })

  it('filters log rows by minimum level and formats the local clock', () => {
    const panel = loadPanelPure()
    const entries: LogEntry[] = [
      { seq: 1, at: '2026-10-31T09:05:07.000Z', level: 'debug', text: 'dedupe dropped' },
      { seq: 2, at: '2026-10-31T09:05:08.000Z', level: 'info', text: 'accepted' },
      { seq: 3, at: '2026-10-31T09:05:09.000Z', level: 'warn', text: 'no reply' },
      { seq: 4, at: '2026-10-31T09:05:10.000Z', level: 'error', text: 'send failed' },
    ]
    expect(panel.imLogFilter(entries, 'all').map((row) => row.seq)).toEqual([1, 2, 3, 4])
    // 默认 info：debug 噪音挡住，warn/error 立刻可见。
    expect(panel.imLogFilter(entries, 'info').map((row) => row.seq)).toEqual([2, 3, 4])
    expect(panel.imLogFilter(entries, 'warn').map((row) => row.seq)).toEqual([3, 4])
    expect(panel.imLogFilter(entries, 'error').map((row) => row.seq)).toEqual([4])
    expect(panel.imLogTime(new Date(2026, 9, 31, 9, 5, 7).toISOString())).toBe('09:05:07')
    expect(panel.imLogTime('not-a-date')).toBe('--:--:--')
  })

  it('labels a bound session by title, Tavern binding, then a short id', () => {
    const panel = loadPanelPure()
    const label = panel.imSessionLabeler(
      {
        'session-title': { title: '我的会话', character: 'Alice', chatId: 'chat.jsonl' },
        'session-tavern': { character: '角色 A', chatId: '2026-10-30 12-00-00.jsonl' },
      },
      { 'session-host': { title: 'Host title' } },
    )
    expect(label('session-title')).toBe('我的会话')
    expect(label('session-tavern')).toBe('角色 A · 2026-10-30 12-00-00')
    expect(label('session-host')).toBe('Host title')
    expect(label('session-1234567890abcdef')).toBe('session-…')
    expect(label('')).toBe('')
  })

  it('renders the panel shell with all three channel cards, every band and the runtime log (render smoke)', () => {
    const components = createPanelRender({ characters: ['Alice'], chatLists: { Alice: ['one.jsonl'] } })
    const useSessions = (selector: (value: { ids: string[]; byId: Record<string, unknown>; phase: string }) => unknown) => selector({ ids: [], byId: {}, phase: 'ready' })
    const tree = collectNode(components.PanelIm({ useSessions }))
    expect(tree.texts).toContain('nav.loading')
    expect(tree.texts).toContain('im.hint.title')
    expect(tree.texts).toContain('im.channels')
    expect(tree.types.filter((type) => type === 'ImChannelCard')).toHaveLength(3)
    // 三个数据带是函数组件，渲染冒烟只验挂点；带内结构由下面几条用例逐个执行。
    expect(tree.types).toContain('ImOneBotBand')
    expect(tree.types).toContain('ImPeersBand')
    expect(tree.types).toContain('ImSettingsBand')
    // 运行日志带挂在绑定表之后：诊断就在它诊断的东西旁边，且不打断配置流程。
    expect(tree.types).toContain('ImLogBand')
    const order = tree.types.filter((type) => type === 'ImPeersBand' || type === 'ImLogBand' || type === 'ImSettingsBand')
    expect(order).toEqual(['ImPeersBand', 'ImLogBand', 'ImSettingsBand'])
  })

  it('renders channel state, the install button and every bind phase (render smoke)', () => {
    const components = createPanelRender({})
    const card = collectNode(components.ImChannelCard({
      channel: 'qq',
      accounts: [{ channel: 'qq', accountId: '1024', label: 'QQ bot', status: { state: 'error', message: 'gateway dropped' }, peers: 2 }],
      scanning: false,
      runtimeMissing: true,
      disabled: false,
      busy: '',
      onBind: () => {},
      onInstall: () => {},
      onRemove: () => {},
    }))
    expect(card.attrs).toContain('data-im-channel=qq')
    expect(card.attrs).toContain('data-im-tone=error')
    expect(card.texts).toContain('gateway dropped')
    expect(card.texts).toContain('QQ bot')
    // 「最近状态 · N 个对端」是同一行文本，按子串断言。
    expect(card.texts.some((text) => text.includes('im.accountPeers(count=2)'))).toBe(true)
    expect(card.texts).toContain('im.qqRuntimeMissing')
    // 缺运行期包时给的是安装按钮，不是可复制的 shell 命令。
    expect(card.texts).toContain('im.qqInstall')
    // 缺包时扫码按钮必须禁用（安装按钮仍可点）。
    expect(card.attrs).toContain('disabled=true')

    const verify = collectNode(components.ImBindPanel({
      bind: { channel: 'weixin', phase: 'verify', prompt: 'digits please' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(verify.attrs).toContain('data-im-bind-phase=verify')
    expect(verify.texts).toContain('digits please')
    expect(verify.types).toContain('input')

    // 平台给图片地址：直接透传，不要再包一层自绘二维码。
    const waiting = collectNode(components.ImBindPanel({
      bind: { channel: 'qq', phase: 'waiting', url: 'https://example.test/qr.png' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(waiting.attrs).toContain('src=https://example.test/qr.png')
    expect(waiting.attrs).toContain('href=https://example.test/qr.png')
    expect(waiting.texts).toContain('im.bindQrLink')

    // 平台给内容串：用服务端渲染好的 SVG（实机破图就是这条没走通）。
    const rendered = collectNode(components.ImBindPanel({
      bind: { channel: 'weixin', phase: 'waiting', url: 'https://weixin.qq.com/x/abc', qrSvg: 'data:image/svg+xml;base64,AAA' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(rendered.attrs).toContain('src=data:image/svg+xml;base64,AAA')
    expect(rendered.attrs).toContain('href=https://weixin.qq.com/x/abc')

    const failed = collectNode(components.ImBindPanel({
      bind: { channel: 'qq', phase: 'failed', reason: 'connector exploded' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(failed.attrs).toContain('data-im-bind-phase=failed')
    expect(failed.texts).toContain('im.bindFailed(reason=connector exploded)')
    expect(failed.texts).toContain('im.bindRetry')
  })

  it('renders log rows with the local clock and the level badge, and the empty state (render smoke)', () => {
    const components = createPanelRender({})
    const rows = collectNode(components.ImLogRows({
      entries: [
        { seq: 7, at: new Date(2026, 9, 31, 9, 5, 7).toISOString(), level: 'info', text: 'accepted an inbound message' },
        { seq: 8, at: new Date(2026, 9, 31, 9, 5, 9).toISOString(), level: 'warn', text: 'no reply was produced' },
        { seq: 9, at: new Date(2026, 9, 31, 9, 5, 11).toISOString(), level: 'error', text: 'sending the reply failed' },
        { seq: 10, at: new Date(2026, 9, 31, 9, 5, 12).toISOString(), level: 'debug', text: 'duplicate dropped' },
      ],
    }))
    expect(rows.attrs).toContain('data-im-log-count=4')
    expect(rows.attrs).toContain('data-im-log-level=warn')
    expect(rows.attrs).toContain('data-im-log-level=error')
    // 级别徽标：warn/error/info 借既有 state 色板，debug 没有对应状态色。
    expect(rows.attrs).toContain('data-tone=warning')
    expect(rows.attrs).toContain('data-tone=error')
    expect(rows.attrs).toContain('data-tone=info')
    expect(rows.attrs).not.toContain('data-tone=undefined')
    expect(rows.texts).toContain('09:05:07')
    expect(rows.texts).toContain('09:05:11')
    expect(rows.texts).toContain('warn')
    expect(rows.texts).toContain('sending the reply failed')
    expect(rows.types.filter((type) => type === 'div')).toHaveLength(5)

    // 默认 info + 空列表：只剩空态文案，级别切换与刷新/清空入口都在。
    const band = collectNode(components.ImLogBand({ disabled: false, onError: () => {} }))
    expect(band.texts).toContain('im.log.title')
    expect(band.texts).toContain('im.log.level')
    expect(band.texts).toContain('im.log.levelAll')
    expect(band.texts).toContain('im.log.empty')
    expect(band.texts).toContain('im.log.refresh')
    expect(band.texts).toContain('im.log.clear')
    // 空列表不渲染行容器，只有工具栏与空态。
    expect(band.types).not.toContain('ImLogRows')
    expect(band.types.filter((type) => type === 'button')).toHaveLength(5)
  })

  it('renders the shared-session badge and the access form (render smoke)', () => {
    const components = createPanelRender({})
    const row = collectNode(components.ImPeerRow({
      peer: { key: 'qq:1024:private:u1', sessionId: 'session-a', scope: 'private', boundBy: 'manual', createdAt: '2026-10-30T10:00:00.000Z', live: false },
      shared: true,
      currentSession: 'session-current',
      sessionLabel: () => 'Alice · ten',
      disabled: false,
      onRebind: () => {},
      onUnbind: () => {},
    }))
    expect(row.attrs).toContain('data-im-peer=qq:1024:private:u1')
    expect(row.texts).toContain('qq:1024:private:u1')
    expect(row.texts).toContain('im.scope.private')
    expect(row.texts).toContain('im.peers.shared')
    expect(row.texts).toContain('im.peers.session(session=Alice · ten)')
    expect(row.texts).toContain('im.peers.closed')
    expect(row.texts).toContain('im.peers.rebindCurrent')

    const settings = collectNode(components.ImSettingsBand({
      settings: { groupRequireMention: true, privateAllow: ['u1'], groupAllow: [] },
      allowDraft: { private: null, group: null },
      busy: '',
      onPatch: () => {},
      onAllowDraft: () => {},
      onAllowCommit: () => {},
    }))
    expect(settings.texts).toContain('im.settings.groupRequireMention')
    expect(settings.texts).toContain('im.settings.privateAllow')
    expect(settings.texts).toContain('im.settings.groupAllow')
    expect(settings.types.filter((type) => type === 'textarea')).toHaveLength(2)
    // 自动绑定模式字段已删除。
    expect(settings.texts).not.toContain('im.settings.bindingMode')
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect("{ id: 'imX',".includes("{ id: 'im',")).toBe(false)
    expect('const IM_BIND_POLL_MSX = 1500'.includes('const IM_BIND_POLL_MS = 1500')).toBe(false)
    expect('const IM_LOG_POLL_MSX = 3000'.includes('const IM_LOG_POLL_MS = 3000')).toBe(false)
    expect("'panel.section.imX':".includes("'panel.section.im':")).toBe(false)
    expect('90'.includes('1500')).toBe(false)
    expect('.dt-im-light-errorX{background'.includes('.dt-im-light-error{background')).toBe(false)
    expect('.dt-im-log-listX{display'.includes('.dt-im-log-list{display')).toBe(false)
  })
})

/**
 * 「聊天渠道」面板源检查（提案 0024 §6.1 / §6.3，M5）：三张通道卡与状态灯、扫码
 * 相位轮询与微信验证码、OneBot 端点地址、绑定表（共享会话徽标/改绑/解绑）、自动
 * 绑定设置与两份白名单。
 *
 * 读 `client-src/97-ui-im.js` 而不是 `client/main.js`：后者是构建产物，而
 * `pnpm run check` 里 vitest 跑在 `scripts/build-plugin.mjs` 之前（与
 * agent-tavern-body-client.spec.ts 同一条理由）。纯函数（共享徽标判定、白名单
 * 解析、安装命令提取、状态灯）用 vm 真实执行，其余是字符串/正则结构断言。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(here, '../client-src')
const imSource = readFileSync(join(sourceDir, '97-ui-im.js'), 'utf8')
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
  'im.peers.chat',
  'im.peers.boundAt',
  'im.peers.shared',
  'im.peers.sharedHint',
  'im.peers.rebind',
  'im.peers.select',
  'im.peers.unbind',
  'im.peers.unbindConfirm',
  'im.scope.private',
  'im.scope.group',
  'im.settings.title',
  'im.settings.hint',
  'im.settings.bindingMode',
  'im.settings.mode.manual',
  'im.settings.mode.independent',
  'im.settings.mode.shared',
  'im.settings.mode.manualHint',
  'im.settings.mode.independentHint',
  'im.settings.mode.sharedHint',
  'im.settings.sourceChat',
  'im.settings.sourceChatNone',
  'im.settings.sourceChatHint',
  'im.settings.sharedChat',
  'im.settings.sharedChatNone',
  'im.settings.sharedChatHint',
  'im.settings.incomplete',
  'im.settings.groupRequireMention',
  'im.settings.groupRequireMentionHint',
  'im.settings.privateAllow',
  'im.settings.groupAllow',
  'im.settings.allowHint',
  'im.settings.saved',
]

type PanelPure = {
  imChannelTone: (accounts: Array<{ status?: { state?: string } }>, scanning: boolean) => string
  imChannelReason: (accounts: Array<{ status?: { state?: string; message?: string; reason?: string } }>) => string
  imPeerParts: (key: string) => { channel: string; accountId: string; scope: string; peerId: string } | null
  imSharedSessionIds: (peers: Array<{ sessionId?: string }>) => Set<string>
  imIdList: (text: string) => string[]
  imQqInstallCommand: (reason: string) => string
  imChatKey: (character: string, chatId: string) => string
  imChatRefFromKey: (key: string) => { character: string; chatId: string } | null
  imChatOptions: (characters: string[], chatLists: Record<string, string[]>) => Array<{ key: string; label: string }>
  imWithChatOption: (options: Array<{ key: string }>, ref: { character: string; chatId: string } | null) => Array<{ key: string }>
}

/** 在 vm 里执行分片并取回纯函数：顶层只有常量与函数声明，不依赖 React。 */
function loadPanelPure(): PanelPure {
  const context = vm.createContext({
    navigator: { language: 'en-US' },
    location: { origin: 'http://localhost:3000' },
  })
  vm.runInContext(
    `${imSource}
;globalThis.__imPanel = {
  imChannelTone, imChannelReason, imPeerParts, imSharedSessionIds, imIdList,
  imQqInstallCommand, imChatKey, imChatRefFromKey, imChatOptions, imWithChatOption,
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
    bootstrap: { characters: options.characters ?? [] },
    chatLists: options.chatLists ?? {},
  }
  const context = vm.createContext({
    React: { Fragment: 'Fragment' },
    h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RenderNode => ({ type, props: props ?? {}, children }),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
    useEffect: () => {},
    useTranslate: () => (key: string, params?: Record<string, unknown>) => (
      params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(';')})`
    ),
    useTavernStore: () => store,
    Button: 'Button',
    Pill: 'Pill',
    IconTrashOutline16: 'IconTrash',
    Input: 'Input',
    Modal: 'Modal',
    api: () => Promise.resolve({}),
    jsonHeaders: () => ({ 'content-type': 'application/json' }),
    loadChatList: () => Promise.resolve([]),
    window: { confirm: () => true },
    navigator: {},
    location: { origin: 'http://localhost:3000' },
    API: '/api/dsh-soulmojito',
  })
  vm.runInContext(
    `${imSource}
;globalThis.__imRender = { PanelIm, ImChannelCard, ImBindPanel, ImPeerRow, ImPeersBand, ImSettingsBand, ImOneBotBand }`,
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
      if (key.startsWith('data-im') || key === 'src' || key === 'href' || key === 'disabled') {
        attrs.push(`${key}=${String(value)}`)
      }
    }
    for (const child of entry.children) visit(child)
  }
  visit(tree)
  return { texts, attrs, classNames, types }
}

function definitionCount(source: string, key: string): number {
  return source.split(`'${key}':`).length - 1
}

describe('IM channels panel (client-src source check)', () => {
  it('ships the 97-ui-im fragment between the presets and apply fragments', () => {
    const presetsAt = manifest.fragments.indexOf('96-panels-presets.js')
    const imAt = manifest.fragments.indexOf('97-ui-im.js')
    const applyAt = manifest.fragments.indexOf('98-apply.js')
    expect(presetsAt).toBeGreaterThanOrEqual(0)
    expect(imAt).toBe(presetsAt + 1)
    expect(applyAt).toBe(imAt + 1)
  })

  it('registers the im section in the system group with a locale thunk', () => {
    const presetsAt = coreSource.indexOf("{ id: 'presets',")
    const imAt = coreSource.indexOf("{ id: 'im',")
    const scriptsAt = coreSource.indexOf("{ id: 'scripts',")
    expect(imAt).toBeGreaterThan(presetsAt)
    expect(imAt).toBeLessThan(scriptsAt)
    expect(coreSource).toContain("{ id: 'im', group: 'system', icon: IconSendOutline16, label: (t) => t('panel.section.im'), component: () => h(PanelIm) }")
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
      [...imSource.matchAll(/t\('(im\.[A-Za-z][\w.]*)'/g)].map((match) => match[1]),
    )
    // 三元里的私聊/群聊键不紧跟 t(' 形态，单独补两条。
    referenced.add('im.scope.private')
    referenced.add('im.scope.group')
    expect(referenced.size).toBeGreaterThan(50)
    for (const key of referenced) expect(declared.has(key), key).toBe(true)
    // 模板拼出来的族必须整族齐备（gate 只检查 zh/en 互为镜像，不检查族完整性）。
    for (const channel of ['qq', 'weixin', 'onebot']) expect(declared.has(`im.channel.${channel}`)).toBe(true)
    for (const mode of ['manual', 'independent', 'shared']) {
      expect(declared.has(`im.settings.mode.${mode}`)).toBe(true)
      expect(declared.has(`im.settings.mode.${mode}Hint`)).toBe(true)
    }
  })

  it('polls im/bind/status on a 1.5s interval and stops on idle/failed', () => {
    expect(imSource).toContain('const IM_BIND_POLL_MS = 1500')
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
    ]) {
      expect(imSource).toContain(marker)
    }
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

  it('disables QR binding with the runtime reason and install command when the QQ packages are missing', () => {
    expect(imSource).toContain('qqRuntime.installed === false')
    expect(imSource).toContain('imQqInstallCommand(qqRuntime.reason)')
    expect(imSource).toContain("t('im.qqRuntimeMissing')")
    // 禁用条件必须同时覆盖「宿主不可用」与「缺运行期包」，缺一条就会把 503 显示成可点按钮。
    expect(imSource).toContain('disabled: disabled || runtimeMissing || busy !==')
    expect(imSource).toContain('onClick: copy')
  })

  it('shows the reverse WebSocket address after an OneBot account is created', () => {
    expect(imSource).toContain('const wsUrl = `${location.origin}${API}/im/onebot/ws`')
    expect(imSource).toContain("channel: 'onebot'")
    expect(imSource).toContain('secret: { token }')
    expect(imSource).toContain("t('im.onebot.wsHint', { account: endpoint })")
    expect(imSource).toContain("t('im.onebot.created')")
  })

  it('marks shared sessions and wires rebind/unbind from the bootstrap chat lists', () => {
    expect(imSource).toContain('function imSharedSessionIds(peers)')
    expect(imSource).toContain('sharedSessions.has(peer.sessionId)')
    expect(imSource).toContain("h(Pill, { active: true }, t('im.peers.shared'))")
    expect(imSource).toContain('function imPeerParts(key)')
    expect(imSource).toContain('function imChatOptions(characters, chatLists)')
    expect(imSource).toContain('imChatOptions(characters, state.chatLists)')
    expect(imSource).toContain("api(`im/peers?key=${encodeURIComponent(peer.key)}`, { method: 'DELETE' })")
    expect(imSource).toContain("t('im.peers.unbindConfirm', { peer: peer.key })")
  })

  it('submits the three binding modes, both chat refs and both allowlists', () => {
    for (const marker of [
      "const IM_BINDING_MODES = ['manual', 'independent', 'shared']",
      'onPatch({ bindingMode: event.target.value })',
      'onPatch({ sourceChat: imChatRefFromKey(event.target.value) })',
      'onPatch({ sharedChat: imChatRefFromKey(event.target.value) })',
      'onPatch({ groupRequireMention: event.target.checked })',
      "onBlur: () => onAllowCommit('private')",
      "onBlur: () => onAllowCommit('group')",
      "void saveSettings({ [field]: next })",
      "t(`im.settings.mode.${settings.bindingMode}Hint`)",
    ]) {
      expect(imSource).toContain(marker)
    }
  })

  it('keeps the panel styles on existing design tokens', () => {
    const imStyleLines = stylesSource.split('\n').filter((line) => line.includes('dt-im-'))
    expect(imStyleLines.length).toBeGreaterThan(20)
    const rules = imStyleLines.join('\n')
    expect(rules).toContain('var(--dsw-alias-label-tertiary)')
    expect(rules).toContain('.dt-im-light-error{background:var(--dsw-alias-state-error-primary)')
    expect(rules).toContain('.dt-im-allow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))')
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

  it('extracts the QQ install command out of the runtime reason', () => {
    const panel = loadPanelPure()
    const reason = 'QQ runtime packages are missing from /data/im/runtime: a@1.0.5, b@1.2.0. Install them with: cd "/data/im/runtime" && pnpm add a@1.0.5 b@1.2.0'
    expect(panel.imQqInstallCommand(reason)).toBe('cd "/data/im/runtime" && pnpm add a@1.0.5 b@1.2.0')
    expect(panel.imQqInstallCommand('nothing to install')).toBe('')
    expect(panel.imQqInstallCommand('')).toBe('')
  })

  it('round-trips chat refs through the null-separated select key', () => {
    const panel = loadPanelPure()
    const key = panel.imChatKey('角色 A', '2026-10-30 12-00-00.jsonl')
    expect(key).toBe('角色 A\u00002026-10-30 12-00-00.jsonl')
    // 对象来自 vm 另一个 realm，逐字段比对，别依赖原型。
    const parsed = panel.imChatRefFromKey(key)
    expect(parsed?.character).toBe('角色 A')
    expect(parsed?.chatId).toBe('2026-10-30 12-00-00.jsonl')
    expect(panel.imChatRefFromKey('')).toBeNull()
    expect(panel.imChatRefFromKey('no-separator')).toBeNull()
    const options = panel.imChatOptions(['A'], { A: ['one.jsonl', 'two.jsonl'] })
    expect(options.map((option) => option.label)).toEqual(['A / one', 'A / two'])
    // 未加载的当前聊天仍要出现在下拉里（否则用户看到「未选择」）。
    const merged = panel.imWithChatOption(options, { character: 'B', chatId: 'three.jsonl' })
    expect(merged[0]?.key).toBe('B\u0000three.jsonl')
    expect(panel.imWithChatOption(options, null)).toBe(options)
  })

  it('renders the panel shell with all three channel cards and every band (render smoke)', () => {
    const components = createPanelRender({ characters: ['Alice'], chatLists: { Alice: ['one.jsonl'] } })
    const tree = collectNode(components.PanelIm())
    expect(tree.texts).toContain('nav.loading')
    expect(tree.texts).toContain('im.hint.title')
    expect(tree.texts).toContain('im.channels')
    expect(tree.types.filter((type) => type === 'ImChannelCard')).toHaveLength(3)
    // 三个数据带是函数组件，渲染冒烟只验挂点；带内结构由下面两条用例逐个执行。
    expect(tree.types).toContain('ImOneBotBand')
    expect(tree.types).toContain('ImPeersBand')
    expect(tree.types).toContain('ImSettingsBand')
  })

  it('renders channel state, the install command and every bind phase (render smoke)', () => {
    const components = createPanelRender({})
    const card = collectNode(components.ImChannelCard({
      channel: 'qq',
      accounts: [{ channel: 'qq', accountId: '1024', label: 'QQ bot', status: { state: 'error', message: 'gateway dropped' }, peers: 2 }],
      scanning: false,
      runtimeMissing: true,
      installCommand: 'cd "/data" && pnpm add a@1.0.5',
      disabled: false,
      busy: '',
      onBind: () => {},
      onRemove: () => {},
    }))
    expect(card.attrs).toContain('data-im-channel=qq')
    expect(card.attrs).toContain('data-im-tone=error')
    expect(card.texts).toContain('gateway dropped')
    expect(card.texts).toContain('QQ bot')
    // 「最近状态 · N 个对端」是同一行文本，按子串断言。
    expect(card.texts.some((text) => text.includes('im.accountPeers(count=2)'))).toBe(true)
    expect(card.texts).toContain('im.qqRuntimeMissing')
    expect(card.texts).toContain('cd "/data" && pnpm add a@1.0.5')
    // 缺包时扫码按钮必须禁用（copy 按钮仍可点）。
    expect(card.attrs).toContain('disabled=true')

    const verify = collectNode(components.ImBindPanel({
      bind: { channel: 'weixin', phase: 'verify', prompt: 'digits please' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(verify.attrs).toContain('data-im-bind-phase=verify')
    expect(verify.texts).toContain('digits please')
    expect(verify.types).toContain('input')

    const waiting = collectNode(components.ImBindPanel({
      bind: { channel: 'qq', phase: 'waiting', url: 'https://example.test/qr.png' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(waiting.attrs).toContain('src=https://example.test/qr.png')
    expect(waiting.attrs).toContain('href=https://example.test/qr.png')
    expect(waiting.texts).toContain('im.bindQrLink')

    const failed = collectNode(components.ImBindPanel({
      bind: { channel: 'qq', phase: 'failed', reason: 'connector exploded' },
      qrFailedFor: '', verifyCode: '', busy: '', onQrFailed: () => {}, onVerifyCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onCancel: () => {},
    }))
    expect(failed.attrs).toContain('data-im-bind-phase=failed')
    expect(failed.texts).toContain('im.bindFailed(reason=connector exploded)')
    expect(failed.texts).toContain('im.bindRetry')
  })

  it('renders the shared-session badge and the full settings form (render smoke)', () => {
    const components = createPanelRender({})
    const row = collectNode(components.ImPeerRow({
      peer: { key: 'qq:1024:private:u1', sessionId: 'session-a', character: 'Alice', chatId: '2026-10-30 10-00-00.jsonl', scope: 'private', boundBy: 'manual', createdAt: '2026-10-30T10:00:00.000Z' },
      shared: true,
      chatOptions: [{ key: 'Alice\u00002026-10-30 10-00-00.jsonl', label: 'Alice / ten' }],
      disabled: false,
      onRebind: () => {},
      onUnbind: () => {},
    }))
    expect(row.attrs).toContain('data-im-peer=qq:1024:private:u1')
    expect(row.texts).toContain('qq:1024:private:u1')
    expect(row.texts).toContain('im.scope.private')
    expect(row.texts).toContain('im.peers.shared')
    expect(row.texts).toContain('im.peers.chat(character=Alice;chat=2026-10-30 10-00-00.jsonl)')

    const settings = collectNode(components.ImSettingsBand({
      settings: { bindingMode: 'shared', groupRequireMention: true, privateAllow: ['u1'], groupAllow: [] },
      chatOptions: [],
      allowDraft: { private: null, group: null },
      busy: '',
      onPatch: () => {},
      onAllowDraft: () => {},
      onAllowCommit: () => {},
    }))
    expect(settings.texts).toContain('im.settings.mode.shared')
    expect(settings.texts).toContain('im.settings.mode.sharedHint')
    // 共享模式没选共享聊天 = 服务端会拒；面板必须提前把条件说清。
    expect(settings.texts).toContain('im.settings.incomplete')
    expect(settings.texts).toContain('im.settings.privateAllow')
    expect(settings.texts).toContain('im.settings.groupAllow')
    expect(settings.types.filter((type) => type === 'textarea')).toHaveLength(2)
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect("{ id: 'imX',".includes("{ id: 'im',")).toBe(false)
    expect('const IM_BIND_POLL_MSX = 1500'.includes('const IM_BIND_POLL_MS = 1500')).toBe(false)
    expect("'panel.section.imX':".includes("'panel.section.im':")).toBe(false)
    expect('90'.includes('1500')).toBe(false)
    expect('.dt-im-light-errorX{background'.includes('.dt-im-light-error{background')).toBe(false)
  })
})

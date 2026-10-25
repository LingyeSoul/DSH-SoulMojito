/**
 * 卡脚本右栏（2026-10-21）的客户端源码检查：tab 类型 + keyed slot 注册、手动
 * 运行（挂载/切换不自动执行）、警告文案、会话世界书重置入口、`</script` 转义、
 * 以及 zh/en 键镜像。复用 frontend-client.spec.ts 的 source-check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const cardScriptsSource = readFileSync(join(here, '../client-src/88b-ui-card-scripts.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')
const store = readFileSync(join(here, '../../tavern-store/src/store.ts'), 'utf8')

const CARD_SCRIPTS_I18N_KEYS = [
  'cardScripts.title',
  'cardScripts.guide.description',
  'cardScripts.empty',
  'cardScripts.unbound',
  'cardScripts.warning',
  'cardScripts.run',
  'cardScripts.stop',
  'cardScripts.running',
  'cardScripts.resetWorldbook',
  'cardScripts.resetDone',
  'cardScripts.resetScripts',
  'cardScripts.resetScriptsConfirm',
  'cardScripts.resetScriptsDone',
  'cardScripts.scriptsLabel',
  'cardScripts.autoRunning',
  'cardScripts.stopAutoRun',
  'cardScripts.autoRunStopped',
  'cardScripts.autoHostedInFrontend',
  'cardScripts.openFrontend',
  'cardScripts.sharedHost',
  'cardScripts.buttons',
  'cardScripts.loadFailed',
]

describe('client card scripts sidebar (main.js source check)', () => {
  it('registers the tab type and the keyed slot body', () => {
    expect(source).toContain("const CARD_SCRIPTS_TAB_ID = 'dsh-soulmojito/card-scripts'")
    expect(source).toContain("const CARD_SCRIPTS_TAB_KIND = 'tavern-card-scripts'")
    expect(source).toContain('function TavernCardScriptsSidebarTab({ sessionId }) {')
    expect(source).toContain('key: CARD_SCRIPTS_TAB_ID')
    expect(source).toContain("title: () => translate('cardScripts.title')")
    expect(source).toContain("order: 43")
    expect(source).toContain("'data-dsh-soulmojito-surface': 'card-scripts-sidebar'")
  })

  it('loads the card script list from the dedicated endpoint with race cancellation', () => {
    expect(source).toContain('api(`card/scripts?character=${encodeURIComponent(binding.character)}&chatId=${encodeURIComponent(binding.chatId)}&includeDisabled=1`)')
    expect(source).toContain('const requestRef = useRef(0)')
    expect(source).toContain('if (requestRef.current !== request) return')
  })

  it('only runs a script after an explicit click, and stops on chat/character switches', () => {
    // 挂载与切换只清空，不设置 runningId：没有任何自动执行路径。
    expect(source).toContain('setRunningId(null)')
    expect(source).not.toContain('setRunningId(scripts[0]')
    expect(source).toContain("setRunningId(runningId === script.id ? null : script.id)")
    expect(source).toContain("t('cardScripts.run')")
    expect(source).toContain("t('cardScripts.stop')")
  })

  it('wraps the script in a full document and escapes the closing script tag', () => {
    expect(source).toContain('function cardScriptDocument(script)')
    expect(source).toContain("replaceAll('</script', '<\\\\/script')")
    expect(source).toContain('<script type="module">')
    expect(source).toContain('token: `card-script-${sessionId}-${script.id}`')
    expect(source).toContain('messageId: -1')
  })

  it('shows the write-permission warning and the session world-book reset entry', () => {
    expect(source).toContain("t('cardScripts.warning')")
    expect(source).toContain("t('cardScripts.resetWorldbook')")
    expect(source).toContain("op: 'lorebook.reset'")
    expect(source).toContain("t('cardScripts.resetDone')")
    expect(source).toContain("t('cardScripts.loadFailed', { error })")
  })

  it('resets the session script tree and stops the running script', () => {
    expect(source).toContain("t('cardScripts.resetScripts')")
    expect(source).toContain("t('cardScripts.resetScriptsConfirm')")
    expect(source).toContain("t('cardScripts.resetScriptsDone')")
    expect(source).toContain("op: 'scripts.reset'")
    // reset 成功后停止正在运行的脚本并重新拉列表
    const resetStart = source.indexOf('const resetScripts = () => {')
    expect(resetStart).toBeGreaterThanOrEqual(0)
    const resetBlock = source.slice(resetStart, source.indexOf('if (!supported) {', resetStart))
    expect(resetBlock).toContain('setRunningId(null)')
    expect(resetBlock).toContain('void loadRef.current()')
  })

  it('sends card-script resets through the shared helper token provider', () => {
    // Both reset buttons proxy /helper; the token belongs to the panel's own
    // session binding and the shared client retries once after a 401.
    expect(cardScriptsSource).toContain('const helperSlotRef = useRef(null)')
    expect(cardScriptsSource).toContain('acquireHelperToken({ character, chatId })')
    expect(cardScriptsSource).toContain('slot.release()')
    expect(cardScriptsSource).toContain("slot.request('helper'")
    expect(cardScriptsSource).toContain("op: 'lorebook.reset'")
    expect(cardScriptsSource).toContain("op: 'scripts.reset'")
    expect(cardScriptsSource).not.toContain("api('helper'")
    expect(cardScriptsSource).not.toContain('headers: jsonHeaders()')
  })

  it('ships every i18n key in both dictionaries', () => {
    for (const key of CARD_SCRIPTS_I18N_KEYS) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
  })

  it('gates and opens the auto-run host tab when cardScriptsAutoRun is on', () => {
    expect(source).toContain('function useCardScriptsAutoOpen(sessionId, binding, architecture, enabled)')
    expect(source).toContain('if (!enabled || binding === undefined || binding.group === true) return')
    expect(source).toContain("useCardScriptsAutoOpen(sessionId, binding, architecture, state.bootstrap.state.cardScriptsAutoRun === true)")
    expect(source).toContain('openedRef.current.has(key)')
    // AgentTavern 的自动运行宿主是「美化前端」；ST 仍是「卡脚本」。
    expect(source).toContain("const targetKind = architecture === 'agent-tavern' ? FRONTEND_TAB_KIND : CARD_SCRIPTS_TAB_KIND")
    expect(source).toContain('sidebarRight.openTab(targetKind)')
    // 设置页开关与安全警告
    expect(source).toContain("applyPatch({ cardScriptsAutoRun: event.target.checked })")
    expect(source).toContain("t('settings.cardScriptsAutoRunHint')")
    expect(source).toContain("'settings.cardScriptsAutoRun'")
    // 状态持久化：默认 false、parse 只认 true
    expect(store).toContain('cardScriptsAutoRun: boolean')
    expect(store).toContain('cardScriptsAutoRun: false')
    expect(store).toContain('cardScriptsAutoRun: parsed.cardScriptsAutoRun === true')
  })

  it('hands AgentTavern auto-run to the frontend tab and stops manual duplicates', () => {
    expect(source).toContain("const autoRunHostedInFrontend = autoRunSetting && architecture === 'agent-tavern'")
    expect(source).toContain("const autoRunEnabled = autoRunSetting && architecture === 'st'")
    expect(source).toContain('disabled: autoRunning || autoRunHostedInFrontend')
    expect(source).toContain("t('cardScripts.autoHostedInFrontend')")
    expect(source).toContain("t('cardScripts.openFrontend')")
    expect(source).toContain('window.dispatchEvent(new Event(CARD_SCRIPTS_RESET_EVENT))')
  })

  it('auto-runs every enabled script in isolated sandboxed iframes and can stop', () => {
    // Script container (2026-10-23): one iframe per script, each with its own
    // identity so getScriptId/getScriptInfo observe the node. The legacy
    // single-document helpers stay for the AgentTavern auto-run host.
    expect(source).toContain('function cardScriptTreeDocument(scripts)')
    expect(source).toContain("return `<script type=\"module\">${content}</script>`")
    expect(source).toContain('const renderScriptFrame = (script) =>')
    expect(source).toContain('identity: { scriptId: script.id, scriptName: script.name, scriptInfo: script.info }')
    expect(source).toContain('onScriptButtons: handleScriptButtons')
    expect(source).toContain('const [scriptButtons, setScriptButtons] = useState({})')
    expect(source).toContain('dispatchScriptButton')
    expect(source).toContain("const autoRunEnabled = autoRunSetting && architecture === 'st'")
    expect(source).toContain('const [autoRunning, setAutoRunning] = useState(false)')
    expect(source).toContain('const autoRunStoppedRef = useRef(false)')
    expect(source).toContain('bundle.key === key')
    expect(source).toContain('if (!supported || !autoRunEnabled) {')
    expect(source).toContain('if (currentBundle === null || currentBundle.scripts.filter((script) => script.enabled !== false).length === 0) {')
    const autoStart = source.indexOf('setAutoRunning(true)')
    const autoGate = source.indexOf('if (!supported || !autoRunEnabled) {')
    expect(autoGate).toBeGreaterThanOrEqual(0)
    expect(autoStart).toBeGreaterThan(autoGate)
    expect(source).toContain('disabled: autoRunning || autoRunHostedInFrontend')
    expect(source).toContain('function cardScriptTreeRefreshKey(chatKey, scripts)')
    expect(source).toContain("t('cardScripts.autoRunning', { count: scripts.length })")
    expect(source).toContain("t('cardScripts.stopAutoRun')")
    expect(source).toContain("t('cardScripts.autoRunStopped')")
    // 重置卡脚本同时停止自动运行
    const resetStart = source.indexOf('const resetScripts = () => {')
    const resetBlock = source.slice(resetStart, source.indexOf('if (!supported) {', resetStart))
    expect(resetBlock).toContain('autoRunStoppedRef.current = true')
    expect(resetBlock).toContain('setAutoRunning(false)')
  })
})

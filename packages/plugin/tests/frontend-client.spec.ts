/**
 * 美化前端右栏的客户端源码检查（2026-10-20）：注册链路（tab 类型 + keyed slot
 * body）、标题栏入口、ST 架构不重复执行的说明空态，以及 zh/en 键镜像。
 * 复用 games-client.spec.ts 的 main.js source-check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')

const FRONTEND_I18N_KEYS = [
  'frontend.title',
  'frontend.guide.description',
  'frontend.empty',
  'frontend.emptyTitle',
  'frontend.emptyHint',
  'frontend.floor',
  'frontend.refresh',
  'frontend.resizeHint',
  'frontend.expand',
  'frontend.collapse',
  'frontend.inlineOnly',
  'frontend.unbound',
  'frontend.cardScriptsAutoRunning',
  'frontend.stopCardScripts',
  'frontend.cardScriptsStopped',
  'frontend.cardScriptsError',
  'frontend.cardScriptsOnly',
]

describe('client frontend sidebar (main.js source check)', () => {
  it('registers the tab type and the keyed slot body', () => {
    expect(source).toContain("const FRONTEND_TAB_ID = 'dsh-soulmojito/frontend'")
    expect(source).toContain("const FRONTEND_TAB_KIND = 'tavern-frontend'")
    expect(source).toContain('function TavernFrontendSidebarTab({ sessionId }) {')
    expect(source).toContain("key: FRONTEND_TAB_ID")
    expect(source).toContain('inject: (sessionId) => ({ sessionId })')
  })

  it('opens the tab from the AgentTavern header entry', () => {
    expect(source).toContain('const openFrontendSurface = () => {')
    expect(source).toContain('sidebarRight.openTab(FRONTEND_TAB_KIND)')
    expect(source).toContain("hasSidebarRight ? h('button', {")
  })

  it('keeps ST inline rendering and does not run a second copy in the sidebar', () => {
    expect(source).toContain("architecture === 'st' ? t('frontend.inlineOnly')")
    expect(source).toContain("'data-dsh-soulmojito-surface': 'frontend-sidebar'")
  })

  it('ships every i18n key in both dictionaries', () => {
    for (const key of FRONTEND_I18N_KEYS) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
  })

  it('fills the iframe canvas with the DSH native background when the frontend sets none', () => {
    // Without a card background the browser default white canvas shows through
    // (a white ring in dark mode). The host resolves --dsw-alias-bg-base to a
    // concrete color and injects it as --dt-host-background; theme flips update
    // it via postMessage without rebuilding the srcdoc. Card background rules
    // still win because the reset comes first in the cascade.
    expect(source).toContain("const FRONTEND_THEME_MESSAGE = 'dsh-soulmojito:theme'")
    expect(source).toContain("const FRONTEND_BACKGROUND_CSS_VAR = '--dt-host-background'")
    expect(source).toContain('html{background:var(--dt-host-background)}')
    expect(source).toContain('function frontendHostBackgroundColor()')
    expect(source).toContain("getPropertyValue('--dsw-alias-bg-base')")
    expect(source).toContain("data-ds-dark-theme")
    expect(source).toContain('function useThemeBridge(frameRef)')
  })

  it('paints the iframe element and forces a late canvas rule against card !important', () => {
    // 行动台这类卡写 `html,body{background:transparent!important}`：head 里的
    // reset 输掉 cascade，画布露出浏览器白底。late canvas 规则在卡样式之后，
    // 只强制 html（body 与卡自己的 .tactics-panel 背景保持）。
    expect(source).toContain('const canvas = `<style>html{background:var(--dt-host-background)!important;}</style>`')
    expect(source).toContain('`${canvas}${reporter}</body>`')
    expect(source).toContain('style: { height: effectiveHeight, background: initialBackgroundRef.current }')
  })

  it('translates sandboxed unload listeners to pagehide before card scripts run', () => {
    // Chromium disables unload in cross-origin frames, and a sandboxed srcdoc
    // cannot opt in with an allow attribute (no headers of its own). The shim
    // must be injected before the helper libraries and card markup.
    expect(source).toContain('function frontendUnloadCompatScript()')
    expect(source).toContain('target === window || target === document')
    expect(source).toContain("type.toLowerCase() === 'unload'")
    expect(source).toContain("Object.defineProperty(window, 'onunload'")
    expect(source).toContain('${csp}${unloadCompat}${reset}${viewport}${theme}${helper}')
  })

  it('lets the user drag the frontend height and keeps it across card frame prefs', () => {
    expect(source).toContain("const FRONTEND_MANUAL_MAX_HEIGHT = 4000")
    expect(source).toContain('const [manualHeight, setManualHeight] = useState(null)')
    expect(source).toContain('className: \'dt-frontend-resize-handle\'')
    expect(source).toContain('setPointerCapture(event.pointerId)')
    expect(source).toContain('frame.style.setProperty(\'height\', `${manualHeight}px`, \'important\')')
    expect(source).toContain('manualHeightRef.current !== null')
  })

  it('reloads the iframe on manual refresh and expands the sidebar panel', () => {
    // srcDoc is a string prop: re-fetching identical HTML does not reload the
    // browsing context. The nonce must reach the React key so refresh remounts.
    expect(source).toContain('const [reloadNonce, setReloadNonce] = useState(0)')
    expect(source).toContain('setReloadNonce((value) => value + 1)')
    expect(source).toContain('key: `${message.index}-${index}-${reloadNonce}`')
    expect(source).toContain('key: `card-scripts-${reloadNonce}`')
    // Expansion must keep the same DOM node: a portal/reparent destroys the
    // iframe browsing context and cards reload data, so use Fullscreen API/CSS.
    expect(source).not.toContain('createPortal(panel')
    expect(source).toContain('requestFullscreen()')
    expect(source).toContain('ref: panelRef')
    expect(source).toContain('dt-frontend-side-expanded')
    expect(source).toContain("t(expanded ? 'frontend.collapse' : 'frontend.expand')")
  })

  it('injects auto-run card scripts into the same latest-frontend iframe', () => {
    // 2026-10-21 第二次修订：脚本不再另起空白 iframe，而是拼进最新美化前端文档，
    // 让 window.top.document.body 上的悬浮面板直接落在美化前端里。
    expect(source).toContain('function frontendCardScriptBlocks(scripts)')
    expect(source).toContain('function frontendWithCardScripts(html, scripts)')
    expect(source).toContain('function frontendCardScriptHostIndex(documents)')
    expect(source).toContain("const CARD_SCRIPTS_RESET_EVENT = 'dsh-soulmojito:card-scripts-reset'")
    expect(source).toContain('api(`card/scripts${query}`)')
    expect(source).toContain("const autoRunHosted = cardScriptsAutoRun && architecture === 'agent-tavern'")
    expect(source).toContain('const scriptsPending = autoRunHosted && scriptBundle === null')
    expect(source).toContain('index === scriptHostIndex ? frontendWithCardScripts(html, scripts) : html')
    expect(source).toContain("html: frontendWithCardScripts('', scripts)")
    expect(source).toContain("t('frontend.cardScriptsAutoRunning', { count: scripts.length })")
    expect(source).toContain("t('frontend.stopCardScripts')")
    expect(source).toContain("t('frontend.cardScriptsStopped')")
    expect(source).toContain('setAutoStopped(true)')
    expect(source).toContain('addEventListener(CARD_SCRIPTS_RESET_EVENT, onReset)')
  })
})

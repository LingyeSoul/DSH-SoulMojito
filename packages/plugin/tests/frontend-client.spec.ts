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
  'frontend.inlineOnly',
  'frontend.unbound',
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
})

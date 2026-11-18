/**
 * Panel user manual source checks (2026-11-18 user request: add a manual with
 * onboarding, SillyTavern differences and feature explanations).
 *
 * The client half is a host ModuleLoader IIFE with no module exports, so this
 * follows the established main.js source-check pattern: pin the section
 * registration, every jump target, both locale tables and the onboarding
 * callout. The locale gate separately enforces zh/en key parity and identical
 * placeholders, so this file only locks the manual-specific surface.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const manualSource = readFileSync(join(here, '../client-src/89c-ui-manual.js'), 'utf8')

const MANUAL_SECTION_IDS = [
  'characters',
  'worlds',
  'presets',
  'personas',
  'regex',
  'scripts',
  'dataBank',
  'chats',
  'notes',
  'guides',
  'variables',
  'games',
  'prompts',
  'behavior',
  'memory',
  'workbench',
  'im',
  'mods',
  'backup',
]

const MANUAL_TARGETS = [
  'dt-manual-start',
  'dt-manual-terms',
  'dt-manual-diff',
  'dt-manual-features',
  'dt-manual-limits',
]

interface RenderNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

interface ManualRender {
  tree: unknown
  updated: Array<Record<string, unknown>>
  lastScrollTarget: () => string
}

function createManualRender(): ManualRender {
  const updated: Array<Record<string, unknown>> = []
  let scrollTarget = ''
  const sectionIds = [...MANUAL_SECTION_IDS, 'overview', 'manual', 'about']
  const context = vm.createContext({
    h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => (
      typeof type === 'function'
        ? (type as (componentProps: Record<string, unknown>) => unknown)({ ...(props ?? {}), children })
        : { type, props: props ?? {}, children } satisfies RenderNode
    ),
    useTranslate: () => (key: string, params?: Record<string, unknown>) => (
      params === undefined
        ? key
        : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(';')})`
    ),
    useTavernStore: () => ({ bootstrap: { version: '0.8.1' } }),
    update: (patch: Record<string, unknown>) => { updated.push(patch) },
    panelSections: sectionIds.map((id) => ({ id, label: () => id })),
    document: {
      getElementById: (id: string) => ({
        scrollIntoView: () => { scrollTarget = id },
      }),
    },
  })
  vm.runInContext(`${manualSource}\n;globalThis.__manualRender = { PanelManual }`, context, { filename: '89c-ui-manual.js' })
  const PanelManual = vm.runInContext('globalThis.__manualRender.PanelManual', context) as () => unknown
  return { tree: PanelManual(), updated, lastScrollTarget: () => scrollTarget }
}

function collectManual(tree: unknown): {
  texts: string[]
  buttons: Array<{ label: string; props: Record<string, unknown> }>
  articles: number
  details: number
  tables: RenderNode[]
} {
  const texts: string[] = []
  const buttons: Array<{ label: string; props: Record<string, unknown> }> = []
  const tables: RenderNode[] = []
  let articles = 0
  let details = 0
  const textOf = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node !== null && typeof node === 'object' && 'children' in node) {
      return textOf((node as RenderNode).children)
    }
    return ''
  }
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
    if (typeof node !== 'object' || !('type' in node)) return
    const entry = node as RenderNode
    if (entry.type === 'article') articles += 1
    if (entry.type === 'details') details += 1
    if (entry.type === 'table') tables.push(entry)
    if (entry.type === 'button') {
      buttons.push({ label: textOf(entry.children), props: entry.props })
    }
    for (const child of entry.children) visit(child)
  }
  visit(tree)
  return { texts, buttons, articles, details, tables }
}

describe('panel user manual (main.js source check)', () => {
  it('registers the manual between overview and characters and links it from overview', () => {
    const overviewAt = source.indexOf("{ id: 'overview',")
    const manualAt = source.indexOf("{ id: 'manual',")
    const charactersAt = source.indexOf("{ id: 'characters', group: 'content'")
    expect(overviewAt).toBeGreaterThanOrEqual(0)
    expect(manualAt).toBeGreaterThan(overviewAt)
    expect(charactersAt).toBeGreaterThan(manualAt)
    // Overview callout: first-run discovery must not depend on scanning the nav.
    expect(source).toContain("className: 'dt-manual-callout'")
    expect(source).toContain("onClick: () => update({ panelSection: 'manual' })")
    expect(source).toContain("t('panel.overview.manualOpen')")
  })

  it('keeps every manual jump target inside the rendered manual', () => {
    for (const target of MANUAL_TARGETS) {
      expect(source, target).toContain(`id: '${target}'`)
    }
    expect(source).toContain("h('nav', { className: 'dt-manual-toc', 'aria-label': t('manual.toc.label') }")
    expect(source).toContain("node.scrollIntoView({ block: 'start' })")
  })

  it('points every manual card and step at a registered panel section', () => {
    const manualBlock = source.slice(source.indexOf('const MANUAL_STEPS ='), source.indexOf('function PanelManual()'))
    for (const id of MANUAL_SECTION_IDS) {
      expect(source, id).toContain(`{ id: '${id}',`)
      expect(manualBlock, id).toContain(`section: '${id}'`)
    }
  })

  it('ships onboarding, the ST comparison, the feature map and honest limits', () => {
    for (const marker of [
      "'manual.start.title': '五分钟上手'",
      "'manual.start.title': 'Five-minute start'",
      "'manual.diff.title': '和 SillyTavern 的区别'",
      "'manual.diff.title': 'Differences from SillyTavern'",
      "'manual.diff.runtime.st': '独立应用：自带服务端、网页 UI 与更新器'",
      "'manual.diff.runtime.soul': 'DSH 插件包：挂在官方 slot 上，随 DSH 启动与升级'",
      "'manual.features.title': '功能地图：每个分区管什么'",
      "'manual.features.title': 'Feature map: what each section owns'",
      "'manual.limit.managed.title': 'agent-managed 保持关闭'",
      "'manual.limit.managed.title': 'agent-managed stays closed'",
      "t('manual.faq.title')",
    ]) {
      expect(source).toContain(marker)
    }
    // FAQ uses real disclosure elements rather than a wall of text.
    expect(source).toContain("h('details', { key: item.id, className: 'dt-manual-faq' }")
    expect(source).toContain("h('summary', null, t(item.question))")
  })

  it('carries the manual locale keys in both tables with mirrored placeholders', () => {
    const keys = [
      'panel.section.manual',
      'panel.overview.manualTitle',
      'panel.overview.manualHint',
      'panel.overview.manualOpen',
      'manual.title',
      'manual.tagline',
      'manual.intro',
      'manual.openSection',
      'manual.start.title',
      'manual.term.dsh.body',
      'manual.arch.agent.limit',
      'manual.data.storage',
      'manual.diff.loop.soul',
      'manual.feature.characters.body',
      'manual.limit.template.body',
      'manual.faq.architecture.answer',
      'manual.footer',
    ]
    for (const key of keys) {
      expect(source.split(`'${key}':`).length - 1, key).toBe(2)
    }
    expect(source).toContain("'manual.openSection': '打开「{section}」'")
    expect(source).toContain("'manual.openSection': 'Open {section}'")
    expect(source).toContain("'manual.footer': '本手册对应 {version}。完整实现与边界以源码和 docs 为准。'")
    expect(source).toContain("'manual.footer': 'This manual matches {version}. The source code and docs remain the authority for implementation and limits.'")
  })

  it('renders the full manual, wires section jumps and TOC scrolling (render smoke)', () => {
    const render = createManualRender()
    const { texts, buttons, articles, details, tables } = collectManual(render.tree)
    for (const key of [
      'manual.title',
      'manual.start.title',
      'manual.arch.title',
      'manual.data.title',
      'manual.diff.title',
      'manual.features.title',
      'manual.limits.title',
      'manual.faq.title',
      'manual.footer(version=v0.8.1)',
    ]) {
      expect(texts, key).toContain(key)
    }
    // 19 feature cards + 5 FAQ disclosures: both are real rendered structures.
    expect(articles).toBe(19)
    expect(details).toBe(5)
    // Table groups must be siblings. A missing close once nested tbody inside
    // thead, which browsers restructured into a header-only table: the header
    // labels drifted right while body columns stayed put (2026-11-18 screenshot).
    expect(tables).toHaveLength(2)
    for (const table of tables) {
      const groups = (table.children.flat(Infinity) as RenderNode[])
        .filter((node) => node !== null && typeof node === 'object' && 'type' in node)
      expect(groups.map((node) => node.type)).toEqual(['thead', 'tbody'])
      for (const group of groups) {
        const rows = group.children.flat(Infinity) as RenderNode[]
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every((node) => node.type === 'tr')).toBe(true)
      }
    }
    const openButtons = buttons.filter((button) => button.label.startsWith('manual.openSection('))
    expect(openButtons.length).toBeGreaterThanOrEqual(19)
    const characterButton = openButtons.find((button) => button.label.includes('section=characters'))
    expect(characterButton).toBeDefined()
    ;(characterButton!.props.onClick as () => void)()
    expect(render.updated.at(-1)).toEqual({ panelSection: 'characters' })
    // TOC buttons scroll to the section anchor instead of changing panelSection.
    const diffToc = buttons.find((button) => button.label === 'manual.toc.diff')
    expect(diffToc).toBeDefined()
    ;(diffToc!.props.onClick as () => void)()
    expect(render.lastScrollTarget()).toBe('dt-manual-diff')
    expect(render.updated).toHaveLength(1)
  })

  it('does not confuse the manual markers with near-miss ids (negative sample)', () => {
    expect("{ id: 'manualX',".includes("{ id: 'manual',")).toBe(false)
    expect("'panel.section.manualX':".includes("'panel.section.manual':")).toBe(false)
    expect("id: 'dt-manual-startX'".includes("id: 'dt-manual-start'")).toBe(false)
  })
})
/**
 * 酒馆管理面板（TavernPanel）滚动契约（2026-10-14 用户反馈：红框的「Tavern」
 * 标题区要固定不动，只有其余部分滚动）。
 *
 * 背景：导航列的分区清单可被 Mod 扩展（registerPanelSection 追加），分区数增长
 * 后必然溢出——原来 overflow-y:auto 挂在整个 nav 上，滚动会把品牌块（「这是
 * 酒馆面板」的标识 + 版本 stamp）一起卷走。改法是把 nav 拆两段：品牌块常驻 +
 * 清单进 .dt-panel-navlist 独占滚动；主区 header 补 flex:none，保证内容再长也
 * 不参与伸缩（标题栏与内容区是「标题常驻 + 内容滚动」的关系）。
 *
 * 为什么不写行为断言：client half 是宿主 ModuleLoader 的 IIFE，没有模块出口；
 * jsdom 也没有布局引擎（量不出「谁在滚」）。真实滚动已在 headless Chrome 里用
 * 宿主 Modal 的真实 CSS + 本工程同一份插件 CSS 量过（清单 scrollTop 变化时
 * 品牌 top 恒定、内容滚动时 header top 恒定）；这里锁结构与规则文本，产物层面
 * 由 gates frontend-runtime 的对应 marker（含负样本自证）对账。
 *
 * 2026-10-14 移动端回归补记：700px 断点里 .dt-panel-navlist 必须退场
 * （display:contents）——它是「品牌块常驻」新增的桌面滚动容器，留着会在横向
 * 按钮条里竖排堆叠分区按钮、把主区挤没（真实量测见
 * decisions/2026-10-14-panel-mobile-navlist-strip-regression.md）。
 *
 * 2026-10-16 brand note: the panel brand block, the sidebar footer action, the
 * settings panel entry and the panel about section header carry the delivered
 * DSH-SoulMojito logo (assets/logo.svg) inlined as the local SoulMojitoLogo
 * component (user request: use the supplied logo as the mark, show it in the
 * README and in the about page). One component, four surfaces; the count lock
 * turns red when a new surface misses the mark, and the asset-vs-inline case
 * turns red when the two copies drift apart.
 * See decisions/2026-10-16-soulmojito-brand-mark.md.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

/** h(...) 调用的右括号位置：从 callAt 起按括号配平扫到 depth 归零。 */
function closingParenOf(text: string, callAt: number): number {
  let depth = 0
  for (let index = callAt; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

describe('tavern panel navigation shell layout', () => {
  it('keeps the brand block outside the scrollable section list', () => {
    const brandAt = source.indexOf("h('div', { className: 'dt-panel-brand' },")
    const listAt = source.indexOf("h('div', { className: 'dt-panel-navlist' },")
    const cellsAt = source.indexOf("panelSections.map((item) => h('button', {", listAt)
    const mainAt = source.indexOf("h('div', { className: 'dt-panel-main' },")
    expect(brandAt).toBeGreaterThanOrEqual(0)
    expect(listAt).toBeGreaterThan(brandAt)
    expect(cellsAt).toBeGreaterThan(listAt)
    // 品牌块在清单容器开始前就闭合：它不属于滚动区。
    expect(closingParenOf(source, brandAt)).toBeLessThan(listAt)
    // 清单容器在主区之前闭合：分区按钮挂在清单里，滚动余量不会吃掉主区。
    expect(closingParenOf(source, listAt)).toBeGreaterThan(cellsAt)
    expect(closingParenOf(source, listAt)).toBeLessThan(mainAt)
  })

  it('scrolls only the section list, never the nav column itself', () => {
    // nav 不再自滚（overflow:hidden）——回到 overflow-y:auto 就是这次反馈的回归。
    expect(source).toContain('.dt-panel-nav{display:flex;flex-direction:column;gap:2px;width:198px;flex:none;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow:hidden}')
    expect(source).not.toContain('border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto}')
    expect(source).toContain('.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}')
  })

  it('pins the section title bar and gives the scroll to the body', () => {
    // 标题栏 flex:none（不参与伸缩）+ 内容区独占滚动余量（flex:1 + min-height:0
    // 是「滚动容器能在 flex 列里真正溢出」的前提）。
    expect(source).toContain('.dt-panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}')
    expect(source).toContain('.dt-panel-body{flex:1;min-height:0;overflow-y:auto}')
  })

  it('retires the section-list wrapper inside the mobile chip strip', () => {
    // 700px 断点自 §3.5 起就是「面板转纵向 + 导航列变横向滑动按钮条」；6613a75
    // 新增的 .dt-panel-navlist 带着桌面列向规则（display:flex;flex-direction:column;
    // flex:1）进了横条——按钮改在横条里竖排堆叠，nav 从 55px 涨到 667px、主区只剩
    // 33px、正文不可见（2026-10-14 移动端实况，headless Chrome 390×844 实测）。
    // 修复：清单容器在移动端退场（display:contents），按钮回到横条的 flex 流。
    const baseListAt = source.indexOf('.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}')
    const mobileAt = source.indexOf('@media(max-width:700px){.dt-panel{flex-direction:column}')
    expect(baseListAt).toBeGreaterThanOrEqual(0)
    // display:contents 靠 cascade 覆盖基础规则：媒体查询必须排在基础规则之后。
    expect(mobileAt).toBeGreaterThan(baseListAt)
    // 该媒体查询在源文件里是独立一行（逐条规则一行排布），整行取出来锁。
    const mobileLine = source.slice(mobileAt, source.indexOf('\n', mobileAt))
    expect(mobileLine).toContain('.dt-panel-nav{width:100%;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}')
    expect(mobileLine).toContain('.dt-panel-navlist{display:contents}')
    expect(mobileLine).toContain('.dt-panel-navcell{flex:none}')
    // 回归形态：横条里再现清单的桌面列向规则（带或不带后续属性）就是这次移动端回归。
    expect(mobileLine).not.toContain('.dt-panel-navlist{display:flex;flex-direction:column')
  })

  it('brands the panel shell and the about section with the SoulMojito logo', () => {
    // Brand logo (2026-10-16 user request): one inlined component, four surfaces
    // -- panel brand block, sidebar footer action, settings panel entry, about
    // section header. The count lock (1 definition + 4 usages) turns red when a
    // new surface is added without the mark.
    expect(source.split('SoulMojitoLogo').length - 1).toBe(5)
    expect(source).toContain('function SoulMojitoLogo({ size = 16, className })')
    // Brand block: mark + brand name (the copy used to read 'Tavern').
    const brandAt = source.indexOf("h('div', { className: 'dt-panel-brand' },")
    const brandBlock = source.slice(brandAt, closingParenOf(source, brandAt) + 1)
    expect(brandBlock).toContain('h(SoulMojitoLogo)')
    expect(brandBlock).toContain("h('strong', null, 'SoulMojito')")
    expect(brandBlock).not.toContain("'Tavern'")
    // Sidebar footer action: mark + brand label. The accessible name repeats
    // the visible label (WCAG 2.5.3 label-in-name -- voice control matches the
    // text a user reads), and nav.title keeps labeling both the sidebar section
    // heading and the host conversation tab: only the footer label moved.
    const footerAt = source.indexOf('function SidebarFooterAction({ wide }) {')
    const buttonAt = source.indexOf("h('button', {", footerAt)
    const button = source.slice(buttonAt, closingParenOf(source, buttonAt) + 1)
    expect(button).toContain('h(SoulMojitoLogo, { size: wide ? 16 : 18 })')
    expect(button).toContain("className: 'dt-footer-label' }, 'SoulMojito')")
    const ariaLabelLine = button.split('\n').find((line) => line.includes("'aria-label'")) ?? ''
    expect(ariaLabelLine).toContain("t('panel.open')")
    expect(ariaLabelLine).toContain('SoulMojito')
    expect(source).not.toContain("className: 'dt-footer-label' }, t('nav.title')")
    expect(source).toContain("label: () => translate('nav.title')")
    // Settings panel entry borrows the mark but keeps its own label.
    expect(source).toContain("icon: h(SoulMojitoLogo), onClick: () => openPanel() }, t('panel.open'))")
    // About section header: mark + the official brand spelling. The heading used
    // to be the lower-case directory name, which is not the product name.
    expect(source).toContain("h('div', { className: 'dt-about-head' },")
    expect(source).toContain('h(SoulMojitoLogo, { size: 40 })')
    expect(source).toContain("h('h3', null, 'DSH-SoulMojito')")
    expect(source).not.toContain("h('h3', null, 'dsh-soulmojito')")
  })

  it('keeps the inlined logo identical to the delivered assets/logo.svg', () => {
    // The client half is a ModuleLoader IIFE with no file access, so the logo
    // geometry is inlined in main.js while the delivered file stays the design
    // source of truth. Pin every geometry/palette literal of the asset to the
    // source: dropping a new export into assets/logo.svg without re-inlining it
    // (or editing one side only) has to turn red instead of shipping two marks.
    const logo = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../assets/logo.svg'), 'utf8')
    expect(logo).toContain('viewBox="-90 -100 180 190"')
    expect(source).toContain("viewBox: '-90 -100 180 190'")
    const literals = [...logo.matchAll(/(?:d|fill|stroke|stroke-width|fill-opacity|transform)="([^"]+)"/g)].map(
      (match) => match[1],
    )
    // Guards the guard: a re-written asset in another attribute style must not
    // turn this case into a no-op that passes on an empty literal list.
    expect(literals.length).toBeGreaterThanOrEqual(15)
    for (const literal of new Set(literals)) expect(source).toContain(literal)
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect('.dt-panel-navlistX{display:flex'.includes('.dt-panel-navlist{display:flex')).toBe(false)
    expect('.dt-panel-navX{display:flex'.includes('.dt-panel-nav{display:flex')).toBe(false)
    expect("h('div', { className: 'dt-panel-navlistX' },".includes("h('div', { className: 'dt-panel-navlist' },")).toBe(false)
    expect('justify-content:space-between;gap:12px;min-height:52px'.includes('justify-content:space-between;gap:12px;flex:none;min-height:52px')).toBe(false)
    expect('.dt-panel-navlist{display:contentsX}'.includes('.dt-panel-navlist{display:contents}')).toBe(false)
    expect('function SoulMojitoLogoX({ size = 16, className })'.includes('function SoulMojitoLogo({ size = 16, className })')).toBe(false)
    expect("h('strong', null, 'SoulMojitoX')".includes("h('strong', null, 'SoulMojito')")).toBe(false)
    expect("className: 'dt-footer-label' }, 'SoulMojitoX'".includes("className: 'dt-footer-label' }, 'SoulMojito'")).toBe(false)
    expect('h(SoulMojitoLogoX, { size: 40 })'.includes('h(SoulMojitoLogo, { size: 40 })')).toBe(false)
    expect("h('h3', null, 'DSH-SoulMojitoX')".includes("h('h3', null, 'DSH-SoulMojito')")).toBe(false)
    // A one-unit geometry drift in the asset is exactly what the sync case is
    // meant to catch, so the literal compare has to reject it.
    expect('M-58,-78 C-58,-20 -34,10 0,10 C34,10 58,-20 58,-79 Z'.includes('M-58,-78 C-58,-20 -34,10 0,10 C34,10 58,-20 58,-78 Z')).toBe(false)
  })
})

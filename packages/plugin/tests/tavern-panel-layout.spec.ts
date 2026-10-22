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
 *
 * 2026-10-21 nav rework note: users reported the panel as hard to use; the flat
 * 18-item nav grew unreadable (five sections sharing one pen icon, no grouping,
 * no filter, no fullscreen, scroll position lost on every section switch). The
 * nav is now: pinned brand + pinned section filter + grouped section list
 * (content / sessions / system, mod panels land in system), 18 distinct icons,
 * arrow-key navigation, per-section scroll memory, and a fullscreen toggle.
 * The section cell render moved out of an inline `panelSections.map(...)` into a
 * named `sectionCell` rendered per group -- the locks below pin the new
 * structure with the same string-witness discipline (including negative
 * samples), and the gates frontend-runtime markers carry the same contract.
 * See decisions/2026-10-21-panel-navigation-ux-rework.md.
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
  it('keeps the brand block and the search filter outside the scrollable section list', () => {
    const brandAt = source.indexOf("h('div', { className: 'dt-panel-brand' },")
    const searchAt = source.indexOf("className: 'dt-panel-search'")
    const listAt = source.indexOf("h('div', { className: 'dt-panel-navlist', ")
    const mainAt = source.indexOf("h('div', { className: 'dt-panel-main' },")
    const cellAt = source.indexOf("const sectionCell = (item) => h('button', {")
    expect(brandAt).toBeGreaterThanOrEqual(0)
    expect(searchAt).toBeGreaterThan(brandAt)
    expect(listAt).toBeGreaterThan(searchAt)
    expect(cellAt).toBeGreaterThanOrEqual(0)
    // 品牌块与过滤框都在清单容器开始前闭合：两者常驻不滚，只有分组清单滚动
    // （2026-10-14 品牌钉住的既有契约 + 2026-10-21 过滤框并入同段）。
    expect(closingParenOf(source, brandAt)).toBeLessThan(listAt)
    expect(closingParenOf(source, searchAt)).toBeLessThan(listAt)
    // 分区按钮由 sectionCell 产出（data-dt-section 供键盘导航聚焦），三个挂点
    // 都在清单容器内部：无组前置项（overview）、组内项、无组后置项（about）。
    const listClose = closingParenOf(source, listAt)
    expect(listClose).toBeGreaterThan(listAt)
    expect(listClose).toBeLessThan(mainAt)
    const listBlock = source.slice(listAt, listClose + 1)
    expect(listBlock).toContain('topUngrouped.map(sectionCell)')
    expect(listBlock).toContain('items.map(sectionCell)')
    expect(listBlock).toContain('bottomUngrouped.map(sectionCell)')
    // 组容器与组标签在清单内渲染；空过滤结果的空态提示也在清单内。
    expect(listBlock).toContain("className: 'dt-panel-group'")
    expect(listBlock).toContain("className: 'dt-panel-group-label'")
    expect(listBlock).toContain("className: 'dt-panel-search-empty'")
    // 键盘导航聚焦锚点写进分区按钮本身。
    expect(source).toContain("'data-dt-section': item.id")
  })

  it('renders one group container per non-empty section group in declaration order', () => {
    // 组清单是呈现层常量，顺序即渲染顺序；组标签文案走 locale thunk（i18n
    // 键 panel.group.* 的 zh/en 对账由 gates locale 校验兜底）。
    expect(source).toContain('const panelSectionGroups = [')
    const contentAt = source.indexOf("{ id: 'content', label: (t) => t('panel.group.content') }")
    const sessionAt = source.indexOf("{ id: 'session', label: (t) => t('panel.group.session') }")
    const systemAt = source.indexOf("{ id: 'system', label: (t) => t('panel.group.system') }")
    expect(contentAt).toBeGreaterThanOrEqual(0)
    expect(sessionAt).toBeGreaterThan(contentAt)
    expect(systemAt).toBeGreaterThan(sessionAt)
    // 动态 Mod 面板分区在 syncModPanelSections 标 'system'，与 Mod 管理同组。
    expect(source).toContain("group: 'system'")
    // 组内渲染保持注册顺序（注册表顺序即面板文档顺序）。
    expect(source).toContain('items: visibleSections.filter((item) => item.group === group.id)')
  })

  it('restores the scroll position per section instead of resetting to the top', () => {
    // 分区切换把旧分区的 scrollTop 存进 scrollMemory、切回时还原——长清单来回
    // 切不再被打回顶部。锁写读两行：删任一行这个能力就消失。
    expect(source).toContain('scrollMemory.current[trackedSection.current] = body.scrollTop')
    expect(source).toContain('body.scrollTop = scrollMemory.current[section] ?? 0')
  })

  it('offers a fullscreen toggle and grows the modal to the viewport', () => {
    // 全屏切换写 store 的 panelExpanded（与 panelSection 同款 UI 状态语义），
    // 模态框挂 dt-panel-modal-full 修饰类吃满视口减 24px；窄屏回落交给既有
    // min() 取宽高的基础规则（calc(100vw - 24px) 天然取更小者生效）。
    expect(source).toContain('update({ panelExpanded: !expanded })')
    expect(source).toContain("className: `dt-panel-modal${state.panelExpanded === true ? ' dt-panel-modal-full' : ''}`")
    expect(source).toContain('.dt-panel-modal-full{width:calc(100vw - 24px)!important;height:calc(100vh - 24px)!important}')
    expect(source).toContain("className: 'dt-panel-expand'")
  })

  it('filters sections from the pinned search box and announces the empty state', () => {
    // 过滤按当前 locale 显示名小写包含匹配；匹配不到时清单内出空态文案
    // （panel.searchEmpty），过滤框 Esc 先清词。
    expect(source).toContain("const [filter, setFilter] = useState('')")
    expect(source).toContain('item.label(t).toLowerCase().includes(query)')
    expect(source).toContain("if (event.key === 'Escape' && filter !== '') setFilter('')")
    expect(source).toContain("t('panel.searchEmpty')")
  })

  it('navigates sections with arrow keys inside the section list', () => {
    // ↑↓/Home/End 在可见分区间移动激活并聚焦对应按钮（data-dt-section 锚点）；
    // 原生 Tab 序不受影响。
    expect(source).toContain('const handleNavKeyDown = (event) => {')
    expect(source).toContain('onKeyDown: handleNavKeyDown')
    expect(source).toContain('requestAnimationFrame(() => focusSectionButton(id))')
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
    expect(mobileLine).toContain('.dt-panel-nav{box-sizing:border-box;width:100%;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}')
    expect(mobileLine).toContain('.dt-panel-navlist{display:contents}')
    // 分组容器同样退场（2026-10-23）：它是 2026-10-21 导航重做新加的列向
    // 容器，与 navlist 同款漏进横条会把组内按钮竖排成多列、把标题区挤在一起。
    expect(mobileLine).toContain('.dt-panel-group{display:contents}')
    expect(mobileLine).toContain('.dt-panel-navcell{flex:none}')
    // 回归形态：横条里再现清单/分组容器的桌面列向规则（带或不带后续属性）
    // 就是移动端横条回归。
    expect(mobileLine).not.toContain('.dt-panel-navlist{display:flex;flex-direction:column')
    expect(mobileLine).not.toContain('.dt-panel-group{display:flex;flex-direction:column')
  })

  it('reveals the active section chip inside the mobile strip', () => {
    // 程序化切区（总览数字卡片、会话头入口）不会经过横条点击，活动分区可能
    // 停在可视区外；切区后把 chip 居中滚进横条。桌面导航无横向溢出，guard
    // 让该 effect 成为 no-op。
    expect(source).toContain('const navRef = useRef(null)')
    expect(source).toContain("h('nav', { className: 'dt-panel-nav', 'aria-label': t('panel.nav'), ref: navRef },")
    expect(source).toContain('if (!state.panelOpen) return')
    expect(source).toContain('if (nav === null || nav.scrollWidth <= nav.clientWidth) return')
    expect(source).toContain('const left = nav.scrollLeft + chipRect.left - navRect.left - (navRect.width - chipRect.width) / 2')
    expect(source).toContain('nav.scrollLeft = Math.max(0, left)')
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
    expect('.dt-panel-group{display:contentsX}'.includes('.dt-panel-group{display:contents}')).toBe(false)
    expect('const navRef = useRef(nullX)'.includes('const navRef = useRef(null)')).toBe(false)
    expect('nav.scrollLeft = Math.max(1, left)'.includes('nav.scrollLeft = Math.max(0, left)')).toBe(false)
    expect('function SoulMojitoLogoX({ size = 16, className })'.includes('function SoulMojitoLogo({ size = 16, className })')).toBe(false)
    expect("h('strong', null, 'SoulMojitoX')".includes("h('strong', null, 'SoulMojito')")).toBe(false)
    // 2026-10-21 导航重做的六个新锚点同样要有近 miss 自证（组标签是组容器
    // 的「前缀 + 后缀」关系，特别容易误匹配，单列两条）。
    expect("className: 'dt-panel-searchX'".includes("className: 'dt-panel-search'")).toBe(false)
    expect("className: 'dt-panel-groupX'".includes("className: 'dt-panel-group'")).toBe(false)
    expect("className: 'dt-panel-group-labelX'".includes("className: 'dt-panel-group-label'")).toBe(false)
    expect("className: 'dt-panel-search-emptyX'".includes("className: 'dt-panel-search-empty'")).toBe(false)
    expect('dt-panel-modal-fullX{width'.includes('.dt-panel-modal-full{width')).toBe(false)
    expect("'data-dt-sectionX': item.id".includes("'data-dt-section': item.id")).toBe(false)
    expect("className: 'dt-panel-expandX'".includes("className: 'dt-panel-expand'")).toBe(false)
    expect('body.scrollTop = scrollMemory.current[section] ?? 1'.includes('body.scrollTop = scrollMemory.current[section] ?? 0')).toBe(false)
    expect("className: 'dt-footer-label' }, 'SoulMojitoX'".includes("className: 'dt-footer-label' }, 'SoulMojito'")).toBe(false)
    expect('h(SoulMojitoLogoX, { size: 40 })'.includes('h(SoulMojitoLogo, { size: 40 })')).toBe(false)
    expect("h('h3', null, 'DSH-SoulMojitoX')".includes("h('h3', null, 'DSH-SoulMojito')")).toBe(false)
    // A one-unit geometry drift in the asset is exactly what the sync case is
    // meant to catch, so the literal compare has to reject it.
    expect('M-58,-78 C-58,-20 -34,10 0,10 C34,10 58,-20 58,-79 Z'.includes('M-58,-78 C-58,-20 -34,10 0,10 C34,10 58,-20 58,-78 Z')).toBe(false)
  })
})

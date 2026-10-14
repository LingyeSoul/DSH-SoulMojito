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

  it('marker does not match near-miss samples (negative sample)', () => {
    expect('.dt-panel-navlistX{display:flex'.includes('.dt-panel-navlist{display:flex')).toBe(false)
    expect('.dt-panel-navX{display:flex'.includes('.dt-panel-nav{display:flex')).toBe(false)
    expect("h('div', { className: 'dt-panel-navlistX' },".includes("h('div', { className: 'dt-panel-navlist' },")).toBe(false)
    expect('justify-content:space-between;gap:12px;min-height:52px'.includes('justify-content:space-between;gap:12px;flex:none;min-height:52px')).toBe(false)
  })
})

/**
 * 侧边栏（TavernSidebar）分区高度契约（2026-10-16 用户反馈：「让侧边栏写卡
 * 工作台默认保持收起，并且酒馆区域和写卡工作台区域固定一定高度，并且支持滚动，
 * 防止会话、角色卡过多导致原始会话工作区被挤压到看不见」）。
 *
 * 背景：侧栏以宿主会话列表上方的一个 flex:none 插槽注入（
 * [data-dsh-soulmojito-sidebar-host]），整块高度由内容决定。角色卡 + 每个角色的
 * 聊天列表 + 分组 + 写卡工作台会话累计增高时，宿主原生会话树被推到视口外——两块
 * 内容都无法让位。改法是给两个分区各自一个固定高度上限的滚动容器
 * （.dt-sidebar-scroll + 分区类，max-height:min(320px,32vh) + overflow-y:auto），
 * 并把写卡工作台的默认折叠态置为收起（标题行的「+」钮折叠态仍可新建）。
 *
 * 为什么不写行为断言：client half 是宿主 ModuleLoader 的 IIFE，没有模块出口；
 * jsdom 也没有布局引擎（量不出「谁溢出、谁在滚」）。真实几何已在 headless
 * Chromium 里用宿主真实侧栏列（flex 列：本插件插槽 flex:none + 原生会话树
 * flex:1）与插件同一份注入 CSS 量过（插槽高度被上限夹住、分区容器 scrollHeight
 * > clientHeight、原生树保有可视区）。这里锁结构与规则文本；产物层面由 gates
 * frontend-runtime 的对应 marker（含负样本自证）对账。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

const TAVERN_WRAPPER = "h('div', { className: 'dt-sidebar-scroll dt-sidebar-tavern' }"
const WORKBENCH_WRAPPER = "h('div', { className: 'dt-sidebar-scroll dt-sidebar-workbench' }"
const SCROLL_RULE = '.dt-sidebar-scroll{display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);overflow-y:auto;overflow-x:hidden}'

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

describe('tavern sidebar section height contract', () => {
  it('wraps each section body in its own scroll container', () => {
    const tavernAt = source.indexOf(TAVERN_WRAPPER)
    const workbenchAt = source.indexOf(WORKBENCH_WRAPPER)
    expect(tavernAt).toBeGreaterThanOrEqual(0)
    expect(workbenchAt).toBeGreaterThan(tavernAt)
    // 酒馆容器的括号必须闭合在写卡工作台容器开始之前（两块内容不在同一个滚动区里，
    // 各自的固定上限独立生效）。
    expect(closingParenOf(source, tavernAt)).toBeLessThan(workbenchAt)
    // 原始形态（用户报告的那一版）：内容直接挂在 tavernOpen 三元的分片里，
    // 没有任何高度上限——回退到这个写法就是这次反馈的回归。
    expect(source).not.toContain('tavernOpen ? h(React.Fragment, null,')
  })

  it('keeps the whole tavern block inside the tavern scroll container', () => {
    const tavernAt = source.indexOf(TAVERN_WRAPPER)
    const tavernEnd = closingParenOf(source, tavernAt)
    // 角色列表（每角色一个可展开组）、空态、分组子标题与分组列表都必须在门控内。
    const charactersAt = source.indexOf('state.bootstrap.characters.map((character) => {', tavernAt)
    const groupsHeadingAt = source.indexOf("h('div', { className: 'dt-sidebar-heading dt-sidebar-subheading' },", tavernAt)
    expect(charactersAt).toBeGreaterThan(tavernAt)
    expect(groupsHeadingAt).toBeGreaterThan(charactersAt)
    expect(groupsHeadingAt).toBeLessThan(tavernEnd)
  })

  it('keeps the workbench list inside the workbench scroll container', () => {
    const workbenchAt = source.indexOf(WORKBENCH_WRAPPER)
    const workbenchEnd = closingParenOf(source, workbenchAt)
    const listAt = source.indexOf('h(WorkbenchList, { ctx, useSessions, currentSession })', workbenchAt)
    expect(listAt).toBeGreaterThan(workbenchAt)
    expect(listAt).toBeLessThan(workbenchEnd)
  })

  it('caps the section height and scrolls instead of growing', () => {
    // 唯一一条让「固定高度 + 滚动」成立的规则；max-height 是钳制增长的关键，
    // 只留 flex 布局或换成 overflow:visible 都会让插槽重新无限增高。
    expect(source).toContain(SCROLL_RULE)
    expect(source).not.toContain('[data-dsh-soulmojito-sidebar-host]{flex:none;margin:0 0 6px;padding-right:var(--dsh-session-list-edge-inset,8px);max-height')
  })

  it('collapses the workbench section by default', () => {
    // 默认态进 store 初值（页面重载回到这一份）；酒馆保持展开。
    expect(source).toContain('sidebarCollapsed: { tavern: false, workbench: true }')
    expect(source).not.toContain('sidebarCollapsed: { tavern: false, workbench: false }')
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect('.dt-sidebar-scrollX{display:flex'.includes('.dt-sidebar-scroll{display:flex')).toBe(false)
    expect('.dt-sidebar-scroll{display:flex;flex-direction:column;overflow:visible}'.includes(SCROLL_RULE)).toBe(false)
    expect("className: 'dt-sidebar-tavern-gone'".includes(TAVERN_WRAPPER)).toBe(false)
    expect("className: 'dt-sidebar-workbench-gone'".includes(WORKBENCH_WRAPPER)).toBe(false)
    expect('sidebarCollapsed: { tavern: false, workbench: false }'.includes('sidebarCollapsed: { tavern: false, workbench: true }')).toBe(false)
  })
})

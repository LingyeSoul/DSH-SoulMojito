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
 * 为什么不写布局断言：client half 是宿主 ModuleLoader 的 IIFE，没有模块出口；
 * jsdom 也没有布局引擎（量不出「谁溢出、谁在滚」）。真实几何已在 headless
 * Chromium 里用宿主真实侧栏列（flex 列：本插件插槽 flex:none + 原生会话树
 * flex:1）与插件同一份注入 CSS 量过（插槽高度被上限夹住、分区容器 scrollHeight
 * > clientHeight、原生树保有可视区）。这里锁结构与规则文本；产物层面由 gates
 * frontend-runtime 的对应 marker（含负样本自证）对账。
 *
 * 2026-11-13 collapse memory: the localStorage read/write helpers are pure
 * string/JSON functions with no DOM dependency, so they are extracted from the
 * shipped bundle and executed against a fake storage — valid, missing, partial,
 * wrong-typed, corrupt and throwing-storage payloads are all asserted here. The
 * mount-level wiring stays a source check.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

const TAVERN_WRAPPER = "h('div', { className: 'dt-sidebar-scroll dt-sidebar-tavern' }"
const WORKBENCH_WRAPPER = "h('div', { className: 'dt-sidebar-scroll dt-sidebar-workbench' }"
const SCROLL_RULE = '.dt-sidebar-scroll{display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);overflow-y:auto;overflow-x:hidden}'
const COLLAPSE_STORAGE_KEY = 'dsh-soulmojito:sidebar-collapsed'

interface CollapseState { tavern: boolean; workbench: boolean }
interface FakeStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface CollapseHelpers {
  readSidebarCollapsed(): CollapseState
  writeSidebarCollapsed(value: CollapseState): CollapseState
}
interface FakeLocalStorage extends FakeStorage { values: Map<string, string> }

function fakeStorage(seed: string | null): FakeLocalStorage {
  const values = new Map<string, string>()
  if (seed !== null) values.set(COLLAPSE_STORAGE_KEY, seed)
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

/** Extracts the shipped storage helpers (key/default/normalize/read/write). */
function collapseHelpers(storage: FakeStorage, warn: (message: string, error: unknown) => void): CollapseHelpers {
  const start = source.indexOf('const SIDEBAR_COLLAPSED_STORAGE_KEY')
  const writeAt = source.indexOf('function writeSidebarCollapsed(value) {', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(writeAt).toBeGreaterThan(start)
  const writeEnd = closingBraceOf(source, source.indexOf('{', writeAt))
  expect(writeEnd).toBeGreaterThan(writeAt)
  const block = source.slice(start, writeEnd + 1)
  return new Function('window', 'console', `${block}\nreturn { readSidebarCollapsed, writeSidebarCollapsed }`)({ localStorage: storage }, { warn })
}

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

/** `{...}` 块的右花括号位置（用于截取函数体）。 */
function closingBraceOf(text: string, braceAt: number): number {
  let depth = 0
  for (let index = braceAt; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
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

  it('seeds the store from the persisted collapse state, defaulting the workbench to collapsed', () => {
    // 初值从 localStorage 读（2026-11-13 用户需求：记忆折叠状态）；酒馆默认
    // 展开、写卡工作台默认收起，作为没有存量值时的那一份。
    expect(source).toContain('const SIDEBAR_COLLAPSED_STORAGE_KEY = \'dsh-soulmojito:sidebar-collapsed\'')
    expect(source).toContain('const SIDEBAR_COLLAPSED_DEFAULT = { tavern: false, workbench: true }')
    expect(source).toContain('sidebarCollapsed: readSidebarCollapsed(),')
    expect(source).not.toContain('sidebarCollapsed: { tavern: false, workbench: true },')
  })

  it('writes every toggle through the same normalizer', () => {
    // 折叠钮是唯一写入口：写前过 normalize，坏掉的存量 payload 会被完整合法
    // 对象覆盖；两个挂载点仍共享 store 里的同一份值。
    expect(source).toContain('const next = { ...state.sidebarCollapsed, [section]: !state.sidebarCollapsed[section] }')
    expect(source).toContain('update({ sidebarCollapsed: writeSidebarCollapsed(next) })')
    expect(source).toContain('window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(normalized))')
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect('.dt-sidebar-scrollX{display:flex'.includes('.dt-sidebar-scroll{display:flex')).toBe(false)
    expect('.dt-sidebar-scroll{display:flex;flex-direction:column;overflow:visible}'.includes(SCROLL_RULE)).toBe(false)
    expect("className: 'dt-sidebar-tavern-gone'".includes(TAVERN_WRAPPER)).toBe(false)
    expect("className: 'dt-sidebar-workbench-gone'".includes(WORKBENCH_WRAPPER)).toBe(false)
    expect('sidebarCollapsed: { tavern: false, workbench: true },'.includes('sidebarCollapsed: readSidebarCollapsed(),')).toBe(false)
  })
})

describe('sidebar collapse memory', () => {
  it('uses the shipped defaults when nothing is stored', () => {
    const helpers = collapseHelpers(fakeStorage(null), () => {})
    expect(helpers.readSidebarCollapsed()).toEqual({ tavern: false, workbench: true })
  })

  it('keeps valid fields and fills the missing ones from the defaults', () => {
    const helpers = collapseHelpers(fakeStorage('{"tavern":true}'), () => {})
    expect(helpers.readSidebarCollapsed()).toEqual({ tavern: true, workbench: true })
  })

  it('rejects wrong-typed and corrupt payloads with a visible warning', () => {
    const wrongTypeWarnings: string[] = []
    const wrongType = collapseHelpers(fakeStorage('{"tavern":"true","workbench":0}'), (message) => { wrongTypeWarnings.push(message) })
    expect(wrongType.readSidebarCollapsed()).toEqual({ tavern: false, workbench: true })
    expect(wrongTypeWarnings).toHaveLength(0)

    const corruptWarnings: string[] = []
    const corrupt = collapseHelpers(fakeStorage('{'), (message) => { corruptWarnings.push(message) })
    expect(corrupt.readSidebarCollapsed()).toEqual({ tavern: false, workbench: true })
    expect(corruptWarnings).toHaveLength(1)
  })

  it('round-trips a toggle and keeps working when the storage rejects writes', () => {
    const storage = fakeStorage(null)
    const helpers = collapseHelpers(storage, () => {})
    expect(helpers.writeSidebarCollapsed({ tavern: true, workbench: false })).toEqual({ tavern: true, workbench: false })
    expect(JSON.parse(storage.values.get(COLLAPSE_STORAGE_KEY) ?? '')).toEqual({ tavern: true, workbench: false })
    expect(helpers.readSidebarCollapsed()).toEqual({ tavern: true, workbench: false })

    const warnings: string[] = []
    const blocked = collapseHelpers({
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
    }, (message) => { warnings.push(message) })
    expect(blocked.readSidebarCollapsed()).toEqual({ tavern: false, workbench: true })
    expect(blocked.writeSidebarCollapsed({ tavern: false, workbench: false })).toEqual({ tavern: false, workbench: false })
    expect(warnings).toHaveLength(2)
  })
})

/**
 * 聊天导入入口契约（2026-11-13 审查收口）：宿主会话列表上方的侧栏保持窄行，
 * 不放工具行；导入按钮只出现在管理面板「聊天」分区（同一份 TavernSidebar 的
 * 另一个挂载点），经 allowChatImport → ChatList.allowImport 门控。锚点用
 * 分发产物里的源码标记（client-src 逐字拼接），与上方分区高度契约同一纪律。
 */
describe('panel-only chat import entry', () => {
  const PANEL_MOUNT = "h(TavernSidebar, { ctx: host.ctx, useSessions: host.useSessions, allowChatImport: true })"
  const HOST_MOUNT = 'createPortal(h(TavernSidebar, { ctx: PanelHost.context, useSessions }), host)'
  const IMPORT_ROW = "allowImport && !group ? h('div', { className: 'dt-sidebar-chat-tools' }"
  const CHAT_TOOLS_RULE = '.dt-sidebar-chat-tools{display:flex;align-items:center;gap:6px;padding:0 0 6px;min-width:0}'

  it('gates the import row behind the panel-only flag', () => {
    expect(source).toContain(PANEL_MOUNT)
    // 宿主侧栏挂载点不得携带该标志（否则工具行回到宿主会话列表，行宽再次溢出）。
    expect(source).toContain(HOST_MOUNT)
    expect(source).not.toContain('h(TavernSidebar, { ctx: PanelHost.context, useSessions, allowChatImport')
    // 工具行只能以条件表达式出现：无条件渲染就是这次回归；组列表也不提供
    // （import/chat 要求同名角色卡存在）。
    expect(source).toContain(IMPORT_ROW)
    expect(source).toContain('allowImport && !group ?')
    expect(source.match(/className: 'dt-sidebar-chat-tools'/g)).toHaveLength(1)
    expect(source).toContain(CHAT_TOOLS_RULE)
  })

  it('threads the flag through both per-character and group chat lists', () => {
    expect(source.match(/allowImport: allowChatImport/g)).toHaveLength(2)
    expect(source).toContain('function ChatList({ ctx, character, currentSession, group = false, allowImport })')
  })

  it('imports the chosen .jsonl into the character the list belongs to', () => {
    expect(source).toContain("accept: '.jsonl,application/jsonl,application/json',")
    expect(source).toContain("api('import/chat', {")
    expect(source).toContain('body: JSON.stringify({ character, name, content }),')
    expect(source).toContain('}).then(() => loadChatList(character, true)).catch((cause) => {')
    // 失败必须落到侧栏错误行，且带本地化前缀，不能静默。
    const localizedImportError = "setError(`${t('nav.importChatFailed')}: "
    expect(source.split(localizedImportError)).toHaveLength(3)
    expect(source).toContain('reader.onerror = () =>')
  })

  it('marker does not match the unconditional form (negative sample)', () => {
    expect("h('div', { className: 'dt-sidebar-chat-tools' }".includes(IMPORT_ROW)).toBe(false)
    expect("allowImportX ? h('div', { className: 'dt-sidebar-chat-tools' }".includes(IMPORT_ROW)).toBe(false)
  })
})

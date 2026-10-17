/**
 * 游戏分区客户端源检查（提案 0018 §4.3，P1；2026-10-14 修订补 game_wait 交互
 * 模型的对局面）：分区注册（mods 之前）、zh/en 全键镜像（占位符一致性由
 * client-vm-mount gate 兜底）、桥协议双消息与 games/* 调用字面量、下行载荷
 * 形状（与 src/games/view.ts 注入的桥脚本逐字段对齐：{type, token, session,
 * view}）、对局面与 MVU 状态同位（ST 内联顺序 + AgentTavern 右栏 tab 注册 +
 * 开局自动展开 watcher）。follow prompt-viewer.spec.ts 的 main.js source check
 * 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

const GAMES_I18N_KEYS = [
  'panel.section.games',
  'games.hint',
  'games.needBinding',
  'games.empty',
  'games.start',
  'games.starting',
  'games.broken',
  'games.source.builtin',
  'games.source.imported',
  'games.source.mod',
  'games.tabTitle',
  'games.guide.description',
  'games.boardEmpty',
  'games.openPanel',
  'games.sessionsTitle',
  'games.sessionsEmpty',
  'games.turnYou',
  'games.turnYouHint',
  'games.waitAi',
  'games.turnAiNow',
  'games.finished',
  'games.winner',
  'games.ownerHuman',
  'games.ownerAgent',
  'games.orphaned',
  'games.orphanedHint',
  'games.resign',
  'games.resignConfirm',
  'games.import.title',
  'games.import.hint',
  'games.import.file',
  'games.import.placeholder',
  'games.import.button',
  'games.import.installing',
  'games.import.done',
  'games.import.failed',
  'games.import.force',
  'games.import.tooLarge',
]

describe('client games panel (main.js source check)', () => {
  it('registers the games panel section before the mods section', () => {
    const gamesAt = source.indexOf("{ id: 'games',")
    const modsAt = source.indexOf("{ id: 'mods',")
    expect(gamesAt).toBeGreaterThanOrEqual(0)
    expect(modsAt).toBeGreaterThan(gamesAt)
  })

  it('carries every games locale key in both the zh and en tables', () => {
    for (const key of GAMES_I18N_KEYS) {
      // 键定义形态（带冒号）只在 zh/en 两张表出现；t('...') 引用不带冒号。
      expect(source.split(`'${key}':`).length - 1, key).toBe(2)
    }
  })

  it('keeps the winner placeholder set identical in zh and en', () => {
    expect(source).toContain("'games.winner': '胜方：{role}（{owner}）'")
    expect(source).toContain("'games.winner': 'Winner: {role} ({owner})'")
  })

  it('speaks the bridge protocol and calls the games HTTP routes', () => {
    for (const marker of [
      'dsh-soulmojito:game-state',
      'dsh-soulmojito:game-action',
      'games/list',
      'games/state/',
      'games/revision',
      'games/start',
      'games/action/',
      'function GameSurface({ session',
      'function GamesPanel({ useSessions })',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('mounts the inline game board next to the MVU status card in TavernView', () => {
    // ST 架构：对局面与 MVU 状态同位（MVU 卡之后、剧本进度卡之前），无对局
    // 返回 null 不占位（2026-10-14 修订）。
    const mvuAt = source.indexOf('h(TavernMvuStatus, { sessionId }),')
    const boardAt = source.indexOf('h(TavernGameBoard, { sessionId }),')
    const scriptAt = source.indexOf('h(TavernScriptProgress, { sessionId }),')
    expect(mvuAt).toBeGreaterThanOrEqual(0)
    expect(boardAt).toBeGreaterThan(mvuAt)
    expect(scriptAt).toBeGreaterThan(boardAt)
    expect(source).toContain('function TavernGameBoard({ sessionId, sidebar = false })')
    expect(source).toContain('function useChatGameSessions(character, chatId)')
  })

  it('owns the initial load inside the shared hook (sidebar tab renders empty without it)', () => {
    // 2026-10-14 回归锁：挂载加载必须住在 useChatGameSessions 里——早期版本把它
    // 留在 GamesPanel，右栏 tab/内联对局面经 hook 消费时从未拉取、恒渲染 null。
    const hookAt = source.indexOf('function useChatGameSessions(character, chatId)')
    const boardAt = source.indexOf('function TavernGameBoard(')
    const effect = source.indexOf('useEffect(() => { void loadList() }, [loadList])', hookAt)
    expect(hookAt).toBeGreaterThanOrEqual(0)
    expect(effect).toBeGreaterThan(hookAt)
    expect(effect).toBeLessThan(boardAt)
    // 无活跃会话也不能饿死：轮询两档（守望 5s / 对局中 1s），空档位不停摆。
    expect(source).toContain('activeKey === \'\' ? SESSION_PANEL_POLL_MS : GAMES_REVISION_POLL_MS')
    // 侧边栏空态：用户主动打开的 tab 给指引而不是空白。
    expect(source).toContain("t('games.boardEmpty')")
  })

  it('reads the revision baseline strictly before the session data (no swallowed-move window)', () => {
    // 2026-10-14 二次修订回归锁（侧边栏自动刷新 RCA）：基线读取必须 await 完成后
    // 才发起 list——任何「数据读取之后」的落子必然改变水位、必被轮询发现；
    // 并发发起会让基线反映到比已渲染数据更新的状态而吞掉那一手。
    const hookAt = source.indexOf('function useChatGameSessions(character, chatId)')
    const baselineAt = source.indexOf(".then(() => api(`games/list${query}`))", hookAt)
    const revisionChainAt = source.indexOf("return api('games/revision')", hookAt)
    expect(revisionChainAt).toBeGreaterThan(hookAt)
    expect(baselineAt).toBeGreaterThan(revisionChainAt)
  })

  it('exposes a header entry next to the MVU button that opens the games sidebar tab', () => {
    // 2026-10-14 二次修订：AgentTavern 标题栏与 MVU 同位同款的游戏入口——右栏
    // tab 优先，旧宿主/开 tab 失败回落设置面板游戏分区。
    expect(source).toContain('const openGamesSurface = () => {')
    expect(source).toContain('openPanel(\'games\')')
    const mvuSlotAt = source.indexOf("className: 'dt-mvu-slot'")
    const gamesButtonAt = source.indexOf('onClick: openGamesSurface')
    const guidesAt = source.indexOf("title: t('view.openGuides')")
    expect(gamesButtonAt).toBeGreaterThan(mvuSlotAt)
    expect(guidesAt).toBeGreaterThan(gamesButtonAt)
    // 空态卡：图标 + 标题 + 指引 + 打开面板按钮（不再是纯文本一行）。
    expect(source).toContain('dt-game-board-empty')
  })

  it('registers the game board as a right-sidebar tab (AgentTavern, MVU tab sibling) with auto-open', () => {
    for (const marker of [
      "const GAMES_TAB_ID = 'dsh-soulmojito/games'",
      "const GAMES_TAB_KIND = 'tavern-games'",
      'function TavernGamesSidebarTab({ sessionId })',
      'sidebarRight.openTab(GAMES_TAB_KIND)',
    ]) {
      expect(source).toContain(marker)
    }
    // 自动展开 watcher 只作用于 agent-tavern 绑定（ST 走内联对局面）。
    expect(source).toContain("architecture !== 'agent-tavern' || binding.group === true")
  })

  it('drops the legacy "send any message to prompt the AI" copy (game_wait revision)', () => {
    expect(source).not.toContain('send any message to let it move')
    expect(source).not.toContain('发送任意消息让它落子')
    expect(source).not.toContain('发送任意消息唤起')
  })

  it('marks every game surface with the hand-drawn gamepad icon (2026-10-14 user request)', () => {
    // 需求源：用户实况——游戏分区沿用「总览」的 sparkle，看不出游戏语义；宿主
    // primitives 0.2.0-rc.2 没有游戏语义的图标（IconPlay/IconGoal 都不是手柄），
    // 故自绘 IconGamepadOutline16。四处游戏面必须同款：面板分区 + 右栏 tab guide
    // + 标题栏入口 + 空态卡；计数锁 1 处定义 + 4 处使用，新增游戏面漏换时翻红。
    expect(source.split('IconGamepadOutline16').length - 1).toBe(5)
    for (const marker of [
      'function IconGamepadOutline16({ size = 16, className })',
      "{ id: 'games', icon: IconGamepadOutline16,",
      'icon: IconGamepadOutline16,',
      '}, h(IconGamepadOutline16)),',
      "h('div', { className: 'dt-game-board-empty-icon' }, h(IconGamepadOutline16, { size: 22 })),",
    ]) {
      expect(source).toContain(marker)
    }
    // 总览继续用 sparkle：两个分区不能共用同一图标（游戏图标的意义就是不与总览混）。
    expect(source).toContain("{ id: 'overview', icon: IconSparkle16,")
    // 负样本：近邻名字不得命中组件标记。
    expect('function IconGamepadOutline15('.includes('function IconGamepadOutline16(')).toBe(false)
    expect("h(IconGamepadOutline16X, { size: 22 })".includes('h(IconGamepadOutline16, { size: 22 })')).toBe(false)
  })

  it('downlink payload carries {type, token, session, view} verbatim for the injected bridge script', () => {
    expect(source).toContain('{ type: GAME_STATE_MESSAGE, token, session: payload.session, view: payload.view }')
  })

  it('renders the resign control on the game surface and keeps the final board on finished games (2026-10-14 user requests)', () => {
    for (const marker of [
      // 投降按钮：走与棋子同一条上行路径（postActionPost→POST games/action），
      // 两步点击确认（armed 样式类 + 4s 复位）、「禁用投降」时整体不渲染。
      'dt-game-actions',
      'dt-game-resign-armed',
      "postActionRef.current({ type: 'resign' })",
      "t('games.resignConfirm')",
      "t('games.resign')",
      'store.bootstrap.state.gamesDisableResign !== true',
      // 面板「游戏」分区开关（补丁路由即时生效）。
      'patchState({ gamesDisableResign: event.target.checked })',
      // 终局保留盘面：见证集判据（本挂载见证过的已终局会话也补拉快照）。
      'witnessed[session.id] !== undefined',
    ]) {
      expect(source).toContain(marker)
    }
    // 终局盘面两处同款：内联对局面（TavernGameBoard）与面板会话卡（GamesPanel）。
    expect(source.split('h(GameSurface, { key: session.id, session: live?.session || session, view: live?.view, onOutcome: handleOutcome })').length - 1).toBe(2)
    // 「禁用投降」开关的 zh/en 双表（占位符无关，键齐备即可）。
    expect(source.split("'settings.gamesDisableResign':").length - 1).toBe(2)
    // 负样本：近邻名字不得命中组件标记。
    expect('dt-game-act'.includes('dt-game-actions')).toBe(false)
    expect("postActionRef.current({ kind: 'resign' })".includes("postActionRef.current({ type: 'resign' })")).toBe(false)
    expect('witnessedGone[session.id] !== undefined'.includes('witnessed[session.id] !== undefined')).toBe(false)
  })

  it('exposes the game package import entry: zip upload + git install (2026-10-17)', () => {
    for (const marker of [
      'GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024',
      'const runGameImport = (source, busyKey) =>',
      'const importGameZip = (file) =>',
      'const installGameFromGit = () =>',
      "accept: '.zip,application/zip'",
      "'data-dsh-soulmojito-surface': 'games-import'",
      "api('games/install'",
      'zipBase64',
      "t('games.import.tooLarge'",
    ]) {
      expect(source).toContain(marker)
    }
    // 导入成功后重拉清单（新游戏即时出现在上方列表）。
    const importAt = source.indexOf('const runGameImport = (source, busyKey) =>')
    expect(source.indexOf('return loadList()', importAt)).toBeGreaterThan(importAt)
    // 顺带修复（2026-10-17）：GamesPanel 开局路径引用 loadList，此前解构漏项会在
    // 点「开局」时抛 ReferenceError（loadList is not defined）——引用与解构同锁。
    expect(source).toContain('const { hasBinding, games, sessions, sessionStates, listError, loadList, handleOutcome, turnOwner } = useChatGameSessions(character, chatId)')
    // 近邻负样本：不得以子串形态命中。
    expect('games/gone-import'.includes('games/install')).toBe(false)
    expect('zip-gone-base64'.includes('zipBase64')).toBe(false)
    expect('GAMES_ZIP_MAX_BYTES = 50 * 1024 * 1024'.includes('GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024')).toBe(false)
  })

  it('polls the games revision watermark at the 1s cadence', () => {
    expect(source).toContain('GAMES_REVISION_POLL_MS = 1000')
    expect(source).toContain("api('games/revision')")
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect("{ id: 'gamesX',".includes("{ id: 'games',")).toBe(false)
    expect("'panel.section.gamesX':".includes("'panel.section.games':")).toBe(false)
    expect('games/rev-gone'.includes('games/revision')).toBe(false)
    expect('games/gone-list'.includes('games/list')).toBe(false)
    expect("'tavern-gamesX'".includes("'tavern-games'")).toBe(false)
    expect('function TavernGameBoardX('.includes('function TavernGameBoard(')).toBe(false)
  })
})

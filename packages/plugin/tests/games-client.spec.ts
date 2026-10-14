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
      'dsh-tavern:game-state',
      'dsh-tavern:game-action',
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
      "const GAMES_TAB_ID = 'dsh-tavern/games'",
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

  it('downlink payload carries {type, token, session, view} verbatim for the injected bridge script', () => {
    expect(source).toContain('{ type: GAME_STATE_MESSAGE, token, session: payload.session, view: payload.view }')
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

/**
 * 示例 Mod（提案 0018 P3 交付物）：Mod 游戏注册——三局两胜猜拳。
 *
 * 演示的 api.games.register 面（docs/mods/mod-api.md「游戏注册」节）：
 * - manifest `games: ["dsh-tavern.rps.gesture"]` 声明（未声明即拒）+ id 带
 *   `<modId>.` 前缀——宿主注册期双纪律（onButton + 工具注册的同款收口）；
 * - engine 是进程内纯函数对象（提案 §3.2 引擎契约：JSON-safe state、确定性、
 *   非法动作中文抛错、legalActions 有界建议集）——与导入包的 engine.mjs 同形，
 *   差别只在「随 Mod 代码直接持有」而非动态 import；
 * - view 是内联 HTML 字符串（Mod 无静态文件服务，UI_PAGE 常量内联纪律，
 *   mood-tracker 同款）；桥协议两条消息（dsh-tavern:game-state 下行 /
 *   dsh-tavern:game-action 上行）与 src/games/view.ts 注入脚本对齐
 *   （桥写法照抄 examples/games/dsh-tavern.gomoku/view.html）；
 * - 不声明 panel：游戏不出现在 Mod 分区，而是在面板「游戏」分区出现
 *   （source 徽标 mod）。
 *
 * 规则建模（回合制，提案 §3.4 动作语言）：first（甲方，人类默认先手）出拳
 * {type:'throw', gesture} → second（乙方）出拳 → 引擎判定本局胜负计入比分 →
 * 平局重掷该局；先取 2 局胜者终局。引擎纯函数无随机（确定性是导入烟测的
 * 硬约束）——「猜」的随机性全部来自双方（人类与 Agent）的出拳选择。
 */

const GESTURES = ['rock', 'paper', 'scissors']
const GESTURE_NAMES = { rock: '石头', paper: '布', scissors: '剪刀' }
const ROLE_NAMES = { first: '甲方', second: '乙方' }
const WINS_NEEDED = 2

/** 与 mod.json/games 及注册参数完全一致的冗余清单（运行时以 meta 为准）。 */
const META = {
  id: 'dsh-tavern.rps.gesture',
  name: '猜拳',
  version: '1.0.0',
  players: { min: 2, max: 2, roles: ['first', 'second'] },
  turnBased: true,
  actionVocabulary:
    "出拳 {type:'throw', gesture:'rock'|'paper'|'scissors'}（石头/布/剪刀）；三局两胜，平局重掷该局；认输 {type:'resign'} 由运行时统一处理",
}

function beats(a, b) {
  return (a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper')
}

/** 深拷贝 state（history 逐条、pending/wins 逐字段），绝不共享可变结构。 */
function cloneState(state) {
  return {
    turn: state.turn,
    round: state.round,
    wins: { first: state.wins.first, second: state.wins.second },
    pending: { first: state.pending.first, second: state.pending.second },
    finished: state.finished,
    winner: state.winner,
    history: state.history.map((entry) => ({ round: entry.round, first: entry.first, second: entry.second, winner: entry.winner })),
  }
}

const RPS_ENGINE = {
  meta: META,

  /** 开局：第 1 局，甲方先出。options（含 seed）接受但忽略——判定无随机性。 */
  createGame(_options) {
    return {
      state: {
        turn: 'first',
        round: 1,
        wins: { first: 0, second: 0 },
        pending: { first: null, second: null },
        finished: false,
        winner: null,
        history: [],
      },
    }
  },

  /** 建议集恒为三个拳（天然有界）；终局返回空数组。 */
  legalActions(state) {
    if (state.finished) return []
    return GESTURES.map((gesture) => ({ type: 'throw', gesture }))
  },

  /**
   * 出拳并推进局面。校验顺序：动作形状 → type → 未终局 → 行棋方 → gesture；
   * 任一不过抛 Error（中文报错）。绝不改入参 state——深拷贝出新态。
   */
  applyAction(state, action, actor) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) throw new Error('动作必须是 JSON 对象')
    if (typeof action.type !== 'string' || action.type === '') throw new Error('动作缺少 type 字段')
    if (action.type !== 'throw') {
      throw new Error(`不支持的动作类型「${action.type}」：本引擎只实现 throw（resign 由运行时统一处理）`)
    }
    if (state.finished) throw new Error('对局已结束，不能再出拳')
    if (actor !== 'first' && actor !== 'second') throw new Error(`未知角色「${String(actor)}」：本游戏角色为 first/second`)
    if (actor !== state.turn) throw new Error(`现在轮到${ROLE_NAMES[state.turn]}出拳，${String(actor)} 不能出拳`)
    if (!GESTURES.includes(action.gesture)) {
      throw new Error(`gesture 必须是 ${GESTURES.join('/')} 之一，收到 ${String(action.gesture)}`)
    }

    const next = cloneState(state)
    const round = state.round
    if (actor === 'first') {
      next.pending.first = action.gesture
      next.turn = 'second'
      const summary = `第${round}局：${ROLE_NAMES.first}出了${GESTURE_NAMES[action.gesture]}，等待${ROLE_NAMES.second}出拳`
      return { state: next, events: [summary], finished: false, winner: null, summary }
    }

    // 乙方出拳：本局双拳齐备，判定（turn 纪律保证甲方已出）。
    const firstGesture = state.pending.first
    const secondGesture = action.gesture
    next.pending.second = secondGesture
    const firstLabel = `${ROLE_NAMES.first}出${GESTURE_NAMES[firstGesture]}`
    const secondLabel = `${ROLE_NAMES.second}出${GESTURE_NAMES[secondGesture]}`
    if (firstGesture === secondGesture) {
      // 平局：双拳清空，本局重掷（甲方重新先出，局数不变）。
      next.pending = { first: null, second: null }
      next.turn = 'first'
      const summary = `第${round}局：${firstLabel}，${secondLabel}——平局，重掷本局`
      return { state: next, events: [summary], finished: false, winner: null, summary }
    }
    const roundWinner = beats(firstGesture, secondGesture) ? 'first' : 'second'
    next.pending = { first: null, second: null }
    next.turn = 'first'
    next.wins[roundWinner] += 1
    next.history.push({ round, first: firstGesture, second: secondGesture, winner: roundWinner })
    const score = `${next.wins.first}:${next.wins.second}`
    if (next.wins[roundWinner] >= WINS_NEEDED) {
      next.finished = true
      next.winner = roundWinner
      const ending = `${firstLabel}，${secondLabel}——${ROLE_NAMES[roundWinner]}拿下第${round}局，${score} 结束对局，${ROLE_NAMES[roundWinner]}获胜`
      return { state: next, events: [ending], finished: true, winner: roundWinner, summary: ending }
    }
    next.round = round + 1
    const summary = `${firstLabel}，${secondLabel}——${ROLE_NAMES[roundWinner]}拿下第${round}局（比分 ${score}）`
    return { state: next, events: [summary], finished: false, winner: null, summary }
  },

  /**
   * 人类可读的一手描述。乙方出拳时 state 里已有甲方的一拳、动作里带着乙方的一拳，
   * 可合成整局叙述（如「甲方出石头，乙方出剪刀，甲方拿下第 2 局」）；其余单拳直述。
   */
  describe(state, actor, action) {
    if (action !== null && typeof action === 'object' && !Array.isArray(action) && action.type === 'throw' && GESTURES.includes(action.gesture)) {
      if (actor === 'second' && state.pending.first) {
        const firstGesture = state.pending.first
        const secondGesture = action.gesture
        if (firstGesture === secondGesture) {
          return `第${state.round}局：双方都出${GESTURE_NAMES[firstGesture]}，平局重掷`
        }
        const roundWinner = beats(firstGesture, secondGesture) ? 'first' : 'second'
        return `${ROLE_NAMES.first}出${GESTURE_NAMES[firstGesture]}，${ROLE_NAMES.second}出${GESTURE_NAMES[secondGesture]}，${ROLE_NAMES[roundWinner]}拿下第${state.round}局`
      }
      return `${ROLE_NAMES[actor]}出了${GESTURE_NAMES[action.gesture]}`
    }
    return `${String(actor)}的动作未被本引擎识别`
  },
}

const UI_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>猜拳 · dsh-tavern 游戏桥</title>
<style>
  /* 自包含视图（提案 0018 §3.3）：零外部资源，CSP connect-src 'none' 纪律。
     桥协议只有两条消息：下行 dsh-tavern:game-state / 上行 dsh-tavern:game-action。 */
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #171a20; color: #e8e4da;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
    min-height: 100vh; padding: 12px 12px 16px;
  }
  .wrap { width: 100%; max-width: 420px; position: relative; }
  header { display: flex; justify-content: space-between; align-items: baseline; font-size: 14px; padding-bottom: 8px; }
  .session-id { color: #9a948a; font-size: 11px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #banner { border: 1px solid #3a3f4a; background: #22262e; border-radius: 8px; padding: 8px 12px; font-size: 13px; text-align: center; margin-bottom: 10px; }
  #banner.wait { background: #20242c; border-color: #4a5568; color: #b9c4d8; }
  #banner.finished { background: #2a2416; border-color: #8a6d2f; color: #e7cf96; }
  .scoreboard { display: flex; align-items: center; justify-content: center; gap: 22px; padding: 8px 0 2px; }
  .side { text-align: center; min-width: 90px; }
  .side .who { font-size: 12px; color: #9a948a; }
  .side .score { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .side .mark { font-size: 11px; color: #6f7fa8; }
  .colon { font-size: 22px; color: #5d6675; align-self: center; padding-bottom: 6px; }
  #round { font-size: 12px; color: #9a948a; text-align: center; padding-bottom: 6px; }
  #throws { display: flex; gap: 10px; justify-content: center; padding: 6px 0 2px; }
  .throw {
    flex: 1; max-width: 112px; padding: 10px 0 8px; border-radius: 10px;
    border: 1px solid #3a3f4a; background: #22262e; color: #e8e4da;
    font: inherit; font-size: 14px; user-select: none; text-align: center; cursor: default;
  }
  .throw .emoji { display: block; font-size: 26px; margin-bottom: 2px; }
  .throw.playable { cursor: pointer; }
  .throw.playable:hover { background: #2a3140; border-color: #4a5568; }
  .throw[disabled] { opacity: .45; }
  #history { margin-top: 10px; font-size: 12px; color: #a8a294; line-height: 1.7; }
  #history .row { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dashed #2c313b; padding: 2px 0; }
  #hint { margin-top: 8px; font-size: 12px; color: #8d887e; text-align: center; }
  .overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 6px;
    background: rgba(14, 15, 18, .82); border-radius: 8px;
  }
  .overlay.hidden { display: none; }
  .overlay .result { font-size: 24px; font-weight: 700; color: #f0e6c8; letter-spacing: 2px; }
  .overlay .sub { font-size: 13px; color: #c9c0a8; }
</style>
</head>
<body>
<div class="wrap">
  <header><span>猜拳 · 三局两胜</span><span class="session-id" id="session-id"></span></header>
  <div id="banner" class="wait">等待对局…</div>
  <div class="scoreboard">
    <div class="side"><div class="who">甲方</div><div class="score" id="score-first">0</div><div class="mark" id="mark-first"></div></div>
    <div class="colon">:</div>
    <div class="side"><div class="who">乙方</div><div class="score" id="score-second">0</div><div class="mark" id="mark-second"></div></div>
  </div>
  <div id="round"></div>
  <div id="throws">
    <button type="button" class="throw" data-gesture="rock"><span class="emoji">✊</span>石头</button>
    <button type="button" class="throw" data-gesture="paper"><span class="emoji">✋</span>布</button>
    <button type="button" class="throw" data-gesture="scissors"><span class="emoji">✌</span>剪刀</button>
  </div>
  <div id="history"></div>
  <div id="hint"></div>
  <div class="overlay hidden" id="overlay"><div class="result" id="overlay-result"></div><div class="sub">对局结束</div></div>
</div>
<script>
  'use strict'
  // ===== 桥协议（提案 0018 §3.3，照抄 gomoku view.html 的桥写法）=====
  // token 从 location.search 自读；监听下行 dsh-tavern:game-state（token 对账），
  // 人类回合点击拳钮上行 dsh-tavern:game-action——合法性由 Node 侧引擎终审。
  var GESTURE_NAMES = { rock: '石头', paper: '布', scissors: '剪刀' }
  var ROLE_NAMES = { first: '甲方', second: '乙方' }
  var params = new URLSearchParams(window.location.search)
  var TOKEN = params.get('token')
  var sessionId = params.get('session') || params.get('sid') || ''
  var current = null // 最近一次 game-state：{ view, session }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type !== 'dsh-tavern:game-state' || data.token !== TOKEN) return
    current = { view: data.view && typeof data.view === 'object' ? data.view : {}, session: data.session || null }
    if (data.session && data.session.id) sessionId = data.session.id
    render()
  })

  function ownerOf(session, role) {
    if (!session || !Array.isArray(session.players)) return null
    for (var i = 0; i < session.players.length; i++) {
      if (session.players[i] && session.players[i].role === role) return session.players[i].owner
    }
    return null
  }

  // 无 token（浏览器直接打开）时的静态演示局面：1:1，轮甲方（人类）。
  var PREVIEW_VIEW = {
    state: { turn: 'first', round: 3, wins: { first: 1, second: 1 },
      pending: { first: null, second: null }, finished: false, winner: null,
      history: [
        { round: 1, first: 'rock', second: 'scissors', winner: 'first' },
        { round: 2, first: 'rock', second: 'paper', winner: 'second' },
      ] },
    legal: [{ type: 'throw', gesture: 'rock' }, { type: 'throw', gesture: 'paper' }, { type: 'throw', gesture: 'scissors' }],
    finished: false,
    summary: '静态演示局面（无 token）',
  }
  var PREVIEW_SESSION = {
    players: [
      { role: 'first', owner: 'human' },
      { role: 'second', owner: 'agent' },
    ],
  }

  function active() {
    if (current && current.view.state) return { view: current.view, session: current.session || PREVIEW_SESSION, live: true }
    if (TOKEN !== null) return { view: { state: null, legal: [] }, session: PREVIEW_SESSION, live: true }
    return { view: PREVIEW_VIEW, session: PREVIEW_SESSION, live: false }
  }

  var bannerEl = document.getElementById('banner')
  var roundEl = document.getElementById('round')
  var historyEl = document.getElementById('history')
  var hintEl = document.getElementById('hint')
  var overlayEl = document.getElementById('overlay')

  function endText(state) {
    if (state.winner === 'first' || state.winner === 'second') return ROLE_NAMES[state.winner] + '获胜'
    return '平局'
  }

  function render() {
    var act = active()
    var state = act.view.state
    var humanTurn = false

    if (!state) {
      bannerEl.className = 'wait'
      bannerEl.textContent = '等待对局状态…'
    } else if (state.finished) {
      bannerEl.className = 'finished'
      bannerEl.textContent = '对局结束：' + endText(state) + (act.view.summary ? ' · ' + act.view.summary : '')
    } else {
      var owner = ownerOf(act.session, state.turn)
      humanTurn = owner === 'human'
      bannerEl.className = 'wait'
      bannerEl.textContent = '第' + state.round + '局 · 轮到' + ROLE_NAMES[state.turn]
        + (state.pending.first ? '（已出拳，等' + ROLE_NAMES.second + '）' : '')
        + (owner === 'agent' ? ' · 等待 AI 出拳…发条消息让它落拳' : '')
    }

    document.getElementById('session-id').textContent = act.live && sessionId ? '对局 ' + sessionId : (act.live ? '等待会话…' : '预览模式')
    if (state) {
      document.getElementById('score-first').textContent = String(state.wins.first)
      document.getElementById('score-second').textContent = String(state.wins.second)
      roundEl.textContent = state.finished ? '三局两胜 · 已终局' : '三局两胜 · 第 ' + state.round + ' 局'
      document.getElementById('mark-first').textContent = ownerOf(act.session, 'first') === 'human' ? '你' : 'AI'
      document.getElementById('mark-second').textContent = ownerOf(act.session, 'second') === 'human' ? '你' : 'AI'
    } else {
      roundEl.textContent = ''
    }

    var buttons = document.querySelectorAll('.throw')
    for (var i = 0; i < buttons.length; i++) {
      var playable = !!(state && !state.finished && (act.live ? humanTurn : true))
      buttons[i].disabled = !playable
      buttons[i].className = 'throw' + (playable ? ' playable' : '')
    }

    historyEl.textContent = ''
    if (state) {
      for (var j = 0; j < state.history.length; j++) {
        var row = state.history[j]
        var line = document.createElement('div')
        line.className = 'row'
        var left = document.createElement('span')
        left.textContent = '第' + row.round + '局 ' + GESTURE_NAMES[row.first] + ' vs ' + GESTURE_NAMES[row.second]
        var right = document.createElement('span')
        right.textContent = ROLE_NAMES[row.winner] + '胜'
        line.appendChild(left); line.appendChild(right)
        historyEl.appendChild(line)
      }
    }

    var finished = !!(act.live && state && state.finished)
    overlayEl.className = finished ? 'overlay' : 'overlay hidden'
    if (finished) document.getElementById('overlay-result').textContent = endText(state)

    hintEl.textContent = !act.live
      ? '这是静态演示局面：由 dsh-tavern 游戏服务装载后，拳钮将启用实时交互。'
      : (!state
        ? '正在连接 dsh-tavern 游戏服务…'
        : (finished
          ? '对局已结束。可关闭本面板或在对局列表中开新一局。'
          : (humanTurn ? '轮到你了：点一个拳钮出拳（合法性由服务端引擎终审）。' : '等待 AI 出拳——发送任意消息让 Agent 落拳。')))
  }

  // 人类回合点拳钮：上行 game-action（服务端引擎终审，本地不做规则裁决）。
  document.getElementById('throws').addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('.throw') : null
    if (!current || !current.view.state || current.view.state.finished) return
    if (!TOKEN || !target) return
    if (ownerOf(current.session, current.view.state.turn) !== 'human') return
    window.parent.postMessage(
      { type: 'dsh-tavern:game-action', token: TOKEN, action: { type: 'throw', gesture: target.getAttribute('data-gesture') } },
      '*'
    )
  })

  render()
</script>
</body>
</html>
`

export async function setup(api) {
  // 游戏注册（提案 0018 §4.5 第 3 源）：id 已在 manifest games 名单内声明并带
  // `<modId>.` 前缀（宿主双纪律）；引擎 duck 校验/烟测与跨源查重在 games
  // service——任一不过本 setup 抛错，Mod 进错误位（fail-fast，镜像工具注册）。
  // 返回的反注册函数可以忽略（宿主卸载时整组回收）——这里示范保存并在
  // dispose 里显式调用（mood-tracker 的主动撤销一路；二次调用幂等无害）。
  const offGame = api.games.register({
    id: 'dsh-tavern.rps.gesture',
    name: '猜拳',
    version: '1.0.0',
    players: { min: 2, max: 2, roles: ['first', 'second'] },
    turnBased: true,
    actionVocabulary:
      "出拳 {type:'throw', gesture:'rock'|'paper'|'scissors'}（石头/布/剪刀）；三局两胜，平局重掷该局；认输 {type:'resign'} 由运行时统一处理",
    engine: RPS_ENGINE,
    view: UI_PAGE,
  })

  api.logger.info(`rps ready（api v${api.version}）：猜拳已注册进游戏桥，在「游戏」分区开局`)

  return () => {
    offGame()
    api.logger.info('rps disposed：猜拳已反注册')
  }
}

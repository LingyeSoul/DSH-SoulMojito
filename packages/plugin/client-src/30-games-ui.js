    // ── 游戏对局面（提案 0018 §4.3，P1）──────────────────────────────────
    // 桥协议两条消息（§3.3）：下行 dsh-soulmojito:game-state（全量 {token, session,
    // view}，view 含 {state, turn, legal, finished, summary}——与 src/games/
    // view.ts 注入的桥脚本逐字段对齐）+ 上行 dsh-soulmojito:game-action。刷新走
    // games/revision 1s 轮询（镜像 store-revision 的便宜纪律：仅游戏分区挂载
    // 且存在未终局会话时轮询，页面不可见停发；不引入 SSE、不动全局水位）。
    const GAME_STATE_MESSAGE = 'dsh-soulmojito:game-state'
    const GAME_ACTION_MESSAGE = 'dsh-soulmojito:game-action'
    const GAMES_REVISION_POLL_MS = 1000
    // 游戏包 zip 上传预检（与服务端 games/install 的 8MB JSON 上限对账：base64
    // 膨胀约 4/3，5MB zip → ~6.7MB 正文，留余量；超限就地报错不发请求）。
    const GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024

    // 游戏图标=手柄（2026-10-14）：宿主 primitives 0.2.0-rc.2 的图标清单里没有
    // 游戏语义的图形（IconPlay 是「播放」、IconGoal 是「目标」，点开都不是游戏），
    // 游戏面自绘一个。几何纪律对齐宿主图标：16 网格、fill:none、
    // stroke=currentColor、1px 描边（IconXxx16 经 bind 别名解析进的 Regular 档
    // 观感），尺寸走同一套 size 属性。小尺寸可辨性按 16px 真光栅逐候选比过：
    // 带握把的机型（Lucide gamepad-2 等比缩编）在 16px 糊成一团，只剩「胶囊机身
    // + 十字键 + 两颗按钮」三个特征还立得住，故取此形。
    function IconGamepadOutline16({ size = 16, className }) {
      return h('svg', {
        width: size,
        height: size,
        className,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('rect', { x: 1.5, y: 4.5, width: 13, height: 7, rx: 3.5, stroke: 'currentColor' }),
      h('path', { d: 'M4.75 8h2.5', stroke: 'currentColor' }),
      h('path', { d: 'M6 6.75v2.5', stroke: 'currentColor' }),
      h('circle', { cx: 10.6, cy: 7.1, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: 12, cy: 8.9, r: 0.7, fill: 'currentColor', stroke: 'none' }))
    }

    // Brand logo (2026-10-16 user request): the delivered DSH-SoulMojito logo,
    // inlined verbatim from assets/logo.svg -- same viewBox, same primitives,
    // same palette. The client half is a ModuleLoader IIFE with no file access,
    // so the geometry lives twice; tavern-panel-layout.spec.ts pins the two
    // copies to each other so they cannot drift.
    // Unlike the host icons this mark is a full-colour logo: it carries its own
    // palette (green glass / mint / ice) instead of currentColor, and its frame
    // is portrait (180x190), so a square `size` letterboxes it -- the glass
    // itself is ~84% of the box height. The delivered frame is kept as-is.
    function SoulMojitoLogo({ size = 16, className }) {
      return h('svg', {
        width: size,
        height: size,
        className,
        viewBox: '-90 -100 180 190',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
      },
      h('g', null,
        h('path', { d: 'M-58,-78 C-58,-20 -34,10 0,10 C34,10 58,-20 58,-78 Z', fill: '#e8f6ee', fillOpacity: 0.14 }),
        h('path', { d: 'M-54.3,-52 C-54.3,-21 -32.4,8.1 0,8.1 C32.4,8.1 54.3,-21 54.3,-52 Z', fill: '#2f9e77' }),
        h('rect', { x: -30, y: -38, width: 18, height: 18, rx: 3, fill: '#dff3e6', opacity: 0.75, transform: 'rotate(18 -21 -29)' }),
        h('rect', { x: 6, y: -22, width: 15, height: 15, rx: 3, fill: '#dff3e6', opacity: 0.7, transform: 'rotate(-12 13 -14)' }),
        h('circle', { cx: -12, cy: -58, r: 3.5, fill: '#dff3e6', opacity: 0.9 }),
        h('circle', { cx: 18, cy: -46, r: 2.5, fill: '#dff3e6', opacity: 0.8 }),
        h('circle', { cx: 0, cy: -34, r: 2, fill: '#dff3e6', opacity: 0.7 }),
        h('path', { d: 'M-58,-78 C-58,-20 -34,10 0,10 C34,10 58,-20 58,-78 Z', fill: 'none', stroke: '#8fd14f', strokeWidth: 5 }),
        h('path', { d: 'M0,10 L0,58 M-22,58 L22,58', fill: 'none', stroke: '#8fd14f', strokeWidth: 5, strokeLinecap: 'round' }),
        h('g', { transform: 'translate(-14,-66) rotate(-38)' },
          h('path', { d: 'M0,0 C10,-12 30,-14 42,-4 C32,6 10,8 0,0 Z', fill: '#3EB489' }))))
    }

    // 对局表面（ModSurface 范式）：持久 iframe 指向 GET games/:gid/view/:sid，
    // per-mount token 经 URL 查询段交给视图（桥脚本自读，回投时对账）+ 事件源
    // 必须是本 frame 的 contentWindow，双对账缺一不受理。人类落子经宿主同源
    // fetch 代理 POST games/action/:id——合法性由 Node 侧引擎终审（iframe 说了
    // 不算）。409=非人类回合/终局 → 横幅提示唤起 AI；400=非法动作（引擎中文
    // 报错透传）；503=孤儿会话/运行时不可用。
    function GameSurface({ session, view, onOutcome }) {
      const t = useTranslate()
      const frameRef = useRef(null)
      const [height, setHeight] = useState(140)
      const postViewport = useViewportBridge(frameRef)
      const [notice, setNotice] = useState('')
      // 最新下行载荷 ref：props 变化即记录；iframe load 事件补发（桥脚本在
      // <head> 同步执行，load 时监听器必已就绪——useViewportBridge 的同款论证；
      // load 前的投递会丢，不能只靠 mount 即发）。
      const payloadRef = useRef(null)
      const [token] = useState(() => `dsh-soulmojito-game-${session.id}-${Math.random().toString(36).slice(2)}`)
      // 投降（2026-10-14 用户需求）：两步点击确认（4s 窗口自动复位）防误触；
      // 「禁用投降」设置开启时不渲染（服务端另有权威门——按钮只是入口，见
      // 面板「游戏」分区开关）。投降是会话级终止，人类任意时刻可投（含 AI 回合）。
      const [resignArmed, setResignArmed] = useState(false)
      useEffect(() => {
        if (!resignArmed) return undefined
        const timer = setTimeout(() => setResignArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [resignArmed])
      const store = useTavernStore()
      const resignAvailable = session.finished !== true && session.orphaned !== true
        && store.bootstrap.state.gamesDisableResign !== true
      const push = useCallback(() => {
        const payload = payloadRef.current
        if (payload === null) return
        try { frameRef.current?.contentWindow?.postMessage({ type: GAME_STATE_MESSAGE, token, session: payload.session, view: payload.view }, '*') } catch {}
      }, [token])
      // 人类动作上行（棋盘 iframe 与投降按钮共用一条路径；合法性由 Node 侧引擎
      // 终审）。ref 持有最新闭包：message 效应按 [session.id, token] 订阅，直接
      // 内联会因闭包陈旧拿到旧的 onOutcome/会话态——与 loadListRef 同款纪律。
      const postAction = (action) => {
        void fetch(`${API}/games/action/${encodeURIComponent(session.id)}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ action }),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok === false) {
              setNotice(response.status === 409 ? t('games.turnAiNow') : String(body.message || `HTTP ${response.status}`))
              return
            }
            setNotice('')
            onOutcome(session.id, body.session, body.view)
            // 即时下行（不等父级重渲染链路）——人类落子的最快反馈路径；轮询
            // 只兜 Agent 侧落子（§4.3）。
            payloadRef.current = { session: body.session, view: body.view }
            push()
          })
          .catch((cause) => { setNotice(cause instanceof Error ? cause.message : String(cause)) })
      }
      const postActionRef = useRef(postAction)
      useEffect(() => { postActionRef.current = postAction })
      useEffect(() => {
        payloadRef.current = view === undefined ? null : { session, view }
        push()
      }, [session, view, push])
      // 新一手到达（自己落子成功或轮询追平 AI 落子）即清横幅。
      useEffect(() => { setNotice('') }, [session?.updatedAt])
      const onFrameLoad = () => {
        postViewport()
        push()
      }
      useEffect(() => {
        const onMessage = (event) => {
          if (event.source !== frameRef.current?.contentWindow) return
          const data = event.data
          if (!data || typeof data !== 'object' || data.token !== token) return
          if (data.type === FRONTEND_HEIGHT_MESSAGE) {
            if (typeof data.height === 'number' && Number.isFinite(data.height)) {
              setHeight(Math.max(80, Math.min(Math.ceil(data.height), 1200)))
            }
            return
          }
          if (data.type !== GAME_ACTION_MESSAGE) return
          const action = data.action
          if (action === null || typeof action !== 'object' || Array.isArray(action)) return
          postActionRef.current(action)
        }
        addEventListener('message', onMessage)
        return () => removeEventListener('message', onMessage)
      }, [session.id, token])
      return h(React.Fragment, null,
        notice ? h('p', { className: 'dt-hint' }, notice) : null,
        h('iframe', {
          ref: frameRef,
          className: 'dt-frontend-frame dt-mod-surface',
          sandbox: 'allow-scripts',
          referrerPolicy: 'no-referrer',
          title: session.gameName || session.gameId,
          src: `${API}/games/${encodeURIComponent(session.gameId)}/view/${encodeURIComponent(session.id)}?token=${encodeURIComponent(token)}`,
          onLoad: onFrameLoad,
          style: { height },
        }),
        resignAvailable
          ? h('div', { className: 'dt-game-actions' },
              h(Button, {
                size: 'sm',
                variant: 'outline',
                className: resignArmed ? 'dt-game-resign dt-game-resign-armed' : 'dt-game-resign',
                onClick: () => {
                  if (!resignArmed) {
                    setResignArmed(true)
                    return
                  }
                  setResignArmed(false)
                  postActionRef.current({ type: 'resign' })
                },
              }, resignArmed ? t('games.resignConfirm') : t('games.resign')))
          : null)
    }

    // 本聊天对局数据面（提案 0018 §4.3；2026-10-14 修订抽出共用）：GamesPanel
    // （设置面板「游戏」分区，管理面）与 TavernGameBoard（MVU 同位对局面，展示
    // 面）共用同一份「list 过滤 + 未终局快照补拉 + games/revision 1s 轮询 + 落子
    // 回填」。轮询纪律不变：仅存在未终局会话时进行，页面不可见停发、回前台补拍、
    // 首拍只立基线；水位变化即重拉（props 变化驱动 GameSurface 下行）。
    function useChatGameSessions(character, chatId) {
      const hasBinding = character !== '' && chatId !== ''
      const [games, setGames] = useState(null)
      const [sessions, setSessions] = useState([])
      const [listError, setListError] = useState('')
      // 未终局会话的最新 {session, view}：list 只带 summary，view 由 games/
      // state/:id 或 start/action 响应补齐——GameSurface 的下行载荷来源。
      const [sessionStates, setSessionStates] = useState({})
      // 「见证过」判据的实时镜像（loadList 是长生命周期回调，直接闭包读
      // sessionStates 会锁死在旧渲染——与 loadListRef 同款 ref 纪律）。
      const sessionStatesRef = useRef({})
      const mergeSession = useCallback((session, view) => {
        if (!session || typeof session.id !== 'string') return
        setSessionStates((current) => ({ ...current, [session.id]: { session, view } }))
      }, [])
      const loadList = useCallback(() => {
        // character+chatId 双全才过滤会话（games 面板同款纪律：无绑定时全量
        // 清单、不展示会话区，避免跨聊天串台）。
        const query = hasBinding ? `?character=${encodeURIComponent(character)}&chatId=${encodeURIComponent(chatId)}` : ''
        // 先读水位基线、**await 之后再**拉数据（2026-10-14 二次修订，侧边栏自动
        // 刷新 RCA）：基线严格早于数据读取，任何「本次渲染之后」发生的落子都
        // 必然改变水位、必被轮询发现；并发发起两个请求时响应序不保证「基线先
        // 于数据」，基线可能反映到比已渲染数据更新的状态而吞掉那一手（AI 在
        // 棋盘打开瞬间落子就停在上一个局面直到下一手）。失败静默——基线保持
        // 旧值只会多拉一次，不会漏。
        return api('games/revision')
          .then((rev) => {
            if (typeof rev.revision === 'string' && rev.revision !== '') revisionRef.current = rev.revision
          }, () => undefined)
          .then(() => api(`games/list${query}`))
          .then(async (result) => {
            const list = Array.isArray(result.sessions) ? result.sessions : []
            setGames(Array.isArray(result.games) ? result.games : [])
            setSessions(list)
            setListError('')
            // 未终局且非孤儿的会话补拉快照（list 响应不含 view；孤儿卡只读不
            // 渲染 iframe）。快照的 session 一并合入——list 项的 turn/finished
            // 随之保鲜。2026-10-14 用户反馈修订：**本次挂载见证过的**已终局会话
            // 同样补拉——终局要显示最终盘面（最后一手若由对方走出，旧逻辑的
            // 过滤会把它停在倒数第二手）；见证集 = 已有 sessionStates 条目的 id，
            // 挂载时已终局的旧对局不拉（「不翻旧账」纪律不变）。
            const witnessed = sessionStatesRef.current
            await Promise.all(list
              .filter((session) => !session.orphaned && (!session.finished || witnessed[session.id] !== undefined))
              .map((session) => api(`games/state/${encodeURIComponent(session.id)}`)
                .then((snapshot) => {
                  setSessions((current) => current.map((item) => item.id === snapshot.session.id ? snapshot.session : item))
                  mergeSession(snapshot.session, snapshot.view)
                })
                .catch(() => {})))
            return { games: Array.isArray(result.games) ? result.games : [], sessions: list }
          })
          .catch((cause) => {
            // 不拒绝：错误落 listError（面板渲染），挂载效应/轮询/开局回填
            // 无需逐处 catch（2026-10-14 之前的 GamesPanel 原语义）。
            setListError(cause instanceof Error ? cause.message : String(cause))
            return undefined
          })
      }, [character, chatId, hasBinding, mergeSession])
      // 落子结果回填：sessionStates 驱动 GameSurface 下行，sessions 列表项同步
      // 替换（终局后结果卡立即切换）。
      const handleOutcome = useCallback((sessionId, session, view) => {
        if (!session || typeof session.id !== 'string') return
        setSessionStates((current) => ({ ...current, [sessionId]: { session, view } }))
        setSessions((current) => current.map((item) => item.id === sessionId ? session : item))
      }, [])
      // 挂载/绑定变化（切换会话/聊天）无条件加载一次——**加载必须由 hook 自持**
      // （2026-10-14 侧边栏空渲染修复）：对局面（右栏 tab/ST 内联）不经
      // GamesPanel，早期版本把挂载加载留在面板组件里，导致 TavernGameBoard
      // 从未拉取、恒渲染 null。
      useEffect(() => { void loadList() }, [loadList])
      useEffect(() => { sessionStatesRef.current = sessionStates })
      // games/revision 两档水位轮询（§4.3，2026-10-14 修订）：存在未终局会话时
      // 1s（对局进行中，AI 落子 ≤1s 可见）；无活跃会话时 5s 低频守望（等
      // 「Agent 在对话里开局」出现——tab 已开时 openTab 是 no-op 不触发重挂载，
      // 原先「无活跃不轮询」会让空面板饿死）。水位变化即重拉 list + 逐会话
      // 快照；页面不可见停发、回前台立即补一拍；首拍只立基线不触发重拉，
      // 基线跨档位保留（终局后降档不丢变更）。
      const activeKey = sessions
        .filter((session) => !session.finished && !session.orphaned)
        .map((session) => session.id)
        .join('\u0000')
      const loadListRef = useRef(loadList)
      useEffect(() => { loadListRef.current = loadList })
      const revisionRef = useRef('')
      useEffect(() => {
        let cancelled = false
        let inFlight = false
        const check = () => {
          if (cancelled || inFlight || document.visibilityState === 'hidden') return
          inFlight = true
          void api('games/revision')
            .then((result) => {
              if (cancelled || typeof result.revision !== 'string' || result.revision === '') return
              if (revisionRef.current === '') {
                revisionRef.current = result.revision
                return
              }
              if (result.revision === revisionRef.current) return
              revisionRef.current = result.revision
              return loadListRef.current()
            })
            .catch(() => {})
            .finally(() => { inFlight = false })
        }
        const timer = setInterval(check, activeKey === '' ? SESSION_PANEL_POLL_MS : GAMES_REVISION_POLL_MS)
        const onVisibility = () => { if (document.visibilityState === 'visible') check() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [activeKey])
      const turnOwner = (session) => {
        const player = Array.isArray(session.players)
          ? session.players.find((item) => item && item.role === session.turn)
          : null
        return player ? player.owner : ''
      }
      return { hasBinding, games, sessions, sessionStates, listError, loadList, handleOutcome, turnOwner }
    }

    // 对局面（2026-10-14 修订，提案 0018 §4.3）：与 MVU 状态同位的自动展示面。
    // ST 架构内联在 TavernView 的 MVU 状态卡之后；AgentTavern 架构由宿主原生
    // 右侧栏 games tab 承载（MVU tab 同款注册，见 TavernGamesSidebarTab），标题栏
    // watcher 在对局开始时自动展开 tab。内容 = 本聊天未终局会话的棋盘
    // （GameSurface）+ 终局结果卡——结果卡只展示本挂载期间见证过的对局（挂载时
    // 已终局的旧会话不占位，MVU「无内容不占位」同款纪律）。
    function TavernGameBoard({ sessionId, sidebar = false }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const character = typeof binding?.character === 'string' ? binding.character : ''
      const chatId = typeof binding?.chatId === 'string' ? binding.chatId : ''
      const { sessions, sessionStates, handleOutcome, turnOwner } = useChatGameSessions(character, chatId)
      const [seenActive, setSeenActive] = useState(() => new Set())
      useEffect(() => {
        const ids = sessions.filter((session) => !session.finished && !session.orphaned).map((session) => session.id)
        if (ids.every((id) => seenActive.has(id))) return
        setSeenActive((current) => {
          const next = new Set(current)
          for (const id of ids) next.add(id)
          return next
        })
      }, [sessions])
      const active = sessions.filter((session) => !session.finished && !session.orphaned)
      const finished = sessions.filter((session) => session.finished && seenActive.has(session.id))
      if (!binding) return null
      // 无对局：内联变体不占位（MVU 同款纪律）；侧边栏变体是用户主动打开的
      // tab，给指引而不是空白（2026-10-14 侧边栏空渲染修复的伴生体验项）。
      if (active.length === 0 && finished.length === 0) {
        // 空态卡（2026-10-14 二次修订）：图标 + 标题 + 指引 + 打开游戏面板按钮
        // ——用户主动打开的 tab 不给纯空白；内联变体维持无对局不占位。
        return sidebar
          ? h('div', { className: 'dt-game-board-empty', 'data-dsh-soulmojito-surface': 'game-board' },
            h('div', { className: 'dt-game-board-empty-icon' }, h(IconGamepadOutline16, { size: 22 })),
            h('strong', null, t('games.tabTitle')),
            h('p', { className: 'dt-hint' }, t('games.boardEmpty')),
            h(Button, { size: 'sm', variant: 'outline', onClick: () => openPanel('games') }, t('games.openPanel')))
          : null
      }
      return h('div', { className: 'dt-game-board', 'data-dsh-soulmojito-surface': 'game-board' },
        active.map((summary) => {
          const live = sessionStates[summary.id]
          const session = live?.session || summary
          const owner = turnOwner(session)
          return h('article', { key: session.id, className: 'dt-mod-row' },
            h('div', { className: 'dt-mod-row-head' },
              h('strong', null, session.gameName || session.gameId),
              owner === 'agent'
                ? h('span', { className: 'dt-mod-meta' }, t('games.waitAi'))
                : h('span', { className: 'dt-mod-meta' }, t('games.turnYou'))),
            owner !== 'agent' ? h('p', { className: 'dt-hint' }, t('games.turnYouHint')) : null,
            h(GameSurface, { key: session.id, session, view: live?.view, onOutcome: handleOutcome }))
        }),
        finished.map((session) => {
          const live = sessionStates[session.id]
          const winner = Array.isArray(session.players)
            ? session.players.find((item) => item && item.role === session.winner)
            : null
          return h('article', { key: session.id, className: 'dt-mod-row' },
            h('div', { className: 'dt-mod-row-head' },
              h('strong', null, session.gameName || session.gameId),
              h(Pill, null, t('games.finished'))),
            // 2026-10-14 用户反馈（「结束很突兀」）：终局不能只剩一行结果文案——
            // 保留最终盘面（视图自带终局覆盖层，点击已禁用），结果行在盘面之下。
            h(GameSurface, { key: session.id, session: live?.session || session, view: live?.view, onOutcome: handleOutcome }),
            h('p', { className: 'dt-hint' }, session.summary || ''),
            session.winner ? h('p', { className: 'dt-hint' }, t('games.winner', {
              role: session.winner,
              owner: winner?.owner === 'human' ? t('games.ownerHuman') : t('games.ownerAgent'),
            })) : null)
        }))
    }

    // 「游戏」分区主体（提案 0018 §4.3）：游戏清单（status ok 可开局 / broken
    // 灰显 + reason tooltip）+ 本聊天会话卡（未终局渲染 GameSurface、终局只出
    // 结果卡不再渲染 iframe、孤儿只读说明）。聊天绑定跟随当前会话（MVU/指引
    // 面板同源：sessionBindings[currentSession] 的 character/chatId）；拿不到
    // 绑定时清单仍展示，开局按钮禁用并提示。数据面共用 useChatGameSessions
    // （对局面 TavernGameBoard 同源，2026-10-14 修订）。
    function GamesPanel({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useSessions ? useCurrentSessionId(useSessions) : null
      const binding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const character = typeof binding?.character === 'string' ? binding.character : ''
      const chatId = typeof binding?.chatId === 'string' ? binding.chatId : ''
      const { hasBinding, games, sessions, sessionStates, listError, loadList, handleOutcome, turnOwner } = useChatGameSessions(character, chatId)
      const [startPending, setStartPending] = useState('')
      const [startError, setStartError] = useState('')
      const start = (game) => {
        if (!hasBinding || startPending !== '') return
        setStartPending(game.id)
        setStartError('')
        // humanRole 缺省 roles[0]（服务端纪律：人类执先，Agent 执另一方）。
        void api('games/start', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ gameId: game.id, character, chatId }),
        })
          .then((result) => {
            handleOutcome(result.session.id, result.session, result.view)
            return loadList()
          })
          .catch((cause) => { setStartError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => setStartPending(''))
      }
      // 导入游戏包（提案 0018 §4.5 面板入口，2026-10-17）：zip 上传 + git 安装
      // 共用同一状态机（importBusy 为 'zip'/'git' 互斥键）；成功后重拉清单，
      // 新游戏立即出现在上方列表（broken 条目连同 reason 一并可见）。
      const [importUrl, setImportUrl] = useState('')
      const [importForce, setImportForce] = useState(false)
      const [importBusy, setImportBusy] = useState('')
      const [importStatus, setImportStatus] = useState('')
      const [importFailed, setImportFailed] = useState(false)
      const runGameImport = (source, busyKey) => {
        if (importBusy !== '') return
        setImportBusy(busyKey)
        setImportFailed(false)
        setImportStatus(t('games.import.installing'))
        void api('games/install', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ ...source, ...(importForce ? { force: true } : {}) }),
        })
          .then((result) => {
            setImportStatus(t('games.import.done', { name: result.game?.name || result.game?.id || '' }))
            setImportUrl('')
            return loadList()
          })
          .catch((cause) => {
            setImportFailed(true)
            setImportStatus(t('games.import.failed', { error: cause instanceof Error ? cause.message : String(cause) }))
          })
          .finally(() => setImportBusy(''))
      }
      const importGameZip = (file) => {
        if (file === undefined || importBusy !== '') return
        if (file.size > GAMES_ZIP_MAX_BYTES) {
          setImportFailed(true)
          setImportStatus(t('games.import.tooLarge', { limit: `${GAMES_ZIP_MAX_BYTES / (1024 * 1024)} MB` }))
          return
        }
        void readFile(file, true)
          .then((buffer) => runGameImport({ zipBase64: bytesToBase64(new Uint8Array(buffer)) }, 'zip'))
          .catch((cause) => {
            setImportFailed(true)
            setImportStatus(t('games.import.failed', { error: cause instanceof Error ? cause.message : String(cause) }))
          })
      }
      const installGameFromGit = () => {
        const url = importUrl.trim()
        if (url === '' || importBusy !== '') return
        runGameImport({ url }, 'git')
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('p', { className: 'dt-hint' }, t('games.hint')),
          // 禁用投降（2026-10-14 用户需求）：全局开关，服务端在两个动作入口
          // （人类棋盘 / Agent game_move）逐次读取判定——翻转即时生效。
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: state.bootstrap.state.gamesDisableResign === true,
              onChange: (event) => {
                // 失败进既有错误行（与开局错误同一位），不静默吞掉。
                void patchState({ gamesDisableResign: event.target.checked })
                  .catch((cause) => { setStartError(cause instanceof Error ? cause.message : String(cause)) })
              },
            }),
            h('span', null, t('settings.gamesDisableResign'))),
          !hasBinding ? h('p', { className: 'dt-muted' }, t('games.needBinding')) : null,
          games === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : h(React.Fragment, null,
              games.length === 0 ? h('p', { className: 'dt-muted' }, t('games.empty')) : null,
              h('div', { className: 'dt-mod-list' }, games.map((game) => h('article', {
                key: game.id,
                className: `dt-mod-row${game.status === 'ok' ? '' : ' dt-game-row-broken'}`,
                title: game.status === 'ok' ? undefined : String(game.reason || ''),
              },
                h('div', { className: 'dt-mod-row-head' },
                  h('strong', null, game.name),
                  h('span', { className: 'dt-mod-meta' }, `v${game.version}`),
                  h(Pill, null, t(`games.source.${game.source}`)),
                  game.status === 'ok'
                    ? h(Button, {
                        size: 'sm',
                        variant: 'outline',
                        disabled: !hasBinding || startPending !== '',
                        onClick: () => start(game),
                      }, startPending === game.id ? t('games.starting') : t('games.start'))
                    : h(Pill, null, t('games.broken'))),
                game.status !== 'ok'
                  ? h('p', { className: 'dt-hint' }, String(game.reason || t('games.broken')))
                  : (typeof game.actionVocabulary === 'string' && game.actionVocabulary !== ''
                      ? h('p', { className: 'dt-hint' }, game.actionVocabulary)
                      : null))))),
          startError ? h('p', { className: 'dt-error' }, startError) : null),
        // 导入游戏包（§4.5 面板入口，2026-10-17）：zip 上传（朋友分享的交付形态）
        // + git 安装两条入口共用强制覆盖勾选与状态行；失败原因就地在状态行透传。
        h('section', { className: 'dt-settings-band', 'data-dsh-soulmojito-surface': 'games-import' },
          h('h3', null, t('games.import.title')),
          h('p', { className: 'dt-hint' }, t('games.import.hint')),
          h('div', { className: 'dt-mod-install' },
            h('label', { className: 'dt-upload', title: t('games.import.file') },
              importBusy === 'zip' ? t('games.import.installing') : t('games.import.file'),
              h('input', {
                type: 'file',
                accept: '.zip,application/zip',
                disabled: importBusy !== '',
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) importGameZip(file)
                },
              })),
            h('input', {
              type: 'text',
              value: importUrl,
              placeholder: t('games.import.placeholder'),
              disabled: importBusy !== '',
              onChange: (event) => setImportUrl(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') installGameFromGit() },
            }),
            h(Button, { size: 'sm', variant: 'outline', disabled: importBusy !== '' || importUrl.trim() === '', onClick: installGameFromGit },
              importBusy === 'git' ? t('games.import.installing') : t('games.import.button')),
            h('label', { className: 'dt-toggle' },
              h('input', {
                type: 'checkbox',
                checked: importForce,
                onChange: (event) => setImportForce(event.target.checked),
              }),
              h('span', null, t('games.import.force')))),
          importStatus ? h('p', { className: importFailed ? 'dt-error' : 'dt-hint' }, importStatus) : null),
        hasBinding ? h('section', { className: 'dt-settings-band' },
          h('h3', null, t('games.sessionsTitle')),
          sessions.length === 0 ? h('p', { className: 'dt-muted' }, t('games.sessionsEmpty')) : null,
          h('div', { className: 'dt-mod-list' }, sessions.map((summary) => {
            const live = sessionStates[summary.id]
            const session = live?.session || summary
            if (session.finished) {
              const winner = Array.isArray(session.players)
                ? session.players.find((item) => item && item.role === session.winner)
                : null
              return h('article', { key: session.id, className: 'dt-mod-row' },
                h('div', { className: 'dt-mod-row-head' },
                  h('strong', null, session.gameName || session.gameId),
                  h(Pill, null, t('games.finished'))),
                // 终局保留最终盘面（2026-10-14 用户反馈，TavernGameBoard 同款）。
                h(GameSurface, { key: session.id, session: live?.session || session, view: live?.view, onOutcome: handleOutcome }),
                h('p', { className: 'dt-hint' }, session.summary || ''),
                session.winner ? h('p', { className: 'dt-hint' }, t('games.winner', {
                  role: session.winner,
                  owner: winner?.owner === 'human' ? t('games.ownerHuman') : t('games.ownerAgent'),
                })) : null)
            }
            if (session.orphaned) {
              return h('article', { key: session.id, className: 'dt-mod-row dt-game-row-broken' },
                h('div', { className: 'dt-mod-row-head' },
                  h('strong', null, session.gameName || session.gameId),
                  h(Pill, null, t('games.orphaned'))),
                h('p', { className: 'dt-hint' }, t('games.orphanedHint')))
            }
            const owner = turnOwner(session)
            return h('article', { key: session.id, className: 'dt-mod-row' },
              h('div', { className: 'dt-mod-row-head' },
                h('strong', null, session.gameName || session.gameId),
                owner === 'agent'
                  ? h('span', { className: 'dt-mod-meta' }, t('games.waitAi'))
                  : h('span', { className: 'dt-mod-meta' }, t('games.turnYou'))),
              h(GameSurface, { key: session.id, session, view: live?.view, onOutcome: handleOutcome }))
          }))) : null,
        listError ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, listError)) : null)
    }

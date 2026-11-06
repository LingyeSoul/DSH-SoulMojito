import { ProjectionCheckpointLagError } from './agent-tavern/checkpoint-batch.js'
import { adoptAgentTavernFork, type ForkAdoptionOutcome } from './agent-tavern/fork.js'
import { emitAgentPresetChanged } from './agent-tavern/preset.js'
import { recoverBodyOperation, type BodyWiringContext } from './agent-tavern/body-wiring.js'
import type { AgentTavernProjector } from './agent-tavern/projector.js'
import { BUILD_INFO } from './build-info.js'
import { tavernDataRoot } from './dsh-home.js'
import { openGamesService, type GamesService } from './games/service.js'
import { wakeAgentOnHumanMove } from './games/wake.js'
import { mountImToolsOnAgent, unmountAllImTools, unmountImToolsForAgent } from './im/agent-mount.js'
import { createImRuntime, imDisabledByEnv, type ImRuntime } from './im/runtime.js'
import { listLiveAgents } from './im/session-host.js'
import { refreshActivePrompt } from './model-catalog.js'
import { preheatNativeAgentPresetOne } from './native-preset.js'
import { getGamesServicePromise, modHost, setGamesServicePromise, setImRuntime, setModHostContext, tavernUpdate } from './runtime.js'
import { bindSession } from './session/binding.js'
import { handleNovelSessionEvent, novelHttpFailure } from './http/novel.js'
import { API, handleApi } from './http/router.js'
import { sendJson } from './http/io.js'
import { sendApiError } from './http/public-error.js'
import { requestTrustFailure } from './http/trust.js'
import type { PluginContext } from './host-contract.js'
import type { MemoryStore, MemoryVectorStore, TavernStore, VariableStore } from '../../tavern-store/src/index.js'

/**
 * Runtime handles the mount phases read. Only stateful accessors live here;
 * the phases import their pure collaborators directly.
 */
export interface MountDeps {
  readonly store: () => Promise<TavernStore>
  readonly variables: () => Promise<VariableStore>
  readonly memories: () => Promise<MemoryStore>
  readonly memoryVectors: () => Promise<MemoryVectorStore>
  readonly bodyWiring: BodyWiringContext
  readonly getAgentTavernProjectorPromise: () => Promise<AgentTavernProjector> | undefined
  readonly getImRuntime: () => ImRuntime | undefined
  readonly allowedHosts: readonly string[]
}

/**
 * Session event fan-in: tavern projection, turn-scope scratch expiry and the
 * AgentNovel receive barrier share this single host subscription.
 */
export function mountSessionEvent(ctx: PluginContext, deps: MountDeps): void {
  ctx.on?.('session/event', (session, event) => {
    void deps.getAgentTavernProjectorPromise()!.then((projector) => projector.project(session, event))
      .catch((error) => {
        // A checkpoint lag means the floor is already on disk and only the
        // checkpoint write failed; labelling that "projection failed" sends
        // whoever reads the log after the wrong problem.
        const label = error instanceof ProjectionCheckpointLagError
          ? 'AgentTavern projection checkpoint lag'
          : 'AgentTavern projection failed'
        ctx.logger?.warn?.(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      })
    // turn 作用域变量是单轮 scratch 状态，turn 结束即过期。
    if (event?.type === 'turn/end' && typeof session?.id === 'string') {
      void deps.variables().then((store) => store.clear('turn', session.id)).catch(() => {})
    }
    // AgentNovel (proposal 0005 §9.1/§12.1): the receive barrier and the turn
    // accounting ride the SAME listener; no second session/event subscription.
    void handleNovelSessionEvent(ctx, session, event)
  })
}

/**
 * Agent creation fan-in: host fork adoption, projection replay, body recovery
 * and the IM preset switch all happen before the loop advances.
 */
export function mountAgentCreated(ctx: PluginContext, deps: MountDeps): void {
  ctx.on?.('agent/created', async ({ agent }) => {
    // 宿主原生会话分叉收养（决策 2026-10-11-agent-tavern-host-fork）：宿主把
    // agent/created 做成串行事件（announce 在 loop start 前被 await），这里
    // await 收养可保证分叉子会话首轮装配与工具面看到完整绑定。串行 listener
    // 的 rejection 会炸掉宿主 agent 创建——整体吞错，失败降级为普通 DSH 会话。
    let adopted: ForkAdoptionOutcome = 'skipped'
    try {
      const db = await deps.store()
      adopted = await adoptAgentTavernFork(agent?.session, {
        store: db,
        bind: (sessionId, character, chatId, contextMode) =>
          bindSession(db, sessionId, character, chatId, false, 'agent-tavern', contextMode),
        variables: await deps.variables(),
        memories: await deps.memories(),
        vectors: await deps.memoryVectors(),
        logger: ctx.logger,
      })
    } catch (error) {
      ctx.logger?.warn?.(`AgentTavern fork adoption failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (adopted === 'adopted') {
      // 与正常激活路径同款的投影预热尾步（决策 §2 第 8 步）：fire-and-forget，
      // 不拖串行 dispatch；首轮懒装载路径照常兜底。
      void emitAgentPresetChanged().then(() => refreshActivePrompt()).catch(() => {})
    }
    // 新会话的预设首轮就绪（2026-11-06 用户需求「第一轮就生效」）：宿主把
    // agent/created 做成串行事件并在 loop start 前 await，这里 await 单 agent
    // 预热，第一次装配即可拿到 native-preset 投影。放在 fork 收养之后，绑定
    // 已落库的会话由装载门控写空串；绑定变更路径另经 emitAgentPresetChanged
    // 写穿，避免工作台/小说/ST 在创建后才绑定时沿用标准会话投影。
    const createdAgentId = typeof agent?.id === 'string' && agent.id !== ''
      ? agent.id
      : (typeof agent?.session?.id === 'string' && agent.session.id !== '' ? agent.session.id : undefined)
    if (createdAgentId !== undefined) {
      try {
        await preheatNativeAgentPresetOne(createdAgentId)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-soulmojito native preset preheat failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const session = agent.session
    if (session !== undefined) {
      void deps.getAgentTavernProjectorPromise()!.then((projector) => projector.replay(session))
        .catch((error) => ctx.logger?.warn?.(`AgentTavern projection replay failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    // Body recovery runs after fork adoption (so a resumed session already has
    // its binding) and before the loop advances. A malformed/unsupported host
    // shape only skips body settlement; agent creation itself must not fail.
    try {
      await recoverBodyOperation(deps.bodyWiring, agent)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-soulmojito body: agent recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // IM 绑定会话的 preset 自动切换：绑定发生在会话未打开/运行中时，这里补上。
    // await：preset 要在 loop 启动前生效，否则首轮仍按旧 preset 跑；失败只记日志，
    // 不阻断 agent 创建。
    const imRuntime = deps.getImRuntime()
    if (imRuntime?.ensurePresetForAgent !== undefined) {
      try {
        await imRuntime.ensurePresetForAgent(agent)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-soulmojito im: AgentTavernIM preset switch failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
}

/**
 * Self-update polling: the effect owns the timer and stops it on unload.
 */
export function mountUpdateCheck(ctx: PluginContext): void {
  ctx.effect(() => tavernUpdate(ctx).start(), 'dsh-soulmojito: update auto-check')
}

/**
 * Games bridge runtime (proposal 0018 P0+P2): scan the registry (built-in plus
 * the installed directory) and publish the globalThis handle. Loading is async
 * and does not block apply; a broken game is recorded as broken. Failures only
 * log — the tool and HTTP surfaces report "game runtime unavailable" while the
 * rest of the plugin mounts normally.
 */
export function mountGames(ctx: PluginContext, deps: MountDeps): Promise<GamesService> {
  const gamesServicePromise = openGamesService({
    root: tavernDataRoot(),
    hostVersion: BUILD_INFO.version,
    logger: { warn: (message) => ctx.logger?.warn?.(message) },
    // 投降门（2026-10-14 用户需求「禁用投降」）：逐次读 state（TavernStore 的
    // getState 是内存态，零文件 IO）——面板翻转即时生效，无需写穿。
    resignAllowed: async () => (await (await deps.store()).getState()).gamesDisableResign !== true,
    // 人类落子自动续弈（2026-10-14 用户需求）：Agent 没调 game_wait 就结束
    // 回合时，用户落子经这里 followup 唤起绑定会话（src/games/wake.ts 负责
    // 通知文本/来源形状/等待中与冷会话的静默跳过）。绑定反查扫 sessionBindings
    // ——只认 agent-tavern 且非群聊（与懒段/bindingFor 同一可见面；群聊无游戏
    // 段，唤醒了也没局面上下文）。同一聊天多绑定时取首个（v1 边界：一个聊天
    // 一个对局一个会话，与工具面寻址假设一致）。
    onHumanAction: async (session) => {
      await wakeAgentOnHumanMove({
        agents: ctx.agents,
        bindingOf: async (character, chatId) => {
          const state = await (await deps.store()).getState()
          for (const [agentId, binding] of Object.entries(state.sessionBindings)) {
            if (binding.architecture !== 'agent-tavern' || binding.group === true) continue
            if (binding.character === character && binding.chatId === chatId) return agentId
          }
          return undefined
        },
        logger: { warn: (message) => ctx.logger?.warn?.(message) },
      }, session)
    },
  })
  setGamesServicePromise(gamesServicePromise)
  gamesServicePromise.catch((error: unknown) => {
    ctx.logger?.warn?.(`dsh-soulmojito: games service failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    ctx.effect?.(() => () => {
      void getGamesServicePromise()?.then((service) => service.dispose()).catch(() => {})
      setGamesServicePromise(undefined)
    }, 'dsh-soulmojito: games unload')
  } catch {
    // 拒绝晚注册 effect 的宿主只失去摘句柄兜底；句柄本身不受影响。
  }
  return gamesServicePromise
}

/**
 * IM channels (proposal 0024): this phase only mounts, it never activates — with
 * no real channel adapter it sends no network request, and the HTTP surface can
 * still inspect bindings and settings. The environment hard switch
 * (DSH_SOULMOJITO_DISABLE_IM) skips the whole block; the panel then reports the
 * surface as unavailable.
 */
export function mountIm(ctx: PluginContext, deps: MountDeps): void {
  if (imDisabledByEnv()) {
    ctx.logger?.info?.('dsh-soulmojito im: disabled by DSH_SOULMOJITO_DISABLE_IM')
  } else {
    // IM 工具挂进**每个原生会话**的 agent 域：绑定会话可能是 standard / novel /
    // workbench，不能只在 agent-tavern preset 里注册。三个入口（created /
    // status / 启动时的 live 列表）都试一次，按 agent id 去重。
    const imToolsDeps = {
      db: deps.store,
      runtime: deps.getImRuntime,
      ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    }
    const mountImTools = (agent: unknown): void => {
      try {
        mountImToolsOnAgent(imToolsDeps, agent as Parameters<typeof mountImToolsOnAgent>[1])
      } catch (error) {
        ctx.logger?.warn?.(`dsh-soulmojito im: mounting IM tools failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    ctx.on?.('agent/created', ({ agent }) => { mountImTools(agent) })
    // 宿主 compose 完成较晚时 agent/created 可能还看不到 tools.register；
    // status 事件是低成本的重试点（已挂过就是空操作）。
    ctx.on?.('agent/status' as string, (payload: unknown) => {
      const agent = (payload as { agent?: unknown } | null | undefined)?.agent
      if (agent === undefined) return
      mountImTools(agent)
      const status = (payload as { status?: unknown }).status
        ?? (agent as { status?: unknown }).status
      if (status !== 'idle') return
      const runtime = deps.getImRuntime()
      if (runtime?.ensurePresetForAgent === undefined) return
      void runtime.ensurePresetForAgent(agent).catch((error: unknown) => {
        ctx.logger?.warn?.(`dsh-soulmojito im: AgentTavernIM preset switch failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    ctx.on?.('agent/disposed' as string, (payload: unknown) => {
      const agent = (payload as { agent?: { id?: unknown; session?: { id?: unknown } } } | null | undefined)?.agent
      const id = typeof agent?.id === 'string' ? agent.id : typeof agent?.session?.id === 'string' ? agent.session.id : undefined
      if (id !== undefined) unmountImToolsForAgent(id)
    })
    void deps.store().then(() => {
      for (const agent of listLiveAgents(ctx.agents)) mountImTools(agent)
    }).catch((error: unknown) => {
      ctx.logger?.warn?.(`dsh-soulmojito im: mounting IM tools on live agents failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    try {
      ctx.effect?.(() => () => { unmountAllImTools() }, 'dsh-soulmojito: im tool mount')
    } catch {
      // 晚注册被拒只失去卸载反注册；宿主销毁挂载域时注册自然失效。
    }

    // 实例与它自己的撤销函数都留在本次 apply 的闭包里：重载时旧 fiber 只能摘掉
    // 自己那一次发布、只 dispose 自己的实例，不会误伤新 fiber（审查 P1-1）。
    let ownedRuntime: ImRuntime | undefined
    let ownedDispose: (() => void) | undefined
    void deps.store().then((db) => {
      ownedRuntime = createImRuntime(ctx, { db, ...(ctx.logger === undefined ? {} : { logger: ctx.logger }) })
      ownedDispose = setImRuntime(ownedRuntime)
      // 启动时补一次：插件重启前已绑定、但会话还没重新打开/空闲的 preset 切换。
      void ownedRuntime.ensurePresets?.().catch((error: unknown) => {
        ctx.logger?.warn?.(`dsh-soulmojito im: AgentTavernIM preset sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }).catch((error: unknown) => {
      ctx.logger?.warn?.(`dsh-soulmojito im: runtime unavailable: ${error instanceof Error ? error.message : String(error)}`)
    })
    try {
      ctx.effect?.(() => () => {
        ownedDispose?.()
        ownedDispose = undefined
        const owned = ownedRuntime
        ownedRuntime = undefined
        void owned?.dispose()
      }, 'dsh-soulmojito: im unload')
    } catch {
      // 拒绝晚注册 effect 的宿主只失去卸载兜底；运行时句柄本身不受影响。
    }
  }
}

/**
 * Mod host (proposal 0015 P3): once stores are ready, scan <tavern>/mods/ and
 * load by the three-layer switches (both default false plus the
 * DSH_SOULMOJITO_DISABLE_MODS hard switch). Loading is async and does not block
 * apply; a broken mod only records an audit entry and an error flag, and unload
 * disposes the whole host. P3 serializes this after the games service settles:
 * api.games.register at setup reaches the registry through the globalThis
 * handle, and an unpublished handle fail-fasts the mod into an error flag. A
 * failed games service does not block mods (the catch continues; a mod that
 * registers games then reports the runtime as unavailable).
 */
export function mountMods(ctx: PluginContext, gamesServicePromise: Promise<GamesService>): void {
  setModHostContext(ctx)
  void gamesServicePromise.catch(() => {}).then(() => modHost()).catch((error: unknown) => {
    ctx.logger?.warn?.(`dsh-soulmojito: mod host failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    ctx.effect?.(() => () => { void modHost().then((host) => host.disposeAll()).catch(() => {}) }, 'dsh-soulmojito: mods unload')
  } catch {
    // 拒绝晚注册 effect 的宿主只失去卸载兜底；装载本身不受影响。
  }
}

/**
 * API transport mount: the host web server owns dispatch but no origin policy,
 * so the route owns the browser trust boundary and the public error mapping.
 */
export function mountTransport(ctx: PluginContext, deps: MountDeps): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      // The host web server owns dispatch but no origin/auth policy, so this
      // route owns the browser trust boundary (see http/trust.ts).
      const webServer = ctx.webServer as
        | { host?: unknown; port?: unknown; getOrigin?: () => unknown }
        | undefined
      let reportedOrigin: string | undefined
      try {
        const value = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : undefined
        if (typeof value === 'string' && value !== '') reportedOrigin = value
      } catch {
        // A host without origin reporting keeps the loopback-only fallback.
      }
      const trustFailure = requestTrustFailure(req, {
        host: typeof webServer?.host === 'string' ? webServer.host : undefined,
        port: typeof webServer?.port === 'number' ? webServer.port : undefined,
        origin: reportedOrigin,
        allowedHosts: deps.allowedHosts,
        // The virtual IndexedDB upload is the one route whose body is raw bytes.
        allowNonJsonBody: (req.url ?? '').split('?')[0] === `${API}/frontend/idb/put`,
      })
      if (trustFailure !== undefined) {
        sendJson(res, trustFailure.status, { ok: false, message: trustFailure.message })
        return
      }
      try {
        await handleApi(ctx, req, res)
      } catch (error) {
        // Novel domain errors map onto structured HTTP statuses (§13); every
        // infrastructure detail stays in the server log, never in the body.
        sendApiError(res, error, {
          operation: 'http-api',
          logger: ctx.logger,
          novelFailure: novelHttpFailure(error),
        })
      }
    },
  }), 'dsh-soulmojito: API')
}

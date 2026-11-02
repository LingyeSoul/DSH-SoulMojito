import { ProjectionCheckpointLagError } from './agent-tavern/checkpoint-batch.js'
import { adoptAgentTavernFork, type ForkAdoptionOutcome } from './agent-tavern/fork.js'
import { emitAgentPresetChanged } from './agent-tavern/preset.js'
import { recoverBodyOperation, type BodyWiringContext } from './agent-tavern/body-wiring.js'
import type { AgentTavernProjector } from './agent-tavern/projector.js'
import type { ImRuntime } from './im/runtime.js'
import { refreshActivePrompt } from './model-catalog.js'
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

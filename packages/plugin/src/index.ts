import { AGENT_TAVERN_PRESET_ID, bootstrapAgentTavernCapabilities } from './agent-tavern/capabilities.js'
import { createDshAgentTavernAdapter } from './agent-tavern/dsh-adapter.js'
import { AgentTavernProjector } from './agent-tavern/projector.js'
import {
  bodyWiringContext,
  recoverBodyOperations,
  registerBodyProjection,
  registerBodyTurnStopping,
} from './agent-tavern/body-wiring.js'
import { registerAgentTavernAnchor } from './agent-tavern/anchor.js'
import { registerAgentTavernCardState } from './agent-tavern/card-state.js'
import { registerAgentTavernPromptCapture } from './agent-tavern/prompt-capture.js'
import { inspectAgentNovelCapabilities } from './agent-novel/capabilities.js'
import { NovelDriver } from './agent-novel/driver.js'
import { NovelProjector } from './agent-novel/projector.js'
import { describeHostShape } from '../../bind/src/index.js'
import { tavernDataRoot } from './dsh-home.js'
import { getActiveAgentPrompt, refreshActivePrompt } from './model-catalog.js'
import {
  mountAgentCreated,
  mountGames,
  mountIm,
  mountMods,
  mountSessionEvent,
  mountTransport,
  mountUpdateCheck,
  type MountDeps,
} from './mount.js'
import { nativeAgentPresetSection, preheatNativeAgentPreset } from './native-preset.js'
import {
  getAgentTavernProjectorPromise,
  getImRuntime,
  memories,
  memoryVectors,
  novelStore,
  setAgentNovelCapabilities,
  setAgentTavernCapabilities,
  setAgentTavernCapabilitiesPromise,
  setAgentTavernProjectorPromise,
  setNovelDriverPromise,
  setNovelProjectorPromise,
  setTemplatesEnabledFlag,
  setUpdateChecksEnabledFlag,
  store,
  templatesEnabled,
  updateChecksEnabled,
  variables,
} from './runtime.js'
import { registerTavernSessionCommand } from './session/command.js'
import { registerSessionBindingReclaim } from './session/reclaim.js'
import { listLiveAgents } from './im/session-host.js'
import { normalizeAllowedHosts } from './http/trust.js'
import type { PluginContext } from './host-contract.js'
import { ensureAgentPresetDeclared, recoverMountedNovels } from './http/novel.js'

export const name = 'dsh-soulmojito'
export const inject = ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction', 'sessions']
export function apply(ctx: PluginContext, config: { anchorEveryTurns?: unknown, checkForUpdates?: unknown, templateEnabled?: unknown, allowedHosts?: unknown, pruneStaleBindings?: unknown } = {}): void {
  // Fail fast before mounting any surface: a malformed allowlist must not
  // silently fall back to loopback-only (or, worse, reflect Host values).
  const allowedHosts = normalizeAllowedHosts(config.allowedHosts)
  // Body wiring is registered before any session/agent derivation so restored
  // sessions are projected and recovered from their first reader. `sessions` is
  // a hard dependency of every supported host (DSH 0.2.0-rc.2 exposes
  // `ctx.sessions`), so inject names it; the optional part is that service's
  // `registerMessageProjection` seam. A host shape without that seam only
  // disables body operations, and the rest of the plugin keeps mounting
  // (proposal 0021 §12.8).
  const bodyWiring = bodyWiringContext(ctx, async (sessionId) => (await (await store()).getState()).sessionBindings[sessionId])
  registerBodyProjection(bodyWiring)
  const bodyProjectionSeam = typeof bodyWiring.sessions?.registerMessageProjection === 'function'
  ctx.logger?.info?.(
    `dsh-soulmojito body: projection seam ${bodyProjectionSeam ? 'available' : 'missing; body operations disabled'}`,
  )
  registerBodyTurnStopping(bodyWiring)
  void recoverBodyOperations(bodyWiring)
    .catch((error: unknown) => ctx.logger?.warn?.(`dsh-soulmojito body: startup recovery failed: ${error instanceof Error ? error.message : String(error)}`))
  registerAgentTavernAnchor(ctx, { everyTurns: config.anchorEveryTurns })
  // 卡内 EJS 世界书注入：默认注册（inner），提示词查看器 prepend 在更外层，
  // 因此捕获面能看到锚定 + 卡内状态两条插件注入。
  registerAgentTavernCardState(ctx)
  // 提示词查看器（Agent 模式）pre-step 捕获：必须在 anchor **之后** prepend
  // 注册（后 prepend 者更外层），await next() 后才能看到含锚定/开场提醒的
  // 最终进入批次（决策 2026-10-11-agent-prompt-viewer）。
  registerAgentTavernPromptCapture(ctx)
  setUpdateChecksEnabledFlag(updateChecksEnabled(config))
  setTemplatesEnabledFlag(templatesEnabled(config))
  const adapter = createDshAgentTavernAdapter(ctx)
  // 宿主形状一次性上报：rc.6 与 0.1.2+ 的绑定路径差异排查从这行日志读起。
  ctx.logger?.info?.(`dsh-soulmojito host shape: ${JSON.stringify(describeHostShape(ctx))}`)
  const agentTavernCapabilitiesPromise = bootstrapAgentTavernCapabilities(adapter, {
    presetId: AGENT_TAVERN_PRESET_ID,
    ensurePreset: () => ensureAgentPresetDeclared(ctx, AGENT_TAVERN_PRESET_ID),
  })
  setAgentTavernCapabilitiesPromise(agentTavernCapabilitiesPromise)
  void agentTavernCapabilitiesPromise.then((value) => { setAgentTavernCapabilities(value) })
  const agentTavernProjectorPromise = store().then((db) => AgentTavernProjector.open(tavernDataRoot(), db))
  setAgentTavernProjectorPromise(agentTavernProjectorPromise)
  // AgentNovel capability snapshot (proposal 0005 §16): read by the bootstrap
  // route and the novel-open command. Pure shape probing; the bundled preset
  // declaration (bundle cordis.patch.yml row) is asserted on demand via
  // ensureAgentPresetDeclared, not forced here.
  setAgentNovelCapabilities(inspectAgentNovelCapabilities(ctx))
  const novelProjectorPromise = Promise.all([novelStore(), memories()])
    .then(([store, memory]) => NovelProjector.open(tavernDataRoot(), store, memory))
  setNovelProjectorPromise(novelProjectorPromise)
  const novelDriverPromise = Promise.all([novelStore(), store(), novelProjectorPromise])
    .then(([novelDb, tavern, projector]) => {
      // The driver subscribes agent/created|disposed|status itself and owns
      // its gated degradation (§12.1); dispose rides the effect hook.
      const driver = NovelDriver.create(ctx, { store: novelDb, tavern, projector })
      try {
        // ctx.effect runs the callback now and calls its return value at
        // unload; returning the disposer keeps that contract intact.
        ctx.effect?.(() => () => { void driver.dispose() }, 'dsh-soulmojito:novel-driver-dispose')
      } catch {
        // A host that rejects a late effect registration only loses unload
        // disposal; scheduling itself is unaffected.
      }
      return driver
    })
    .catch((error: unknown) => {
      ctx.logger?.warn?.(`dsh-soulmojito: AgentNovel driver unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  setNovelDriverPromise(novelDriverPromise)
  const mountDeps: MountDeps = {
    store,
    variables,
    memories,
    memoryVectors,
    bodyWiring,
    getAgentTavernProjectorPromise,
    getImRuntime,
    allowedHosts,
  }
  mountSessionEvent(ctx, mountDeps)
  mountAgentCreated(ctx, mountDeps)
  void refreshActivePrompt()
  // §12.3 restart recovery runs after apply returns; it never blocks mounting.
  void recoverMountedNovels(ctx)
  ctx.systemPrompt.section({
    name: 'dsh-soulmojito:active-character',
    order: 25,
    text: () => getActiveAgentPrompt(),
  })
  // 标准 DSH Agent 会话的激活预设投影（2026-11-01 用户需求）：index bundle 是
  // profile 级挂载，section 对全部会话的装配可见，装载期按「无 Tavern 绑定」门控
  // ——绑定会话各有专属预设通道（agent-tavern/agent.ts、preset-mount.ts）。
  ctx.systemPrompt.section(nativeAgentPresetSection())
  // 重启预热（native-preset.ts）：活着的标准会话先装载一次，消除首轮空串 →
  // 整块出现。fire-and-forget，懒装载兜底。
  const liveAgentIds = listLiveAgents(ctx.agents)
    .map((agent) => agent.id)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  void preheatNativeAgentPreset(liveAgentIds)

  registerTavernSessionCommand(ctx)
  // 失效会话绑定回收：默认关闭，`pruneStaleBindings: report|prune` 显式开启（决策 2026-11-02-stale-session-binding-reclaim）。
  void registerSessionBindingReclaim(ctx, { configured: config.pruneStaleBindings, store })

  // Domain mount phases: update → games → IM → mods → transport. The transport
  // stays last so the API cannot serve before its surfaces exist; mods wait on
  // the games promise inside mountMods.
  mountUpdateCheck(ctx)

  const gamesServicePromise = mountGames(ctx, mountDeps)
  mountIm(ctx, mountDeps)
  mountMods(ctx, gamesServicePromise)

  mountTransport(ctx, mountDeps)
}

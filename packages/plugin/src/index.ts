import { AGENT_TAVERN_PRESET_ID, bootstrapAgentTavernCapabilities } from './agent-tavern/capabilities.js'
import { createDshAgentTavernAdapter } from './agent-tavern/dsh-adapter.js'
import { adoptAgentTavernFork, type ForkAdoptionOutcome } from './agent-tavern/fork.js'
import { emitAgentPresetChanged } from './agent-tavern/preset.js'
import { AgentTavernProjector } from './agent-tavern/projector.js'
import { registerAgentTavernAnchor } from './agent-tavern/anchor.js'
import { registerAgentTavernCardState } from './agent-tavern/card-state.js'
import { registerAgentTavernPromptCapture } from './agent-tavern/prompt-capture.js'
import { inspectAgentNovelCapabilities } from './agent-novel/capabilities.js'
import { NovelDriver } from './agent-novel/driver.js'
import { NovelProjector } from './agent-novel/projector.js'
import { describeHostShape } from '../../bind/src/index.js'
import { ChatRevisionConflictError } from '../../tavern-store/src/index.js'
import { BUILD_INFO } from './build-info.js'
import { tavernDataRoot } from './dsh-home.js'
import { openGamesService } from './games/service.js'
import { wakeAgentOnHumanMove } from './games/wake.js'
import { getActiveAgentPrompt, refreshActivePrompt } from './model-catalog.js'
import {
  getAgentTavernProjectorPromise,
  getGamesServicePromise,
  memories,
  memoryVectors,
  modHost,
  novelStore,
  setAgentNovelCapabilities,
  setAgentTavernCapabilities,
  setAgentTavernCapabilitiesPromise,
  setAgentTavernProjectorPromise,
  setGamesServicePromise,
  setModHostContext,
  setNovelDriverPromise,
  setNovelProjectorPromise,
  setTemplatesEnabledFlag,
  setUpdateChecksEnabledFlag,
  store,
  tavernUpdate,
  templatesEnabled,
  updateChecksEnabled,
  variables,
} from './runtime.js'
import { bindSession, TavernArchitectureConflictError } from './session/binding.js'
import { registerTavernSessionCommand } from './session/command.js'
import { API, handleApi } from './http/router.js'
import { sendJson } from './http/io.js'
import { ensureAgentPresetDeclared, handleNovelSessionEvent, novelHttpFailure, recoverMountedNovels } from './http/novel.js'

export const name = 'dsh-soulmojito'
export const inject = ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction']
export function apply(ctx, config: { anchorEveryTurns?: unknown, checkForUpdates?: unknown, templateEnabled?: unknown } = {}) {
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
  ctx.on?.('session/event', (session, event) => {
    void getAgentTavernProjectorPromise()!.then((projector) => projector.project(session, event))
      .catch((error) => ctx.logger?.warn?.(`AgentTavern projection failed: ${error instanceof Error ? error.message : String(error)}`))
    // turn 作用域变量是单轮 scratch 状态，turn 结束即过期。
    if (event?.type === 'turn/end' && typeof session?.id === 'string') {
      void variables().then((store) => store.clear('turn', session.id)).catch(() => {})
    }
    // AgentNovel (proposal 0005 §9.1/§12.1): the receive barrier and the turn
    // accounting ride the SAME listener; no second session/event subscription.
    void handleNovelSessionEvent(ctx, session, event)
  })
  ctx.on?.('agent/created', async ({ agent }) => {
    // 宿主原生会话分叉收养（决策 2026-10-11-agent-tavern-host-fork）：宿主把
    // agent/created 做成串行事件（announce 在 loop start 前被 await），这里
    // await 收养可保证分叉子会话首轮装配与工具面看到完整绑定。串行 listener
    // 的 rejection 会炸掉宿主 agent 创建——整体吞错，失败降级为普通 DSH 会话。
    let adopted: ForkAdoptionOutcome = 'skipped'
    try {
      const db = await store()
      adopted = await adoptAgentTavernFork(agent?.session, {
        store: db,
        bind: (sessionId, character, chatId, contextMode) =>
          bindSession(db, sessionId, character, chatId, false, 'agent-tavern', contextMode),
        variables: await variables(),
        memories: await memories(),
        vectors: await memoryVectors(),
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
    void getAgentTavernProjectorPromise()!.then((projector) => projector.replay(agent.session))
      .catch((error) => ctx.logger?.warn?.(`AgentTavern projection replay failed: ${error instanceof Error ? error.message : String(error)}`))
  })
  void refreshActivePrompt()
  // §12.3 restart recovery runs after apply returns; it never blocks mounting.
  void recoverMountedNovels(ctx)
  ctx.systemPrompt.section({
    name: 'dsh-soulmojito:active-character',
    order: 25,
    text: () => getActiveAgentPrompt(),
  })

  registerTavernSessionCommand(ctx)

  ctx.effect(() => tavernUpdate(ctx).start(), 'dsh-soulmojito: update auto-check')

  // 游戏桥运行时（提案 0018 P0+P2）：扫描注册表（内置 + installed 目录）并
  // 发布 globalThis 句柄。装载是异步的，不阻塞 apply 返回；坏游戏 broken 入
  // 册不影响宿主。失败只记日志——工具面与 HTTP 面在句柄缺失时报
  // 「游戏运行时不可用」，插件其余表面照常。
  const gamesServicePromise = openGamesService({
    root: tavernDataRoot(),
    hostVersion: BUILD_INFO.version,
    logger: { warn: (message) => ctx.logger?.warn?.(message) },
    // 投降门（2026-10-14 用户需求「禁用投降」）：逐次读 state（TavernStore 的
    // getState 是内存态，零文件 IO）——面板翻转即时生效，无需写穿。
    resignAllowed: async () => (await (await store()).getState()).gamesDisableResign !== true,
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
          const state = await (await store()).getState()
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

  // Mod 宿主（提案 0015 P3）：stores 就绪后扫描 <tavern>/mods/ 并按三层
  // 开关装载（双默认 false + DSH_SOULMOJITO_DISABLE_MODS 硬关）。装载是异步的，
  // 不阻塞 apply 返回；坏 Mod 只记审计与错误位。宿主卸载时统一 dispose。
  // P3 起装载在游戏服务**落定之后**串行开始：api.games.register 在 setup 期
  // 经 globalThis 句柄直调注册表，句柄未发布会 fail-fast 把注册游戏的 Mod 打
  // 成错误位——先开游戏服务再装 Mod 消除这个竞态。游戏服务打开失败不阻断
  // Mod 装载（catch 后继续；注册游戏的 Mod 会如实报 games runtime 不可用）。
  setModHostContext(ctx)
  void gamesServicePromise.catch(() => {}).then(() => modHost()).catch((error: unknown) => {
    ctx.logger?.warn?.(`dsh-soulmojito: mod host failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    ctx.effect?.(() => () => { void modHost().then((host) => host.disposeAll()).catch(() => {}) }, 'dsh-soulmojito: mods unload')
  } catch {
    // 拒绝晚注册 effect 的宿主只失去卸载兜底；装载本身不受影响。
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      try {
        await handleApi(ctx, req, res)
      } catch (error) {
        if (!res.writableEnded) {
          // Novel domain errors map onto structured HTTP statuses (§13); the
          // original detail is logged server-side because corruption and
          // ownership messages carry internal paths and pids.
          const novelFailure = novelHttpFailure(error)
          if (novelFailure !== undefined) {
            ctx.logger?.warn?.(`dsh-soulmojito: novel route failed (${novelFailure.code}): ${error instanceof Error ? error.message : String(error)}`, { operation: 'novels-api', errorCode: novelFailure.code })
          }
          const message = novelFailure?.sanitized === true
            ? `Novel failure '${novelFailure.code}'; see the server log for details.`
            : error instanceof Error ? error.message : String(error)
          const code = error instanceof ChatRevisionConflictError || error instanceof TavernArchitectureConflictError
            ? error.code
            : novelFailure?.code
          if (res.headersSent) {
            res.write(JSON.stringify({ type: 'error', message, code }) + '\n')
            res.end()
          } else {
            const status = error instanceof ChatRevisionConflictError || error instanceof TavernArchitectureConflictError
              ? 409
              : novelFailure?.status ?? 500
            sendJson(res, status, { ok: false, message, code, ...(novelFailure?.extra ?? {}) })
          }
        }
      }
    },
  }), 'dsh-soulmojito: API')
}

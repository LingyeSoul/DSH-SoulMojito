/**
 * IM 运行时（提案 0024 §3）：把通道、路由、会话托管与宿主 seam 装到一起。
 *
 * 单进程单实例，由 `apply()` 创建、`ctx.effect` 的 disposer 关闭。本轮还没有
 * 真实通道适配器（OneBot/QQ/微信在后续里程碑），因此运行时的通道表为空、
 * 整个子系统处于「已装配但不活动」状态——它不注册路由之外的东西，也不发起
 * 任何网络请求。
 */

import { AGENT_TAVERN_PRESET_ID } from '../agent-tavern/capabilities.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { envCompat } from '../env-compat.js'
import type { HostLogger, HostSessionEventLike, HostSessionLike, PluginContext } from '../host-contract.js'
import { ensureAgentPresetDeclared } from '../http/novel.js'
import { displayTextForMessage } from '../prompt-context.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { bindSession } from '../session/binding.js'
import type { ChatMessage } from '../../../tavern-format/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { sessionEvents } from '../../../bind/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { prepareInternalWorkspace } from '../workspace.js'
import { imDisabledByEnv, type ImRuntimeHandle } from './handle.js'
import { createImRouter, type ImRouter } from './router.js'
import {
  bindImChat,
  ensureImAgent,
  ensureImSession,
  inspectImSessionCapabilities,
  type ImAgentsSeam,
  type ImPresetsSeam,
  type ImSessionCapabilities,
  type ImSessionDeps,
} from './session-host.js'
import type { ImChannel, ImChannelView, ImTarget } from './types.js'
import { imPeerKey } from './types.js'
import { ImStore } from './store.js'

export type ImRuntime = ImRuntimeHandle

export interface CreateImRuntimeOptions {
  db: TavernStore
  logger?: HostLogger
}

export { imDisabledByEnv }

export function createImRuntime(ctx: PluginContext, options: CreateImRuntimeOptions): ImRuntime {
  const { db } = options
  const agents = ctx.agents as ImAgentsSeam | undefined
  const presets = ctx.agentPresets as ImPresetsSeam | undefined
  const capabilities = inspectImSessionCapabilities(agents, presets)
  const channels = new Map<string, ImChannel>()
  const store = ImStore.open(tavernDataRoot('im'))

  const sessionDeps: ImSessionDeps = {
    db,
    agents,
    presets,
    presetId: AGENT_TAVERN_PRESET_ID,
    ensurePreset: async () => { await ensureAgentPresetDeclared(ctx, AGENT_TAVERN_PRESET_ID) },
    workspace: async () => (await prepareInternalWorkspace()).path,
    bind: async (sessionId, character, chatId) =>
      bindSession(db, sessionId, character, chatId, false, 'agent-tavern', 'dsh-native'),
    presetChanged: async () => { await emitAgentPresetChanged() },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }

  const router = createImRouter({
    db,
    now: () => Date.now(),
    seenDedupe: (dedupeKey, now) => store.seenDedupe(dedupeKey, now),
    ensureSession: async (request) => ensureImSession(sessionDeps, request),
    followup: async (sessionId, message) => {
      const agent = await liveAgent(sessionDeps, sessionId)
      const target = agent as { followup?: (payload: unknown) => unknown }
      if (typeof target.followup !== 'function') {
        throw new Error(`the host agent for session ${sessionId} exposes no followup()`)
      }
      await target.followup({
        id: message.id,
        role: 'user',
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      })
    },
    render: async (target, text) => renderForTarget(db, target, text),
    send: async (target, parts) => {
      const channel = channels.get(channelKey(target.channel, target.accountId))
      if (channel === undefined) {
        throw new Error(`IM channel ${target.channel}/${target.accountId} is not running`)
      }
      await channel.send(target, parts)
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  function handleSessionEvent(session: HostSessionLike, event: HostSessionEventLike): void {
    if (event.type !== 'turn/end') return
    const sessionId = session.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const turn = event.data?.['turn']
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return
    void isImSession(db, sessionId).then((bound) => {
      if (!bound) return
      return router.finishTurn(sessionId, turn, sessionEvents(session))
    }).catch((error: unknown) => {
      options.logger?.warn?.(`dsh-soulmojito im: turn ${turn} of ${sessionId} reply failed: ${messageOf(error)}`)
    })
  }

  return {
    router,
    capabilities,
    views: () => [...channels.values()].map((channel) => ({
      channel: channel.channel,
      accountId: channel.accountId,
      status: channel.status(),
      peers: 0,
    })),
    bindChat: async (chat, existingSessionId) => bindImChat(sessionDeps, chat, existingSessionId),
    handleSessionEvent,
    dispose: async () => {
      for (const channel of channels.values()) {
        await channel.stop().catch((error: unknown) => {
          options.logger?.warn?.(`dsh-soulmojito im: stopping ${channel.channel}/${channel.accountId} failed: ${messageOf(error)}`)
        })
      }
      channels.clear()
    },
  }
}

/** 会话是否被任一 IM peer 绑定；未绑定的会话不参与回复抽取。 */
async function isImSession(db: TavernStore, sessionId: string): Promise<boolean> {
  const state = await db.getState()
  for (const binding of Object.values(state.imPeers ?? {})) {
    if (binding.sessionId === sessionId) return true
  }
  return false
}

/** 重启后 live agent 可能已不在注册表里：先 resume/create，再投递。 */
async function liveAgent(deps: ImSessionDeps, sessionId: string): Promise<unknown> {
  const live = deps.agents?.get?.(sessionId)
  if (live !== undefined && live !== null) return live
  return ensureImAgent(deps, sessionId)
}

/**
 * 展示层渲染：与面板渲染走同一套 `markdownOnly` 正则，IM 看到的正文因此
 * 与网页端一致；渲染失败时退回原文——宁可少一层正则，也不要丢一整轮回复。
 */
async function renderForTarget(db: TavernStore, target: ImTarget, text: string): Promise<string> {
  const state = await db.getState()
  const key = imPeerKey(target.channel, target.accountId, target.scope, target.peerId)
  const binding = state.imPeers?.[key]
  if (binding === undefined) return text
  const card = await db.getCharacter(binding.character)
  const scripts = await collectSessionRegexScripts(db, state, binding.character, binding.chatId, card)
  const message: ChatMessage = {
    name: '',
    is_user: false,
    is_system: false,
    send_date: new Date().toISOString(),
    mes: text,
  }
  return displayTextForMessage(scripts, message, 0)
}

function channelKey(channel: string, accountId: string): string {
  return `${channel}:${accountId}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

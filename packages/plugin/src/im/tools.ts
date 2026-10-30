/**
 * IM 工具族（提案 0024 §3.6）：`im_identity` / `im_channels` / `im_send`。
 *
 * 身份只来自宿主注入的 agent id + `state.imPeers` 反查，**没有任何 sessionId
 * 参数**——工具面不能变成「给任意 QQ 号发消息」的开放接口。
 *
 * 对外只暴露 **alias**（peerKey 的短哈希），不暴露 peerKey / peerId：QQ openid
 * 与微信 user_id 是平台身份标识，进了模型上下文就可能被复述到群里。alias 稳定
 * 且与 peerKey 一一对应，模型用它在同一会话内选目标已经足够。
 */

import { createHash } from 'node:crypto'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { objectOutput, tool, type ToolDefinition, type ToolExecution } from '../agent-tavern/tools/shared.js'
import type { ImRuntimeHandle } from './handle.js'
import type { ImScope } from './types.js'
import { imPeerKeyParts } from './types.js'

/** 工具面单条上限：不在这里切分，超长交给模型自己分段（提案 §3.7 的切分属出站投影）。 */
export const IM_SEND_MAX_CHARS = 4000

export interface ImToolsDeps {
  /** store 访问器由调用方 memoize（与 agent-tavern 工具同一实例纪律）。 */
  db: () => Promise<TavernStore>
  /** 当前 IM 运行时；未装配时返回 undefined。 */
  runtime: () => ImRuntimeHandle | undefined
}

/** 本会话的一条绑定投影：只含对外安全的身份字段。 */
interface BoundPeer {
  /** 内部路由键，永不出现在工具返回值里。 */
  peerKey: string
  alias: string
  channel: string
  scope: ImScope
  character: string
  chatId: string
}

export function createImTools(deps: ImToolsDeps): ToolDefinition[] {
  return [
    tool('im_identity', 'Report the IM peers bound to this very session: channel, private/group scope, character and chat. Use it when you need to know which chat window this conversation is coming from. Returns an empty peer list when the session has no IM binding; it cannot look up any other session.', {}, identityOutput, async (_args, exec) => {
      return { peers: (await boundPeers(deps, requireAgentId(exec))).map(publicPeer) }
    }),
    tool('im_channels', 'Report whether the IM subsystem is available in this host process and the current state of every configured channel account (idle, starting, online, paused, error). Read-only; never returns credentials.', {}, channelsOutput, async () => {
      const runtime = deps.runtime()
      if (runtime === undefined) {
        return {
          available: false,
          reasons: ['IM runtime is not mounted in this host process'],
          channels: [],
        }
      }
      return {
        available: runtime.capabilities.available,
        reasons: [...runtime.capabilities.reasons],
        channels: runtime.views().map((view) => ({
          channel: view.channel,
          accountId: view.accountId,
          state: view.status.state,
        })),
      }
    }),
    tool('im_send', 'Send one text message to an IM peer that is bound to this session. Omit peer when exactly one peer is bound; pass the alias from im_identity when several are. Text is trimmed and capped at 4000 characters. Cross-session sending is forbidden: an alias outside this session is rejected.', {
      text: { type: 'string', required: true, description: 'Message text, 1-4000 characters after trimming.' },
      peer: { type: 'string', description: 'Target peer alias from im_identity; required when this session has more than one binding.' },
    }, sendOutput, async (args, exec) => {
      const text = sendTextOf(args)
      const requested = aliasOf(args)
      const peers = await boundPeers(deps, requireAgentId(exec))
      let peer: BoundPeer
      if (requested !== undefined) {
        const found = peers.find((entry) => entry.alias === requested)
        if (found === undefined) throw new Error(`peer '${requested}' is not bound to this session`)
        peer = found
      } else if (peers.length === 0) {
        throw new Error('this session has no IM peer binding; bind one in the DSH-SoulMojito IM panel first')
      } else {
        peer = peerWhenSingle(peers)
      }
      const runtime = deps.runtime()
      if (runtime === undefined) {
        throw new Error('IM runtime is not available in this host process; im_send cannot deliver messages')
      }
      const receipt = await runtime.router.sendText(peer.peerKey, text)
      return {
        peer: peer.alias,
        parts: receipt.parts,
        sentAt: new Date(receipt.at).toISOString(),
        ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
      }
    }),
  ]
}

/** 对外投影：alias + 非标识性身份。 */
function publicPeer(peer: BoundPeer): { alias: string; channel: string; scope: ImScope; character: string; chatId: string } {
  return {
    alias: peer.alias,
    channel: peer.channel,
    scope: peer.scope,
    character: peer.character,
    chatId: peer.chatId,
  }
}

const identityOutput = objectOutput({
  peers: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        alias: { type: 'string' },
        channel: { type: 'string' },
        scope: { type: 'string', enum: ['private', 'group'] },
        character: { type: 'string' },
        chatId: { type: 'string' },
      },
      required: ['alias', 'channel', 'scope', 'character', 'chatId'],
      additionalProperties: false,
    },
  },
})

const channelsOutput = objectOutput({
  available: { type: 'boolean' },
  reasons: { type: 'array', items: { type: 'string' } },
  channels: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        accountId: { type: 'string' },
        state: { type: 'string', enum: ['idle', 'starting', 'online', 'paused', 'error'] },
      },
      required: ['channel', 'accountId', 'state'],
      additionalProperties: false,
    },
  },
})

const sendOutput = objectOutput({
  peer: { type: 'string' },
  parts: { type: 'integer' },
  sentAt: { type: 'string' },
  messageId: { type: 'string' },
}, ['messageId'])

/** 工具身份只认宿主注入的 agent id；缺它就拒绝执行，绝不回落到会话参数。 */
function requireAgentId(exec: ToolExecution): string {
  const agentId = exec.agent?.id
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error('IM tool requires the current agent')
  }
  return agentId
}

async function boundPeers(deps: ImToolsDeps, sessionId: string): Promise<BoundPeer[]> {
  const state = await (await deps.db()).getState()
  const peers: BoundPeer[] = []
  for (const [peerKey, binding] of Object.entries(state.imPeers ?? {})) {
    if (binding.sessionId !== sessionId) continue
    const parts = imPeerKeyParts(peerKey)
    if (parts === undefined) {
      throw new Error(`IM peer key '${peerKey}' is malformed; expected '<channel>:<accountId>:<scope>:<peerId>'`)
    }
    peers.push({
      peerKey,
      alias: imPeerAlias(parts.channel, parts.scope, peerKey),
      channel: parts.channel,
      scope: binding.scope,
      character: binding.character,
      chatId: binding.chatId,
    })
  }
  return peers.sort((left, right) => left.alias.localeCompare(right.alias))
}

/**
 * 稳定别名：同一 peer 的 alias 跨重启不变，模型可以在多轮里复用；哈希让 openid
 * 永远不出现在上下文里。channel + scope 进哈希，避免不同渠道同名 id 撞车。
 */
export function imPeerAlias(channel: string, scope: string, peerKey: string): string {
  return `peer-${createHash('sha256').update(`${channel}:${scope}:${peerKey}`).digest('hex').slice(0, 10)}`
}

function peerWhenSingle(peers: readonly BoundPeer[]): BoundPeer {
  if (peers.length === 1) return peers[0] as BoundPeer
  throw new Error(`this session is bound to ${peers.length} IM peers; pass peer to choose one of: ${peers.map((peer) => peer.alias).join(', ')}`)
}

function sendTextOf(args: Record<string, unknown>): string {
  const value = args['text']
  if (typeof value !== 'string') throw new Error('text must be a string')
  const text = value.trim()
  if (text === '') throw new Error('text must not be blank; im_send sends exactly the text you give it')
  if (text.length > IM_SEND_MAX_CHARS) {
    throw new Error(`text must be at most ${IM_SEND_MAX_CHARS} characters, received ${text.length}`)
  }
  return text
}

function aliasOf(args: Record<string, unknown>): string | undefined {
  const value = args['peer']
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('peer must be a string when provided')
  const alias = value.trim()
  if (alias === '') throw new Error('peer must not be blank when provided')
  return alias
}

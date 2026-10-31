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

import { isAbsolute } from 'node:path'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { HostLogger } from '../host-contract.js'
import { objectOutput, tool, type ToolDefinition, type ToolExecution } from '../agent-tavern/tools/shared.js'
import type { ImRuntimeHandle } from './handle.js'
import type { ImOutboundMedia, ImScope } from './types.js'
import { imPeerAlias, imPeerKeyParts } from './types.js'

/** 工具面单条上限：不在这里切分，超长交给模型自己分段（提案 §3.7 的切分属出站投影）。 */
export const IM_SEND_MAX_CHARS = 4000

export interface ImToolsDeps {
  /** store 访问器由调用方 memoize（与 agent-tavern 工具同一实例纪律）。 */
  db: () => Promise<TavernStore>
  /** 当前 IM 运行时；未装配时返回 undefined。 */
  runtime: () => ImRuntimeHandle | undefined
  /** 工具挂载失败的可见日志（面板运行日志的宿主镜像）。 */
  logger?: HostLogger
}

/** 本会话的一条绑定投影：只含对外安全的身份字段。 */
interface BoundPeer {
  /** 内部路由键，永不出现在工具返回值里。 */
  peerKey: string
  alias: string
  channel: string
  scope: ImScope
}

export function createImTools(deps: ImToolsDeps): ToolDefinition[] {
  return [
    tool('im_identity', 'Report the IM peers bound to this very session: channel, private/group scope and the alias to pass to im_send. Use it when you need to know which IM conversations this session can answer. Returns an empty peer list when the session has no IM binding; it cannot look up any other session.', {}, identityOutput, async (_args, exec) => {
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
    tool('im_send', 'Send one message to an IM peer that is bound to this session. Use it to reply when an IM message has been relayed into this session. Send text, a media item, or a media item with a caption. Omit peer when exactly one peer is bound, or to reply to the most recent inbound message of this session; otherwise pass the alias from im_identity. Text is trimmed and capped at 4000 characters. Media is read from an absolute local path (preferred) or an http(s) URL for image/video. Cross-session sending is forbidden: an alias outside this session is rejected.', {
      text: { type: 'string', description: 'Message text, 1-4000 characters after trimming. Optional when media is attached; then it becomes the caption.' },
      peer: { type: 'string', description: 'Target peer alias from im_identity; required when this session has more than one binding.' },
      mediaKind: { type: 'string', enum: ['image', 'voice', 'video', 'file'], description: 'Kind of the media item; required when mediaPath or mediaUrl is given.' },
      mediaPath: { type: 'string', description: 'Absolute path of a local file to send (preferred: no network fetch).' },
      mediaUrl: { type: 'string', description: 'Remote http(s) URL to send. Only image and video are supported by every channel.' },
      mediaName: { type: 'string', description: 'Optional display file name for the media item.' },
    }, sendOutput, async (args, exec) => {
      const text = optionalTextOf(args)
      const media = mediaOf(args)
      if (text === undefined && media === undefined) {
        throw new Error('im_send needs text, mediaPath or mediaUrl')
      }
      const requested = aliasOf(args)
      const agentId = requireAgentId(exec)
      const peers = await boundPeers(deps, agentId)
      let peer: BoundPeer
      if (requested !== undefined) {
        const found = peers.find((entry) => entry.alias === requested)
        if (found === undefined) throw new Error(`peer '${requested}' is not bound to this session`)
        peer = found
      } else if (peers.length === 0) {
        throw new Error('this session has no IM peer binding; bind one in the dsh-soulmojito IM panel first')
      } else {
        // 微信一条绑定只有一个聊天；多通道共用会话时，回给最近一条入站消息的对端。
        const lastKey = deps.runtime()?.router.lastPeerOf?.(agentId)
        const recent = lastKey === undefined ? undefined : peers.find((entry) => entry.peerKey === lastKey)
        peer = recent ?? peerWhenSingle(peers)
      }
      const runtime = deps.runtime()
      if (runtime === undefined) {
        throw new Error('IM runtime is not available in this host process; im_send cannot deliver messages')
      }
      if (media !== undefined) {
        if (runtime.router.sendMedia === undefined) {
          throw new Error('this IM runtime cannot send media; update dsh-soulmojito and restart DSH')
        }
        const withCaption: typeof media = text === undefined ? media : { ...media, caption: text }
        const receipt = await runtime.router.sendMedia(peer.peerKey, withCaption)
        return {
          peer: peer.alias,
          parts: receipt.parts,
          sentAt: new Date(receipt.at).toISOString(),
          mediaKind: media.kind,
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
        }
      }
      const receipt = await runtime.router.sendText(peer.peerKey, text as string)
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
function publicPeer(peer: BoundPeer): { alias: string; channel: string; scope: ImScope } {
  return {
    alias: peer.alias,
    channel: peer.channel,
    scope: peer.scope,
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
      },
      required: ['alias', 'channel', 'scope'],
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
  mediaKind: { type: 'string', enum: ['image', 'voice', 'video', 'file'] },
}, ['messageId', 'mediaKind'])

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
    // 手工改坏/损坏的记录跳过：工具挂在每个会话上，一条坏 key 不能让所有会话的
    // IM 工具一起失效。
    if (parts === undefined) continue
    if (parts.scope !== 'private' && parts.scope !== 'group') continue
    peers.push({
      peerKey,
      alias: imPeerAlias(parts.channel, parts.scope, peerKey),
      channel: parts.channel,
      scope: binding.scope,
    })
  }
  return peers.sort((left, right) => left.alias.localeCompare(right.alias))
}

export { imPeerAlias } from './types.js'

function peerWhenSingle(peers: readonly BoundPeer[]): BoundPeer {
  if (peers.length === 1) return peers[0] as BoundPeer
  throw new Error(`this session is bound to ${peers.length} IM peers; pass peer to choose one of: ${peers.map((peer) => peer.alias).join(', ')}`)
}

function optionalTextOf(args: Record<string, unknown>): string | undefined {
  const value = args['text']
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('text must be a string')
  const text = value.trim()
  if (text === '') throw new Error('text must not be blank; omit it when sending only media')
  if (text.length > IM_SEND_MAX_CHARS) {
    throw new Error(`text must be at most ${IM_SEND_MAX_CHARS} characters, received ${text.length}`)
  }
  return text
}

const MEDIA_KINDS: readonly ImOutboundMedia['kind'][] = ['image', 'voice', 'video', 'file']

/**
 * 媒体参数 → 结构化描述。只接受一个来源（本地路径或 URL）：两样都给时让调用方
 * 改，而不是替它猜哪个优先——猜错就是发错文件。
 */
function mediaOf(args: Record<string, unknown>): ImOutboundMedia | undefined {
  const kindValue = args['mediaKind']
  const pathValue = args['mediaPath']
  const urlValue = args['mediaUrl']
  const nameValue = args['mediaName']
  const hasPath = pathValue !== undefined
  const hasUrl = urlValue !== undefined
  if (!hasPath && !hasUrl) {
    if (kindValue !== undefined || nameValue !== undefined) {
      throw new Error('mediaKind/mediaName need mediaPath or mediaUrl')
    }
    return undefined
  }
  if (hasPath && hasUrl) throw new Error('pass either mediaPath or mediaUrl, not both')
  if (typeof kindValue !== 'string' || !MEDIA_KINDS.includes(kindValue as ImOutboundMedia['kind'])) {
    throw new Error("mediaKind must be one of 'image' | 'voice' | 'video' | 'file' when sending media")
  }
  const kind = kindValue as ImOutboundMedia['kind']
  let name: string | undefined
  if (nameValue !== undefined) {
    if (typeof nameValue !== 'string' || nameValue.trim() === '') {
      throw new Error('mediaName must be a non-empty string when provided')
    }
    name = nameValue.trim()
  }
  if (hasPath) {
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      throw new Error('mediaPath must be a non-empty absolute path')
    }
    const localPath = pathValue.trim()
    if (!isAbsolute(localPath)) {
      throw new Error(`mediaPath '${localPath}' is not absolute; pass a full path (the attachment summary prints one)`)
    }
    return { kind, localPath, ...(name === undefined ? {} : { name }) }
  }
  if (typeof urlValue !== 'string' || urlValue.trim() === '') {
    throw new Error('mediaUrl must be a non-empty http(s) URL')
  }
  const raw = urlValue.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`mediaUrl '${raw}' is not a valid absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`mediaUrl '${raw}' uses protocol '${parsed.protocol}'; expected http(s)`)
  }
  return { kind, url: raw, ...(name === undefined ? {} : { name }) }
}

function aliasOf(args: Record<string, unknown>): string | undefined {
  const value = args['peer']
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('peer must be a string when provided')
  const alias = value.trim()
  if (alias === '') throw new Error('peer must not be blank when provided')
  return alias
}

/**
 * Author directive receive adapter for AgentNovel (proposal 0005 §9.1).
 *
 * W4 mounts this on the session/event entry barrier: real user messages are
 * turned into persisted requirement records before they can become visible to
 * the author agent or unblock the next unit claim (§9.1 receive barrier).
 * The adapter never throws for unparseable events — a broken event shape must
 * not take down the host event stream; it reports accepted:false instead.
 */

import { createHash } from 'node:crypto'
import { NovelCapabilityError, type NovelStore } from '../../../tavern-store/src/index.js'

/** Where a directive came from (§9.1); 'internal' is reserved for programmatic registration. */
export interface RequirementSourceKind {
  kind: 'composer' | 'panel' | 'internal'
}

/**
 * Stable hostMessageId derivation: identical (sessionId, messageKey) pairs map
 * to the same id across processes and restarts, so host retries cannot
 * register the same directive twice (§4.1/§9.1).
 */
export function stableMessageKey(sessionId: string, messageKey: string): string {
  return createHash('sha256').update(`${sessionId}\u0000${messageKey}`).digest('hex')
}

/**
 * Author-message event discrimination, kept consistent with the AgentTavern
 * projector: `user/message` events whose source is the real user and whose
 * text content is non-empty. Plugin/model/mirror sources never count.
 */
export function isNovelAuthorMessage(event: { type?: string; data?: unknown }): boolean {
  return extractAuthorMessage(event) !== null
}

export async function receiveAuthorMessage(
  store: NovelStore,
  novelId: string,
  sessionId: string,
  event: unknown,
): Promise<{ accepted: boolean; duplicate: boolean; reason?: string }> {
  const extracted = extractAuthorMessage(event)
  if (extracted === null) {
    return { accepted: false, duplicate: false, reason: 'event is not a real user author message (user/message with user source and non-empty text)' }
  }
  try {
    const received = await store.receiveRequirement(novelId, {
      hostMessageId: stableMessageKey(sessionId, extracted.messageId),
      text: extracted.text,
      sourceKind: extracted.sourceKind,
    })
    return { accepted: true, duplicate: received.duplicate }
  } catch (cause) {
    // The receive barrier must not throw into the host event stream (§9.1);
    // every failure mode is reported as accepted:false with a reason for logs.
    if (cause instanceof NovelCapabilityError) {
      return { accepted: false, duplicate: false, reason: cause.reason }
    }
    return { accepted: false, duplicate: false, reason: `${(cause as Error).name}: ${(cause as Error).message}` }
  }
}

interface ExtractedAuthorMessage {
  messageId: string
  text: string
  sourceKind: 'composer' | 'panel'
}

function extractAuthorMessage(event: unknown): ExtractedAuthorMessage | null {
  if (typeof event !== 'object' || event === null) return null
  const record = event as { type?: unknown; data?: unknown }
  if (record.type !== 'user/message') return null
  if (typeof record.data !== 'object' || record.data === null) return null
  const data = record.data as {
    id?: unknown
    content?: unknown
    source?: { kind?: unknown; channel?: unknown; panel?: unknown }
  }
  if (data.source === null || typeof data.source !== 'object') return null
  if (data.source.kind !== 'user') return null
  if (typeof data.id !== 'string' || data.id.trim() === '') return null
  const text = textBlocks(data.content)
  if (text.trim() === '') return null
  const sourceKind = data.source.channel === 'panel' || data.source.panel === true ? 'panel' : 'composer'
  return { messageId: data.id, text, sourceKind }
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { text?: unknown } => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
}

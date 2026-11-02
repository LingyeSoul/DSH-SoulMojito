// Structural JSON guards shared by the route modules that read client
// payloads.

import type { ChatLogIR } from '../../../tavern-format/src/index.js'

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Structural admission for a client-supplied chat log. The store re-validates
 * the full message shape on write; this guard only ensures the fields routing
 * touches exist before the log enters the store.
 */
export function asChatLog(value: unknown): ChatLogIR | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const header = asRecord(record['header'])
  if (header === undefined) return undefined
  if (typeof header['user_name'] !== 'string' || typeof header['character_name'] !== 'string') return undefined
  if (!Array.isArray(record['messages'])) return undefined
  return value as ChatLogIR
}

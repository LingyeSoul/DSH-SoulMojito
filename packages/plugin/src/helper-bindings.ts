/**
 * Server-issued helper binding tokens (2026-10-25).
 *
 * The host page owns the Tavern session binding; the sandboxed frontend only
 * supplies an op payload. On mount the host exchanges its current
 * character/chatId for a token, and every helper or frontend/generate request
 * carries that token. The route resolves identity from the token, so a payload
 * cannot address another chat even if it forges character/chatId.
 *
 * Tokens are process-local and expire after 30 minutes. A plugin restart drops
 * the table; the client binds again on the next FrontendFrame mount.
 */

import { randomUUID } from 'node:crypto'

export const HELPER_TOKEN_HEADER = 'x-dsh-helper-token'

const HELPER_BINDING_TTL_MS = 30 * 60 * 1000

export interface HelperBinding {
  character: string
  chatId: string
  createdAt: number
}

const bindings = new Map<string, HelperBinding>()

function pruneExpired(now: number): void {
  for (const [token, binding] of bindings) {
    if (now - binding.createdAt >= HELPER_BINDING_TTL_MS) bindings.delete(token)
  }
}

export function createHelperBinding(character: string, chatId: string): string {
  const now = Date.now()
  pruneExpired(now)
  const token = randomUUID()
  bindings.set(token, { character, chatId, createdAt: now })
  return token
}

export function resolveHelperBinding(token: string): HelperBinding | undefined {
  pruneExpired(Date.now())
  return bindings.get(token)
}

export function deleteHelperBinding(token: string): boolean {
  return bindings.delete(token)
}

/** Test-only: start a test from a clean token table. */
export function resetHelperBindingsForTests(): void {
  bindings.clear()
}

/**
 * Reads the token from request headers. Node lowercases incoming header names,
 * but tests and other adapters may pass any casing, so compare lowercased.
 */
export function helperTokenFromRequest(req: unknown): string | undefined {
  const headers = (req as { headers?: Record<string, unknown> } | null | undefined)?.headers
  if (headers === undefined || headers === null) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== HELPER_TOKEN_HEADER) continue
    const first = Array.isArray(value) ? value[0] : value
    return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined
  }
  return undefined
}

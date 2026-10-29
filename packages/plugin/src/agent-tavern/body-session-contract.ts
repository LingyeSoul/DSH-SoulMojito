/**
 * Structural host slices, logging and primitive guards shared by the body
 * session readers.
 *
 * Split out of `body-session.ts` so the session module stays inside the source
 * budget; the session module re-exports every symbol, so existing importers
 * keep their entry point.
 */

import type { HostAgentsService, HostLogger } from '../host-contract.js'

/** Persistent binding slice needed to decide whether body operations apply. */
export interface BodyBindingView {
  readonly architecture: string
  readonly character?: string
  readonly chatId?: string
  readonly group?: boolean
}

/** Resolves one session id to its Tavern binding (state is owned by the store). */
export type BodyBindingResolver = (
  sessionId: string,
) => BodyBindingView | undefined | Promise<BodyBindingView | undefined>

/** Structural host slices accepted by the session helpers. */
export interface BodyLogHost {
  readonly logger?: HostLogger
}

export interface BodyBindingHost extends BodyLogHost {
  readonly bindingOf?: BodyBindingResolver
}

export interface BodyAgentsHost extends BodyLogHost {
  readonly agents?: HostAgentsService
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function warn(ctx: BodyLogHost, message: string, fields: Record<string, unknown>): void {
  try {
    ctx.logger?.warn?.(message, fields)
  } catch {
    // Logging must never mask the body failure it reports.
  }
}

export function info(ctx: BodyLogHost, message: string, fields: Record<string, unknown>): void {
  try {
    ctx.logger?.info?.(message, fields)
  } catch {
    // Same as warn.
  }
}

export function errorLog(ctx: BodyLogHost, message: string, fields: Record<string, unknown>): void {
  try {
    ctx.logger?.error?.(message, fields)
  } catch {
    // Same as warn.
  }
}

export function failureCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const code = error['code']
  return typeof code === 'string' && code !== '' ? code : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

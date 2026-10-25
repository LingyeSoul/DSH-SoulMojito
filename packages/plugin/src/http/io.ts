// Shared JSON request/response helpers for the plugin HTTP surface.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './errors.js'

/**
 * Minimal structural view of the Node response fields these helpers touch.
 * `http.ServerResponse` satisfies it; route test doubles may implement only
 * these members too.
 */
export interface JsonResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string | Uint8Array): void
  readonly writableEnded?: boolean
}

/**
 * Minimal structural view of a readable request body. `http.IncomingMessage`
 * satisfies it, as do the route test doubles, which type listeners as
 * `(chunk?: unknown) => void`. The host's own request type is looser still
 * (e.g. optional `on`), so call sites that hand over that type may need to
 * narrow it themselves.
 */
export interface JsonRequest {
  headers?: Record<string, string | string[] | undefined>
  on(event: string, listener: (chunk?: unknown) => void): unknown
  destroy?(): void
}

/** Route request shape: the host web server hands over a Node IncomingMessage. */
export type HttpRequest = IncomingMessage

/** Route response shape: the host web server hands over a Node ServerResponse. */
export type HttpResponse = ServerResponse

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export function sendJson(res: JsonResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function readJson(req: JsonRequest, maxBytes?: number): Promise<Record<string, unknown>> {
  const limit = maxBytes ?? DEFAULT_MAX_BYTES
  const contentType = headerValue(req.headers?.['content-type'])
  // Local non-browser clients may omit content-type; a present non-JSON type
  // is a cross-site form/simple request (or a caller bug) and must not parse.
  if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
    return Promise.reject(new HttpError(415, `unsupported content-type '${contentType}'; expected application/json`))
  }
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    req.on('data', (rawChunk) => {
      // Node's IncomingMessage emits Buffer chunks for 'data' unless the route
      // asked for string encoding; this helper never does.
      const chunk = rawChunk as Buffer
      bytes += chunk.length
      if (bytes > limit) { reject(new HttpError(413, `request exceeds ${limit} bytes`)); req.destroy?.() }
      else chunks.push(chunk)
    })
    req.on('end', () => {
      // Callers treat a parsed body as an object; non-object JSON is already
      // outside their accepted shapes and gets the same unsupported-op/field
      // errors it got before. Parse failures still map to 400.
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) }
      catch { reject(new HttpError(400, 'invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined
}

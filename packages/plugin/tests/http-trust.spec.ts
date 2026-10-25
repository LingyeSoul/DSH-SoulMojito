/**
 * HTTP trust boundary (2026-10-25): the host web server has no server-wide
 * origin policy, so the plugin route must reject cross-site browser requests,
 * DNS-rebinding Host values and form-encoded bodies. These tests pin the pure
 * policy plus the helper identity ordering in the client fragment.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/http/errors.js'
import { readJson } from '../src/http/io.js'
import { normalizeAllowedHosts, requestTrustFailure, type TrustRequest } from '../src/http/trust.js'

const here = dirname(fileURLToPath(import.meta.url))
const frameSource = readFileSync(join(here, '../client-src/10-frontend-frame.js'), 'utf8')
const indexSource = readFileSync(join(here, '../src/index.ts'), 'utf8')
const LOOPBACK_BIND = { host: '127.0.0.1', port: 3456 }

function request(method: string, headers: Record<string, string | string[] | undefined>): TrustRequest {
  return { method, headers }
}

describe('HTTP trust boundary', () => {
  it('allows a same-origin JSON POST from the local page', () => {
    const failure = requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      origin: 'http://127.0.0.1:3456',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json; charset=utf-8',
    }), LOOPBACK_BIND)
    expect(failure).toBeUndefined()
  })

  it('rejects a cross-site Origin on a mutating request', () => {
    const failure = requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      origin: 'https://evil.example',
      'content-type': 'application/json',
    }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 403 })
    expect(failure?.message).toContain('cross-origin')
  })

  it('rejects sec-fetch-site cross-site even without an Origin header', () => {
    const failure = requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
    }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 403 })
    expect(failure?.message).toContain('sec-fetch-site: cross-site')
  })

  it('rejects same-site requests because sibling subdomains are not the page origin', () => {
    const failure = requestTrustFailure(request('PUT', {
      host: '127.0.0.1:3456',
      'sec-fetch-site': 'same-site',
    }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 403 })
  })

  it('rejects a present non-JSON content-type with 415', () => {
    const failure = requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      origin: 'http://127.0.0.1:3456',
      'content-type': 'text/plain',
    }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 415 })
    expect(failure?.message).toContain("text/plain")
  })

  it('allows local callers that send no browser or content-type headers', () => {
    const failure = requestTrustFailure(request('POST', {}), LOOPBACK_BIND)
    expect(failure).toBeUndefined()
  })

  it('rejects an evil Host header (DNS rebinding defense)', () => {
    const failure = requestTrustFailure(request('POST', {
      host: 'evil.example:3456',
      origin: 'http://evil.example:3456',
      'content-type': 'application/json',
    }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 403 })
    expect(failure?.message).toContain('Host')
  })

  it('rejects an evil Host header on reads too', () => {
    const failure = requestTrustFailure(request('GET', { host: 'evil.example:3456' }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 403 })
  })

  it('allows every loopback spelling on any port', () => {
    const cases: Array<{ host: string; origin?: string }> = [
      { host: 'localhost:3456', origin: 'http://localhost:3456' },
      { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456' },
      { host: '[::1]:3456', origin: 'http://[::1]:3456' },
      { host: '::1' },
    ]
    for (const entry of cases) {
      const failure = requestTrustFailure(request('POST', {
        host: entry.host,
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        'content-type': 'application/json',
      }), LOOPBACK_BIND)
      expect(failure, entry.host).toBeUndefined()
    }
  })

  it('allows the configured bind host at its port and rejects a sibling host', () => {
    const bind = { host: '0.0.0.0', port: 7000 }
    expect(requestTrustFailure(request('POST', {
      host: '0.0.0.0:7000',
      origin: 'http://0.0.0.0:7000',
      'content-type': 'application/json',
    }), bind)).toBeUndefined()
    expect(requestTrustFailure(request('POST', {
      host: '0.0.0.0:7001',
      origin: 'http://0.0.0.0:7001',
      'content-type': 'application/json',
    }), bind)).toMatchObject({ status: 403 })
    expect(requestTrustFailure(request('POST', {
      host: 'sibling.internal:7000',
      origin: 'http://sibling.internal:7000',
      'content-type': 'application/json',
    }), bind)).toMatchObject({ status: 403 })
  })

  it('allows explicitly configured deployment hosts with and without a port', () => {
    const bind = { host: '127.0.0.1', port: 3456 }
    // No port on the entry: any port on that host is accepted.
    expect(requestTrustFailure(request('POST', {
      host: 'tavern.internal:8123',
      origin: 'http://tavern.internal:8123',
      'content-type': 'application/json',
    }), { ...bind, allowedHosts: ['tavern.internal'] })).toBeUndefined()
    // An explicit port narrows the entry to exactly that port.
    expect(requestTrustFailure(request('POST', {
      host: 'tavern.internal:8443',
      origin: 'http://tavern.internal:8443',
      'content-type': 'application/json',
    }), { ...bind, allowedHosts: ['tavern.internal:8443'] })).toBeUndefined()
    expect(requestTrustFailure(request('POST', {
      host: 'tavern.internal:8444',
      origin: 'http://tavern.internal:8444',
      'content-type': 'application/json',
    }), { ...bind, allowedHosts: ['tavern.internal:8443'] })).toMatchObject({ status: 403 })
  })

  it('still rejects hosts outside the explicit allowlist', () => {
    const bind = { host: '127.0.0.1', port: 3456, allowedHosts: ['tavern.internal'] }
    expect(requestTrustFailure(request('GET', { host: 'evil.example:3456' }), bind)).toMatchObject({ status: 403 })
    // A malformed wildcard entry is ignored even if it bypasses apply-time validation.
    expect(requestTrustFailure(request('GET', { host: '*' }), { ...bind, allowedHosts: ['*'] })).toMatchObject({ status: 403 })
  })

  it('keeps origin and content-type checks on allowed custom hosts', () => {
    const bind = { host: '127.0.0.1', port: 3456, allowedHosts: ['tavern.internal'] }
    expect(requestTrustFailure(request('POST', {
      host: 'tavern.internal:3456',
      origin: 'https://evil.example',
      'content-type': 'application/json',
    }), bind)).toMatchObject({ status: 403 })
    expect(requestTrustFailure(request('POST', {
      host: 'tavern.internal:3456',
      origin: 'http://tavern.internal:3456',
      'content-type': 'text/plain',
    }), bind)).toMatchObject({ status: 415 })
  })

  it('normalizes allowed host case and trailing DNS dots', () => {
    expect(normalizeAllowedHosts(['Tavern.Internal.', 'Tavern.Internal.:8443'])).toEqual([
      'tavern.internal',
      'tavern.internal:8443',
    ])
    expect(requestTrustFailure(request('GET', { host: 'tavern.internal:3456' }), {
      host: '127.0.0.1',
      port: 3456,
      allowedHosts: normalizeAllowedHosts(['Tavern.Internal.']),
    })).toBeUndefined()
  })

  it('rejects malformed allowedHosts config', () => {
    for (const value of [
      'tavern.internal',
      [''],
      ['   '],
      ['*'],
      ['*.example'],
      ['https://tavern.internal'],
      ['tavern.internal/path'],
      ['user:pass'],
      ['tavern.internal:0'],
      ['tavern.internal:70000'],
      ['tavern.internal:port'],
      [42],
    ]) {
      expect(() => normalizeAllowedHosts(value), JSON.stringify(value)).toThrow()
    }
    expect(normalizeAllowedHosts(undefined)).toEqual([])
  })

  it('rejects a bodyless cross-site POST', () => {
    const failure = requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      origin: 'https://evil.example',
    }), LOOPBACK_BIND)
    expect(failure).toMatchObject({ status: 403 })
  })

  it('rejects the opaque origin null and leaves GET browser reads alone', () => {
    expect(requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      origin: 'null',
    }), LOOPBACK_BIND)).toMatchObject({ status: 403 })
    expect(requestTrustFailure(request('GET', {
      host: '127.0.0.1:3456',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    }), LOOPBACK_BIND)).toBeUndefined()
  })

  it('lets the binary IndexedDB upload keep its non-JSON body type', () => {
    const failure = requestTrustFailure(request('POST', {
      host: '127.0.0.1:3456',
      origin: 'http://127.0.0.1:3456',
      'content-type': 'application/octet-stream',
    }), { ...LOOPBACK_BIND, allowNonJsonBody: true })
    expect(failure).toBeUndefined()
  })
})

describe('JSON body reader status mapping', () => {
  function streamRequest(headers: Record<string, string>, body: string) {
    const listeners = new Map<string, (chunk?: unknown) => void>()
    return {
      headers,
      on(event: string, listener: (chunk?: unknown) => void) {
        listeners.set(event, listener)
        if (event === 'end') {
          listeners.get('data')?.(Buffer.from(body, 'utf8'))
          listener()
        }
        return undefined
      },
      destroy() {},
    }
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<HttpError> {
    const result = await promise.then(() => undefined, (error: unknown) => error)
    expect(result).toBeInstanceOf(HttpError)
    return result as HttpError
  }

  it('maps invalid JSON to 400', async () => {
    const error = await rejectionOf(readJson(streamRequest({ 'content-type': 'application/json' }, '{nope')))
    expect(error.status).toBe(400)
  })

  it('maps a present non-JSON content-type to 415', async () => {
    const error = await rejectionOf(readJson(streamRequest({ 'content-type': 'text/plain' }, '{}')))
    expect(error.status).toBe(415)
  })

  it('maps an oversize body to 413 and keeps missing content-type allowed', async () => {
    const error = await rejectionOf(readJson(streamRequest({ 'content-type': 'application/json' }, '{"large":true}'), 4))
    expect(error.status).toBe(413)
    await expect(readJson(streamRequest({}, '{"ok":true}'))).resolves.toEqual({ ok: true })
  })
})

describe('index wiring (source check)', () => {
  it('runs the trust guard before routing and exempts the binary IDB upload', () => {
    const guardIndex = indexSource.indexOf('requestTrustFailure(req, {')
    const routeIndex = indexSource.indexOf('await handleApi(ctx, req, res)')
    expect(guardIndex).toBeGreaterThanOrEqual(0)
    expect(routeIndex).toBeGreaterThan(guardIndex)
    expect(indexSource.slice(guardIndex, routeIndex)).toContain('`${API}/frontend/idb/put`')
    expect(indexSource.slice(guardIndex, routeIndex)).toContain('allowedHosts')
    expect(indexSource).toContain('normalizeAllowedHosts(config.allowedHosts)')
  })
})

describe('helper identity isolation (client source)', () => {
  it('strips payload identity and applies the host binding last', () => {
    const helperStart = frameSource.indexOf('const helperPayload')
    expect(helperStart).toBeGreaterThanOrEqual(0)
    const requestStart = frameSource.indexOf('void helperRequest({', helperStart)
    const requestEnd = frameSource.indexOf('}).then', requestStart)
    expect(requestStart).toBeGreaterThan(helperStart)
    expect(requestEnd).toBeGreaterThan(requestStart)
    const preamble = frameSource.slice(helperStart, requestStart)
    expect(preamble).toContain('delete helperPayload.character')
    expect(preamble).toContain('delete helperPayload.chatId')
    const body = frameSource.slice(requestStart, requestEnd)
    const payloadIndex = body.indexOf('...helperPayload')
    const opIndex = body.indexOf('op: data.op')
    const characterIndex = body.indexOf('character: current.character')
    const chatIdIndex = body.indexOf('chatId: current.chatId')
    expect(payloadIndex).toBeGreaterThanOrEqual(0)
    expect(opIndex).toBeGreaterThan(payloadIndex)
    expect(characterIndex).toBeGreaterThan(opIndex)
    expect(chatIdIndex).toBeGreaterThan(characterIndex)
  })
})

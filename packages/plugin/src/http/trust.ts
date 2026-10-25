// HTTP trust boundary for the plugin API surface.
//
// The host web server dispatches routes but enforces no server-wide origin or
// authentication policy, so the route owner has to reject browser cross-site
// requests itself. A cross-site simple POST (`text/plain`, no preflight) can
// otherwise reach mutating routes such as games/install, mods/install or
// helper template.render.
//
// This module is pure: callers pass the bind host/port/origin they observed on
// the host service. No ctx access and no IO, so the policy stays unit-testable.

export interface TrustRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

export interface TrustOptions {
  /** Bind host reported by the web server service. */
  host?: string
  /** Bind port reported by the web server service. */
  port?: number
  /** Public origin reported by the web server service, when it exposes one. */
  origin?: string
  /**
   * Extra deployment hosts ("host" or "host:port") beyond loopback and the
   * bind host. Entries are normalized by normalizeAllowedHosts at apply time;
   * a portless entry accepts any port, an explicit port accepts only that one.
   */
  allowedHosts?: readonly string[]
  /**
   * The route owns a raw binary body instead of JSON (virtual IndexedDB
   * upload), so the media-type check must not apply.
   */
  allowNonJsonBody?: boolean
}

export interface TrustFailure {
  status: number
  message: string
}

interface HostAddress {
  hostname: string
  port: number | undefined
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// same-site includes sibling subdomains, which are still a different origin and
// can be controlled by an attacker (subdomain takeover), so only same-origin
// and opaque `none` navigation requests may mutate.
const UNSAFE_FETCH_SITES = new Set(['cross-site', 'same-site'])
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']

/**
 * Validates and normalizes the `allowedHosts` plugin config. Accepts hostnames
 * or IP literals with an optional port; rejects empty entries, wildcards,
 * schemes, paths, credentials and malformed ports. Values are lowercased and
 * one trailing DNS root dot is stripped (via parseHost).
 */
export function normalizeAllowedHosts(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('allowedHosts must be an array of host names')
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`allowedHosts[${index}] must be a string`)
    const trimmed = entry.trim()
    if (trimmed === '') throw new Error(`allowedHosts[${index}] must not be empty`)
    if (trimmed.includes('*')) throw new Error(`allowedHosts[${index}] must not contain a wildcard`)
    const address = parseAllowedHost(trimmed)
    if (address === undefined) {
      throw new Error(`allowedHosts[${index}] must be a host name or host:port without a scheme, path or credentials`)
    }
    return formatAddress(address)
  })
}

/**
 * Returns the rejection for a request that must not reach a route, or
 * undefined when the request passes the trust boundary.
 *
 * Allowed:
 * - no Host header (HTTP/1.0 and in-process local callers);
 * - loopback Host values on any port;
 * - the configured bind host/port, the origin reported by the host service,
 *   and explicit `allowedHosts` deployment entries;
 * - missing sec-fetch-site / origin headers (local non-browser clients);
 * - missing content-type on mutating requests (local non-browser clients).
 *
 * Rejected:
 * - any other Host value (DNS rebinding);
 * - sec-fetch-site cross-site / same-site on mutating requests;
 * - origin that does not match the Host header on mutating requests;
 * - a present non-JSON content-type on mutating requests.
 */
export function requestTrustFailure(req: TrustRequest, options: TrustOptions): TrustFailure | undefined {
  const headers = normalizeHeaders(req.headers)
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
  const hostHeader = firstHeader(headers, 'host')
  const address = hostHeader === undefined ? undefined : parseHost(hostHeader)
  if (hostHeader !== undefined && address === undefined) {
    return { status: 403, message: `malformed Host header '${hostHeader}'` }
  }
  if (address !== undefined && !hostAllowed(address, options)) {
    return { status: 403, message: `Host '${hostHeader ?? ''}' is not allowed` }
  }

  if (!MUTATING_METHODS.has(method)) return undefined

  const fetchSite = firstHeader(headers, 'sec-fetch-site')?.toLowerCase()
  if (fetchSite !== undefined && UNSAFE_FETCH_SITES.has(fetchSite)) {
    return { status: 403, message: `cross-site request rejected (sec-fetch-site: ${fetchSite})` }
  }

  const originHeader = firstHeader(headers, 'origin')
  if (originHeader !== undefined) {
    const origin = parseOrigin(originHeader)
    if (origin === undefined) {
      return { status: 403, message: `Origin '${originHeader}' is not a valid http(s) origin` }
    }
    if (address === undefined) {
      return { status: 403, message: 'Origin header without a Host header is not allowed' }
    }
    if (!sameOrigin(origin, address)) {
      return { status: 403, message: `cross-origin request rejected (Origin ${originHeader}, Host ${hostHeader})` }
    }
  }

  if (options.allowNonJsonBody === true) return undefined

  const contentType = firstHeader(headers, 'content-type')
  if (contentType !== undefined && !isJsonContentType(contentType)) {
    return { status: 415, message: `unsupported content-type '${contentType}'; expected application/json` }
  }

  return undefined
}

/** Normalized lookup table; fake requests may not use Node's lowercase keys. */
function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {}
  if (headers === undefined) return normalized
  for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = value
  return normalized
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined
}

/** Host allowlist: loopback any port, configured bind host at its port. */
function hostAllowed(address: HostAddress, options: TrustOptions): boolean {
  for (const allowed of allowedAddresses(options)) {
    if (allowed.hostname !== address.hostname) continue
    if (allowed.port === undefined || allowed.port === address.port) return true
  }
  return false
}

function allowedAddresses(options: TrustOptions): HostAddress[] {
  const allowed: HostAddress[] = LOOPBACK_HOSTS.map((hostname) => ({ hostname, port: undefined }))
  const configuredHost = normalizedHostname(options.host)
  if (configuredHost !== undefined) {
    const port = validPort(options.port)
    allowed.push({ hostname: configuredHost, port })
  }
  if (options.origin !== undefined) {
    const origin = parseOrigin(options.origin)
    if (origin !== undefined) allowed.push(origin)
  }
  for (const value of options.allowedHosts ?? []) {
    const address = parseAllowedHost(value)
    // Invalid entries are ignored rather than reflected: apply() already
    // rejects them, and a bypassed option must never widen the boundary.
    if (address !== undefined) allowed.push(address)
  }
  return allowed
}

/**
 * Validates one allowlist entry. Unlike the Host header parser this rejects
 * whitespace, path separators, query/fragment markers, credentials, percent
 * escapes (IPv6 zone ids) and wildcards before delegating to parseHost.
 */
function parseAllowedHost(value: string): HostAddress | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (/[\s/\\?#@%*]/.test(trimmed)) return undefined
  return parseHost(trimmed)
}

function formatAddress(address: HostAddress): string {
  const hostname = address.hostname.includes(':') ? `[${address.hostname}]` : address.hostname
  return address.port === undefined ? hostname : `${hostname}:${address.port}`
}

function sameOrigin(origin: HostAddress, host: HostAddress): boolean {
  if (origin.hostname !== host.hostname) return false
  if (host.port !== undefined) return origin.port === host.port
  // A Host header without a port is either HTTP/1.0 or a default-port origin;
  // accept both default schemes because the header itself carries no scheme.
  return origin.port === 80 || origin.port === 443
}

function parseHost(value: string): HostAddress | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let hostnamePart: string
  let portPart: string | undefined
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return undefined
    hostnamePart = trimmed.slice(1, end)
    const rest = trimmed.slice(end + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined
      portPart = rest.slice(1)
    }
  } else {
    const firstColon = trimmed.indexOf(':')
    // A single colon separates host and port; several colons mean a raw IPv6
    // literal, which some local clients send without brackets.
    if (firstColon >= 0 && firstColon === trimmed.lastIndexOf(':')) {
      hostnamePart = trimmed.slice(0, firstColon)
      portPart = trimmed.slice(firstColon + 1)
    } else {
      hostnamePart = trimmed
    }
  }
  const hostname = normalizedHostname(hostnamePart)
  if (hostname === undefined) return undefined
  if (portPart === undefined) return { hostname, port: undefined }
  const port = validPort(Number(portPart))
  if (port === undefined) return undefined
  return { hostname, port }
}

function parseOrigin(value: string): HostAddress | undefined {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const hostname = normalizedHostname(url.hostname)
  if (hostname === undefined) return undefined
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return { hostname, port }
}

/** Lowercase, strip IPv6 brackets and one trailing DNS root dot. */
function normalizedHostname(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  return normalized === '' ? undefined : normalized
}

function validPort(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined
}

function isJsonContentType(value: string): boolean {
  return value.trim().toLowerCase().startsWith('application/json')
}

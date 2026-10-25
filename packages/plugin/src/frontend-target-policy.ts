/**
 * Destination policy for card-owned custom API endpoints (2026-10-25).
 *
 * A JSR card supplies its own OpenAI-compatible base URL, so the host-side
 * bridge would otherwise be an SSRF proxy: an unprivileged card could probe
 * internal HTTPS services and read their status/body snippets back through the
 * generation error. The policy is deliberately conservative and string-only:
 *
 * - loopback (`localhost`, 127.0.0.1, ::1) stays allowed because it is the
 *   documented local development proxy feature;
 * - every other target must use https:// (plain http is loopback-only);
 * - literal private, link-local, unique-local, carrier-grade-NAT, multicast,
 *   documentation and reserved addresses are rejected, including IPv4-mapped
 *   and NAT64 forms of the same addresses;
 * - cloud metadata hostnames and single-label / private-use hostnames are
 *   rejected.
 *
 * The policy cannot resolve DNS here, so a public hostname that later rebinds
 * to a private address is outside this check (documented residual risk). Do not
 * silently substitute another endpoint: callers must surface the rejection.
 */
import { isIP } from 'node:net'

export type CustomApiTargetBlockReason =
  | 'https-required'
  | 'private-address'
  | 'private-hostname'
  | 'metadata-host'

export type CustomApiTargetDecision =
  | { readonly allowed: true; readonly hostname: string; readonly loopback: boolean }
  | {
      readonly allowed: false
      readonly hostname: string
      readonly reason: CustomApiTargetBlockReason
      readonly detail: string
    }

type Ipv4 = readonly [number, number, number, number]
type Ipv6 = readonly [number, number, number, number, number, number, number, number]

const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'metadata.packet.net',
  'metadata.tencentyun.com',
  'metadata.tencent-cloud.com',
  'instance-data',
])

const PRIVATE_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.lan',
  '.localdomain',
  '.intranet',
  '.corp',
  '.private',
]

export function decideCustomApiTarget(url: URL): CustomApiTargetDecision {
  const hostname = normalizeHostname(url.hostname)
  if (isLoopbackHostname(hostname)) {
    return { allowed: true, hostname, loopback: true }
  }
  if (url.protocol === 'http:') {
    return blocked(
      hostname,
      'https-required',
      'use https:// for non-loopback hosts; http:// is allowed only for loopback proxies',
    )
  }
  if (METADATA_HOSTNAMES.has(hostname)) {
    return blocked(hostname, 'metadata-host', 'cloud metadata endpoints are blocked')
  }
  const address = addressVerdict(hostname)
  if (address !== undefined) {
    return address.blocked
      ? blocked(hostname, 'private-address', address.reason)
      : { allowed: true, hostname, loopback: false }
  }
  if (isPrivateHostname(hostname)) {
    return blocked(
      hostname,
      'private-hostname',
      'single-label and private-use hostnames are blocked; use a public HTTPS host or a loopback proxy',
    )
  }
  return { allowed: true, hostname, loopback: false }
}

function blocked(
  hostname: string,
  reason: CustomApiTargetBlockReason,
  detail: string,
): CustomApiTargetDecision {
  return { allowed: false, hostname, reason, detail }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const literal = stripBrackets(hostname)
  const version = isIP(literal)
  if (version === 4) return literal === '127.0.0.1'
  if (version !== 6) return false
  const hextets = ipv6Hextets(literal)
  if (hextets === undefined) return false
  if (isIpv6Loopback(hextets)) return true
  const mapped = mappedIpv4(hextets)
  return mapped !== undefined && isIpv4Loopback(mapped)
}

function isPrivateHostname(hostname: string): boolean {
  // A bare single-label name resolves on the host's search domain; treat it as
  // private service discovery rather than as a public API host.
  if (!hostname.includes('.')) return true
  return PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

function addressVerdict(
  hostname: string,
): { readonly blocked: true; readonly reason: string } | { readonly blocked: false } | undefined {
  const literal = stripBrackets(hostname)
  const version = isIP(literal)
  if (version !== 4 && version !== 6) return undefined
  if (version === 4) {
    const octets = ipv4Octets(literal)
    if (octets === undefined) return { blocked: true, reason: 'invalid IPv4 literal' }
    const reason = ipv4BlockReason(octets)
    return reason === undefined ? { blocked: false } : { blocked: true, reason }
  }
  const hextets = ipv6Hextets(literal)
  if (hextets === undefined) return { blocked: true, reason: 'invalid IPv6 literal' }
  const reason = ipv6BlockReason(hextets)
  return reason === undefined ? { blocked: false } : { blocked: true, reason }
}

function ipv6BlockReason(hextets: Ipv6): string | undefined {
  if (isIpv6Unspecified(hextets)) return ':: (unspecified address)'
  if (isIpv6LinkLocal(hextets)) return 'fe80::/10 (link-local)'
  if (isIpv6UniqueLocal(hextets)) return 'fc00::/7 (unique local)'
  if (isIpv6Multicast(hextets)) return 'ff00::/8 (multicast)'
  if (isIpv6Documentation(hextets)) return '2001:db8::/32 (documentation)'
  if (isIpv6SixToFour(hextets)) return '6to4 range (embeds an arbitrary IPv4 address)'
  if (isIpv6Teredo(hextets)) return 'Teredo range (embeds an arbitrary IPv4 address)'
  const mapped = mappedIpv4(hextets)
  if (mapped !== undefined) return mappedBlockReason(mapped, 'IPv4-mapped IPv6')
  const nat64 = nat64Ipv4(hextets)
  if (nat64 !== undefined) return mappedBlockReason(nat64, 'NAT64')
  if (isDeprecatedIpv4Compatible(hextets)) return 'deprecated IPv4-compatible IPv6 address'
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0x0001) {
    return '64:ff9b:1::/48 (local-use NAT64 prefix)'
  }
  return undefined
}

function mappedBlockReason(octets: Ipv4, label: string): string | undefined {
  const reason = ipv4BlockReason(octets)
  return reason === undefined ? undefined : `${label} address ${octets.join('.')}: ${reason}`
}

function ipv4BlockReason([a, b, c]: Ipv4): string | undefined {
  if (a === 0) return '0.0.0.0/8 (this network / unspecified)'
  if (a === 10) return '10.0.0.0/8 (RFC1918)'
  if (a === 100 && b >= 64 && b <= 127) {
    return '100.64.0.0/10 (carrier-grade NAT; includes cloud metadata ranges)'
  }
  if (a === 127) return '127.0.0.0/8 (loopback; only 127.0.0.1 is accepted)'
  if (a === 169 && b === 254) return '169.254.0.0/16 (link-local / cloud metadata)'
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (RFC1918)'
  if (a === 192 && b === 168) return '192.168.0.0/16 (RFC1918)'
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return '192.0.0.0/24 or 192.0.2.0/24 (IETF/documentation)'
  if (a === 192 && b === 88 && c === 99) return '6to4 relay anycast range'
  if (a === 198 && (b === 18 || b === 19)) return '198.18.0.0/15 (benchmarking)'
  if (a === 198 && b === 51 && c === 100) return '198.51.100.0/24 (documentation)'
  if (a === 203 && b === 0 && c === 113) return '203.0.113.0/24 (documentation)'
  if (a >= 224) return '224.0.0.0/4 or above (multicast / reserved)'
  return undefined
}

function isIpv4Loopback([a, b, c, d]: Ipv4): boolean {
  return a === 127 && b === 0 && c === 0 && d === 1
}

function ipv4Octets(text: string): Ipv4 | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  const values: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    values.push(value)
  }
  return toIpv4(values)
}

function toIpv4(values: number[]): Ipv4 | undefined {
  if (values.length !== 4) return undefined
  const [a, b, c, d] = values
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined
  return [a, b, c, d]
}

function ipv6Hextets(input: string): Ipv6 | undefined {
  const text = stripBrackets(input)
  if (text === '' || text.includes('%')) return undefined
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = parseHextets(halves[0] ?? '')
  const tail = halves.length === 2 ? parseHextets(halves[1] ?? '') : []
  if (head === undefined || tail === undefined) return undefined
  if (halves.length === 1) {
    if (head.length !== 8) return undefined
    return toIpv6(head)
  }
  const missing = 8 - head.length - tail.length
  if (missing < 1) return undefined
  return toIpv6([...head, ...Array.from({ length: missing }, () => 0), ...tail])
}

function parseHextets(side: string): number[] | undefined {
  if (side === '') return []
  const values: number[] = []
  for (const part of side.split(':')) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined
    values.push(Number.parseInt(part, 16))
  }
  return values
}

function toIpv6(values: number[]): Ipv6 | undefined {
  if (values.length !== 8) return undefined
  const [a, b, c, d, e, f, g, h] = values
  if (a === undefined || b === undefined || c === undefined || d === undefined
    || e === undefined || f === undefined || g === undefined || h === undefined) {
    return undefined
  }
  return [a, b, c, d, e, f, g, h]
}

function isIpv6Loopback(hextets: Ipv6): boolean {
  return hextets.every((value, index) => (index === 7 ? value === 1 : value === 0))
}

function isIpv6Unspecified(hextets: Ipv6): boolean {
  return hextets.every((value) => value === 0)
}

function isIpv6LinkLocal(hextets: Ipv6): boolean {
  return (hextets[0] & 0xffc0) === 0xfe80
}

function isIpv6UniqueLocal(hextets: Ipv6): boolean {
  return (hextets[0] & 0xfe00) === 0xfc00
}

function isIpv6Multicast(hextets: Ipv6): boolean {
  return (hextets[0] & 0xff00) === 0xff00
}

function isIpv6Documentation(hextets: Ipv6): boolean {
  return hextets[0] === 0x2001 && hextets[1] === 0x0db8
}

function isIpv6SixToFour(hextets: Ipv6): boolean {
  return hextets[0] === 0x2002
}

function isIpv6Teredo(hextets: Ipv6): boolean {
  return hextets[0] === 0x2001 && hextets[1] === 0x0000
}

function mappedIpv4(hextets: Ipv6): Ipv4 | undefined {
  const [a, b, c, d, e, f, g, h] = hextets
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [(g >> 8) & 0xff, g & 0xff, (h >> 8) & 0xff, h & 0xff]
  }
  return undefined
}

function nat64Ipv4(hextets: Ipv6): Ipv4 | undefined {
  const [a, b, c, d, e, f, g, h] = hextets
  if (a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return [(g >> 8) & 0xff, g & 0xff, (h >> 8) & 0xff, h & 0xff]
  }
  return undefined
}

function isDeprecatedIpv4Compatible(hextets: Ipv6): boolean {
  return hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0
    && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0
}
/**
 * Who a request is from, and what it travelled over, once something else is
 * standing in front.
 *
 * Behind a reverse proxy every request arrives from the proxy, over plaintext,
 * on loopback. Both facts the door needs — the client's address, for the
 * throttle, and whether the connection was encrypted, for the token — are
 * therefore in headers the proxy wrote. Headers are also the easiest thing in
 * HTTP to lie about, so the whole of this module is about being precise on one
 * point: **a forwarded header is believed only where a proxy was declared, and
 * only at the hop that proxy occupies.**
 *
 * The hop count is why `x-forwarded-for` is read from the RIGHT. The header
 * grows left to right as it crosses proxies, so the leftmost entry is whatever
 * the first client claimed — attacker-controlled, always. The rightmost entries
 * were appended by infrastructure that this deployment declared, one per hop.
 * Counting in from the right lands on the address the nearest honest proxy
 * observed; counting from the left lands on a string the attacker chose.
 *
 * Nothing here imports anything but the vocabulary, so what this deployment
 * believes about a header is decided by tests.
 * @module @omdsh-plugins/omdsh-remctrl/forward
 */

import type { Carrier } from './contract.ts'

/**
 * As much of `node:http`'s `IncomingMessage` as this module reads.
 *
 * Structural, so a spec can hand it an object literal, and narrow, so nothing
 * here can reach a socket or a stream by accident.
 */
export interface RequestFacts {
  /** Lowercased header names to values, as Node presents them. */
  headers: Readonly<Record<string, string | string[] | undefined>>
  /** The peer address of the TCP connection, when there is one. */
  remoteAddress?: string | undefined
  /** Whether the socket itself is TLS. Always false today — this plugin terminates no TLS. */
  encrypted?: boolean | undefined
}

/** How much of a forwarding chain this deployment vouches for. */
export interface ProxyTrust {
  /** Whether any forwarded header is believed at all. */
  enabled: boolean
  /**
   * How many proxies stand in front.
   *
   * One is the ordinary answer (a Caddy or an nginx on the same box). Two is a
   * CDN in front of that. The number is how far in from the right of
   * `x-forwarded-for` the client's own address sits.
   */
  hops: number
}

/** The trust a directly-bound gate extends, which is none. */
export const NO_PROXY: ProxyTrust = { enabled: false, hops: 0 }

/**
 * How much of a forwarding chain a carrier vouches for.
 *
 * DERIVED rather than configured, and that is the whole reason this version has
 * no `trustedProxyHops` field. Each answer is forced by what the carrier IS:
 *
 * - `tunnel` — every request arrives from `cloudflared` on this machine's own
 *   loopback, so the socket address is useless and `x-forwarded-for` is the
 *   only place the client's address exists. Exactly one hop, because
 *   `cloudflared` is exactly one process and it is the one we spawned.
 * - `direct` — the socket peer IS the client, and every `x-forwarded-*` header
 *   on the request was written by that client. Believing one would hand a
 *   single attacker a throttle bucket per address they care to invent.
 * - `fronted` over **https** — something terminated TLS to get here, which
 *   means it is a reverse proxy, which means it sets `x-forwarded-for`. One
 *   hop, same as the tunnel.
 * - `fronted` over **http** — this is the `ssh -R` shape, and an ssh reverse
 *   forward sets no headers at all: the request arrives from loopback naked, so
 *   any `x-forwarded-for` on it was written by the client. Believed at zero
 *   hops.
 *
 * The cost of that last row is a throttle that keys every sign-in attempt to
 * `127.0.0.1` — one shared bucket rather than one per address. That is a weaker
 * throttle and a *safer* one: nobody can mint themselves fresh budgets, and an
 * attacker who exhausts it locks out sign-in but not the browsers already
 * signed in. A forgeable bucket would be no throttle at all.
 * @param carrier - how the gate is reached.
 * @param secure - for `fronted`, whether the declared URL is https.
 * @returns the trust.
 */
export function proxyTrustFor(carrier: Carrier, secure = false): ProxyTrust {
  if (carrier === 'tunnel') return { enabled: true, hops: 1 }
  if (carrier === 'fronted' && secure) return { enabled: true, hops: 1 }
  return NO_PROXY
}

/**
 * One header, as a list of comma-separated entries in order.
 *
 * Node hands back an array when a header appeared more than once, and each
 * appearance may itself be a comma list; RFC 7230 says the two spellings mean
 * the same thing, so they are flattened into one sequence here rather than at
 * three call sites.
 * @param facts - the request.
 * @param name - the lowercase header name.
 * @returns the entries, trimmed, without empties.
 */
export function headerList(facts: RequestFacts, name: string): string[] {
  const raw = facts.headers[name]
  if (raw === undefined) return []
  const parts = Array.isArray(raw) ? raw : [raw]
  return parts
    .flatMap(part => part.split(','))
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * The address to hold responsible for this request.
 *
 * With no declared proxy this is the socket's peer, which cannot be forged over
 * TCP. With one, it is the entry `hops` in from the right of
 * `x-forwarded-for` — see the module note for why the right.
 *
 * A chain SHORTER than the declared hop count means the request did not come
 * through the declared proxies. The leftmost entry is used and the caller is
 * told, because the alternative — silently trusting a short chain — is how one
 * attacker gets a throttle bucket per fake address.
 * @param facts - the request.
 * @param trust - what this deployment vouches for.
 * @returns the address and whether it came from a header.
 */
export function clientAddress(
  facts: RequestFacts,
  trust: ProxyTrust,
): { address: string; forwarded: boolean; short: boolean } {
  const socket = normalizeAddress(facts.remoteAddress ?? '')
  if (!trust.enabled) return { address: socket, forwarded: false, short: false }

  const chain = headerList(facts, 'x-forwarded-for')
  if (chain.length === 0) {
    // `x-real-ip` is nginx's single-value spelling of the same fact. It carries
    // no chain, so it is only read when there is no chain to read.
    const real = headerList(facts, 'x-real-ip')[0]
    if (real !== undefined) return { address: normalizeAddress(real), forwarded: true, short: false }
    return { address: socket, forwarded: false, short: true }
  }

  const index = chain.length - trust.hops
  const short = index < 0
  const entry = chain[Math.max(0, index)] ?? socket
  return { address: normalizeAddress(entry), forwarded: true, short }
}

/**
 * The scheme this request reached the OUTERMOST hop over.
 *
 * Read at the same hop as the address and for the same reason: with two proxies
 * declared, `x-forwarded-proto: https, http` means the client spoke HTTPS to
 * the CDN and the CDN spoke HTTP to the origin — and the fact worth knowing,
 * the one about the client, is on the left of that pair. So proto counts from
 * the LEFT where the address counts from the right. They are different
 * questions: the address asks who the nearest honest proxy saw, the scheme asks
 * what the phone actually used.
 * @param facts - the request.
 * @param trust - what this deployment vouches for.
 * @returns `'https'`, `'http'`, or undefined when nothing said.
 */
export function requestProto(facts: RequestFacts, trust: ProxyTrust): 'http' | 'https' | undefined {
  if (facts.encrypted === true) return 'https'
  if (!trust.enabled) return facts.remoteAddress === undefined ? undefined : 'http'
  const declared = headerList(facts, 'x-forwarded-proto')[0]?.toLowerCase()
  if (declared === 'https' || declared === 'http') return declared
  // RFC 7239's spelling, which some proxies emit instead: `for=…;proto=https`.
  for (const element of headerList(facts, 'forwarded')) {
    const match = /(?:^|;)\s*proto\s*=\s*"?(?<proto>[A-Za-z]+)"?/.exec(element)
    const proto = match?.groups?.['proto']?.toLowerCase()
    if (proto === 'https' || proto === 'http') return proto
  }
  return undefined
}

/** What {@link checkTransport} decided about the wire a request arrived on. */
export type TransportVerdict =
  /** Good enough to carry a session cookie. */
  | { kind: 'ok' }
  /** Not good enough, and why. The gate answers this rather than serving. */
  | { kind: 'refused'; message: string }

/**
 * Whether this request arrived over something a session cookie may cross.
 *
 * The check exists for the carriers that PROMISED encryption somebody else
 * performs — the tunnel, and a `fronted` deployment whose declared URL is
 * https. Those are the two where the gate has to ask whether the promise was
 * kept, because a `cloudflared` or a Caddy misconfigured onto plain HTTP is a
 * real thing that would otherwise put a cookie granting shell access into the
 * clear.
 *
 * The others have nothing left to ask: `direct`, and `fronted` over http, are
 * plaintext that somebody acknowledged in writing before the gate would open.
 * @param input - the carrier, whether it promised TLS, the acknowledgement, the request, and the trust.
 * @returns the verdict; see {@link TransportVerdict}.
 */
export function checkTransport(input: {
  carrier: Carrier
  /** For `fronted`, whether the declared URL is https. Ignored otherwise. */
  secure?: boolean
  allowInsecure: boolean
  facts: RequestFacts
  trust: ProxyTrust
}): TransportVerdict {
  const { carrier, allowInsecure, facts, trust } = input
  const promised = carrier === 'tunnel' || (carrier === 'fronted' && input.secure === true)
  if (!promised) return { kind: 'ok' }
  if (allowInsecure) return { kind: 'ok' }
  const proto = requestProto(facts, trust)
  if (proto === 'https') return { kind: 'ok' }
  return {
    kind: 'refused',
    message: proto === undefined
      ? 'this gate sits behind a TLS terminator, and nothing upstream said what scheme you used; '
        + 'whatever carries it must set x-forwarded-proto'
      : 'this gate sits behind a TLS terminator, and this request arrived over http',
  }
}

/**
 * One address, in the spelling the throttle should key on.
 *
 * IPv4-mapped IPv6 (`::ffff:203.0.113.7`) is how a dual-stack socket reports an
 * IPv4 peer, and a port suffix is how some proxies write an entry. Neither
 * changes who the client is, and both would otherwise hand one address two
 * buckets.
 * @param value - the address as observed.
 * @returns the normalized address; `'unknown'` when there was none.
 */
export function normalizeAddress(value: string): string {
  let address = value.trim().toLowerCase()
  if (address === '') return 'unknown'
  if (address.startsWith('[')) {
    // `[::1]:5432` — brackets exist precisely so the port is separable.
    const close = address.indexOf(']')
    if (close > 0) address = address.slice(1, close)
  }
  else if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length)
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mapped)) address = mapped
  }
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'))
  }
  // A zone id names an interface on this machine, not a party on the network.
  const zone = address.indexOf('%')
  if (zone > 0) address = address.slice(0, zone)
  return address === '' ? 'unknown' : address
}

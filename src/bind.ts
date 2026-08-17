/**
 * Where the door listens, and the URL it is reached at.
 *
 * Two carriers, and the address follows from them rather than being configured
 * beside them — which is the point of this version. The previous one had a
 * four-rung exposure ladder and a separate `bindHost` override, and the two
 * could contradict each other in ways that took a boot line to discover.
 *
 * The one place that is not a straight two-way branch is the `direct` carrier,
 * and it is worth stating why: **a public host that this machine actually holds
 * is bound exactly, and one it does not is bound on every interface.** Both
 * halves are forced.
 *
 * - A cloud VM's public address belongs to the provider's NAT and is on no
 *   local interface. Binding it verbatim fails with `EADDRNOTAVAIL` on
 *   precisely the machines that carrier exists for, so the wildcard is the only
 *   thing that works.
 * - A tailnet address IS on a local interface, and binding the wildcard for it
 *   would put a plaintext port on every OTHER network the laptop is on as well
 *   — the café Wi-Fi, the hotel LAN — for no benefit whatsoever. Binding the
 *   address that was asked for is both narrower and more obviously correct.
 *
 * That second case is also the one that needs no acknowledgement: plaintext
 * inside WireGuard is not plaintext on a wire anybody can read.
 *
 * The only import is the vocabulary and one address normalizer, so what this
 * deployment binds is decided by tests.
 * @module @omdsh-plugins/omdsh-remctrl/bind
 */

import { LOOPBACK, type Carrier } from './contract.ts'
import { normalizeAddress } from './forward.ts'

/** Every interface, which is the only address a NAT'd public IP can be reached on. */
export const WILDCARD = '0.0.0.0'

/**
 * Tailscale's IPv4 range, and the CGNAT block it borrows: `100.64.0.0/10`.
 *
 * An address in it ON A LOCAL INTERFACE is, in practice, a WireGuard mesh —
 * Tailscale or one of its relatives. It is not a proof: an ISP doing
 * carrier-grade NAT uses the same block, and a machine that is its own CPE
 * could hold one. What makes the assumption safe enough to hang the
 * acknowledgement on is that such an address is not routable from the internet
 * either way, so the worst case is a plaintext port reachable by other
 * customers of one ISP rather than by everybody.
 */
export const TAILNET_CIDR = '100.64.0.0/10'

/**
 * Tailscale's IPv6 range: `fd7a:115c:a1e0::/48`.
 *
 * A ULA prefix Tailscale allocated to itself, and a far better signal than the
 * IPv4 one — nothing else uses it, so an address here is a tailnet address
 * rather than probably-a-tailnet-address.
 *
 * It earns its place for a reason that is not theoretical: a machine running
 * another VPN in TUN mode can have its `100.64.0.0/10` route stolen — the range
 * is CGNAT space and proxies claim it routinely — while the v6 prefix, which
 * nobody else wants, keeps working. When that happens the v6 address is the
 * only one of the pair that carries traffic.
 */
export const TAILNET_CIDR6 = 'fd7a:115c:a1e0::/48'

/** How far the bound address reaches. */
export type BindScope =
  /** This machine only. */
  | 'loopback'
  /** A WireGuard mesh: plaintext on the wire, but the wire is encrypted. */
  | 'tailnet'
  /** Everything else — a LAN, a public address, or every interface at once. */
  | 'wide'

/** What was decided about the listen address. */
export type BindDecision =
  /** Bind here. */
  | { kind: 'ok'; host: string; carrier: Carrier; scope: BindScope }
  /** Do not bind, and why. */
  | { kind: 'refused'; carrier: Carrier; message: string }

/** What the decision depends on. */
export interface BindRequest {
  enabled: boolean
  carrier: Carrier
  /** The configured host, trimmed; `''` under the tunnel. */
  publicHost: string
  allowInsecure: boolean
  /** Whether this composition has a web interface to forward at all. */
  hasUpstream: boolean
  /** Every address this machine holds; see {@link localAddresses}. */
  available: readonly string[]
}

/** As much of `os.networkInterfaces()` as this module reads. */
export type InterfaceTable = Record<string, Array<{ address: string }> | undefined>

/**
 * Every address this machine holds.
 *
 * Loopback included, deliberately: somebody who writes `127.0.0.1` into
 * `publicHost` is asking for a loopback bind, and refusing to match it would
 * silently give them every interface instead.
 * @param table - what `os.networkInterfaces()` returned.
 * @returns the addresses, normalized and deduplicated.
 */
export function localAddresses(table: InterfaceTable): string[] {
  const held = new Set<string>()
  for (const entries of Object.values(table)) {
    for (const entry of entries ?? []) held.add(normalizeAddress(entry.address))
  }
  held.delete('unknown')
  return [...held]
}

/**
 * Whether one address is a tailnet address, in either family.
 * @param address - the address, in any spelling.
 * @returns whether it is in {@link TAILNET_CIDR} or {@link TAILNET_CIDR6}.
 */
export function isTailnetAddress(address: string): boolean {
  const value = normalizeAddress(address)
  if (value.includes(':')) {
    // The /48 is the first three groups, and each of them is a full four hex
    // digits — so no `::` compression and no leading-zero spelling can move
    // them, and a prefix compare is exact rather than approximate.
    const groups = value.split(':')
    return groups.length >= 3 && groups[0] === 'fd7a' && groups[1] === '115c' && groups[2] === 'a1e0'
  }
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const [first, second] = parts.map(part => Number(part))
  if (first !== 100) return false
  return second !== undefined && Number.isInteger(second) && second >= 64 && second <= 127
}

/** Every tailnet address this machine holds. */
export function tailnetAddresses(available: readonly string[]): string[] {
  return available.filter(isTailnetAddress)
}

/** What was written in `publicHost`, read for what it means. */
export type PublicHost =
  /** Nothing. Go and fetch an address. */
  | { kind: 'none' }
  /** A bare address or name: this process is the thing people reach. */
  | { kind: 'address'; host: string }
  /**
   * A whole URL: something else carries the traffic here.
   *
   * `secure` comes from the URL's own scheme, and it is the only thing that
   * decides whether the carrier is believed to terminate TLS. That is not an
   * inference — it is what the person wrote down about how they are reached.
   */
  | { kind: 'fronted'; url: string; secure: boolean }

/**
 * Read `publicHost` for which deployment it describes.
 *
 * The SHAPE carries the meaning, which is what keeps this to one field: a
 * second setting saying "and there is a proxy in front" could disagree with the
 * first, and in the previous design it regularly did.
 * @param publicHost - the configured value, in any spelling.
 * @returns what it means; see {@link PublicHost}.
 */
export function readPublicHost(publicHost: string): PublicHost {
  const value = publicHost.trim()
  if (value === '') return { kind: 'none' }
  if (!/^https?:\/\//i.test(value)) return { kind: 'address', host: value }
  try {
    const url = new URL(value)
    return {
      kind: 'fronted',
      // Normalized and stripped of a trailing slash: it is concatenated with
      // paths and query strings later, and `https://x//?k=…` is a different
      // origin to a browser than the person meant.
      url: url.origin,
      secure: url.protocol === 'https:',
    }
  } catch {
    // Unreachable through `checkPublicHost`, which refuses this first. Treated
    // as a bare host rather than thrown, because a bind decision that throws
    // takes the plugin down instead of refusing.
    return { kind: 'address', host: value }
  }
}

/**
 * Which carrier a configuration means.
 * @param publicHost - the configured value, possibly empty.
 * @returns the carrier.
 */
export function carrierFor(publicHost: string): Carrier {
  const read = readPublicHost(publicHost)
  return read.kind === 'none' ? 'tunnel' : read.kind === 'fronted' ? 'fronted' : 'direct'
}

/**
 * The address this machine holds that the configured host names, if any.
 *
 * Literals only. A NAME cannot be matched here without a resolver, and a
 * resolver is I/O in a function that has to stay decidable — but it is also
 * the right answer for the commonest naming case: somebody who writes
 * `harness.example.com` has a DNS record pointing at a public address, and a
 * public address is exactly the case that must bind the wildcard.
 * @param publicHost - the configured host, trimmed.
 * @param available - every address this machine holds.
 * @returns the held address, or undefined when the host is a name or is not ours.
 */
export function heldAddress(
  publicHost: string,
  available: readonly string[],
): string | undefined {
  const wanted = normalizeAddress(publicHost)
  if (wanted === 'unknown') return undefined
  return available.find(address => normalizeAddress(address) === wanted)
}

/**
 * Decide the listen address.
 * @param request - see {@link BindRequest}.
 * @returns the decision; see {@link BindDecision}.
 */
export function resolveBind(request: BindRequest): BindDecision {
  const { carrier } = request
  if (!request.enabled) {
    return { kind: 'refused', carrier, message: 'omdsh-remctrl: switched off. Turn it on from the plugin\'s card.' }
  }
  if (!request.hasUpstream) {
    return {
      kind: 'refused',
      carrier,
      message: 'omdsh-remctrl: this harness composes no web interface, so there is nothing to forward. '
        + 'Remote control is for the web and desktop shapes.',
    }
  }
  if (carrier === 'tunnel') {
    // Loopback, and that is the whole security story for this carrier: the only
    // client is a `cloudflared` this process spawned, running beside it. A
    // wildcard bind here would put an unencrypted copy of the door on the LAN
    // in addition to the tunnel, for no benefit at all.
    return { kind: 'ok', host: LOOPBACK, carrier, scope: 'loopback' }
  }

  if (carrier === 'fronted') {
    const read = readPublicHost(request.publicHost)
    const secure = read.kind === 'fronted' && read.secure
    // Loopback for every carrier in this family, and it is not a guess: a Caddy
    // on this box, an `ssh -R` from a VPS, an `frp`, a named Cloudflare tunnel
    // — every one of them reaches this process on 127.0.0.1. Binding wider
    // would add an exposure the carrier does not need and the person did not
    // ask for.
    if (secure) return { kind: 'ok', host: LOOPBACK, carrier, scope: 'loopback' }
    // A plaintext URL says the traffic crosses a network in the clear before it
    // gets here. The loopback bind does not change that, so the acknowledgement
    // is the same one the wide `direct` bind takes.
    if (!request.allowInsecure) {
      return {
        kind: 'refused',
        carrier,
        message: 'omdsh-remctrl: the address you are reached at is plain http, so the session cookie — which grants '
          + 'everything this harness can do — crosses a network unencrypted before it arrives. Set allowInsecure to '
          + 'say you meant it, or put TLS on the carrier and write the https URL here.',
      }
    }
    return { kind: 'ok', host: LOOPBACK, carrier, scope: 'loopback' }
  }

  const held = heldAddress(request.publicHost, request.available)
  const host = held ?? WILDCARD
  const scope: BindScope = held === undefined
    ? 'wide'
    : isTailnetAddress(held) ? 'tailnet' : host === LOOPBACK ? 'loopback' : 'wide'

  // A tailnet address needs no acknowledgement, and that is not a shortcut: the
  // acknowledgement exists because the session cookie would cross a wire
  // somebody else can read, and inside WireGuard it does not. Loopback likewise
  // — somebody who asked for `127.0.0.1` by name is asking for a door only this
  // machine can open.
  if (scope === 'wide' && !request.allowInsecure) {
    return {
      kind: 'refused',
      carrier,
      message: held === undefined
        ? 'omdsh-remctrl: a public host is set that this machine does not hold, so the door would listen on every '
          + 'interface, in plain HTTP. The session cookie would cross the internet in the clear, and it grants '
          + 'everything this harness can do. Set allowInsecure to say you meant it — or clear publicHost and let '
          + 'the tunnel carry it over https.'
        : `omdsh-remctrl: ${host} is an address this machine holds, but it is not a tailnet address, so the door `
          + 'would serve plain HTTP on a network you may not control. Set allowInsecure to say you meant it.',
    }
  }
  return { kind: 'ok', host, carrier, scope }
}

/**
 * The URL a browser should open.
 * @param input - the carrier, the configured host, the port, and the tunnel's URL.
 * @returns the URL, or `''` when nothing is reachable yet.
 */
export function reachableUrl(input: {
  decision: BindDecision
  publicHost: string
  port: number
  tunnelUrl?: string | undefined
}): string {
  if (input.decision.kind !== 'ok') return ''
  if (input.decision.carrier === 'tunnel') return input.tunnelUrl ?? ''
  const read = readPublicHost(input.publicHost)
  // A fronted deployment was told its own URL, port and all. Rebuilding one
  // from the bound address would produce `http://127.0.0.1:3081`, which is
  // true and useless.
  if (read.kind === 'fronted') return read.url
  return `http://${bracket(input.publicHost.trim())}:${String(input.port)}`
}

/**
 * The same URL with the passcode on it — what the card's sign-in link is.
 * @param url - the base URL, or `''`.
 * @param passcode - the passcode, or `''`.
 * @param param - the query parameter name.
 * @returns the link, or `''` when either half is missing.
 */
export function signInLink(url: string, passcode: string, param: string): string {
  if (url === '' || passcode === '') return ''
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(param, passcode)
    return parsed.toString()
  } catch {
    return ''
  }
}

/**
 * A host, ready to sit in a URL.
 *
 * A bare IPv6 literal has colons in it, which a URL reads as the port
 * separator; brackets are what tell it otherwise. A host that already has them,
 * or has none of its own, is left alone.
 * @param host - the configured host.
 * @returns the host as a URL authority.
 */
export function bracket(host: string): string {
  if (host.startsWith('[') || !host.includes(':')) return host
  return `[${host}]`
}

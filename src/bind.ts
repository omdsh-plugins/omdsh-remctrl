/**
 * Where this plugin is allowed to listen.
 *
 * The harness's own carrier refuses to bind anywhere but loopback, and the web
 * app's CLI says why in as many words: binding wider *would expose remote code
 * execution to the network*. This plugin opens a second listener, so it
 * inherits that argument and has to answer it.
 *
 * The answer is that the objection is to exposing an agent to a network
 * WITHOUT authentication, and to a network anyone can join. This module
 * enforces the second half structurally: the only addresses it will hand back
 * as bindable are loopback and an address this machine actually holds inside
 * Tailscale's `100.64.0.0/10`. A LAN address is refused. `0.0.0.0` is refused.
 * A tailnet address belonging to some other machine is refused. There is no
 * configuration value — no escape hatch, no "I know what I'm doing" flag —
 * that makes this plugin put the harness on a public interface.
 *
 * Everything here is a pure function over an interface table, so the whole
 * policy is decided by tests rather than by whatever machine happens to run
 * them.
 * @module @omdsh-plugins/omdsh-remctrl/bind
 */

import { LOOPBACK } from './contract.ts'

/**
 * One address on one interface, as much of `os.NetworkInterfaceInfo` as this
 * module reads. Structural so the policy can be tested against a table a spec
 * wrote, and so nothing here imports `node:os`.
 */
export interface InterfaceAddress {
  /** `'IPv4'` or `'IPv6'` on Node 18 and later. */
  family: string
  /** The address literal. */
  address: string
  /** Whether the interface is a loopback/internal one. */
  internal: boolean
}

/** The shape `os.networkInterfaces()` returns. */
export type InterfaceTable = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>

/**
 * Tailscale's address space: the carrier-grade NAT block `100.64.0.0/10`.
 *
 * Matching the RANGE rather than the interface name is deliberate. The name is
 * platform-specific and unstable — `utun4` on macOS, `tailscale0` on Linux,
 * `Tailscale` on Windows, and on macOS the number moves between reboots — while
 * the range is the same everywhere Tailscale runs. The block is real CGNAT
 * space that an ISP may also use, but an ISP's use of it is upstream of this
 * machine; an address IN it, held BY a local non-internal interface, is a
 * tailnet address in every deployment this plugin targets.
 */
export const TAILNET_CIDR = '100.64.0.0/10'

/**
 * Whether an address literal is a well-formed IPv4 address inside
 * {@link TAILNET_CIDR}.
 * @param address - the literal to test.
 * @returns true when it parses as IPv4 and falls in the tailnet block.
 */
export function isTailnetAddress(address: string): boolean {
  const octets = address.split('.')
  if (octets.length !== 4) return false
  const parsed: number[] = []
  for (const octet of octets) {
    // `Number` would accept ' 12', '0x0c', and '1e2'. Leading zeros are
    // refused too: `inet_aton` reads `064` as octal, so accepting it here
    // would let one address have two spellings — and only one of them would
    // ever match the literal the OS reports.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return false
    const value = Number(octet)
    if (value > 255) return false
    parsed.push(value)
  }
  const [first, second] = parsed as [number, number, number, number]
  // 100.64.0.0/10 fixes the first octet and the top two bits of the second.
  return first === 100 && second >= 64 && second <= 127
}

/**
 * Every tailnet address this machine holds.
 * @param interfaces - the interface table, normally `os.networkInterfaces()`.
 * @returns the addresses, in interface-table order, without duplicates.
 */
export function tailnetAddresses(interfaces: InterfaceTable): string[] {
  const found: string[] = []
  for (const addresses of Object.values(interfaces)) {
    if (addresses === undefined) continue
    for (const entry of addresses) {
      if (entry.family !== 'IPv4') continue
      if (entry.internal) continue
      if (!isTailnetAddress(entry.address)) continue
      if (!found.includes(entry.address)) found.push(entry.address)
    }
  }
  return found
}

/** What {@link resolveBind} decided about a configured bind host. */
export type BindDecision =
  /**
   * Loopback. Reachable from this machine only; a phone gets here through
   * `tailscale serve`, which is also the deployment that has TLS and therefore
   * the one that can install a PWA and receive push.
   */
  | { kind: 'loopback'; host: string }
  /**
   * A tailnet address this machine holds. Reachable from every node on the
   * tailnet, over WireGuard, without TLS.
   */
  | { kind: 'tailnet'; host: string }
  /**
   * Not bindable, and why. The listener does not start; a refusal names what
   * was asked for and what would have been accepted, because "remote control
   * did not come up" is otherwise a silent boot.
   */
  | { kind: 'refused'; host: string; message: string }

/**
 * Decide whether a configured bind host may be listened on.
 * @param host - the configured value.
 * @param available - this machine's tailnet addresses, from {@link tailnetAddresses}.
 * @returns the decision; see {@link BindDecision}.
 */
export function resolveBind(host: string, available: readonly string[]): BindDecision {
  if (host === LOOPBACK || host === 'localhost') return { kind: 'loopback', host: LOOPBACK }
  if (host === '0.0.0.0' || host === '::' || host === '*') {
    return {
      kind: 'refused',
      host,
      message: `omdsh-remctrl refuses to bind ${host}: that is every interface, including whatever public one this machine has. `
        + `Bind ${LOOPBACK} and put \`tailscale serve\` in front of it, or bind one of this machine's tailnet addresses`
        + `${available.length > 0 ? ` (${available.join(', ')})` : ' once Tailscale is running'}.`,
    }
  }
  if (!isTailnetAddress(host)) {
    return {
      kind: 'refused',
      host,
      message: `omdsh-remctrl refuses to bind ${host}: it is neither loopback nor an address in ${TAILNET_CIDR}. `
        + 'This plugin puts an agent behind a door; the door may only open onto a private network'
        + `${available.length > 0 ? `. This machine's tailnet addresses are ${available.join(', ')}` : ''}.`,
    }
  }
  if (!available.includes(host)) {
    return {
      kind: 'refused',
      host,
      message: `omdsh-remctrl cannot bind ${host}: it is a tailnet address, but not one this machine holds`
        + `${available.length > 0 ? ` — this machine has ${available.join(', ')}` : '; Tailscale does not appear to be up'}.`,
    }
  }
  return { kind: 'tailnet', host }
}

/**
 * The URLs a phone can be pointed at.
 *
 * A loopback bind yields none, and that is the honest answer rather than an
 * omission: nothing off this machine can reach it, and the URL that does work
 * belongs to `tailscale serve` — whose hostname this plugin does not know and
 * will not guess.
 * @param decision - the resolved bind.
 * @param port - the listening port.
 * @returns URLs, most useful first.
 */
export function reachableUrls(decision: BindDecision, port: number): string[] {
  if (decision.kind !== 'tailnet') return []
  return [`http://${decision.host}:${port}/`]
}

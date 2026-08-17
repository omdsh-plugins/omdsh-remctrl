/**
 * The desktop's side: the switch, the passcode, the browsers that are signed
 * in, and every field of the configuration.
 *
 * These are the controls, so they are the one part of this plugin that must NOT
 * be reachable from the public side. They are not served on the door at all.
 * They ride `ctx.connection.rpc`, a channel the harness already owns, registered
 * with `authority: 'loopback'` — which makes the fence the harness's
 * `isTrustedApiRequest` rather than a check written here.
 *
 * **And in this version that fence is deliberately not a wall**, which is worth
 * saying plainly rather than discovering. Forwarding the harness's own interface
 * means a signed-in browser reaches `/api` with a rewritten `Host`, and a
 * rewritten `Host` is a loopback `Host`, so a phone that has signed in can call
 * this channel too — it can read the passcode, change the port, and switch the
 * whole thing off. That is not a hole in the gate; it is what "the same
 * interface" means, and it cuts the useful way as often as not: a person who
 * left remote control on can turn it off from the phone they left with. The
 * only thing standing in front of all of it is the passcode, which is why
 * `throttle.ts` exists and why the card says the passcode out loud.
 * @module @omdsh-plugins/omdsh-remctrl/control
 */

import {
  CONTROL_ENDPOINTS,
  type AccessView, type BrowserList, type ConfigView, type Mutation, type PasscodeState,
  type RemctrlPatch, type RevokeAll, type RpcResult, type StatusView,
} from './contract.ts'
import type { AccessJournal } from './access.ts'
import type { BrowserStore } from './browsers.ts'

/** What {@link createControlHandler} needs. */
export interface ControlDeps {
  /** The signed-in browsers. */
  browsers: BrowserStore
  /** What has happened at the door. */
  access: AccessJournal
  /** Where the door is, computed fresh so a card left open does not go stale. */
  status: () => StatusView
  /** The configuration as the card draws it, likewise fresh. */
  config: () => ConfigView
  /**
   * Apply one edit to the settings section.
   *
   * Returns the seam's own refusal rather than throwing it: a port already held
   * is a thing a person needs to READ, and an exception on a loopback RPC
   * channel becomes `internal` with the message buried.
   * @param patch - the fields to change.
   * @returns undefined on success, or the reason it was refused.
   */
  writeConfig: (patch: RemctrlPatch) => Promise<string | undefined>
  /**
   * Mint a new passcode and store it.
   * @returns the new passcode, or a refusal.
   */
  resetPasscode: () => Promise<string | { error: string }>
}

// These are what this channel answers with, and they live in `contract.ts`
// beside everything else on the wire: the desktop card is compiled into a
// different artifact by a different bundler, so a shape it shares with this
// file has to come from somewhere both builds reach.
export type { AccessView, BrowserList, Mutation, PasscodeState, RevokeAll } from './contract.ts'

/**
 * Build the control-channel handler.
 * @param deps - see {@link ControlDeps}.
 * @returns a handler matching the harness's `ConnectionRpcHandler`.
 */
export function createControlHandler(
  deps: ControlDeps,
): (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>> {
  return async (endpoint, payload) => {
    switch (endpoint) {
      case CONTROL_ENDPOINTS.readStatus:
        return ok<StatusView>(deps.status())

      case CONTROL_ENDPOINTS.readConfig:
        return ok<ConfigView>(deps.config())

      case CONTROL_ENDPOINTS.writeConfig: {
        const parsed = parsePatch(payload)
        if (typeof parsed === 'string') return badRequest(parsed)
        if (Object.keys(parsed).length === 0) return badRequest('a configuration write names at least one field')
        const refusal = await deps.writeConfig(parsed)
        if (refusal !== undefined) return badRequest(refusal)
        return ok<ConfigView>(deps.config())
      }

      case CONTROL_ENDPOINTS.listBrowsers:
        return ok<BrowserList>({ browsers: deps.browsers.list() })

      case CONTROL_ENDPOINTS.revokeBrowser: {
        const request = payload as { browserId?: unknown }
        if (typeof request?.browserId !== 'string') {
          return badRequest('signing a browser out names a browserId')
        }
        return ok<Mutation>({ changed: deps.browsers.revoke(request.browserId) })
      }

      case CONTROL_ENDPOINTS.revokeAllBrowsers:
        // No confirmation asked for here. The card asks — twice, in fact — and
        // a channel that second-guessed its caller would be a channel with a
        // second policy in it. This one does what it is told.
        return ok<RevokeAll>({ removed: deps.browsers.revokeAll() })

      case CONTROL_ENDPOINTS.readAccess:
        return ok<AccessView>(deps.access.view())

      case CONTROL_ENDPOINTS.ackAccess:
        return ok<AccessView>(deps.access.acknowledge())

      case CONTROL_ENDPOINTS.clearAccess:
        // Like `browser/revoke-all`, this asks for no confirmation of its own:
        // the card asks, and a channel with a second policy in it is a channel
        // with two places to change one rule.
        return ok<AccessView>(deps.access.clear())

      case CONTROL_ENDPOINTS.resetPasscode: {
        const minted = await deps.resetPasscode()
        if (typeof minted !== 'string') return badRequest(minted.error)
        // Signed-in browsers are NOT dropped. The passcode is how you get in,
        // not what keeps you in, and the two failures are different: a passcode
        // somebody read over your shoulder is fixed by minting another, and a
        // phone left in a taxi is fixed by revoking that phone. Conflating them
        // would mean every reset signs out the laptop you are holding.
        return ok<PasscodeState>({ passcode: minted })
      }

      default:
        return badRequest(`no endpoint named ${JSON.stringify(endpoint)} on this channel`)
    }
  }
}

/**
 * Narrow an untrusted payload to the editable fields.
 *
 * Field by field rather than by casting the whole object, so a payload with an
 * extra key cannot smuggle one into `settings.update` — the section also holds
 * `passcode` and `browsers`, and a write that reached those could set a passcode
 * of its own choosing or install a session token hash. That is the difference
 * between "the card edits five fields" and "the card edits the credential
 * store", and it is twenty lines.
 * @param payload - whatever arrived.
 * @returns the patch, or a message saying what was wrong with it.
 */
export function parsePatch(payload: unknown): RemctrlPatch | string {
  if (payload === null || typeof payload !== 'object') return 'a configuration write is an object'
  const input = payload as Record<string, unknown>
  const patch: RemctrlPatch = {}

  for (const key of ['enabled', 'allowInsecure'] as const) {
    if (!Object.hasOwn(input, key)) continue
    if (typeof input[key] !== 'boolean') return `${key} is a boolean`
    patch[key] = input[key]
  }
  if (Object.hasOwn(input, 'publicHost')) {
    const host = input['publicHost']
    if (typeof host !== 'string') return 'publicHost is a string'
    const trimmed = host.trim()
    const problem = checkPublicHost(trimmed)
    if (problem !== undefined) return problem
    patch.publicHost = trimmed
  }
  if (Object.hasOwn(input, 'port')) {
    const port = input['port']
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return 'port is a number between 1 and 65535'
    }
    patch.port = port
  }
  if (Object.hasOwn(input, 'sessionTtlDays')) {
    const days = input['sessionTtlDays']
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 3650) {
      return 'sessionTtlDays is a whole number of days, 0 to 3650'
    }
    patch.sessionTtlDays = days
  }
  return patch
}

/**
 * Whether a public host is one of the two things this field accepts.
 *
 * It takes either a bare address (`121.43.252.12`) — this process is what
 * people reach — or a whole URL (`https://dsh.example.com`) — something else
 * carries the traffic here. A URL used to be refused as a paste mistake; it is
 * now the way to say "I am reached THERE, not here", so what is left to check
 * is that each shape is well formed as itself.
 * @param host - the trimmed value.
 * @returns the refusal, or undefined when it is fine.
 */
export function checkPublicHost(host: string): string | undefined {
  if (host === '') return undefined
  if (/\s/.test(host)) return 'publicHost has a space in it'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return checkPublicUrl(host)
  if (host.includes('/')) return 'publicHost is an address with no path on it, or a whole http(s) URL'
  // A port on a BARE address would be silently ignored in favour of the `port`
  // field, which is worse than a refusal: the card would show one number and
  // the listener would hold another. Somebody who means a port is writing a
  // URL. An IPv6 literal in brackets keeps its own colons.
  if (!host.startsWith('[') && /:\d+$/.test(host)) {
    return 'a bare address carries no port — set the port field, or write the whole URL instead'
  }
  return undefined
}

/**
 * Whether a URL in `publicHost` is one this plugin can stand behind.
 *
 * Only the origin is used, so anything past it is a misunderstanding worth
 * naming rather than silently dropping: a path suggests the person expects the
 * app to be mounted under it, which this forward does not do.
 * @param value - the trimmed value, already known to look like a URL.
 * @returns the refusal, or undefined when it is fine.
 */
function checkPublicUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `publicHost ${JSON.stringify(value)} is not a URL this plugin can parse`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'publicHost is an http or https URL, or a bare address'
  }
  if (url.username !== '' || url.password !== '') {
    return 'publicHost carries no credentials — the passcode is the credential'
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return 'publicHost is an origin with no path on it; this forward serves the whole of it, not a subdirectory'
  }
  if (url.search !== '' || url.hash !== '') return 'publicHost carries no query or fragment'
  return undefined
}

/**
 * The success branch.
 * @param value - the payload.
 * @returns the result.
 */
function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/**
 * The refusal branch.
 *
 * `bad-request` rather than a code of this plugin's own: the error vocabulary
 * belongs to the harness's RPC contract, and inventing a member of a closed
 * union is how a client ends up with an error it cannot narrow.
 * @param message - what was wrong.
 * @returns the result.
 */
function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

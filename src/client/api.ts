/**
 * The card's half of the loopback control channel.
 *
 * Every call in this file lands on `control.ts` through
 * `ctx.connection.rpc.call`, which means the fence in front of it is the
 * harness's `authority: 'loopback'` rather than one written here: no HTTP, no
 * route, no CORS, and no second copy of the trust decision.
 *
 * Worth knowing while reading it: because this version forwards the harness's
 * own interface, a browser that has signed in through the gate reaches this
 * channel too — the forward rewrites `Host` to loopback, which is what the
 * fence reads. So these are not desktop-only controls in practice; they are
 * controls behind the passcode. `control.ts` says so at length.
 * @module @omdsh-plugins/omdsh-remctrl/client/api
 */

import { CONTROL_CHANNEL, CONTROL_ENDPOINTS } from '../contract.ts'
import type {
  AccessView, BrowserList, ConfigView, Mutation, PasscodeState, RemctrlPatch, RevokeAll,
  RpcResult, StatusView,
} from '../contract.ts'

/** The browser half of the harness's Connection service, as much as this uses. */
export interface ConnectionRpcLike {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>
  }
}

/**
 * A refusal from the host half, as a thrown error with the message intact.
 *
 * The messages this channel returns are the ones worth showing — "publicHost is
 * a host, not a URL", naming the mistake — so they are carried rather than
 * replaced with a generic failure the card would have to guess a translation
 * for.
 */
export class ControlError extends Error {
  /**
   * @param message - the host's own words.
   * @param code - the RPC error code.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ControlError'
  }
}

/**
 * Call one endpoint and unwrap it.
 * @param connection - the browser Connection service.
 * @param endpoint - the endpoint on this plugin's channel.
 * @param payload - its payload.
 * @param signal - caller cancellation.
 * @returns the value.
 * @throws ControlError when the host refused.
 */
async function call<T>(
  connection: ConnectionRpcLike,
  endpoint: string,
  payload: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const result = await connection.rpc.call(CONTROL_CHANNEL, endpoint, payload, signal)
  if (!result.ok) throw new ControlError(result.error.message, result.error.code)
  return result.value as T
}

/** Everything the card reads in one pass, so one refresh is one round of calls. */
export interface CardSnapshot {
  status: StatusView
  config: ConfigView
  browsers: BrowserList
  access: AccessView
}

/**
 * Read the whole card.
 * @param connection - the browser Connection service.
 * @param signal - caller cancellation.
 * @returns the snapshot.
 */
export async function readCard(connection: ConnectionRpcLike, signal?: AbortSignal): Promise<CardSnapshot> {
  const [status, config, browsers, access] = await Promise.all([
    call<StatusView>(connection, CONTROL_ENDPOINTS.readStatus, {}, signal),
    call<ConfigView>(connection, CONTROL_ENDPOINTS.readConfig, {}, signal),
    call<BrowserList>(connection, CONTROL_ENDPOINTS.listBrowsers, {}, signal),
    call<AccessView>(connection, CONTROL_ENDPOINTS.readAccess, {}, signal),
  ])
  return { status, config, browsers, access }
}

/**
 * Write part of the settings section.
 * @param connection - the browser Connection service.
 * @param patch - the fields to change.
 * @returns the section as it now is.
 */
export async function writeConfig(connection: ConnectionRpcLike, patch: RemctrlPatch): Promise<ConfigView> {
  return call<ConfigView>(connection, CONTROL_ENDPOINTS.writeConfig, patch)
}

/**
 * Sign one browser out. Its cookie stops resolving at once.
 * @param connection - the browser Connection service.
 * @param browserId - which one.
 * @returns whether anything changed.
 */
export async function revokeBrowser(connection: ConnectionRpcLike, browserId: string): Promise<Mutation> {
  return call<Mutation>(connection, CONTROL_ENDPOINTS.revokeBrowser, { browserId })
}

/**
 * Sign every browser out at once.
 * @param connection - the browser Connection service.
 * @returns how many were signed out.
 */
export async function revokeAllBrowsers(connection: ConnectionRpcLike): Promise<RevokeAll> {
  return call<RevokeAll>(connection, CONTROL_ENDPOINTS.revokeAllBrowsers)
}

/**
 * Mint a new passcode. Signed-in browsers are not affected.
 * @param connection - the browser Connection service.
 * @returns the new passcode.
 */
export async function resetPasscode(connection: ConnectionRpcLike): Promise<PasscodeState> {
  return call<PasscodeState>(connection, CONTROL_ENDPOINTS.resetPasscode)
}

/**
 * Mark the access log as read.
 * @param connection - the browser Connection service.
 * @returns the log as it now reads.
 */
export async function ackAccess(connection: ConnectionRpcLike): Promise<AccessView> {
  return call<AccessView>(connection, CONTROL_ENDPOINTS.ackAccess)
}

/**
 * Empty the access log. One row is left behind saying it was emptied.
 * @param connection - the browser Connection service.
 * @returns the log as it now reads.
 */
export async function clearAccess(connection: ConnectionRpcLike): Promise<AccessView> {
  return call<AccessView>(connection, CONTROL_ENDPOINTS.clearAccess)
}

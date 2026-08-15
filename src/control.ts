/**
 * The desktop's side: minting a code, listing what is paired, taking it back.
 *
 * These are the configuration surface, so they are the one part of this plugin
 * that must NOT be reachable from a phone. They are not served on the door in
 * `server.ts` at all. They ride `ctx.connection.rpc`, a channel the harness
 * already owns, registered with `authority: 'loopback'` — which makes the fence
 * the harness's `isTrustedApiRequest` rather than a check written here, and
 * gives the desktop panel a same-origin call with no CORS and no second route.
 *
 * The split is the design in miniature: the phone gets a token and a narrow
 * door; the machine you are sitting at gets the controls.
 * @module @omdsh-plugins/omdsh-remctrl/control
 */

import {
  CONTROL_ENDPOINTS,
  type DeviceView,
  type MintedCode,
  type ReachabilityView,
  type RpcResult,
} from './contract.ts'
import type { DeviceStore } from './devices.ts'
import type { PairingCodes } from './pairing.ts'

/** What {@link createControlHandler} needs. */
export interface ControlDeps {
  /** The paired devices. */
  devices: DeviceStore
  /** The outstanding pairing code. */
  pairing: PairingCodes
  /** Where the phone should point, computed fresh so a panel left open does not go stale. */
  status: () => ReachabilityView
  /**
   * Called after a device is forgotten.
   *
   * A revocation has to reach connections that are already open — from M1 that
   * is a live event stream — and the store cannot know about them. Nothing is
   * hooked up in M0 beyond the token ceasing to resolve, which is already true
   * the instant `revoke` returns.
   */
  onRevoke?: (deviceId: string) => void
}

/** `pair/read` answers this: a live code, or nothing outstanding. */
export interface CodeState {
  code: MintedCode | null
}

/** `device/list` answers this. */
export interface DeviceList {
  devices: DeviceView[]
}

/** What a mutation reports back. */
export interface Mutation {
  /** False when no device answers to that id — a panel racing another panel. */
  changed: boolean
}

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
      case CONTROL_ENDPOINTS.mintCode: {
        const minted = deps.pairing.mint()
        return ok<MintedCode>({ code: minted.code, expiresAt: minted.expiresAt })
      }
      case CONTROL_ENDPOINTS.readCode: {
        const live = deps.pairing.peek()
        return ok<CodeState>({
          code: live === undefined ? null : { code: live.code, expiresAt: live.expiresAt },
        })
      }
      case CONTROL_ENDPOINTS.listDevices:
        return ok<DeviceList>({ devices: deps.devices.list() })
      case CONTROL_ENDPOINTS.renameDevice: {
        const request = payload as { deviceId?: unknown; label?: unknown }
        if (typeof request.deviceId !== 'string' || typeof request.label !== 'string') {
          return badRequest('renaming a device names a deviceId and a label')
        }
        const label = request.label.trim()
        if (label === '') return badRequest('a device label cannot be empty')
        return ok<Mutation>({ changed: deps.devices.rename(request.deviceId, label) })
      }
      case CONTROL_ENDPOINTS.revokeDevice: {
        const request = payload as { deviceId?: unknown }
        if (typeof request.deviceId !== 'string') {
          return badRequest('revoking a device names a deviceId')
        }
        const changed = deps.devices.revoke(request.deviceId)
        if (changed) deps.onRevoke?.(request.deviceId)
        return ok<Mutation>({ changed })
      }
      case CONTROL_ENDPOINTS.readStatus:
        return ok<ReachabilityView>(deps.status())
      default:
        return badRequest(`no endpoint named ${JSON.stringify(endpoint)} on this channel`)
    }
  }
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

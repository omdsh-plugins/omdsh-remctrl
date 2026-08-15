/**
 * The vocabulary every party speaks: the phone's door, the desktop panel's
 * loopback channel, and the settings section that outlives both.
 *
 * Kept in its own entry so a consumer can have the words without a listener —
 * the desktop panel that lands next imports from here, `import type` only, and
 * the phone's page (a string in `mobile/assets.ts` until it earns a build) is
 * written against the same names.
 * @module @omdsh-plugins/omdsh-remctrl/contract
 */

/** The settings namespace this plugin owns, per the omdsh convention. */
export const SETTINGS_NAMESPACE = 'omdsh-remctrl'

/**
 * The port the phone's door listens on by default.
 *
 * Deliberately not the harness's: the web app composes `3080`, and these are
 * two different doors onto one process. A collision would be reported as
 * `EADDRINUSE` at boot rather than silently shadowing anything, but a default
 * that never collides is better than a good error message.
 */
export const DEFAULT_PORT = 3081

/** Loopback, and the only bind host that needs no discovery to be legal. */
export const LOOPBACK = '127.0.0.1'

/**
 * The loopback-fenced channel the desktop panel calls the host half on.
 *
 * Registered through `ctx.connection.rpc.handle`, so the fence is the
 * harness's rather than ours. Channel names must match
 * `/^\/[A-Za-z0-9._~-]+$/` — one segment, no inner slashes.
 */
export const CONTROL_CHANNEL = '/omdsh-remctrl'

/**
 * Endpoints on {@link CONTROL_CHANNEL}. Each segment must match
 * `/^[A-Za-z0-9_$.-]+$/`; the `/` between segments is the channel's own.
 */
export const CONTROL_ENDPOINTS = {
  /** Mint a fresh pairing code, replacing any outstanding one. */
  mintCode: 'pair/mint',
  /** The outstanding code, if one is live — so a reopened panel shows it rather than minting a second. */
  readCode: 'pair/read',
  /** Every paired device. */
  listDevices: 'device/list',
  /** Rename one device. */
  renameDevice: 'device/rename',
  /** Revoke one device: it is forgotten and its token stops working at once. */
  revokeDevice: 'device/revoke',
  /** Where the phone should point, and whether anything is reachable at all. */
  readStatus: 'status/read',
} as const

/** Paths on the phone's door. */
export const MOBILE_ROUTES = {
  /** The page shell. */
  root: '/',
  /** Its stylesheet; separate so the page needs no inline `style` and the CSP can stay strict. */
  css: '/app.css',
  /** Its script; separate for the same reason. */
  js: '/app.js',
  /** Redeem a pairing code for a device token. */
  pair: '/pair',
  /** Who this token is; the authenticated probe that makes "paired" observable. */
  session: '/session',
} as const

/**
 * How much of the harness a device may reach.
 *
 * Ordered by inclusion: each tier admits everything below it. `cancel` sits in
 * `respond` rather than `drive` on purpose — the ability to STOP something
 * should be available a whole tier before the ability to start one.
 */
export type Tier = 'observe' | 'respond' | 'drive' | 'full'

/** The tiers, weakest first. Index in this array IS the ordering. */
export const TIER_ORDER: readonly Tier[] = ['observe', 'respond', 'drive', 'full']

/** What a phone posts to {@link MOBILE_ROUTES.pair}. */
export interface PairRequest {
  /** The code shown on the desktop. */
  code: string
  /** What to call this device; derived from the User-Agent when absent. */
  label?: string
}

/** What it gets back on success. The token is returned once and never again. */
export interface PairSuccess {
  token: string
  deviceId: string
  label: string
  tier: Tier
}

/** Why a redemption did not produce a token. */
export type PairRefusal =
  /** The body was not a pairing request. */
  | { reason: 'malformed'; message: string }
  /** Nothing has been minted, or the last code was already spent or burned. */
  | { reason: 'no-code'; message: string }
  /** A code was minted and its time ran out. */
  | { reason: 'expired'; message: string }
  /** Wrong code; `remaining` says how many tries are left before it burns. */
  | { reason: 'mismatch'; remaining: number; message: string }
  /** The tries ran out. The code is gone and the desktop must mint another. */
  | { reason: 'locked'; message: string }

/** What {@link MOBILE_ROUTES.session} answers a device that presents a live token. */
export interface SessionView {
  deviceId: string
  label: string
  tier: Tier
  /** When this device paired, epoch milliseconds. */
  pairedAt: number
}

/** A live pairing code, as the desktop panel shows it. */
export interface MintedCode {
  code: string
  /** Epoch milliseconds; the panel counts down to it. */
  expiresAt: number
}

/** One paired device, as the desktop panel lists it. */
export interface DeviceView {
  deviceId: string
  label: string
  tier: Tier
  createdAt: number
  lastSeenAt: number
}

/** Where the phone should point, and what stands in the way if nothing works. */
export interface ReachabilityView {
  /** The address the listener actually bound. */
  bindHost: string
  /** The port it actually listens on. */
  port: number
  /** Which kind of address that is. */
  kind: 'loopback' | 'tailnet'
  /** Every tailnet address found on this machine, whether bound or not. */
  tailnetAddresses: string[]
  /** URLs a phone can try, most useful first; empty when only loopback is bound. */
  urls: string[]
  /** Whether any device is paired at all. */
  paired: number
}

/**
 * A restatement of the harness's `RpcResult`, so this package depends on no
 * harness contract package to speak on its own loopback channel.
 *
 * The shape is fixed by `@deepseek-ai/dsh-host-apiproxy/api`; only the error
 * `code` is loosened, from that package's closed union to `string`. Nothing
 * here mints a code outside it — `bad-request` and `internal` are the two this
 * channel uses — and the widening keeps a type-only import off the dependency
 * list of a package that otherwise needs none.
 */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

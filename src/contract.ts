/**
 * The vocabulary every party speaks: the gate on the public address, the
 * desktop card's loopback channel, and the settings section that outlives both.
 *
 * Kept in its own entry so a consumer can have the words without a listener —
 * the desktop card imports from here, `import type` wherever it can.
 * @module @omdsh-plugins/omdsh-remctrl/contract
 */

/** The settings namespace this plugin owns, per the omdsh convention. */
export const SETTINGS_NAMESPACE = 'omdsh-remctrl'

/**
 * The port the gate listens on by default.
 *
 * Deliberately not the harness's own: this is a second socket in front of the
 * first. A collision reports `EADDRINUSE` at boot rather than shadowing
 * anything, but a default that never collides is better than a good error.
 */
export const DEFAULT_PORT = 3081

/** Loopback, which is both the upstream's address and the tunnel's near end. */
export const LOOPBACK = '127.0.0.1'

/**
 * How the gate becomes reachable from outside this machine.
 *
 * There is still ONE field. What you write in {@link RemctrlWire.publicHost}
 * says which of these you have, by its SHAPE rather than by a second setting
 * that could contradict it:
 *
 * - `tunnel` — `publicHost` is empty. `cloudflared` opens an outbound
 *   connection and hands back an `https://….trycloudflare.com` name. Nothing
 *   to forward, no firewall to open, and TLS is somebody else's problem
 *   because Cloudflare terminates it.
 * - `direct` — `publicHost` is a bare address or name (`121.43.252.12`). This
 *   process IS the thing people reach: it binds that address when the machine
 *   holds it, every interface when it cannot. No TLS anywhere, so it needs
 *   {@link RemctrlWire.allowInsecure} before it will open.
 * - `fronted` — `publicHost` is a whole URL
 *   (`https://dsh.example.com`, `http://121.43.252.12:7860`). Something else
 *   is carrying the traffic — a Caddy on this box, an `ssh -R` from a VPS, an
 *   `frp`, a named Cloudflare tunnel — and every one of those reaches this
 *   process on **loopback**, which is therefore what it binds. The URL's own
 *   SCHEME says whether that carrier terminates TLS, and everything else
 *   follows from it.
 *
 * A URL is not a mistake to be corrected, in other words: it is the way to say
 * "I am reached THERE, not here".
 */
export type Carrier = 'tunnel' | 'direct' | 'fronted'

/** The carriers. */
export const CARRIERS: readonly Carrier[] = ['tunnel', 'direct', 'fronted']

/**
 * The path prefix the gate keeps for itself.
 *
 * Two underscores and a name nothing else uses, because everything NOT under
 * it is forwarded verbatim to the harness — the prefix is the whole of the
 * namespace negotiation between this plugin and an app it does not control.
 */
export const GATE_PREFIX = '/__remctrl'

/** The gate's own routes. */
export const GATE_ROUTES = {
  /** The passcode form, and where it posts. */
  signIn: `${GATE_PREFIX}/sign-in`,
  /** Drop this browser's session and forget it. */
  signOut: `${GATE_PREFIX}/sign-out`,
  /** The phone stylesheet, linked into the forwarded index. */
  mobileCss: `${GATE_PREFIX}/mobile.css`,
  /** The phone script, likewise. */
  mobileJs: `${GATE_PREFIX}/mobile.js`,
} as const

/**
 * The two routes the gate answers itself even though they are BEHIND the
 * passcode.
 *
 * They are only ever referenced from the forwarded index, which a signed-out
 * browser never sees, so gating them costs nothing and keeps the rule simple:
 * exactly two paths are reachable without a session, and both of them are
 * about getting one.
 */
export const MOBILE_ASSETS: readonly string[] = [GATE_ROUTES.mobileCss, GATE_ROUTES.mobileJs]

/**
 * The cookie the gate hands a browser that has signed in.
 *
 * A cookie rather than a header, and that is forced rather than chosen: the
 * thing being carried is a whole web app this plugin did not write. Its
 * `fetch` calls, its `<script src>` tags and its two WebSockets all go out
 * without an `Authorization` header, and no amount of care here can add one to
 * a `<link rel=stylesheet>`. A cookie is the one credential every one of those
 * carries by itself.
 */
export const COOKIE_NAME = 'omdsh_remctrl'

/**
 * The query parameter that signs a browser in on a plain GET.
 *
 * The whole point of this version is that one scan is the entire setup, so the
 * link on the card's QR carries the passcode and the gate honours it on a
 * navigation. It is a magic link, with a magic link's tradeoff: the passcode
 * lands in that browser's history. The gate strips it from the address bar by
 * redirecting to the same path without it, which removes it from the visible
 * URL but not from the history entry that already exists.
 */
export const KEY_PARAM = 'k'

/**
 * The alphabet a passcode is minted from.
 *
 * Crockford's base32 without the vowel-lookalikes: no `I`, `L`, `O`, `U`. Ten
 * characters is fifty bits, which is not a key — it is a passcode with a
 * throttle in front of it, and the throttle is what makes fifty bits enough.
 * The alphabet is chosen so somebody can read it off a screen and type it into
 * a phone without a single ambiguous glyph.
 */
export const PASSCODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** How many characters a minted passcode has. */
export const PASSCODE_LENGTH = 10

/**
 * The loopback-fenced channel the desktop card calls the host half on.
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
  /** Where the door is, what is carrying it, and what stands in the way. */
  readStatus: 'status/read',
  /** The configurable half of the settings section, as the card draws it. */
  readConfig: 'config/read',
  /** Write part of that section. Loopback-fenced, like everything on this channel. */
  writeConfig: 'config/write',
  /** Every browser that has signed in. */
  listBrowsers: 'browser/list',
  /** Sign one browser out; its cookie stops working at once. */
  revokeBrowser: 'browser/revoke',
  /** Sign every browser out at once. */
  revokeAllBrowsers: 'browser/revoke-all',
  /** Mint a new passcode. Every signed-in browser survives; only the way IN changes. */
  resetPasscode: 'passcode/reset',
  /** What has happened at the door: who got in, and who tried. */
  readAccess: 'access/read',
  /** Mark the log as read, so the unseen count starts again. */
  ackAccess: 'access/ack',
  /** Empty the log. Leaves one row saying it was emptied; see {@link AccessEvent.cleared}. */
  clearAccess: 'access/clear',
} as const

/** One browser that has signed in, as the desktop card lists it. */
export interface BrowserView {
  browserId: string
  /** Derived from the User-Agent at sign-in; a person can tell their phone from their laptop. */
  label: string
  /** Epoch milliseconds. */
  signedInAt: number
  lastSeenAt: number
  /** When the session stops working, epoch milliseconds; absent when it does not expire. */
  expiresAt?: number
  /** Whether that moment has passed. A stale row is listed, not hidden — it is a thing to revoke. */
  expired?: boolean
}

/** What `cloudflared` is doing. */
export type TunnelState =
  /** Not wanted: the plugin is off, or the carrier is `direct`. */
  | { kind: 'off' }
  /** Spawned, no URL yet. */
  | { kind: 'starting'; attempt: number }
  /** Carrying, on this URL. */
  | { kind: 'up'; url: string }
  /** Not carrying, and why. `retryInMs` is zero when nothing is scheduled. */
  | { kind: 'failed'; reason: TunnelFailure; detail: string; retryInMs: number }

/** Why the tunnel is not carrying. */
export type TunnelFailure =
  /** `cloudflared` is not installed, or not where this process can see it. */
  | 'missing-binary'
  /** It ran and stopped. */
  | 'exited'
  /** It ran, stayed up, and never printed a URL. */
  | 'no-url'
  /** Anything else, reported verbatim. */
  | 'other'

/** The tunnel, as the desktop card shows it. */
export interface TunnelView {
  state: TunnelState
  /** Where the binary was found, when it was. */
  binary: string
}

/**
 * Something between this configuration and a browser actually reaching the
 * harness.
 *
 * Reported rather than thrown: every one of these is a live install that boots
 * fine and cannot be used, which is exactly the failure a card exists to make
 * visible.
 */
export interface Warning {
  /** Stable key, so the card can translate it. */
  code:
    /** Switched off. Not a fault — the default, said out loud. */
    | 'disabled'
    /**
     * This composition has no `webServer`, so there is no interface to forward.
     * True of a TUI profile, and the one case where the gate refuses to open
     * for a reason that is not about safety.
     */
    | 'no-upstream'
    /** `cloudflared` is not installed. */
    | 'missing-binary'
    /** It is installed and not carrying. */
    | 'tunnel-down'
    /** Carrier is `direct` and nobody said what address people reach. */
    | 'no-public-host'
    /** Carrier is `direct` and `allowInsecure` is off, so the gate stays shut. */
    | 'insecure-unacknowledged'
    /** Carrier is `direct`, acknowledged: the session cookie crosses the internet in the clear. */
    | 'plaintext'
    /**
     * Bound to a tailnet address: plaintext on the wire, but the wire is
     * WireGuard. Not a fault — the good outcome, said out loud, because "plain
     * HTTP" and "safe" look contradictory until somebody explains why they are
     * not.
     */
    | 'tailnet'
    /**
     * `publicHost` named an address this machine holds, and that address is
     * loopback — so the door is up and nothing off this machine can reach it.
     * A real configuration (something else is carrying it), and a real mistake
     * (somebody pasted `127.0.0.1`), and the card cannot tell which.
     */
    | 'loopback-only'
    /**
     * Bound to loopback with something else declared to be carrying it: a
     * reverse proxy, an `ssh -R`, an `frp`. Not a fault — a posture, and one
     * the card should state because "listening on 127.0.0.1" and "reachable
     * from the internet" are both true at once and look contradictory.
     */
    | 'fronted'
    /** The listener did not come up; `detail` carries the reason. */
    | 'refused'
  /** The refusal or explanation, already written out in English. */
  detail: string
}

/** Where the door is, and what stands in the way if nothing works. */
export interface StatusView {
  /** Whether the switch is on. */
  enabled: boolean
  /** Whether the gate is actually holding its port right now. */
  listening: boolean
  /** How it is reached. */
  carrier: Carrier
  /** The address it actually bound, or would have. */
  bindHost: string
  /** How far that address reaches; `'wide'` when nothing is bound. */
  bindScope: 'loopback' | 'tailnet' | 'wide'
  /**
   * Every address this machine holds inside `100.64.0.0/10`.
   *
   * On the card so it can offer them: putting one in `publicHost` is the
   * difference between a plaintext port on the tailnet and a plaintext port on
   * every network the laptop joins.
   */
  tailnetAddresses: string[]
  /** The port the gate holds. */
  port: number
  /**
   * The harness's own port, which is what the gate forwards to. Null when this
   * composition has no web interface at all.
   */
  upstreamPort: number | null
  /** The URL to open, or `''` when nothing is reachable yet. */
  url: string
  /** That URL with the passcode in it — what the QR encodes. `''` when there is no URL. */
  signInUrl: string
  /** The passcode, in full. This channel is loopback-fenced; the card is the only reader. */
  passcode: string
  /** What `cloudflared` is doing. */
  tunnel: TunnelView
  /** How many browsers are signed in. */
  browsers: number
  /** Whatever stands between this configuration and a working phone. */
  warnings: Warning[]
}

/**
 * The part of the settings section the desktop card draws itself.
 *
 * The card replaces the hub's generic form rather than sitting beside it, so
 * every field a person can edit has to travel — the card is the only form
 * there is. `passcode` and `browsers` are not here: both are written by this
 * plugin, and both reach the card through {@link StatusView} and
 * `browser/list` where they arrive already projected.
 */
export interface RemctrlWire {
  /** Whether the gate opens at all. Off by default; this is the manual switch. */
  enabled: boolean
  /**
   * The address people reach this machine at.
   *
   * Empty — the default — means this machine has no public address, so
   * `cloudflared` goes and gets one. Anything else switches the carrier to
   * `direct`: the gate binds every interface and this is the name it is
   * reached by.
   */
  publicHost: string
  /** The port the gate listens on. */
  port: number
  /** Serve `direct` over plain HTTP. The one acknowledgement in this plugin. */
  allowInsecure: boolean
  /** How long a signed-in browser stays signed in, in days; `0` means forever. */
  sessionTtlDays: number
}

/** What `config/write` accepts: any subset of the editable fields. */
export type RemctrlPatch = Partial<RemctrlWire>

/** What `config/read` answers. */
export interface ConfigView {
  /** The resolved values. */
  config: RemctrlWire
  /** Whether the settings provider takes writes at all in this deployment. */
  writable: boolean
}

/** What `browser/list` answers. */
export interface BrowserList {
  browsers: BrowserView[]
}

/** What `browser/revoke-all` answers. */
export interface RevokeAll {
  /** How many were signed out. */
  removed: number
}

/**
 * One thing that happened at the door.
 *
 * The reason this exists rather than a notification: a notification only
 * reaches somebody who is looking. The question a person actually needs
 * answered is "did anybody get in while I was not looking", and that is a
 * question about a record, which is why this one is persisted and bounded
 * rather than pushed.
 */
export interface AccessEvent {
  /** When, epoch milliseconds. For a coalesced refusal, the LAST attempt. */
  at: number
  /** Whether a session was issued. */
  granted: boolean
  /** What it called itself, from the User-Agent. */
  label: string
  /** Where it came from, in the spelling the throttle keys on. */
  address: string
  /**
   * How many attempts this row stands for.
   *
   * Always one for a grant. Refusals from one address inside
   * {@link COALESCE_MS} collapse into a single row, so a machine grinding at
   * the passcode is one line with a number on it rather than fifty lines that
   * push everything else out of a bounded log.
   */
  attempts: number
  /** The browser it created, when it created one. */
  browserId?: string
  /**
   * How many rows a CLEAR removed, when this row is the mark it left.
   *
   * Emptying the log leaves this one entry behind rather than nothing at all,
   * and that is the whole reason the field exists: a log that can go from
   * fifty rows to a blank page with no explanation is a log an intruder empties
   * on their way out. It cannot stop them — anyone who signs in can clear it —
   * but it can stop the result from being indistinguishable from "nothing has
   * ever happened here".
   */
  cleared?: number
}

/** How long consecutive refusals from one address fold into one row. */
export const COALESCE_MS = 30 * 60_000

/** The most events kept. Older ones fall off the end. */
export const ACCESS_LIMIT = 50

/** What `access/read` answers. */
export interface AccessView {
  /** Newest first. */
  events: AccessEvent[]
  /** How many are newer than the last acknowledgement. */
  unseen: number
}

/** What a mutation on the control channel reports back. */
export interface Mutation {
  /** False when nothing answers to that id — a card racing another card. */
  changed: boolean
}

/** What `passcode/reset` answers. */
export interface PasscodeState {
  passcode: string
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

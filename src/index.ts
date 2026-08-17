/**
 * `@omdsh-plugins/omdsh-remctrl` — this harness's own interface, on a public
 * address, behind a passcode.
 *
 * Turn it on and a URL appears. Open that URL from anywhere and you get dsh:
 * the same window, the same sessions, the same buttons, the same everything —
 * because it IS dsh. Nothing is reimplemented, so nothing can drift, and a
 * feature added to the harness tomorrow is on your phone tomorrow.
 *
 * ## One way in, and it is the only way
 *
 * There is a single door and it is a reverse proxy. Requests arrive on a port
 * this plugin binds, a passcode decides whether they go any further, and the
 * ones that do are forwarded to the harness's own loopback port — HTTP, and
 * the two WebSocket downlinks, verbatim.
 *
 * How that port becomes reachable is the only choice, and it has a default:
 *
 * - **nothing configured** — `cloudflared` opens an outbound quick tunnel and
 *   hands back an `https://` name. No forwarding, no firewall, no TLS to
 *   arrange. This is the case for every laptop.
 * - **`publicHost` is a bare address** — this machine is reached at an address
 *   of its own. If it actually HOLDS that address the door binds exactly it —
 *   which is what makes a tailnet address a clean answer, and needs no
 *   acknowledgement because plaintext inside WireGuard is not plaintext on a
 *   readable wire. If it does not (a cloud VM behind its provider's NAT) the
 *   door binds every interface in plain HTTP, and that takes an
 *   acknowledgement first.
 * - **`publicHost` is a whole URL** — something else carries the traffic here:
 *   a Caddy on this box, an `ssh -R` from a VPS, an `frp`. Every one of those
 *   arrives on loopback, so that is what the door binds, and the URL's own
 *   SCHEME decides the rest — https means the carrier terminated TLS and sets
 *   `x-forwarded-*`; http means it did not, and takes the acknowledgement.
 *
 * ## What the passcode is holding
 *
 * Everything. The previous version of this plugin served a small purpose-built
 * app through a method allowlist at a tier the desktop chose, and could
 * therefore promise a phone was less powerful than the desktop. Forwarding the
 * real interface ends that promise, and it ends it by design: `reverse.ts`
 * rewrites the `Host` header to loopback, which is what makes the harness's own
 * trust fence pass, and which means a signed-in browser reaches every
 * loopback-fenced method — settings, credentials, tool approvals, shell.
 *
 * So the compensating controls are not features, they are the whole design:
 *
 * 1. **Off by default.** `enabled` is `false` and nothing opens until somebody
 *    turns it on.
 * 2. **A passcode on every request**, checked before anything is forwarded, and
 *    a session cookie that is `HttpOnly` and `SameSite=Lax`.
 * 3. **A token bucket in front of the passcode** — six tries a minute per
 *    address, which is what makes ten characters enough.
 * 4. **The provenance fence re-imposed at the public boundary** by `gate.ts`,
 *    because rewriting `Host` upstream removes the harness's own copy of it.
 * 5. **A transport check**: under the tunnel, a request that did not arrive
 *    over HTTPS is refused before a credential is read off it. Serving the
 *    direct carrier in plaintext takes `allowInsecure`, by hand.
 * @module @omdsh-plugins/omdsh-remctrl
 */

import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import {
  CONTROL_CHANNEL, DEFAULT_PORT, GATE_ROUTES, KEY_PARAM, PASSCODE_LENGTH, SETTINGS_NAMESPACE,
  type Carrier, type ConfigView, type RemctrlPatch, type RemctrlWire, type RpcResult,
  type StatusView, type TunnelState, type Warning,
} from './contract.ts'
import { AccessJournal, type AccessTable } from './access.ts'
import {
  carrierFor, localAddresses, reachableUrl, readPublicHost, resolveBind, signInLink,
  tailnetAddresses, type BindDecision,
} from './bind.ts'
import { BrowserStore, labelFromUserAgent, type BrowserTable } from './browsers.ts'
import { Cloudflared, isExecutable, locateBinary } from './cloudflared.ts'
import { checkPublicHost, createControlHandler } from './control.ts'
import { startDoor, type Door } from './door.ts'
import { indexTransform } from './mobile.ts'
import { hashToken, mintBrowserId, mintPasscode, mintToken } from './secrets.ts'
import { AUTH_RULE, SIGN_IN_RULE, Throttle } from './throttle.ts'

export * from './contract.ts'
export {
  AccessJournal, ANNOUNCE_AFTER, FLUSH_INTERVAL_MS,
  type AccessDeps, type AccessTable,
} from './access.ts'
export {
  bracket, carrierFor, heldAddress, isTailnetAddress, localAddresses, reachableUrl, readPublicHost,
  resolveBind, signInLink, tailnetAddresses, TAILNET_CIDR, WILDCARD,
  type BindDecision, type BindRequest, type BindScope, type InterfaceTable, type PublicHost,
} from './bind.ts'
export {
  BrowserStore, labelFromUserAgent,
  type BrowserDeps, type BrowserRecord, type BrowserTable,
} from './browsers.ts'
export {
  Cloudflared, isExecutable, locateBinary, readTunnelUrl, tunnelArgs,
  EXTRA_PATHS, KILL_GRACE_MS, RETRY_CEILING_MS, RETRY_FLOOR_MS, URL_TIMEOUT_MS,
  type ChildLike, type CloudflaredDeps,
} from './cloudflared.ts'
export {
  readCookie, signInCookie, signOutCookie, stripCookie, type CookieOptions,
} from './cookies.ts'
export { checkPublicHost, createControlHandler, parsePatch, type ControlDeps } from './control.ts'
export {
  createDoorHandler, createUpgradeHandler, mobileAsset, readBody, safeNext, startDoor, trySignIn,
  FORM_LIMIT, type Door, type DoorDeps,
} from './door.ts'
export {
  checkTransport, clientAddress, headerList, normalizeAddress, proxyTrustFor, requestProto,
  NO_PROXY, type ProxyTrust, type RequestFacts, type TransportVerdict,
} from './forward.ts'
export {
  checkProvenance, decide, isNavigation, splitUrl, withoutKey,
  type GateInput, type GateVerdict,
} from './gate.ts'
export {
  indexTransform, isRewritten, needsViewportFix, withViewport,
  MOBILE_CSS, MOBILE_JS, PHONE_WIDTH, VH_PROPERTY, VIEWPORT, VT_PROPERTY,
} from './mobile.ts'
export { escapeHtml, pickLang, refusalPage, signInPage, type PageLang, type SignInError } from './pages.ts'
export {
  HOP_BY_HOP, isRewritableHtml, proxyHttp, proxyUpgrade, upstreamHeaders, type ReverseDeps,
} from './reverse.ts'
export {
  constantTimeEquals, hashToken, mintBrowserId, mintPasscode, mintToken, normalizePasscode,
} from './secrets.ts'
export { AUTH_RULE, SIGN_IN_RULE, Throttle, type ThrottleRule, type ThrottleVerdict } from './throttle.ts'

/** Stable Cordis plugin name. */
export const name = 'omdsh-remctrl'

/**
 * The one service this plugin REQUIRES.
 *
 * `connection` carries the loopback control channel the desktop card calls.
 * `webServer` and `settings` are taken on nested fibers instead: cordis waits
 * for an injected service forever and the boot audit fails the app for an entry
 * left pending, so a service named at the top level is a service this plugin
 * refuses to boot without. Without `webServer` there is nothing to forward and
 * the card says so; without `settings` the passcode lives in memory until
 * restart. Both are better answers than a dead boot.
 */
export const inject = ['connection']

/** How long a signed-in browser stays signed in, by default. */
export const DEFAULT_SESSION_TTL_DAYS = 30

/** How this plugin is configured. */
export interface RemctrlConfig {
  /** Whether the door opens at all. */
  enabled?: boolean
  /** The address people reach this machine at; empty means `cloudflared` gets one. */
  publicHost?: string
  /** The port the door listens on. */
  port?: number
  /** Serve the direct carrier over plain HTTP. */
  allowInsecure?: boolean
  /** How long a signed-in browser stays signed in, in days; `0` means forever. */
  sessionTtlDays?: number
  /**
   * The passcode.
   *
   * Minted on first use and written back here, so it survives a restart and a
   * person can read it off the card rather than being handed a new one every
   * time the app starts. Declared secret per rule 3.
   */
  passcode?: string
  /**
   * The signed-in browsers.
   *
   * Written by this plugin, hidden from the form, and holding a HASH of each
   * session token rather than the token. It is in the settings section because
   * a phone should not have to sign in again after a restart; it is
   * `.hidden()` because a generic form has no business drawing it.
   */
  browsers?: BrowserTable
  /**
   * What has happened at the door.
   *
   * Persisted for one reason: the case worth catching is the one nobody was
   * watching, and a log that started empty on every restart would be blank
   * exactly when it mattered.
   */
  access?: AccessTable
}

/** The schema, which is what makes any of the above configurable at all. */
export const Config: Schema<RemctrlConfig, Required<RemctrlConfig>> = Schema.object({
  enabled: Schema.boolean().default(false)
    .description('Put this harness\'s own interface on a public address. Off by default, and this is the only switch — everything below has a working default.'),
  publicHost: Schema.string().default('')
    .description('Where people reach this harness, and its SHAPE says which deployment you have. EMPTY (the usual case): cloudflared opens an outbound tunnel and hands back an https address — no port forwarding, no certificate. A bare address (121.43.252.12, or a 100.x tailnet address): this process is what people reach, and it binds that address when the machine holds it. A whole URL (https://dsh.example.com, http://1.2.3.4:7860): something else carries the traffic — a reverse proxy, an ssh -R from a VPS, an frp — so the door binds loopback and the URL is what the card shows.'),
  port: Schema.natural().min(1).max(65535).default(DEFAULT_PORT)
    .description('The port the door listens on. Not the harness\'s own — this is a second socket in front of it. With no publicHost this is loopback-only and nothing outside can reach it directly.'),
  allowInsecure: Schema.boolean().default(false)
    .description('Serve a publicHost over plain HTTP. The session cookie grants everything this harness can do, and without TLS it crosses the internet in the clear. Required before a publicHost will open at all; leave it off and let the tunnel carry it over https.'),
  sessionTtlDays: Schema.natural().max(3650).default(DEFAULT_SESSION_TTL_DAYS)
    .description('How long a signed-in browser stays signed in, in days. Zero means forever — a real choice for a laptop that never leaves a desk, and the wrong one for a phone that leaves a building.'),
  passcode: Schema.string().role('secret').default('')
    .description('The passcode a browser types once. Minted for you the first time this is turned on; the card shows it, and can mint another.'),
  browsers: Schema.dict(Schema.any()).default({}).hidden()
    .description('Signed-in browsers, written by this plugin. Each record holds a hash of the session token, never the token.'),
  access: Schema.any().default({ events: [], seenAt: 0 }).hidden()
    .description('The door\'s log, written by this plugin: who signed in, who tried and failed, and when the card last read it.'),
}).i18n({
  zh: {
    enabled: '把本机的 dsh 界面开放到公网地址上。默认关闭，这也是唯一需要动的开关——下面每一项都有可用的默认值。',
    publicHost: '别人从哪里访问到这台 harness——它的「形状」决定了你是哪种部署。留空（常见情况）：cloudflared 建立出站隧道并返回一个 https 地址，不用端口映射也不用证书。填裸地址（121.43.252.12，或者 100.x 的 tailnet 地址）：本进程就是别人访问的对象，本机持有该地址时就只绑它。填完整 URL（https://dsh.example.com、http://1.2.3.4:7860）：由别的东西承载流量——反向代理、VPS 上的 ssh -R、frp——门绑回环地址，卡片上显示的就是这个 URL。',
    port: '本插件监听的端口。不是 harness 自己的端口——这是挡在它前面的第二个套接字。没有填 publicHost 时它只绑定回环地址，外部无法直接访问。',
    allowInsecure: '允许以明文 HTTP 对外提供 publicHost。会话 Cookie 拥有这台 harness 的全部权限，没有 TLS 就等于让它明文穿过互联网。填了 publicHost 必须先打开这一项才会启动；建议保持关闭，改用隧道走 https。',
    sessionTtlDays: '一个已登录的浏览器保持登录的天数。0 表示永不过期——对一台不离开桌面的笔记本这是合理选择，对一台会离开这栋楼的手机则不是。',
    passcode: '浏览器只需输入一次的通行码。第一次开启时自动生成；卡片上可以查看，也可以重新生成。',
    browsers: '已登录的浏览器，由本插件写入。每条记录只存会话令牌的哈希，不存令牌本身。',
    access: '门口的日志，由本插件写入：谁登录了、谁试过但没进来、以及卡片上一次看到哪里。',
  },
})

/** One namespace's owner handle, as much of `SettingsScope` as this plugin uses. */
interface SettingsScopeLike<T> {
  get: () => T
  watch: (callback: (next: T) => void) => () => void
  update: (patch: Partial<T>) => void | Promise<void>
}

/** The settings seam, structurally. */
interface SettingsLike {
  register: <T>(
    ns: string,
    schema: unknown,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart'; validate?: (value: T) => void },
  ) => SettingsScopeLike<T>
}

/** The harness's Connection service, as much of it as this plugin uses. */
interface ConnectionLike {
  rpc: {
    handle: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
      options: { authority: 'loopback' | 'trusted-host' },
    ) => () => void | Promise<void>
  }
}

/** The harness's WebServer service, as much of it as this plugin reads. */
interface WebServerLike {
  /** The port it actually bound; the OS-assigned value when the composition asked for zero. */
  port: number
}

/**
 * The plugin context, as much of it as this plugin uses.
 *
 * Structural rather than the ambient cordis `Context`, and resolved by NAME
 * rather than by property access: a package compiled outside the harness
 * typechecks its halves as one program, so a dotted `ctx.connection` is
 * whichever declaration the compiler happened to see first. At runtime cordis
 * publishes exactly one service per name, and in this process it is the host's.
 */
export interface RemctrlContext {
  /**
   * Hold a disposable for as long as the plugin is mounted.
   * @param setup - produces the disposer.
   * @param label - what the effect owns, for diagnostics.
   */
  effect: (setup: () => () => void, label?: string) => void
  /**
   * Run `callback` while every named service is available.
   * @param deps - service names.
   * @param callback - receives a context scoped to their availability.
   */
  inject?: (deps: string[], callback: (ctx: RemctrlContext) => void) => void
  /**
   * Resolve one service by name.
   * @param serviceName - the service name.
   * @returns the service, or undefined when nothing provides it.
   */
  get?: (serviceName: string) => unknown
  logger?: {
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
}

/** Every configurable value, resolved. */
export type Options = RemctrlWire

/**
 * Fold a configuration section onto the defaults.
 * @param config - the section, possibly partial.
 * @returns every value, resolved.
 */
export function resolve(config: RemctrlConfig): Options {
  return {
    // `false`, and this is the one default worth stating twice: remote control
    // that arrives switched on is remote control somebody did not choose.
    enabled: config.enabled ?? false,
    publicHost: (config.publicHost ?? '').trim(),
    port: config.port ?? DEFAULT_PORT,
    allowInsecure: config.allowInsecure ?? false,
    sessionTtlDays: config.sessionTtlDays ?? DEFAULT_SESSION_TTL_DAYS,
  }
}

/**
 * Open the door.
 * @param ctx - the plugin context carrying `connection`, and `webServer` and `settings` where they are composed.
 * @param config - the composition entry; see {@link RemctrlConfig}.
 */
export function apply(ctx: RemctrlContext, config: RemctrlConfig = {}): void {
  // Mutable, because these are settings: the listener rebinds and the session
  // lifetime moves without a restart. Everything downstream closes over this
  // object rather than over its values.
  let options = resolve(config)
  let passcode = config.passcode ?? ''

  const browsers = new BrowserStore({ now: () => Date.now(), hashToken })
  browsers.load(config.browsers)

  // `console.log` rather than `ctx.logger.info`, for the same reason the URL
  // line is: a browser signing in is boot-grade news for whoever is watching a
  // terminal, and the logger's info level does not reach one.
  const access = new AccessJournal({ now: () => Date.now(), announce: line => { console.log(line) } })
  access.load(config.access)

  const signIn = new Throttle(SIGN_IN_RULE, () => Date.now())
  const auth = new Throttle(AUTH_RULE, () => Date.now())

  /** The harness's own web server, once a fiber that has it runs. */
  let webServer: WebServerLike | undefined

  const tunnel = new Cloudflared({
    spawn: (binary, args) => spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    findBinary: () => locateBinary(process.env['PATH'], isExecutable),
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      // A pending retry must not be the reason this process stays alive: a
      // `cloudflared` that will not start would otherwise hold the event loop
      // open through every shutdown.
      handle.unref?.()
      return handle
    },
    clearTimer: (handle) => { clearTimeout(handle as NodeJS.Timeout) },
    onState: state => { announceTunnel(state) },
    onLog: line => { ctx.logger?.warn?.(line) },
  })

  /** The live bind, or the refusal that stopped it. Read by the control channel. */
  let decision: BindDecision = { kind: 'refused', carrier: 'tunnel', message: 'not started' }

  /** Every address this machine holds, read fresh: a laptop gains and loses them. */
  const addresses = (): string[] => localAddresses(networkInterfaces())
  let door: Door | undefined
  /**
   * Whether the port is actually held.
   *
   * Separate from `door !== undefined` because `listen` is asynchronous: the
   * server object exists the moment it is created, and the `EADDRINUSE` that
   * means another dsh already holds this port arrives a tick later.
   */
  let listening = false
  let stopped = false
  /**
   * Whether the mounting effect has run.
   *
   * `rebind` is reachable from three places — the effect, the `webServer`
   * fiber, and a settings change — and cordis may run a nested inject before
   * the effect that owns the listener. Without this the door would be opened
   * by a fiber that does not own it, and then closed and reopened a tick later
   * by the one that does: two binds, two `EADDRINUSE` chances, and a tunnel
   * that hands back a second hostname for no reason.
   */
  let started = false

  /** Writes into the settings section, once a fiber that has one runs. */
  let writeConfig = async (_patch: RemctrlPatch): Promise<string | undefined> =>
    'this harness composes no settings provider, so there is nothing to write into'
  let writable = false
  let readConfig = (): RemctrlConfig => config

  const carrier = (): Carrier => carrierFor(options.publicHost)

  /**
   * Whether whatever carries this deployment promised TLS.
   *
   * For `fronted` it is the declared URL's own scheme — the person wrote down
   * how they are reached, and that is a better source than any inference. For
   * the other carriers it is not read.
   */
  const secure = (): boolean => {
    const read = readPublicHost(options.publicHost)
    return read.kind === 'fronted' && read.secure
  }

  /**
   * Mint a passcode if there is not one yet.
   *
   * Lazily rather than at mount: a plugin that is switched off has no business
   * writing a credential into somebody's settings file, and the first moment
   * one is actually needed is the moment the door opens.
   */
  const ensurePasscode = (): void => {
    if (passcode !== '' || !options.enabled) return
    passcode = mintPasscode()
    persistPasscode(passcode)
  }

  /**
   * Write the passcode through, without going via `parsePatch`.
   *
   * `config/write` deliberately refuses a `passcode` field — see `control.ts`
   * — so this plugin's own writes take the scope directly. The refusal there is
   * about what the CARD may send; this is the plugin writing down something it
   * minted.
   */
  let persistPasscode = (_value: string): void => {}

  const currentUrl = (): string => reachableUrl({
    decision,
    publicHost: options.publicHost,
    port: options.port,
    tunnelUrl: tunnel.url(),
  })

  const describeStatus = (): StatusView => {
    const url = currentUrl()
    const available = addresses()
    return {
      enabled: options.enabled,
      listening,
      carrier: carrier(),
      bindHost: decision.kind === 'ok' ? decision.host : '',
      bindScope: decision.kind === 'ok' ? decision.scope : 'wide',
      tailnetAddresses: tailnetAddresses(available),
      port: options.port,
      upstreamPort: webServer?.port ?? null,
      url,
      signInUrl: signInLink(url, passcode, KEY_PARAM),
      passcode,
      tunnel: tunnel.view(),
      browsers: browsers.size,
      warnings: warningsFor({
        options,
        decision,
        hasUpstream: webServer !== undefined,
        tunnel: tunnel.view().state,
        url,
      }),
    }
  }

  /**
   * The section as the card reads it.
   *
   * Read through {@link readConfig} rather than off `options`, and that is not
   * a detail: `options` is only refreshed when the settings watch fires, which
   * is a fiber hop AFTER `scope.update` resolves. A card that wrote a field and
   * immediately read the section back would get the value it just replaced.
   */
  const describeConfig = (): ConfigView => ({ config: resolve(readConfig()), writable })

  /** Say what the tunnel is doing, once per transition. */
  let announcedTunnel = ''
  const announceTunnel = (state: TunnelState): void => {
    const line = tunnelLine(state)
    if (line === undefined || line === announcedTunnel) return
    announcedTunnel = line
    console.log(line)
    // A URL that has just arrived changes the whole announcement, not one line.
    if (state.kind === 'up') announceState()
  }

  /**
   * Bring the listener up on the current options, replacing any running one.
   *
   * Called at mount and again whenever a settings change moves the bind. A
   * refusal leaves nothing listening, which is the correct outcome — a door
   * that would not be private is a door that does not open.
   */
  const rebind = (): void => {
    if (stopped || !started) return
    door?.close()
    door = undefined
    listening = false
    signIn.clear()
    auth.clear()

    decision = resolveBind({
      enabled: options.enabled,
      carrier: carrier(),
      publicHost: options.publicHost,
      allowInsecure: options.allowInsecure,
      hasUpstream: webServer !== undefined,
      available: addresses(),
    })
    // Decided from the bind and acted on BEFORE the new listener, not after it
    // comes up. Doing it in `onListening` looks equivalent and is not: a bind
    // that fails — the port is held, the address went away with the VPN — never
    // calls that callback, so a tunnel that should have died would keep running
    // and keep a public name pointing at a door that just closed.
    if (!tunnelWanted(decision)) tunnel.stop()
    if (decision.kind === 'refused') {
      announceState()
      return
    }
    ensurePasscode()

    door = startDoor(
      {
        browsers,
        signIn,
        auth,
        passcode: () => passcode,
        carrier,
        secure,
        allowInsecure: () => options.allowInsecure,
        sessionTtlMs: () => options.sessionTtlDays * 24 * 60 * 60 * 1000,
        upstreamPort: () => webServer?.port,
        transformHtml: indexTransform,
        mintToken,
        mintBrowserId,
        labelFor: labelFromUserAgent,
        onAccess: (event) => {
          if (event.granted) access.granted({ ...event, browserId: event.browserId ?? '' })
          else access.refused(event)
        },
        onError: error => { ctx.logger?.warn?.(`omdsh-remctrl: ${error.message}`) },
      },
      { host: decision.host, port: options.port },
      (error) => {
        const failure = `omdsh-remctrl: listener on ${decision.kind === 'ok' ? decision.host : '?'}:${String(options.port)} failed: ${error.message}`
        // A failure BEFORE the port is held is boot status, and it goes where
        // the URL line would have gone. `EADDRINUSE` is the case that matters:
        // another dsh already holds this port, and a person who only ever sees
        // `ctx.logger.warn` — which does not reach stdout — is left with a door
        // that silently does not exist.
        if (listening) ctx.logger?.warn?.(failure)
        else {
          console.log(failure)
          console.log(`omdsh-remctrl: nothing is listening. Set a different \`port\`, or stop whatever holds ${String(options.port)}.`)
        }
      },
      () => {
        listening = true
        // Started only once the port is actually held: a tunnel to a door that
        // did not open is a public name for a connection refused.
        if (tunnelWanted(decision)) tunnel.start(options.port)
        announceState()
      },
    )
  }

  /** Whether the loader has finished, so the stored settings are the real ones. */
  let settled = false
  /** What boot last said, so an identical block is not repeated. */
  let lastAnnouncement = ''

  /**
   * Say where to point — once at boot, and again whenever a change moves the
   * answer.
   *
   * Held back until the loader settles, and that is not tidiness. The listener
   * binds TWICE on any install whose stored settings differ from the
   * composition defaults: once on the defaults at mount, once on the real
   * values when the settings fiber adopts them. Announcing both prints two
   * contradictory blocks, of which only the second was ever true.
   */
  const announceState = (): void => {
    if (stopped || !settled) return
    const lines = announcement({ options, decision, url: currentUrl(), passcode, tunnel: tunnel.view().state })
    const joined = lines.join('\n')
    if (joined === lastAnnouncement) return
    lastAnnouncement = joined
    for (const line of lines) console.log(line)
  }

  // The upstream, taken on a NESTED fiber and taken FIRST. A top-level
  // `inject` would make a TUI profile a dead boot rather than a plugin with
  // nothing to forward, and the second is the honest failure. Ahead of the
  // door's own effect so the first bind already knows whether there is
  // anything to forward — see `started`.
  ctx.inject?.(['webServer'], (wctx) => {
    const service = wctx.get?.('webServer') as WebServerLike | undefined
    if (service === undefined) return
    webServer = service
    rebind()
    wctx.effect(() => () => {
      webServer = undefined
      rebind()
    }, 'omdsh-remctrl: upstream')
  })

  ctx.effect(() => {
    started = true
    rebind()
    const settle = (): void => { settled = true; announceState() }
    const pending = (ctx.get?.('loader') as { await?: () => Promise<unknown> } | undefined)?.await?.()
    if (pending === undefined) settle()
    else void pending.then(settle, settle)
    return () => {
      stopped = true
      started = false
      // The tunnel first: it is a child process talking to somebody else's
      // network, and leaving one running past an unmount would keep a public
      // name pointing at a port that is about to stop answering.
      tunnel.stop()
      door?.close()
      door = undefined
    }
  }, 'omdsh-remctrl: the door')

  ctx.effect(() => {
    const connection = ctx.get?.('connection') as ConnectionLike | undefined
    if (connection === undefined) return () => {}
    const dispose = connection.rpc.handle(
      CONTROL_CHANNEL,
      createControlHandler({
        browsers,
        access,
        status: describeStatus,
        config: describeConfig,
        writeConfig: patch => writeConfig(patch),
        resetPasscode: async () => {
          const minted = mintPasscode()
          passcode = minted
          persistPasscode(minted)
          return minted
        },
      }),
      // Loopback, not trusted-host. Which the forward makes reachable from a
      // signed-in browser anyway — see the note in `control.ts` — but the fence
      // is still the harness's, and it is still what keeps this channel off the
      // wire for anyone who has NOT signed in.
      { authority: 'loopback' },
    )
    return () => { void dispose() }
  }, 'omdsh-remctrl: desktop control channel')

  // The settings namespace, per the omdsh convention: the composition entry is
  // the layer underneath, the person's edits sit on top, and `omdsh-plughub`
  // renders the card.
  ctx.inject?.(['settings'], (sctx) => {
    const settings = sctx.get?.('settings') as SettingsLike | undefined
    if (settings === undefined) return
    const scope = settings.register<RemctrlConfig>(SETTINGS_NAMESPACE, Config, {
      base: config,
      applies: 'live',
      validate: (value) => {
        const problem = checkPublicHost((value.publicHost ?? '').trim())
        if (problem !== undefined) throw new Error(`omdsh-remctrl: ${problem}`)
      },
    })

    writable = true
    readConfig = () => scope.get()

    // The stored table is adopted ONCE. From here the in-memory store is
    // authoritative and writes flow the other way: this plugin is the only
    // writer of `browsers`, and re-adopting our own write on the watch it
    // triggers would be a loop with a race in it.
    browsers.load(scope.get().browsers ?? config.browsers)
    access.load(scope.get().access ?? config.access)
    passcode = scope.get().passcode ?? passcode

    /**
     * Mirror a write, and let it fail without taking the process down.
     *
     * `settings.update` rejects on a read-only provider, on a scope this fiber
     * has already dropped, and on a disk that would not take the write. The
     * harness answers an unhandled rejection with `fatal load failure` and
     * `exit(1)`, which would mean one phone signing in takes the whole agent
     * host with it. The store is authoritative in memory either way: what is
     * lost is durability, and the right report for that is a line.
     */
    const mirror = (patch: Partial<RemctrlConfig>, what: string): void => {
      void Promise.resolve(scope.update(patch)).catch((error: unknown) => {
        ctx.logger?.warn?.(
          `omdsh-remctrl: ${what} could not be written to settings; it holds until restart: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
    browsers.setPersist((table) => { mirror({ browsers: table }, 'the browser list') })
    access.setPersist((table) => { mirror({ access: table }, 'the access log') })
    persistPasscode = (value) => { mirror({ passcode: value }, 'the passcode') }

    // A passcode minted before this fiber ran was written into a no-op, so it
    // would be a NEW one on every restart — the one property a persistent
    // passcode exists to have. The mount effect runs before the settings
    // service is available, and a plugin that is already `enabled: true` in its
    // composition entry mints on that first bind.
    ensurePasscode()
    if ((scope.get().passcode ?? '') === '' && passcode !== '') persistPasscode(passcode)

    // The card's writes go through the same scope the form would have used, so
    // the layering, the revision and the validation are the seam's rather than
    // a second path invented here. The refusal is RETURNED rather than thrown,
    // because a person editing a public host needs to read it.
    writeConfig = async (patch) => {
      try {
        await scope.update(patch)
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    const adopt = (next: RemctrlConfig): void => {
      const previous = options
      options = resolve(next)
      if (next.passcode !== undefined && next.passcode !== '') passcode = next.passcode
      if (
        previous.enabled !== options.enabled
        || previous.publicHost !== options.publicHost
        || previous.port !== options.port
        || previous.allowInsecure !== options.allowInsecure
      ) {
        rebind()
      }
    }
    adopt(scope.get())
    sctx.effect(() => {
      const unwatch = scope.watch((next) => { adopt(next) })
      return () => {
        writable = false
        readConfig = () => config
        writeConfig = async () => 'the settings scope for omdsh-remctrl is no longer mounted'
        persistPasscode = () => {}
        browsers.setPersist(undefined)
        access.setPersist(undefined)
        unwatch()
      }
    }, 'omdsh-remctrl: settings adoption')
  })
}

/**
 * Everything between this configuration and a browser reaching the harness.
 *
 * A pure function, so what a person is told is decided by tests rather than by
 * whichever branch happened to run.
 * @param input - the options, the bind, the upstream, the tunnel, and the URL.
 * @returns the warnings, most important first.
 */
export function warningsFor(input: {
  options: Options
  decision: BindDecision
  hasUpstream: boolean
  tunnel: TunnelState
  url: string
}): Warning[] {
  const { options, decision, hasUpstream, tunnel, url } = input
  const warnings: Warning[] = []

  if (!options.enabled) {
    warnings.push({ code: 'disabled', detail: 'Remote control is off. Nothing is listening.' })
    return warnings
  }
  if (!hasUpstream) {
    warnings.push({
      code: 'no-upstream',
      detail: 'This harness composes no web interface, so there is nothing to forward. '
        + 'Remote control works in the desktop app and in `dsh web`.',
    })
    return warnings
  }
  if (decision.kind === 'refused') {
    // The unacknowledged-plaintext refusal is named as its own thing rather
    // than folded into a generic one, because it is the only refusal a person
    // fixes with a checkbox — and that is true of both carriers that can serve
    // plaintext, not just the one that binds an address.
    const unacknowledged = decision.carrier !== 'tunnel' && !options.allowInsecure
    warnings.push({
      code: unacknowledged ? 'insecure-unacknowledged' : 'refused',
      detail: decision.message,
    })
    return warnings
  }

  if (decision.carrier === 'fronted') {
    const read = readPublicHost(options.publicHost)
    const secure = read.kind === 'fronted' && read.secure
    warnings.push(secure
      ? {
          code: 'fronted',
          detail: `Bound to ${decision.host}:${String(options.port)} and reached at ${url} by whatever you put in `
            + 'front of it. Requests that do not arrive over https are refused, so a carrier that stops terminating '
            + 'TLS is one refusal rather than a session cookie in the clear.',
        }
      : {
          code: 'plaintext',
          detail: `Reached at ${url}, which is plain http. The session cookie — which grants everything this harness `
            + 'can do — crosses a network unencrypted before it gets here, and so does everything you type. '
            + 'Put TLS on the carrier and write the https URL here instead.',
        })
    return warnings
  }

  if (decision.carrier === 'direct') {
    if (decision.scope === 'tailnet') {
      warnings.push({
        code: 'tailnet',
        detail: `Bound to ${decision.host}, which is a tailnet address this machine holds. `
          + 'The door speaks plain HTTP and nothing else on this machine\'s other networks can reach it; '
          + 'WireGuard is what encrypts the wire, and nobody in between terminates your TLS.',
      })
      return warnings
    }
    if (decision.scope === 'loopback') {
      warnings.push({
        code: 'loopback-only',
        detail: `Bound to ${decision.host}, so only this machine can reach the door. `
          + 'Put something in front of it — a reverse proxy, a tunnel — or set publicHost to an address others can use.',
      })
      return warnings
    }
    warnings.push({
      code: 'plaintext',
      detail: `Bound to ${decision.host}, in plain HTTP. The session cookie — which grants everything this harness `
        + 'can do — crosses the wire unencrypted, and so does everything you type into it. '
        + 'Put a reverse proxy with TLS in front, use a tailnet address, or clear publicHost and let the tunnel carry it.',
    })
    return warnings
  }

  if (tunnel.kind === 'failed') {
    warnings.push(tunnel.reason === 'missing-binary'
      ? {
          code: 'missing-binary',
          detail: 'cloudflared is not installed. On macOS: `brew install cloudflared`. '
            + 'Otherwise see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
        }
      : { code: 'tunnel-down', detail: tunnel.detail })
    return warnings
  }
  if (url === '') {
    warnings.push({ code: 'tunnel-down', detail: 'The tunnel is starting; there is no address yet.' })
  }
  return warnings
}

/**
 * Whether a `cloudflared` should be running at all, decided from the bind.
 *
 * One predicate rather than a condition at each call site, because the answer
 * has to be the same in three places that are easy to let drift: the bind that
 * refused, the bind that succeeded, and the unmount. A tunnel is wanted exactly
 * when the door came up AND nothing else is carrying it — so writing a public
 * host into the settings takes the tunnel down as a consequence of the bind
 * rather than as a separate thing somebody has to remember to do.
 *
 * What it cannot do is stop a `cloudflared` this plugin did not start. A tunnel
 * launched by hand from a terminal is a process with no relationship to this
 * one, and killing processes it does not own is not a thing a settings panel
 * should do.
 * @param decision - what `resolveBind` decided.
 * @returns whether to have a tunnel.
 */
export function tunnelWanted(decision: BindDecision): boolean {
  return decision.kind === 'ok' && decision.carrier === 'tunnel'
}

/**
 * One line about the tunnel, or nothing when the transition is not worth one.
 *
 * `starting` says nothing after the first attempt: the interesting states are
 * "here is your address" and "here is what is wrong", and a line per retry
 * would bury both.
 * @param state - the tunnel's state.
 * @returns the line, or undefined.
 */
export function tunnelLine(state: TunnelState): string | undefined {
  switch (state.kind) {
    case 'off':
      return undefined
    case 'starting':
      return state.attempt === 1 ? 'omdsh-remctrl: opening a cloudflared tunnel…' : undefined
    case 'up':
      // The URL is announced by `announcement` alongside the passcode, which is
      // the pair a person actually needs.
      return undefined
    default:
      return state.reason === 'missing-binary'
        ? 'omdsh-remctrl: cloudflared is not installed, so there is no way out. On macOS: `brew install cloudflared`.'
        : `omdsh-remctrl: the tunnel is not carrying — ${state.detail}`
  }
}

/**
 * What to say at boot: where to point, and the passcode to type.
 *
 * A pure function returning lines, so what a person is told is decided by tests
 * rather than by whichever branch happened to run. `apply` prints them.
 *
 * Silent when switched off. Remote control is off on every install that never
 * asked for it, and a line about it on every boot would be noise in every
 * terminal in the world.
 * @param input - the options, the bind, the URL, the passcode, and the tunnel.
 * @returns the lines, in order.
 */
export function announcement(input: {
  options: Options
  decision: BindDecision
  url: string
  passcode: string
  tunnel: TunnelState
}): string[] {
  const { options, decision, url, passcode, tunnel } = input
  if (!options.enabled) return []
  if (decision.kind === 'refused') return [decision.message]

  if (url === '') {
    if (tunnel.kind === 'failed') return []
    return ['omdsh-remctrl: the door is up; waiting for the tunnel to hand back an address.']
  }
  const lines = [`omdsh-remctrl: ${url}`]
  if (passcode !== '') {
    lines.push(`omdsh-remctrl: passcode ${passcode} — or open ${url}${url.endsWith('/') ? '' : '/'}?${KEY_PARAM}=${passcode} to skip typing it.`)
  }
  if (decision.carrier === 'fronted') {
    lines.push(`omdsh-remctrl: listening on ${decision.host}:${String(options.port)}; whatever you put in front is what carries it.`)
    if (!url.startsWith('https://')) {
      lines.push('omdsh-remctrl: that address is plain http, so the session cookie crosses a network in the clear before it arrives.')
    }
  }
  if (decision.carrier === 'direct') {
    lines.push(decision.scope === 'tailnet'
      ? `omdsh-remctrl: bound to ${decision.host} only — plain HTTP, carried inside WireGuard, and reachable from nowhere else.`
      : 'omdsh-remctrl: this is plain HTTP on the open internet, and the session cookie it hands out grants everything this harness can do.')
  }
  lines.push(`omdsh-remctrl: sign a browser out again at ${url}${GATE_ROUTES.signOut}, or from the plugin's card.`)
  return lines
}

/** How many characters a passcode has, re-exported so the card can say it. */
export { PASSCODE_LENGTH }

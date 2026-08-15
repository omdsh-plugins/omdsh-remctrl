/**
 * `@omdsh-plugins/omdsh-remctrl` — a second front door onto this harness, opened
 * on its own port, behind a device token.
 *
 * ## What M0 is
 *
 * The door and the lock, and nothing behind them yet. A phone on your tailnet
 * loads a page, types a six-digit code the desktop minted, and gets a token it
 * can prove itself with. `apiProxy` is not reached from here at all — the
 * proxy, the event stream, and the approval cards are M1 through M4 and land
 * beside this file. What exists now is the part that has to be right before any
 * of that is safe to write.
 *
 * ## Why a listener of our own
 *
 * Every sibling plugin in this repository hangs its routes on `ctx.webServer`.
 * This one cannot, and the reason is a fact about the harness rather than a
 * preference:
 *
 * - `WebServer.Config` validates its bind host against a RUNTIME schema
 *   admitting only `127.0.0.1` and `0.0.0.0`, and the web app's CLI refuses
 *   `--host 0.0.0.0` in as many words — *it would expose remote code execution
 *   to the network*. The harness carrier therefore cannot be placed on a
 *   tailnet address; a route registered on it is unreachable from a phone by
 *   construction.
 * - Putting a proxy in front of that carrier does not help, it hurts: `/api`
 *   is behind the same door, and its fence reads the Host header. A proxy that
 *   rewrote Host to loopback would open every privileged method — settings,
 *   credentials — to the whole tailnet, walking straight past the token gate
 *   this plugin exists to be. One listener with one plugin behind it makes that
 *   failure mode absent rather than merely unlikely.
 *
 * The configuration surface goes the other way. Minting codes and revoking
 * devices ride `ctx.connection.rpc` at `authority: 'loopback'`, so the controls
 * are reachable from the machine you are sitting at and from nowhere else, and
 * the fence enforcing that is the harness's rather than one written here.
 *
 * ## The bind is not a preference
 *
 * `bind.ts` will hand back exactly two kinds of address: loopback, or one this
 * machine holds inside Tailscale's `100.64.0.0/10`. There is no setting, flag,
 * or override that makes this plugin listen on a public interface. The harness
 * authors' objection was to exposing an agent to a network without
 * authentication; this plugin adds the authentication and then declines the
 * public network anyway.
 * @module @omdsh-plugins/omdsh-remctrl
 */

import { networkInterfaces } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import {
  CONTROL_CHANNEL, DEFAULT_PORT, LOOPBACK, SETTINGS_NAMESPACE,
  type ReachabilityView, type RpcResult, type Tier,
} from './contract.ts'
import { reachableUrls, resolveBind, tailnetAddresses, type BindDecision } from './bind.ts'
import { createControlHandler } from './control.ts'
import { DeviceStore, labelFromUserAgent, type DeviceTable } from './devices.ts'
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TTL_MS, PairingCodes } from './pairing.ts'
import { hashToken, mintCode, mintDeviceId, mintToken } from './secrets.ts'
import { startRemctrlServer } from './server.ts'

export * from './contract.ts'
export {
  isTailnetAddress, reachableUrls, resolveBind, tailnetAddresses, TAILNET_CIDR,
  type BindDecision, type InterfaceAddress, type InterfaceTable,
} from './bind.ts'
export {
  allows, authorize, isTier, visibleTo, EXPOSED_DOMAINS, METHOD_TIER, NEVER_EXPOSED,
  type Authorization,
} from './gate.ts'
export {
  constantTimeEquals, PairingCodes, DEFAULT_MAX_ATTEMPTS, DEFAULT_TTL_MS,
  type LiveCode, type PairingDeps, type RedeemOutcome,
} from './pairing.ts'
export { DeviceStore, labelFromUserAgent, type DeviceDeps, type DeviceRecord, type DeviceTable } from './devices.ts'
export { createControlHandler, type ControlDeps } from './control.ts'
export {
  bearerToken, cleanLabel, createRemctrlHandler, readBody, startRemctrlServer,
  BODY_LIMIT, LABEL_LIMIT, type ServerDeps,
} from './server.ts'
export { CODE_LENGTH, hashToken, mintCode, mintDeviceId, mintToken } from './secrets.ts'

/** Stable Cordis plugin name. */
export const name = 'omdsh-remctrl'

/**
 * The one service this plugin needs.
 *
 * `connection` carries the loopback control channel the desktop panel calls.
 * `apiProxy` joins it at M1, when there is something to proxy; declaring it now
 * would only stop this plugin activating in a composition it currently works
 * in.
 */
export const inject = ['connection']

/** How this plugin is configured. */
export interface RemctrlConfig {
  /** Whether the phone's door opens at all. */
  enabled?: boolean
  /**
   * Where to listen.
   *
   * Loopback, or a tailnet address this machine holds. Anything else is
   * refused at boot with a message naming what would have been accepted; see
   * `bind.ts` for why there is no third option.
   */
  bindHost?: string
  /** The port the phone's door listens on. */
  port?: number
  /** The tier a device pairs at. */
  defaultTier?: Tier
  /** How long a pairing code lives. */
  pairingTtlSeconds?: number
  /** How many wrong guesses a pairing code survives before it burns. */
  maxPairingAttempts?: number
  /**
   * The paired devices.
   *
   * Written by this plugin, hidden from the form, and holding a HASH of each
   * token rather than the token. It is in the settings section because a phone
   * should not have to pair again after a restart; it is `.hidden()` because a
   * generic form has no business drawing it.
   */
  devices?: DeviceTable
}

/** The schema, which is what makes any of the above configurable at all. */
export const Config: Schema<RemctrlConfig, Required<RemctrlConfig>> = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Whether the phone-facing door listens at all.'),
  bindHost: Schema.string().default(LOOPBACK)
    .description('Where to listen: 127.0.0.1, or one of this machine\'s Tailscale addresses (100.64.0.0/10). Nothing else is accepted — this plugin will not put an agent on a public interface.'),
  port: Schema.natural().max(65535).default(DEFAULT_PORT)
    .description('The port the phone connects to. Not the harness\'s own port — this is a separate door.'),
  defaultTier: Schema.union(['observe', 'respond', 'drive', 'full']).default('drive')
    .description('What a newly paired device may do: observe (read only), respond (approve and cancel), drive (also send messages and start sessions), full (also fork, pick models, and edit workspaces).'),
  pairingTtlSeconds: Schema.natural().min(30).max(3600).default(DEFAULT_TTL_MS / 1000)
    .description('How long a pairing code stays valid, in seconds.'),
  maxPairingAttempts: Schema.natural().min(1).max(20).default(DEFAULT_MAX_ATTEMPTS)
    .description('How many wrong guesses a pairing code survives before it is discarded.'),
  devices: Schema.dict(Schema.any()).default({}).hidden()
    .description('Paired devices, written by this plugin. Each record holds a hash of the device token, never the token.'),
}).i18n({
  zh: {
    enabled: '是否开启面向手机的入口。',
    bindHost: '监听地址：127.0.0.1，或本机的 Tailscale 地址（100.64.0.0/10）。其它一律拒绝——本插件不会把 agent 放到公网接口上。',
    port: '手机连接的端口。不是 harness 自己的端口，这是另一扇门。',
    defaultTier: '新配对设备的权限：observe（只读）、respond（可批准与中止）、drive（还可发消息、开新会话）、full（还可 fork、选模型、改工作区）。',
    pairingTtlSeconds: '配对码的有效期，单位秒。',
    maxPairingAttempts: '配对码允许输错几次，超过即作废。',
    devices: '已配对的设备，由本插件写入。每条记录只存 token 的哈希，不存 token 本身。',
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
    /**
     * Register one absolute channel prefix and its trust policy.
     * @param channel - the channel; one segment, no inner slashes.
     * @param handler - decoded endpoint handler.
     * @param options - the browser authority every endpoint on it accepts.
     * @returns the disposer, which may settle asynchronously.
     */
    handle: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
      options: { authority: 'loopback' | 'trusted-host' },
    ) => () => void | Promise<void>
  }
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
export interface Options {
  enabled: boolean
  bindHost: string
  port: number
  defaultTier: Tier
  pairingTtlSeconds: number
  maxPairingAttempts: number
}

/**
 * Fold a configuration section onto the defaults.
 * @param config - the section, possibly partial.
 * @returns every value, resolved.
 */
function resolve(config: RemctrlConfig): Options {
  return {
    enabled: config.enabled ?? true,
    bindHost: config.bindHost ?? LOOPBACK,
    port: config.port ?? DEFAULT_PORT,
    defaultTier: config.defaultTier ?? 'drive',
    pairingTtlSeconds: config.pairingTtlSeconds ?? DEFAULT_TTL_MS / 1000,
    maxPairingAttempts: config.maxPairingAttempts ?? DEFAULT_MAX_ATTEMPTS,
  }
}

/**
 * Open the door.
 * @param ctx - the plugin context carrying `connection`, and `settings` where one is composed.
 * @param config - the composition entry; see {@link RemctrlConfig}.
 */
export function apply(ctx: RemctrlContext, config: RemctrlConfig = {}): void {
  // Mutable, because these are settings: the listener rebinds and the pairing
  // budgets move without a restart. Everything downstream closes over this
  // object rather than over its values.
  let options = resolve(config)

  const devices = new DeviceStore({ now: () => Date.now(), hashToken })
  devices.load(config.devices)

  const pairing = new PairingCodes({
    now: () => Date.now(),
    mintCode,
    get ttlMs() { return options.pairingTtlSeconds * 1000 },
    get maxAttempts() { return options.maxPairingAttempts },
  })

  /** The live bind, or the refusal that stopped it. Read by the control channel. */
  let decision: BindDecision = { kind: 'refused', host: options.bindHost, message: 'not started' }
  let listener: { close: () => void } | undefined
  let stopped = false

  const describeStatus = (): ReachabilityView => {
    const tailnet = tailnetAddresses(networkInterfaces())
    return {
      bindHost: decision.host,
      port: options.port,
      kind: decision.kind === 'tailnet' ? 'tailnet' : 'loopback',
      tailnetAddresses: tailnet,
      urls: reachableUrls(decision, options.port),
      paired: devices.size,
    }
  }

  /**
   * Bring the listener up on the current options, replacing any running one.
   *
   * Called at mount and again whenever a settings change moves the bind. A
   * refusal is reported and leaves nothing listening, which is the correct
   * outcome — a door that would not be private is a door that does not open.
   */
  const rebind = (): void => {
    if (stopped) return
    listener?.close()
    listener = undefined
    const available = tailnetAddresses(networkInterfaces())
    decision = options.enabled
      ? resolveBind(options.bindHost, available)
      : { kind: 'refused', host: options.bindHost, message: 'omdsh-remctrl: disabled by configuration; the door is closed.' }
    if (decision.kind === 'refused') {
      // `console` rather than `ctx.logger`, for the same reason the web app
      // prints its own URL that way: this is boot status for a person watching
      // a terminal, and the logger's info level does not reach one. A refusal
      // is the most important line of the lot — it is the difference between
      // "remote control is off" and "remote control is silently absent".
      for (const line of announcement({ decision, options, available })) console.log(line)
      return
    }
    listener = startRemctrlServer(
      {
        devices,
        pairing,
        get defaultTier() { return options.defaultTier },
        labelFor: labelFromUserAgent,
        mintToken,
        mintDeviceId,
      },
      { host: decision.host, port: options.port },
      // A fault AFTER boot is a log line, not boot status: `EADDRINUSE`, a
      // handler that threw. The person who needed to see the URL has already
      // seen it.
      (error) => { ctx.logger?.warn?.(`omdsh-remctrl: listener on ${decision.host}:${options.port} failed: ${error.message}`) },
    )
    for (const line of announcement({ decision, options, available })) console.log(line)
  }

  /**
   * Offer a way in, once, if nothing is paired.
   *
   * Deferred until the loader has settled, which is the harness's own idiom for
   * "say this after everything has mounted" — the web app prints its URL line
   * the same way and for the same reason. Here the reason is sharper than
   * tidiness: the device table arrives on the settings fiber, so asking before
   * settlement reliably gets the answer "nothing is paired" and mints a live
   * code on every restart of a perfectly good install.
   *
   * A composition with no loader (a spec, a hand-built tree) answers at once,
   * which is correct there — nothing else is coming.
   */
  let offered = false
  const offerBootstrap = (): void => {
    if (offered || stopped || listener === undefined) return
    offered = true
    if (devices.size > 0) return
    console.log(bootstrapLine(pairing.mint().code, options.pairingTtlSeconds))
  }

  ctx.effect(() => {
    rebind()
    const settled = (ctx.get?.('loader') as { await?: () => Promise<unknown> } | undefined)?.await?.()
    if (settled === undefined) offerBootstrap()
    else void settled.then(offerBootstrap, offerBootstrap)
    return () => {
      stopped = true
      listener?.close()
      listener = undefined
      // A code outstanding at unmount would otherwise still be redeemable if
      // the plugin came back inside its five minutes.
      pairing.clear()
    }
  }, 'omdsh-remctrl: phone door')

  ctx.effect(() => {
    const connection = ctx.get?.('connection') as ConnectionLike | undefined
    if (connection === undefined) return () => {}
    const dispose = connection.rpc.handle(
      CONTROL_CHANNEL,
      createControlHandler({ devices, pairing, status: describeStatus }),
      // Loopback, not trusted-host: these are the controls, and the phone is
      // not where the controls live.
      { authority: 'loopback' },
    )
    return () => { void dispose() }
  }, 'omdsh-remctrl: desktop control channel')

  // The settings namespace, per the omdsh convention: the composition entry is
  // the layer underneath, the person's edits sit on top, and `omdsh-plughub`
  // renders the form from the schema alone.
  ctx.inject?.(['settings'], (sctx) => {
    const settings = sctx.get?.('settings') as SettingsLike | undefined
    if (settings === undefined) return
    const scope = settings.register<RemctrlConfig>(SETTINGS_NAMESPACE, Config, {
      base: config,
      // A rebinding, a tier change, and a revocation all take effect without a
      // restart; `rebind` below is what makes the first of those true.
      applies: 'live',
      validate: (value) => {
        const candidate = resolve(value)
        const verdict = resolveBind(candidate.bindHost, tailnetAddresses(networkInterfaces()))
        // Refusing the WRITE beats storing it and failing to listen at the next
        // mount, when nobody is watching the log.
        if (verdict.kind === 'refused') throw new Error(verdict.message)
      },
    })

    // The stored table is adopted ONCE. From here the in-memory store is
    // authoritative and writes flow the other way: this plugin is the only
    // writer of `devices`, and re-adopting our own write on the watch it
    // triggers would be a loop with a race in it.
    devices.load(scope.get().devices ?? config.devices)

    // The mirror is allowed to fail; the PROCESS is not. `settings.update`
    // rejects on a read-only provider, on a scope this fiber has already
    // dropped, on a disk that would not take the write — and on this
    // namespace's own `validate` above, which refuses a stored `bindHost` the
    // machine has stopped holding, so a laptop whose Tailscale went down turns
    // every later write into a rejection. The harness answers an unhandled
    // rejection with `fatal load failure` and `exit(1)`, which would mean a
    // phone pairing takes the whole agent host down with it. The store is
    // authoritative in memory either way: what is lost is durability, and the
    // right report for that is a line, not a crash.
    const persist = (table: DeviceTable): void => {
      void Promise.resolve(scope.update({ devices: table })).catch((error: unknown) => {
        ctx.logger?.warn?.(
          `omdsh-remctrl: the device table could not be mirrored into settings; pairings hold until restart: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
    devices.setPersist(persist)

    const adopt = (next: RemctrlConfig): void => {
      const previous = options
      options = resolve(next)
      if (
        previous.enabled !== options.enabled
        || previous.bindHost !== options.bindHost
        || previous.port !== options.port
      ) {
        rebind()
      }
    }
    adopt(scope.get())
    sctx.effect(() => scope.watch((next) => { adopt(next) }), 'omdsh-remctrl: settings adoption')
  })
}

/**
 * What to say at boot: where the phone should point, and how to get in.
 *
 * A pure function returning lines, so what a person is told is decided by tests
 * rather than by whichever branch happened to run. `apply` prints them.
 *
 * The bootstrap code is here rather than only in the desktop panel because
 * first contact should not require the GUI to already be open — a fresh install
 * on a headless box is exactly the case that needs it most.
 * @param input - the resolved bind, the resolved options, this machine's tailnet addresses, and the bootstrap code if one was minted.
 * @returns the lines, in order.
 */
export function announcement(input: {
  decision: BindDecision
  options: Options
  available: readonly string[]
}): string[] {
  const { decision, options, available } = input
  if (decision.kind === 'refused') return [decision.message]

  const lines: string[] = []
  const urls = reachableUrls(decision, options.port)
  if (urls.length > 0) {
    for (const url of urls) lines.push(`omdsh-remctrl: ${url}`)
  }
  else {
    lines.push(`omdsh-remctrl: listening on ${LOOPBACK}:${options.port}; nothing off this machine can reach it yet.`)
    lines.push(`omdsh-remctrl: put Tailscale in front of it — \`tailscale serve --bg --https=443 http://${LOOPBACK}:${options.port}\` — which also gives it TLS, and therefore a PWA and push.`)
    if (available.length > 0) {
      lines.push(`omdsh-remctrl: or set bindHost to one of this machine's tailnet addresses (${available.join(', ')}) for plain HTTP over WireGuard.`)
    }
  }
  return lines
}

/**
 * The line offering a way in when nothing is paired.
 *
 * Separate from {@link announcement} because it is answered at a different
 * TIME, not just in a different place: whether anything is paired is only known
 * once the settings section has been adopted, which happens on a fiber that
 * runs after this plugin's own effects. Printing it alongside the URL is how
 * you end up telling a working install it is empty — and handing out a live
 * five-minute pairing window on every restart, which is the thing the
 * "only when nothing is paired" rule exists to prevent.
 * @param code - the minted code.
 * @param ttlSeconds - how long it is good for.
 * @returns the line.
 */
export function bootstrapLine(code: string, ttlSeconds: number): string {
  return `omdsh-remctrl: no device is paired yet; pairing code ${code}, good for ${ttlSeconds}s.`
}

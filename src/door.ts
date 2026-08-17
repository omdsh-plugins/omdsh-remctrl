/**
 * The listener: one socket on the public side, the gate in front of it, and the
 * harness's own interface behind.
 *
 * There is exactly one request path through this file and it is short — decide,
 * then either answer as the gate or hand the request to the forward. Everything
 * that could be a policy lives somewhere else (`gate.ts` decides, `throttle.ts`
 * budgets, `reverse.ts` forwards) so what remains here is plumbing: reading a
 * form body, writing a redirect, and turning a verdict into a response.
 * @module @omdsh-plugins/omdsh-remctrl/door
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { GATE_ROUTES, type Carrier } from './contract.ts'
import { MOBILE_CSS, MOBILE_JS } from './mobile.ts'
import { signInCookie, signOutCookie, readCookie, type CookieOptions } from './cookies.ts'
import { BrowserStore } from './browsers.ts'
import { clientAddress, proxyTrustFor, requestProto, type RequestFacts } from './forward.ts'
import { decide, isNavigation, splitUrl, type GateVerdict } from './gate.ts'
import { pickLang, refusalPage, signInPage, type SignInError } from './pages.ts'
import { proxyHttp, proxyUpgrade, type ReverseDeps } from './reverse.ts'
import { constantTimeEquals, normalizePasscode } from './secrets.ts'
import { Throttle } from './throttle.ts'

/** The most a sign-in form body may be. A passcode and a path; anything more is not one. */
export const FORM_LIMIT = 2048

/** What the door needs to answer a request. */
export interface DoorDeps {
  /** The signed-in browsers. */
  browsers: BrowserStore
  /** The budget for offering a passcode. */
  signIn: Throttle
  /** The budget for presenting a cookie that does not resolve. */
  auth: Throttle
  /** The passcode, read live so a reset takes effect without a rebind. */
  passcode: () => string
  /** How the gate is reached. */
  carrier: () => Carrier
  /** For the `fronted` carrier, whether the declared URL is https. */
  secure: () => boolean
  /** Whether plain HTTP was acknowledged. */
  allowInsecure: () => boolean
  /** How long a new session lives, in milliseconds; zero means forever. */
  sessionTtlMs: () => number
  /** The harness's own port. */
  upstreamPort: () => number | undefined
  /** Rewrite the harness's index on the way back; see `reverse.ts`. */
  transformHtml?: ReverseDeps['transformHtml']
  /** Mint a session token. */
  mintToken: () => string
  /** Mint a browser id. */
  mintBrowserId: () => string
  /** Name a browser from its User-Agent. */
  labelFor: (userAgent: string | undefined) => string
  /**
   * Told about every attempt at the passcode, good or bad.
   *
   * `trySignIn` is the one choke point — the form and the `?k=` link both go
   * through it — so a hook here cannot be bypassed by a second code path,
   * which is the property an access log has to have to be worth keeping.
   */
  onAccess?: (event: { granted: boolean; label: string; address: string; browserId?: string }) => void
  /** Where a fault that is not the client's goes. */
  onError?: (error: Error) => void
}

/** The request, as `gate.ts` and `forward.ts` read it. */
function factsOf(req: IncomingMessage): RequestFacts {
  return {
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress,
    encrypted: false,
  }
}

/**
 * The whole request path, as a handler.
 * @param deps - see {@link DoorDeps}.
 * @returns the node:http request listener.
 */
export function createDoorHandler(
  deps: DoorDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const reverse: ReverseDeps = {
    upstreamPort: deps.upstreamPort,
    ...deps.transformHtml === undefined ? {} : { transformHtml: deps.transformHtml },
    ...deps.onError === undefined ? {} : { onError: deps.onError },
  }

  return (req, res) => {
    const facts = factsOf(req)
    const carrier = deps.carrier()
    const secure = deps.secure()
    const trust = proxyTrustFor(carrier, secure)
    const verdict = decide({
      facts,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      carrier,
      secure,
      allowInsecure: deps.allowInsecure(),
      trust,
      resolve: token => deps.browsers.authenticate(token)?.browserId,
    })

    void answer(verdict, req, res, facts, deps, reverse).catch((error: unknown) => {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)))
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'omdsh-remctrl: internal error')
      else res.destroy()
    })
  }
}

/**
 * Carry out one verdict.
 * @param verdict - what `gate.ts` decided.
 * @param req - the request.
 * @param res - the response.
 * @param facts - the request, structurally.
 * @param deps - see {@link DoorDeps}.
 * @param reverse - the forward's own dependencies.
 */
async function answer(
  verdict: GateVerdict,
  req: IncomingMessage,
  res: ServerResponse,
  facts: RequestFacts,
  deps: DoorDeps,
  reverse: ReverseDeps,
): Promise<void> {
  const lang = pickLang(req.headers['accept-language'])

  switch (verdict.kind) {
    case 'forward': {
      // The two files this plugin adds to the forwarded page. Served here
      // rather than as gate routes so they stay BEHIND the passcode: they are
      // only ever referenced from the index, which a signed-out browser never
      // receives, so the rule stays "exactly two paths are reachable without a
      // session, and both are about getting one".
      const asset = mobileAsset(req.url ?? '/')
      if (asset !== undefined) {
        cacheable(res, asset.type, asset.body)
        return
      }
      proxyHttp(req, res, reverse)
      return
    }

    case 'refused': {
      const body = refusalPage({
        message: verdict.message,
        status: verdict.status,
        lang,
        ...verdict.status === 421 ? { insecure: true } : {},
      })
      send(res, verdict.status, 'text/html; charset=utf-8', body)
      return
    }

    case 'strip-key':
      redirect(res, verdict.next)
      return

    case 'sign-in-page':
      send(res, 200, 'text/html; charset=utf-8', signInPage({ next: verdict.next, lang }))
      return

    case 'unauthorized':
      // 401 with no `WWW-Authenticate`: the credential is a cookie, and naming
      // a scheme here would make Safari raise a basic-auth prompt that cannot
      // possibly succeed. The app reads the status; a person never sees it.
      send(res, 401, 'text/plain; charset=utf-8', 'omdsh-remctrl: sign in first')
      return

    case 'try-key': {
      const outcome = trySignIn(verdict.key, req, facts, deps)
      if (outcome.ok) {
        redirect(res, verdict.next, outcome.cookie)
        return
      }
      // A bad key on a link is answered with the FORM rather than a refusal:
      // the passcode may simply have been reset since the QR was photographed,
      // and the next thing a person needs is somewhere to type the new one.
      send(res, 200, 'text/html; charset=utf-8', signInPage({ next: verdict.next, error: outcome.error, lang }))
      return
    }

    case 'gate':
      if (verdict.route === 'sign-out') {
        signOut(req, res, deps)
        return
      }
      await handleSignIn(req, res, facts, deps, lang)
      return

    /* v8 ignore next 3 -- every arm above returns; this is the compiler's exhaustiveness check. */
    default:
      send(res, 500, 'text/plain; charset=utf-8', 'omdsh-remctrl: unreachable')
  }
}

/** The sign-in route: the form on GET, an attempt on POST. */
async function handleSignIn(
  req: IncomingMessage,
  res: ServerResponse,
  facts: RequestFacts,
  deps: DoorDeps,
  lang: ReturnType<typeof pickLang>,
): Promise<void> {
  const { search } = splitUrl(req.url ?? '/')
  const next = safeNext(new URLSearchParams(search).get('next'))

  if (req.method !== 'POST') {
    send(res, 200, 'text/html; charset=utf-8', signInPage({ next, lang }))
    return
  }

  const body = await readBody(req, FORM_LIMIT)
  if (body === undefined) {
    send(res, 413, 'text/plain; charset=utf-8', 'omdsh-remctrl: that form was too large')
    return
  }
  const form = new URLSearchParams(body)
  const target = safeNext(form.get('next'))
  const outcome = trySignIn(form.get('passcode') ?? '', req, facts, deps)
  if (outcome.ok) {
    redirect(res, target, outcome.cookie)
    return
  }
  send(res, 200, 'text/html; charset=utf-8', signInPage({ next: target, error: outcome.error, lang }))
}

/** Drop this browser's session, then send it back to the front. */
function signOut(req: IncomingMessage, res: ServerResponse, deps: DoorDeps): void {
  const token = readCookie(req.headers.cookie)
  const held = token === undefined ? undefined : deps.browsers.authenticate(token)
  if (held !== undefined) deps.browsers.revoke(held.browserId)
  redirect(res, '/', signOutCookie(cookieOptions(deps, 0)))
}

/** What one attempt at the passcode produced. */
type SignInOutcome =
  | { ok: true; cookie: string }
  | { ok: false; error: SignInError }

/**
 * Check a passcode and, if it is right, mint a session.
 *
 * The throttle is spent BEFORE the comparison and refunded after a correct one,
 * so a wrong answer costs a token whether or not it was close, and a person who
 * mistypes once and gets it right is not still paying for it a minute later.
 * @param offered - whatever was typed, pasted, or carried on a link.
 * @param req - the request, for its User-Agent.
 * @param facts - the request, structurally, for the address to budget against.
 * @param deps - see {@link DoorDeps}.
 * @returns the cookie to set, or why not.
 */
export function trySignIn(
  offered: string,
  req: IncomingMessage,
  facts: RequestFacts,
  deps: DoorDeps,
): SignInOutcome {
  const userAgent = single(req.headers['user-agent'])
  const label = deps.labelFor(userAgent)
  const trust = proxyTrustFor(deps.carrier(), deps.secure())
  const key = clientAddress(facts, trust).address

  const expected = deps.passcode()
  // NOT recorded. Nobody attacked anything: this deployment has no passcode
  // set, so there is no attempt to log — only a misconfiguration to report,
  // which the page already does.
  if (expected === '') return { ok: false, error: 'no-passcode' }

  // Recorded even though it spends no token, because the log answers "how many
  // times did somebody knock", and a knock the throttle turned away is still a
  // knock. Coalescing in `access.ts` is what keeps that from being noise.
  if (!deps.signIn.take(key).ok) {
    deps.onAccess?.({ granted: false, label, address: key })
    return { ok: false, error: 'throttled' }
  }

  if (!constantTimeEquals(normalizePasscode(offered), normalizePasscode(expected))) {
    deps.onAccess?.({ granted: false, label, address: key })
    return { ok: false, error: 'wrong' }
  }
  deps.signIn.forgive(key)

  const token = deps.mintToken()
  const browserId = deps.mintBrowserId()
  deps.browsers.issue({
    browserId,
    token,
    label,
    ttlMs: deps.sessionTtlMs(),
    ...userAgent === undefined ? {} : { userAgent },
  })
  deps.onAccess?.({ granted: true, label, address: key, browserId })
  const ttlMs = deps.sessionTtlMs()
  return { ok: true, cookie: signInCookie(token, cookieOptions(deps, ttlMs)) }
}

/**
 * How to write the cookie in this deployment.
 *
 * `Secure` exactly under the tunnel, where every request really is HTTPS.
 * Setting it under `direct` would mean the browser never sends the cookie back
 * at all — a sign-in that appears to work and then silently does not, which is
 * worse than an honest plaintext cookie next to an acknowledgement somebody had
 * to write down.
 */
function cookieOptions(deps: DoorDeps, ttlMs: number): CookieOptions {
  return {
    // Marked whenever the carrier promised TLS — the tunnel always does, a
    // `fronted` deployment does when its declared URL is https. Marking it on a
    // plaintext origin means the browser never sends it back at all.
    secure: deps.carrier() === 'tunnel' || (deps.carrier() === 'fronted' && deps.secure()),
    maxAgeSeconds: ttlMs > 0 ? Math.floor(ttlMs / 1000) : 0,
  }
}

/**
 * The upgrade path: the same gate, then the same forward.
 *
 * Every non-`forward` verdict ends the socket. There is no page to show and no
 * status a WebSocket client will render — the app's own reconnect loop is what
 * a person sees, and the honest answer to "this handshake is not authenticated"
 * is a closed connection with the reason on the status line.
 * @param deps - see {@link DoorDeps}.
 * @returns the node:http upgrade listener.
 */
export function createUpgradeHandler(
  deps: DoorDeps,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const reverse: ReverseDeps = {
    upstreamPort: deps.upstreamPort,
    ...deps.onError === undefined ? {} : { onError: deps.onError },
  }
  return (req, socket, head) => {
    const carrier = deps.carrier()
    const secure = deps.secure()
    const verdict = decide({
      facts: factsOf(req),
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      carrier,
      secure,
      allowInsecure: deps.allowInsecure(),
      trust: proxyTrustFor(carrier, secure),
      resolve: token => deps.browsers.authenticate(token)?.browserId,
    })
    if (verdict.kind === 'forward') {
      proxyUpgrade(req, socket, head, reverse)
      return
    }
    const status = verdict.kind === 'refused' ? verdict.status : 401
    socket.end(`HTTP/1.1 ${String(status)} Unauthorized\r\nConnection: close\r\n\r\n`)
  }
}

/** The door itself: a bound listener, or an error on the way to one. */
export interface Door {
  server: Server
  close: () => void
}

/**
 * Bind the door.
 * @param deps - see {@link DoorDeps}.
 * @param bind - the address and port.
 * @param onError - a listen or runtime failure.
 * @param onListening - called once the port is actually held.
 * @returns the door; see {@link Door}.
 */
export function startDoor(
  deps: DoorDeps,
  bind: { host: string; port: number },
  onError: (error: Error) => void,
  onListening: () => void,
): Door {
  const server = createServer(createDoorHandler(deps))
  server.on('upgrade', createUpgradeHandler(deps))
  server.on('error', onError)
  // A browser holding two WebSockets and an idle tab is the normal state here,
  // so the default 5s keep-alive would churn connections through the tunnel for
  // no reason. Longer than the harness's own, deliberately: the hop that closes
  // first decides, and it should be the one that knows about the app.
  server.keepAliveTimeout = 61_000
  server.headersTimeout = 65_000
  server.listen(bind.port, bind.host, onListening)
  return {
    server,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/**
 * A redirect target that cannot leave this origin.
 *
 * `next` arrives on a query string and in a form field, so it is attacker
 * controlled, and a redirect that honoured `//evil.example` or
 * `https://evil.example` would turn the sign-in page into an open redirect —
 * the classic way a phishing link borrows a trusted hostname.
 * @param value - whatever was proposed.
 * @returns a same-origin absolute path.
 */
export function safeNext(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '/'
  // A backslash is a slash to several browsers' URL parsers, so `/\evil.example`
  // is protocol-relative to them and a path to a naive check.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value
}

/**
 * How much of an over-long body to swallow before giving up on the connection.
 *
 * A body past the limit is refused, but the refusal still has to reach the
 * browser — and destroying the socket mid-upload turns a readable 413 into
 * `ECONNRESET`. So the rest is drained and discarded, up to a point: past this
 * the sender is not a browser that got the form wrong, and the socket goes.
 */
const DRAIN_LIMIT = 1024 * 1024

/**
 * Read a bounded request body.
 * @param req - the request.
 * @param limit - the most bytes to accept.
 * @returns the body, or undefined when it was longer than the limit.
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    let settled = false
    const done = (value: string | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: unknown) => {
      // Coerced rather than asserted: a body is Buffers on a real socket, and
      // a string on a stream a spec built by hand.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      size += bytes.length
      if (over) {
        if (size > DRAIN_LIMIT) req.destroy()
        return
      }
      if (size > limit) {
        over = true
        chunks.length = 0
        done(undefined)
        return
      }
      chunks.push(bytes)
    })
    req.on('end', () => { done(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', () => { done(undefined) })
    req.on('close', () => { done(undefined) })
  })
}

/**
 * Which of this plugin's own two files a path asks for, if any.
 * @param url - the raw request URL.
 * @returns the file, or undefined when the path is the harness's.
 */
export function mobileAsset(url: string): { type: string; body: string } | undefined {
  const { pathname } = splitUrl(url)
  if (pathname === GATE_ROUTES.mobileCss) return { type: 'text/css; charset=utf-8', body: MOBILE_CSS }
  if (pathname === GATE_ROUTES.mobileJs) return { type: 'text/javascript; charset=utf-8', body: MOBILE_JS }
  return undefined
}

/**
 * One response a browser may keep.
 *
 * Only this plugin's own two files, and only briefly: they change when the
 * plugin is upgraded, and an hour is short enough that a restart fixes a stale
 * one while still saving two requests on every page load over a tunnel.
 */
function cacheable(res: ServerResponse, type: string, body: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** One complete response. */
function send(res: ServerResponse, status: number, type: string, body: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    // The gate's own pages are the only thing here that is not the harness's,
    // and they are the pages a stranger can reach. Nothing about them should be
    // framed, sniffed, or referred onward.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

/** One redirect, optionally setting a cookie on the way. */
function redirect(res: ServerResponse, location: string, cookie?: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(303, {
    location,
    'cache-control': 'no-store',
    ...cookie === undefined ? {} : { 'set-cookie': cookie },
  })
  res.end()
}

/** One header value, when a repeated header would only be a client being odd. */
function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

export { GATE_ROUTES, isNavigation, requestProto }

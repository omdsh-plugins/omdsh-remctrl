/**
 * Who gets through, decided as a pure function.
 *
 * Everything this plugin protects is behind one `if`, so that `if` is written
 * here, alone, with no sockets and no I/O anywhere near it — the whole module
 * imports two constants and a cookie parser. What the harness normally spreads
 * across a Host fence, an Origin fence and a Fetch-Metadata fence, this file
 * re-asks at the public boundary, about the address the browser actually used.
 *
 * The three questions, in the order they are asked and for the reason they are
 * in that order:
 *
 * 1. **Transport.** A request that did not arrive over HTTPS under the tunnel
 *    is refused before anything reads a credential off it, so a misconfigured
 *    carrier is one 421 rather than a session cookie in the clear.
 * 2. **Provenance.** A cross-site request that is not a top-level navigation
 *    is refused, and a mismatched `Origin` with it. This is the whole of the
 *    CSRF defence for an app that has no CSRF tokens of its own — the harness
 *    relies on its own copy of this check, and forwarding rewrites the headers
 *    it reads, so the check has to exist here or it exists nowhere.
 * 3. **Identity.** Only then does a cookie mean anything.
 * @module @omdsh-plugins/omdsh-remctrl/gate
 */

import { GATE_ROUTES, KEY_PARAM, type Carrier } from './contract.ts'
import { readCookie } from './cookies.ts'
import { checkTransport, requestProto, type ProxyTrust, type RequestFacts } from './forward.ts'

/** What the gate decided to do with one request. */
export type GateVerdict =
  /** Signed in: hand it to the forward. */
  | { kind: 'forward'; browserId: string }
  /** One of the gate's own routes. */
  | { kind: 'gate'; route: 'sign-in' | 'sign-out' }
  /** A `?k=` on a navigation: check the passcode and, if it is right, sign in. */
  | { kind: 'try-key'; key: string; next: string }
  /** Already signed in with a `?k=` still on the URL: send them to the clean one. */
  | { kind: 'strip-key'; next: string }
  /** Not signed in, and asking for a page: show the passcode form. */
  | { kind: 'sign-in-page'; next: string }
  /** Not signed in, and not asking for a page: say so in a status the app can read. */
  | { kind: 'unauthorized' }
  /** Refused before identity was considered; see the module note. */
  | { kind: 'refused'; status: number; message: string }

/** What {@link decide} needs beyond the request itself. */
export interface GateInput {
  /** The request, structurally. */
  facts: RequestFacts
  /** Its method. */
  method: string
  /** Its raw URL, path and query together. */
  url: string
  /** How the gate is reached, which decides the transport question. */
  carrier: Carrier
  /** For `fronted`, whether the declared URL is https. */
  secure?: boolean
  /** Whether plain HTTP was acknowledged. */
  allowInsecure: boolean
  /** How much of a forwarding chain to believe; see `forward.ts`. */
  trust: ProxyTrust
  /** Turn a session token into a browser id, or not. */
  resolve: (token: string) => string | undefined
}

/**
 * Decide one request.
 * @param input - see {@link GateInput}.
 * @returns the verdict; see {@link GateVerdict}.
 */
export function decide(input: GateInput): GateVerdict {
  const transport = checkTransport({
    carrier: input.carrier,
    ...input.secure === undefined ? {} : { secure: input.secure },
    allowInsecure: input.allowInsecure,
    facts: input.facts,
    trust: input.trust,
  })
  if (transport.kind === 'refused') {
    // 421 rather than 400: "Misdirected Request" is exactly the case — this
    // request reached a server that is not willing to answer for the scheme it
    // arrived on. A browser will not retry it, which is what we want.
    return { kind: 'refused', status: 421, message: transport.message }
  }

  const provenance = checkProvenance(input.facts, requestProto(input.facts, input.trust))
  if (provenance !== undefined) return { kind: 'refused', status: 403, message: provenance }

  const { pathname, search } = splitUrl(input.url)
  if (pathname === GATE_ROUTES.signIn) return { kind: 'gate', route: 'sign-in' }
  if (pathname === GATE_ROUTES.signOut) return { kind: 'gate', route: 'sign-out' }

  const key = new URLSearchParams(search).get(KEY_PARAM)
  const token = readCookie(input.facts.headers.cookie)
  const browserId = token === undefined ? undefined : input.resolve(token)

  if (browserId !== undefined) {
    return key === null
      ? { kind: 'forward', browserId }
      : { kind: 'strip-key', next: withoutKey(pathname, search) }
  }
  if (key !== null && isNavigation(input.facts, input.method)) {
    return { kind: 'try-key', key, next: withoutKey(pathname, search) }
  }
  if (isNavigation(input.facts, input.method)) {
    return { kind: 'sign-in-page', next: withoutKey(pathname, search) }
  }
  return { kind: 'unauthorized' }
}

/**
 * Whether this request may be believed to come from our own page.
 *
 * A top-level navigation is always allowed, whatever site it came from, and
 * that is deliberate rather than lax: the entire point of this version is that
 * a QR in a photo, a link in a message and a bookmark all work, and every one
 * of those arrives cross-site. A navigation cannot read the response
 * cross-origin, and `SameSite=Lax` is what decides whether the cookie rides —
 * a cross-site POST navigation arrives without it and therefore signed out.
 *
 * Everything else — every `fetch`, every subresource, every WebSocket
 * handshake — must be same-origin, and is checked twice: by the browser's own
 * `sec-fetch-site` label where it exists, and by `Origin` where it does not.
 * @param facts - the request.
 * @param proto - the scheme the outermost hop saw.
 * @returns the refusal, or undefined when the request may proceed.
 */
export function checkProvenance(
  facts: RequestFacts,
  proto: 'http' | 'https' | undefined,
): string | undefined {
  const site = single(facts.headers['sec-fetch-site'])
  const mode = single(facts.headers['sec-fetch-mode'])
  if (mode === 'navigate') return undefined
  if (site === 'cross-site') return 'this request came from another site'

  const origin = single(facts.headers.origin)
  if (origin === undefined) return undefined
  const host = single(facts.headers.host)
  if (host === undefined) return 'this request carried an Origin and no Host'
  // `null` is the opaque origin a sandboxed iframe or a `file:` page sends. It
  // matches nothing, and treating it as absent would let exactly the contexts
  // that were stripped of an origin act as though they had ours.
  if (origin === 'null') return 'this request came from an opaque origin'
  const expected = `${proto ?? 'http'}://${host}`
  if (sameOrigin(origin, expected)) return undefined
  return `this request declared origin ${origin}, and this gate answers for ${expected}`
}

/**
 * Whether the request is a page load rather than something the page issued.
 *
 * `sec-fetch-mode` is the answer where a browser sends it. Where it does not —
 * an older browser, a `curl`, a link opened by an app that strips the headers
 * — the fallback is what the request says it accepts, because a person typing
 * a URL is asking for HTML and a script fetching JSON is not.
 * @param facts - the request.
 * @param method - its method.
 * @returns whether to answer with a page.
 */
export function isNavigation(facts: RequestFacts, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const mode = single(facts.headers['sec-fetch-mode'])
  if (mode !== undefined) return mode === 'navigate'
  const accept = single(facts.headers.accept) ?? ''
  return accept.includes('text/html')
}

/**
 * Two origins, compared the way a browser would.
 *
 * Through `URL` rather than by string equality, so a redundant default port
 * (`https://host:443`) and a difference in case do not decide access.
 */
function sameOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.protocol === b.protocol && a.host === b.host
  } catch {
    return false
  }
}

/** The path and the query, without letting a malformed URL throw. */
export function splitUrl(url: string): { pathname: string; search: string } {
  const at = url.indexOf('?')
  if (at < 0) return { pathname: url, search: '' }
  return { pathname: url.slice(0, at), search: url.slice(at + 1) }
}

/**
 * The same URL with the passcode parameter taken out.
 *
 * The redirect this builds is what keeps the passcode out of the address bar
 * after a scan. It cannot take it out of the history entry that already
 * exists, which is the cost of a magic link and is written down in
 * `contract.ts` beside {@link KEY_PARAM}.
 * @param pathname - the path.
 * @param search - the query, without its `?`.
 * @returns the URL to send the browser to.
 */
export function withoutKey(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete(KEY_PARAM)
  const rest = params.toString()
  const path = pathname === '' ? '/' : pathname
  return rest === '' ? path : `${path}?${rest}`
}

/** One header value, when a repeated header would only be a client being odd. */
function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

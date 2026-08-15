/**
 * The phone's door.
 *
 * A `node:http` listener of this plugin's own, and the reason it is not a
 * handful of routes on `ctx.webServer` is worth restating where the code is:
 * the harness carrier validates its bind host against a runtime schema
 * admitting only `127.0.0.1` and `0.0.0.0`, so it cannot be put on a tailnet at
 * all — and even proxied, everything else it serves, `/api` included, would
 * come along. `/api`'s fence reads the Host header; a proxy that rewrote Host
 * to loopback would open every privileged method to the tailnet and walk past
 * this file entirely. One listener, one plugin behind it, and that whole class
 * of misconfiguration has nowhere to happen.
 *
 * What is served here is deliberately small. M0 is the door itself: the page,
 * the code redemption, and the one authenticated route that makes "paired"
 * observable. The proxy onto `apiProxy` is M1 and lands beside these.
 * @module @omdsh-plugins/omdsh-remctrl/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MOBILE_ROUTES, type PairRefusal, type PairSuccess, type SessionView, type Tier } from './contract.ts'
import type { DeviceStore } from './devices.ts'
import type { PairingCodes } from './pairing.ts'
import { MOBILE_CSS, MOBILE_HTML, MOBILE_JS } from './mobile/assets.ts'

/** The largest request body this door reads. A pairing request is under 100 bytes. */
export const BODY_LIMIT = 4 * 1024

/** The longest device label accepted from a phone. */
export const LABEL_LIMIT = 64

/**
 * The page's content policy.
 *
 * `'self'` and nothing else, which the page is written to satisfy: no inline
 * script, no inline style, no external anything. A door that hands out agent
 * access is the wrong place to start relaxing a content policy.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ')

/** What {@link createRemctrlHandler} needs to answer a request. */
export interface ServerDeps {
  /** The paired devices; the only thing that turns a token into a tier. */
  devices: DeviceStore
  /** The outstanding pairing code. */
  pairing: PairingCodes
  /** The tier a device pairs at. */
  defaultTier: Tier
  /** A default name for a device, from its User-Agent. */
  labelFor: (userAgent: string | undefined) => string
  /** Mint a device token. */
  mintToken: () => string
  /** Mint a device id. */
  mintDeviceId: () => string
}

/**
 * Build the request handler.
 *
 * Separated from the listener so a spec can mount it on an ephemeral loopback
 * port and drive the real thing — the routing, the statuses, the gate — without
 * a harness, a tailnet, or a phone.
 * @param deps - see {@link ServerDeps}.
 * @returns the handler.
 */
export function createRemctrlHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // `req.url` on a server is origin-relative and `URL` needs a base to parse
    // against; nothing reads the host back, so the base is a placeholder. The
    // Host header is deliberately NOT consulted anywhere in this file: this
    // door authenticates with a bearer token, and a fence keyed on Host would
    // only reject the phone it exists for.
    const path = new URL(req.url ?? '/', 'http://remctrl.invalid').pathname
    const method = req.method ?? 'GET'

    switch (path) {
      case MOBILE_ROUTES.root:
        sendAsset(res, method, 'text/html; charset=utf-8', MOBILE_HTML, true)
        return
      case MOBILE_ROUTES.css:
        sendAsset(res, method, 'text/css; charset=utf-8', MOBILE_CSS, false)
        return
      case MOBILE_ROUTES.js:
        sendAsset(res, method, 'text/javascript; charset=utf-8', MOBILE_JS, false)
        return
      case MOBILE_ROUTES.pair:
        await handlePair(deps, req, res, method)
        return
      case MOBILE_ROUTES.session:
        handleSession(deps, req, res, method)
        return
      default:
        sendJson(res, 404, { error: 'no such route' })
    }
  }
}

/**
 * Start the listener.
 * @param deps - see {@link ServerDeps}.
 * @param bind - the resolved host and port. The host is whatever `bind.ts` allowed; this does not re-decide it.
 * @param onError - reported listener failures, `EADDRINUSE` above all.
 * @returns the server and its close, for an owning `ctx.effect`.
 */
export function startRemctrlServer(
  deps: ServerDeps,
  bind: { host: string; port: number },
  onError?: (error: Error) => void,
): { server: Server; close: () => void } {
  const server = createServer((req, res) => {
    void createRemctrlHandler(deps)(req, res).catch((error: unknown) => {
      // A handler that threw has written nothing; the socket would otherwise
      // hang until the phone's own timeout.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      onError?.(error instanceof Error ? error : new Error(String(error)))
    })
  })
  if (onError !== undefined) server.on('error', onError)
  server.listen(bind.port, bind.host)
  return {
    server,
    close: () => {
      // Sockets already accepted must not hold the process past an unmount.
      server.closeAllConnections()
      server.close()
    },
  }
}

/**
 * Redeem a pairing code for a device token.
 * @param deps - see {@link ServerDeps}.
 * @param req - the request.
 * @param res - the response.
 * @param method - the request method.
 */
async function handlePair(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'a pairing request is posted' })
    return
  }
  const body = await readBody(req)
  if (body === undefined) {
    sendJson(res, 413, refusal({ reason: 'malformed', message: 'the request body is too large' }))
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    sendJson(res, 400, refusal({ reason: 'malformed', message: 'the request is not JSON' }))
    return
  }
  const request = parsed as { code?: unknown; label?: unknown }
  if (typeof request.code !== 'string') {
    sendJson(res, 400, refusal({ reason: 'malformed', message: 'a pairing request names a code' }))
    return
  }

  const outcome = deps.pairing.redeem(request.code)
  switch (outcome.kind) {
    case 'no-code':
      sendJson(res, 401, refusal({ reason: 'no-code', message: 'no pairing code is outstanding' }))
      return
    case 'expired':
      sendJson(res, 401, refusal({ reason: 'expired', message: 'the pairing code expired' }))
      return
    case 'mismatch':
      sendJson(res, 401, refusal({
        reason: 'mismatch',
        remaining: outcome.remaining,
        message: `wrong code; ${outcome.remaining} attempts remain`,
      }))
      return
    case 'locked':
      sendJson(res, 401, refusal({
        reason: 'locked',
        message: 'the pairing code ran out of attempts and was discarded',
      }))
      return
    default: {
      const userAgent = headerOf(req, 'user-agent')
      const token = deps.mintToken()
      const deviceId = deps.mintDeviceId()
      const device = deps.devices.issue({
        deviceId,
        token,
        label: cleanLabel(request.label) ?? deps.labelFor(userAgent),
        tier: deps.defaultTier,
        ...userAgent === undefined ? {} : { userAgent },
      })
      // The one and only time the token exists outside the phone.
      const success: PairSuccess = {
        token,
        deviceId: device.deviceId,
        label: device.label,
        tier: device.tier,
      }
      sendJson(res, 200, success)
    }
  }
}

/**
 * Report who a token is. The authenticated probe that makes pairing observable
 * — and, from M1, the shape every other route's gate takes.
 * @param deps - see {@link ServerDeps}.
 * @param req - the request.
 * @param res - the response.
 * @param method - the request method.
 */
function handleSession(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): void {
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'the session is read with GET' })
    return
  }
  const token = bearerToken(req)
  if (token === undefined) {
    sendJson(res, 401, { error: 'this route needs a device token' })
    return
  }
  const device = deps.devices.authenticate(token)
  if (device === undefined) {
    // Identical to the missing-token answer on purpose: a revoked device
    // learns that it is not paired, and learns nothing about whether the token
    // it holds was ever real.
    sendJson(res, 401, { error: 'this route needs a device token' })
    return
  }
  const view: SessionView = {
    deviceId: device.deviceId,
    label: device.record.label,
    tier: device.record.tier,
    pairedAt: device.record.createdAt,
  }
  sendJson(res, 200, view)
}

/**
 * The bearer token a request presents.
 *
 * Header rather than cookie, and that choice is doing real work: a cookie is
 * attached by the browser to any request reaching this origin, so a page on
 * another site could drive this door through the phone that holds it. A token
 * read out of `localStorage` by this origin's own script cannot be replayed by
 * anybody else's, which is why nothing here needs a CSRF token or a Host fence.
 * @param req - the request.
 * @returns the token, or undefined when the header is absent or not a bearer.
 */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = headerOf(req, 'authorization')
  if (header === undefined) return undefined
  const match = /^Bearer[ ]+(?<token>[A-Za-z0-9._~+/=-]+)$/i.exec(header)
  return match?.groups?.['token']
}

/**
 * A device label a phone proposed, if it is usable.
 * @param value - whatever arrived in the `label` field.
 * @returns the trimmed label, or undefined to fall back to the User-Agent.
 */
export function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Control characters would land in a panel that renders this string.
  const trimmed = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, LABEL_LIMIT)
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read a request body, bounded so a runaway upload cannot hold memory.
 * @param req - the request to drain.
 * @param limit - the largest body accepted, in bytes.
 * @returns the body, or undefined when it exceeded the limit.
 */
export async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string | undefined> {
  // A declared length over the limit is refused before a single byte is
  // buffered. The streaming guard below still has to exist — a chunked body
  // declares nothing — but this is the case that would otherwise cost memory
  // to reject.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    // Bounded in BYTES: a character count would let a multi-byte body through
    // at several times the limit.
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One request header, as a single value.
 * @param req - the request.
 * @param name - the lowercase header name.
 * @returns the value, or undefined when absent or empty.
 */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === '' ? undefined : value
}

/** Widen a refusal to the response body shape, so every branch returns one type. */
function refusal(value: PairRefusal): PairRefusal {
  return value
}

/**
 * Serve one static asset.
 * @param res - the response.
 * @param method - the request method; anything but GET or HEAD is refused.
 * @param contentType - the type to declare.
 * @param body - the asset.
 * @param page - whether to attach the content policy (the shell only).
 */
function sendAsset(
  res: ServerResponse,
  method: string,
  contentType: string,
  body: string,
  page: boolean,
): void {
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'this asset is read with GET' })
    return
  }
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...page ? { 'content-security-policy': CSP } : {},
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * Answer one JSON request.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the value to serialize.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * The headers every answer from this door carries.
 *
 * Note what is NOT here: no `access-control-allow-origin`, ever. Its absence is
 * the whole cross-origin policy. A page on another site can still SEND a
 * request here, but every route worth reaching needs either an `authorization`
 * header or a JSON content type, both of which make the request non-simple —
 * so the browser asks a preflight question this door never answers, and the
 * request is never made. Adding a permissive CORS header would undo that in one
 * line.
 * @returns the headers.
 */
function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

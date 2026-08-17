/**
 * The forward itself: one request in on the public side, the same request out
 * on the harness's loopback port, and whatever comes back streamed straight
 * through.
 *
 * ## Why the Host header is rewritten, and why that is not a hole
 *
 * `@deepseek-ai/dsh-client-connection` fences `/api` and both WebSocket
 * downlinks behind a Host check: the request's `Host` must be loopback or a
 * declared `trustedHosts` authority, an `Origin` (when present) must equal it,
 * and an explicit `sec-fetch-site: cross-site` is refused outright. That fence
 * exists to stop DNS rebinding and cross-site reads against a server that has
 * no authentication of its own.
 *
 * Forwarding a request with `Host: something.trycloudflare.com` therefore gets
 * a 403, and every proxy in the world answers that the same way: it rewrites
 * `Host` to the upstream authority, because a reverse proxy IS the client from
 * the upstream's point of view.
 *
 * What makes that safe here is that the fence is re-imposed at the OUTER
 * boundary, on the public origin, by `gate.ts` — same three questions, asked
 * about the address the browser actually used. The rebinding defence is not
 * removed; it moves one hop out, to the only place that can see the name the
 * browser typed. What genuinely changes is that a signed-in browser reaches
 * every loopback-fenced method the desktop can, including settings and
 * credentials, and that is not a leak — it is what "the same interface" means,
 * and why the passcode in front of it is the whole of the security.
 * @module @omdsh-plugins/omdsh-remctrl/reverse
 */

import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { LOOPBACK } from './contract.ts'
import { stripCookie } from './cookies.ts'

/**
 * Headers that belong to one hop of a connection rather than to the message.
 *
 * RFC 7230 §6.1. Forwarding any of them corrupts the next connection: a
 * `connection: keep-alive` copied onto a request Node is already managing, or
 * a `transfer-encoding: chunked` copied onto a body Node will re-frame, both
 * produce a response that is subtly wrong rather than an error.
 */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** What the forward needs to know. */
export interface ReverseDeps {
  /** The harness's own port. */
  upstreamPort: () => number | undefined
  /**
   * Rewrite an `text/html` body on the way back, or leave it alone.
   *
   * The one place this plugin touches what it is forwarding, and it exists for
   * the phone: the harness's index carries a viewport meta written for a
   * desktop, and a stylesheet appended here is the only way to reach a page
   * built in another repository.
   */
  transformHtml?: (html: string) => string
  /** Where a forwarding failure goes. */
  onError?: (error: Error) => void
}

/**
 * The headers to send upstream.
 *
 * Three edits, each forced:
 *
 * - `host` becomes the upstream authority, because the harness's trust fence
 *   reads it (see the module note).
 * - `origin`, when present, becomes the same authority — the fence compares
 *   the two, and a mismatch is refused.
 * - the gate's own cookie is removed, so a credential granting shell access
 *   never appears in a second server's request headers.
 *
 * `referer` is dropped rather than rewritten. The harness does not read it,
 * and a rewritten one would be a lie about a page that does not exist.
 * @param headers - the incoming headers, as Node presents them.
 * @param authority - the upstream `host:port`.
 * @returns the outgoing headers.
 */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  authority: string,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'referer') continue
    if (value === undefined) continue
    out[name] = value
  }
  out.host = authority
  if (out.origin !== undefined) out.origin = `http://${authority}`
  const cookie = stripCookie(headers.cookie)
  if (cookie === undefined) delete out.cookie
  else out.cookie = cookie
  return out
}

/**
 * The response headers to write back.
 *
 * The same hop-by-hop filter as the request side, and it is load-bearing on
 * this side too: the harness answers with `transfer-encoding: chunked`, and
 * copying that onto a response whose length this module just recomputed is the
 * one combination HTTP forbids outright — `Content-Length can't be present with
 * Transfer-Encoding`, and the browser drops the connection. Node frames the
 * response it is given; the upstream's framing is not ours to repeat.
 * @param headers - the upstream response headers.
 * @returns the headers to send downstream.
 */
export function downstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name)) continue
    if (value === undefined) continue
    out[name] = value
  }
  return out
}

/**
 * Whether a response is HTML this plugin may rewrite.
 *
 * Only an uncompressed body: a `content-encoding` means the bytes on the wire
 * are not the document, and decompressing to insert a stylesheet would trade a
 * cheap pipe for a decode, an edit and a re-encode on every page load. The
 * harness's static server compresses nothing, so this is a guard against a
 * future rather than a case that happens.
 * @param headers - the upstream response headers.
 * @returns whether {@link ReverseDeps.transformHtml} should see it.
 */
export function isRewritableHtml(headers: IncomingHttpHeaders): boolean {
  const type = headers['content-type']
  if (typeof type !== 'string' || !type.toLowerCase().includes('text/html')) return false
  return headers['content-encoding'] === undefined
}

/**
 * Forward one ordinary request.
 * @param req - the public-side request.
 * @param res - the public-side response.
 * @param deps - see {@link ReverseDeps}.
 */
export function proxyHttp(req: IncomingMessage, res: ServerResponse, deps: ReverseDeps): void {
  const port = deps.upstreamPort()
  if (port === undefined) {
    plainText(res, 502, 'omdsh-remctrl: this harness composes no web interface, so there is nothing to forward.')
    return
  }
  const authority = `${LOOPBACK}:${String(port)}`
  const upstream = httpRequest({
    host: LOOPBACK,
    port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req.headers, authority),
  }, (from) => {
    const transform = deps.transformHtml
    if (transform === undefined || !isRewritableHtml(from.headers)) {
      res.writeHead(from.statusCode ?? 502, downstreamHeaders(from.headers))
      from.pipe(res)
      return
    }
    // Buffered rather than piped, and only here: an index is a few kilobytes
    // and there is no way to insert into a stream without holding it.
    const chunks: Buffer[] = []
    from.on('data', (chunk: Buffer) => chunks.push(chunk))
    from.on('end', () => {
      const body = Buffer.from(transform(Buffer.concat(chunks).toString('utf8')), 'utf8')
      const headers = { ...downstreamHeaders(from.headers), 'content-length': String(body.byteLength) }
      // The length just changed, so any upstream `etag` describes a document
      // that no longer exists — a browser holding it would be told 304 for a
      // page it never received.
      delete headers.etag
      res.writeHead(from.statusCode ?? 502, headers)
      res.end(body)
    })
    from.on('error', (error: Error) => {
      deps.onError?.(error)
      if (!res.headersSent) plainText(res, 502, 'omdsh-remctrl: the harness closed the response mid-flight.')
      else res.destroy()
    })
  })

  upstream.on('error', (error: Error) => {
    deps.onError?.(error)
    if (res.headersSent) {
      res.destroy()
      return
    }
    plainText(res, 502, `omdsh-remctrl: could not reach the harness on ${authority} — ${error.message}`)
  })
  // A client that hangs up mid-upload leaves the upstream request open with a
  // body Node is still waiting for; without this the socket is held until the
  // harness times it out.
  req.on('error', () => { upstream.destroy() })
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  req.pipe(upstream)
}

/**
 * Forward one protocol upgrade — which in this harness means both WebSocket
 * downlinks, `/api/events.mux` and `/api/events.host`.
 *
 * The handshake is replayed rather than parsed: the upstream's own 101 line
 * and headers are written back verbatim, so `sec-websocket-accept` is computed
 * by the party that owns the protocol and this module never has to know how.
 * After that it is two sockets and a pipe.
 * @param req - the public-side request.
 * @param socket - the public-side socket, already detached from the server.
 * @param head - whatever arrived after the handshake, which may be empty.
 * @param deps - see {@link ReverseDeps}.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: ReverseDeps,
): void {
  const port = deps.upstreamPort()
  if (port === undefined) {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    return
  }
  const authority = `${LOOPBACK}:${String(port)}`
  const headers = upstreamHeaders(req.headers, authority)
  // Restored deliberately: these two are hop-by-hop, and this hop IS the
  // upgrade. Stripping them and putting them back is not a round trip — it is
  // how the upgrade's own headers survive a filter written for everything else.
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade ?? 'websocket'

  const upstream = httpRequest({
    host: LOOPBACK,
    port,
    method: req.method,
    path: req.url,
    headers,
  })
  upstream.end()

  upstream.on('upgrade', (from, fromSocket, fromHead) => {
    const lines = [`HTTP/1.1 ${String(from.statusCode ?? 101)} ${from.statusMessage ?? 'Switching Protocols'}`]
    for (const [name, value] of Object.entries(from.headers)) {
      if (value === undefined) continue
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    // Either side may have sent frames inside its handshake buffer. Pushing
    // them back onto the stream ahead of the pipe is what stops the first
    // message of a connection from being the one that goes missing.
    if (fromHead.length > 0) socket.write(fromHead)
    if (head.length > 0) fromSocket.write(head)
    socket.pipe(fromSocket)
    fromSocket.pipe(socket)
    const drop = (): void => { socket.destroy(); fromSocket.destroy() }
    socket.on('error', drop)
    fromSocket.on('error', drop)
    socket.on('close', () => { fromSocket.destroy() })
    fromSocket.on('close', () => { socket.destroy() })
  })

  // An upgrade the upstream declined to upgrade: it answered with an ordinary
  // response instead. Passing the status through tells the browser what
  // happened rather than showing it a socket that closed for no reason.
  upstream.on('response', (from) => {
    socket.end(`HTTP/1.1 ${String(from.statusCode ?? 502)} ${from.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`)
    from.resume()
  })
  upstream.on('error', (error: Error) => {
    deps.onError?.(error)
    socket.destroy()
  })
  socket.on('error', () => { upstream.destroy() })
}

/**
 * One short answer, for the cases where there is no upstream to answer with.
 * @param res - the response.
 * @param status - the status code.
 * @param message - the sentence.
 */
function plainText(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

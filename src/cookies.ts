/**
 * The cookie the gate signs a browser in with, read and written.
 *
 * A cookie is not this plugin's preference; it is the only credential a whole
 * foreign web app carries by itself. The harness's page issues `fetch` calls,
 * `<script src>` fetches and two WebSocket handshakes, and nothing in this
 * process can put an `Authorization` header on any of them. So the credential
 * has to be one the browser attaches without being asked, and that is a cookie.
 *
 * Which makes the attributes the security, not decoration:
 *
 * - `HttpOnly` — a cross-site script injected into the harness's page cannot
 *   read the token out and post it somewhere. It can still ACT as the browser,
 *   but it cannot walk off with the session.
 * - `SameSite=Lax` — the cookie rides a top-level navigation (so a QR, a link
 *   in a message, a bookmark all work) and rides nothing else. Every
 *   cross-site `fetch`, form POST and subresource arrives without it, which is
 *   the whole of the CSRF defence for an app that has no CSRF tokens of its
 *   own.
 * - `Secure` under the tunnel, where every request really is HTTPS. Omitted
 *   under `direct`, where setting it would mean the cookie is never sent at
 *   all — a flag that silently breaks sign-in is worse than an honest absence
 *   next to an acknowledgement somebody had to write down.
 * @module @omdsh-plugins/omdsh-remctrl/cookies
 */

import { COOKIE_NAME } from './contract.ts'

/**
 * One cookie's value out of a `Cookie` header.
 *
 * Hand-parsed rather than split on `;` and `=` in one pass, because a cookie
 * value may contain `=` (base64url does not, but the parser should not depend
 * on the encoding of what it carries) and because a name must match exactly
 * rather than by prefix — `omdsh_remctrl_other` is not this cookie.
 * @param header - the raw `Cookie` header, or undefined.
 * @param name - the cookie name; {@link COOKIE_NAME} by default.
 * @returns the value, or undefined when the header does not carry one.
 */
export function readCookie(
  header: string | string[] | undefined,
  name: string = COOKIE_NAME,
): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (raw === undefined) return undefined
  for (const pair of raw.split(';')) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    if (pair.slice(0, at).trim() !== name) continue
    return decodeValue(pair.slice(at + 1).trim())
  }
  return undefined
}

/**
 * The `Cookie` header with this plugin's own cookie taken out.
 *
 * Called on the way UPSTREAM. The harness reads no cookies, so forwarding this
 * one changes no behaviour — what it would change is where the token exists: a
 * credential that grants shell access would appear in the request headers of a
 * second server, and from there in whatever that server ever logs. Removing it
 * costs one pass over a short string and means the token's lifetime is exactly
 * the gate.
 * @param header - the raw `Cookie` header, or undefined.
 * @param name - the cookie name to drop; {@link COOKIE_NAME} by default.
 * @returns the header without it, or undefined when nothing is left.
 */
export function stripCookie(
  header: string | string[] | undefined,
  name: string = COOKIE_NAME,
): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (raw === undefined) return undefined
  const kept = raw
    .split(';')
    .map(pair => pair.trim())
    .filter((pair) => {
      if (pair === '') return false
      const at = pair.indexOf('=')
      return (at < 0 ? pair : pair.slice(0, at).trim()) !== name
    })
  return kept.length === 0 ? undefined : kept.join('; ')
}

/** How a session cookie should be written. */
export interface CookieOptions {
  /** Whether to mark it `Secure`; true exactly when every request really is HTTPS. */
  secure: boolean
  /** How long it lives, in seconds. Zero writes a session cookie, which dies with the tab. */
  maxAgeSeconds: number
}

/**
 * The `Set-Cookie` value that signs a browser in.
 * @param token - the session token.
 * @param options - see {@link CookieOptions}.
 * @param name - the cookie name; {@link COOKIE_NAME} by default.
 * @returns the header value.
 */
export function signInCookie(
  token: string,
  options: CookieOptions,
  name: string = COOKIE_NAME,
): string {
  const parts = [`${name}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (options.maxAgeSeconds > 0) parts.push(`Max-Age=${String(Math.floor(options.maxAgeSeconds))}`)
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * The `Set-Cookie` value that signs a browser out.
 *
 * Same `Path` and `Secure` as the one it replaces: a browser matches a
 * deletion to an existing cookie by name, path and domain, so an expiry
 * written at a different path leaves the original in place and the sign-out
 * silently does nothing.
 * @param options - see {@link CookieOptions}; `maxAgeSeconds` is ignored.
 * @param name - the cookie name; {@link COOKIE_NAME} by default.
 * @returns the header value.
 */
export function signOutCookie(options: CookieOptions, name: string = COOKIE_NAME): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * One cookie value, un-escaped, without letting a malformed escape throw.
 *
 * `decodeURIComponent` rejects a lone `%` — and a request is allowed to send
 * one. A cookie that does not decode is simply not our token.
 */
function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

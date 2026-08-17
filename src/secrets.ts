/**
 * The random and one-way values this plugin mints, and the only module that
 * reaches `node:crypto`.
 *
 * Separated so `browsers.ts`, `throttle.ts` and `gate.ts` — the files that
 * carry the whole of this plugin's security — import nothing at all and can be
 * decided entirely by tests. Randomness and clocks are handed to them; this is
 * where the real ones come from.
 * @module @omdsh-plugins/omdsh-remctrl/secrets
 */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { PASSCODE_ALPHABET, PASSCODE_LENGTH } from './contract.ts'

/**
 * Mint one passcode.
 *
 * `randomInt` per character rather than a modulo of random bytes: the alphabet
 * is 32 long so a modulo would in fact be uniform here, but the property is
 * then an accident of one constant, and this is the credential that stands
 * between the internet and a shell on this machine. Its rejection sampling
 * makes uniformity a fact about the function rather than about the alphabet.
 * @param length - characters to mint; {@link PASSCODE_LENGTH} by default.
 * @returns the passcode, in the alphabet's own case.
 */
export function mintPasscode(length: number = PASSCODE_LENGTH): string {
  const count = Math.min(32, Math.max(6, Math.floor(length)))
  let out = ''
  for (let index = 0; index < count; index += 1) {
    out += PASSCODE_ALPHABET[randomInt(0, PASSCODE_ALPHABET.length)]
  }
  return out
}

/**
 * One typed passcode, in the spelling {@link mintPasscode} would have used.
 *
 * The alphabet has no `I`, `L`, `O` or `U` precisely so those four can be
 * folded onto what a person meant: somebody reading `0` off a screen types `O`
 * about as often as not, and refusing them is a support question rather than a
 * security property. Separators are dropped so a passcode written down with a
 * dash in the middle still works.
 * @param value - whatever was typed or pasted.
 * @returns the canonical form.
 */
export function normalizePasscode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
}

/**
 * Whether two secrets are equal, in time that does not depend on where they
 * differ.
 *
 * A passcode comparison that returned early would leak its prefix one request
 * at a time; the throttle bounds how fast that can be walked, but a comparison
 * that does not leak is cheaper than an argument about how much leaking the
 * throttle can absorb.
 * @param left - one value.
 * @param right - the other.
 * @returns whether they are the same string.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, and lengths are not secret:
  // both sides here are fixed-length values this plugin minted.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Mint one session token: 256 bits, base64url so it survives a `Set-Cookie`
 * and a URL without escaping.
 * @returns the token, which the issuing response is the only place it appears.
 */
export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Mint one browser id. Not a secret — it names a row the desktop card lists. */
export function mintBrowserId(): string {
  return randomUUID()
}

/**
 * Hash a session token for storage.
 *
 * Plain SHA-256 with no salt or stretching, and that is the right call here
 * rather than a shortcut: the input is 256 bits of uniform randomness we minted
 * ourselves, so there is no dictionary to slow down and nothing for a salt to
 * separate. What the hash buys is that a settings file — which syncs, backs up,
 * and gets pasted into bug reports — never holds anything that can be replayed.
 * @param token - the token as presented.
 * @returns lowercase hex.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

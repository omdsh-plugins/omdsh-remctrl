/**
 * The three random or one-way values this plugin mints, and the only module
 * that reaches `node:crypto`.
 *
 * Separated so `pairing.ts`, `devices.ts`, `gate.ts`, and `bind.ts` — the four
 * files that carry the whole of this plugin's security — import nothing at all
 * and can be decided entirely by tests. Randomness and clocks are handed to
 * them; this is where the real ones come from.
 * @module @omdsh-plugins/omdsh-remctrl/secrets
 */

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'

/**
 * Digits in a pairing code.
 *
 * Six, which is 20 bits and would be embarrassing on its own. It is not on its
 * own: a code lives five minutes, dies on its fifth wrong guess, and only one
 * is outstanding at a time, so the reachable guess space is five — not a
 * million. The length is chosen for a thumb on a phone keyboard, and the
 * security comes from the budget around it.
 */
export const CODE_LENGTH = 6

/**
 * Mint one pairing code.
 *
 * `randomInt` rather than `Math.random`: this is a credential for a five-minute
 * window, and a predictable one would let anybody on the tailnet pair
 * themselves. Its rejection sampling also keeps the digits uniform, which
 * `Math.random() * 1e6 | 0` would not quite manage.
 * @returns a zero-padded decimal string of {@link CODE_LENGTH} digits.
 */
export function mintCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

/**
 * Mint one device token: 256 bits, base64url so it survives a header and a
 * `localStorage` round trip without escaping.
 * @returns the token, which the issuing response is the only place it appears.
 */
export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Mint one device id. Not a secret — it names a row the desktop panel lists. */
export function mintDeviceId(): string {
  return randomUUID()
}

/**
 * Hash a device token for storage.
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

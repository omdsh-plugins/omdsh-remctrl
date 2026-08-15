/**
 * The one-time code that turns "somebody on the tailnet" into "a device I said
 * yes to".
 *
 * A six-digit code is small. What makes it a credential is the budget around
 * it, and every part of that budget is here:
 *
 * - **One outstanding code.** Minting replaces. There is never a set of live
 *   codes to spray at, and the desktop panel never shows a code that a stale
 *   one could also satisfy.
 * - **A short life.** Five minutes by default, checked against an injected
 *   clock so the expiry is a tested property rather than a hopeful one.
 * - **A guess budget.** Five wrong answers burn the code, and burning it means
 *   the desktop has to mint another — which puts a person back in the loop,
 *   which is the actual point. Without this a million-guess space is a
 *   million-guess space.
 * - **It is spent on success.** A code redeems exactly once.
 *
 * Nothing here imports anything but the tier vocabulary. The clock and the
 * randomness arrive as functions, so a spec decides what time it is.
 * @module @omdsh-plugins/omdsh-remctrl/pairing
 */

/** Default life of a code, in milliseconds. */
export const DEFAULT_TTL_MS = 5 * 60_000

/** Default number of wrong guesses a code survives. */
export const DEFAULT_MAX_ATTEMPTS = 5

/** A live code, as the desktop panel shows it. */
export interface LiveCode {
  code: string
  /** Epoch milliseconds. */
  expiresAt: number
  /** Wrong guesses left before it burns. */
  remaining: number
}

/** What became of a redemption. */
export type RedeemOutcome =
  /** Correct, in time, and now spent. */
  | { kind: 'ok' }
  /** Nothing is outstanding: never minted, already spent, or burned. */
  | { kind: 'no-code' }
  /** A code was outstanding and its time ran out. It is gone. */
  | { kind: 'expired' }
  /** Wrong. `remaining` is how many guesses are left. */
  | { kind: 'mismatch'; remaining: number }
  /** Wrong, and that was the last guess. The code is gone. */
  | { kind: 'locked' }

/** What {@link PairingCodes} needs from the outside world. */
export interface PairingDeps {
  /** The clock. Required rather than defaulted, because a TTL nobody can move is a TTL nobody can test. */
  now: () => number
  /** The code source. Required rather than defaulted, because the obvious default (`Math.random`) is the wrong one. */
  mintCode: () => string
  /** Life of a code in milliseconds; {@link DEFAULT_TTL_MS} when absent. */
  ttlMs?: number
  /** Wrong guesses a code survives; {@link DEFAULT_MAX_ATTEMPTS} when absent. */
  maxAttempts?: number
}

/**
 * Compare two strings without letting the comparison's duration say how much of
 * them matched.
 *
 * Barely necessary at five guesses — you cannot mount a statistical timing
 * attack on a budget of five — but the version that is correct costs four
 * lines, and the habit of writing the correct one is worth more than the four
 * lines saved. Length is not secret: every code this plugin mints is the same
 * number of digits.
 * @param a - one string.
 * @param b - the other.
 * @returns whether they are equal.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/** The outstanding pairing code, and the budget it is spending. */
export class PairingCodes {
  private outstanding: { code: string; expiresAt: number; attemptsLeft: number } | undefined

  /**
   * @param deps - clock, code source, and the budgets; see {@link PairingDeps}.
   */
  constructor(private readonly deps: PairingDeps) {}

  /**
   * Mint a code, replacing whatever was outstanding.
   *
   * Replacing rather than adding is what keeps the guess budget meaningful: two
   * live codes would be two independent budgets against the same door, and a
   * panel that minted on every open would hand out one per refresh.
   * @returns the new code.
   */
  mint(): LiveCode {
    // Budgets are read HERE rather than cached at construction, so a settings
    // change reaches the next code without tearing this object down — and so a
    // code already in somebody's hand keeps the budget it was minted under.
    const attemptsLeft = this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const code = this.deps.mintCode()
    this.outstanding = {
      code,
      expiresAt: this.deps.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS),
      attemptsLeft,
    }
    return { code, expiresAt: this.outstanding.expiresAt, remaining: attemptsLeft }
  }

  /**
   * The outstanding code, if one is still live.
   *
   * Expiry is evaluated here too, so a panel that polls sees the code disappear
   * on its own rather than showing a dead one until somebody tries it.
   * @returns the code, or undefined when nothing is outstanding.
   */
  peek(): LiveCode | undefined {
    const live = this.outstanding
    if (live === undefined) return undefined
    if (this.deps.now() >= live.expiresAt) {
      this.outstanding = undefined
      return undefined
    }
    return { code: live.code, expiresAt: live.expiresAt, remaining: live.attemptsLeft }
  }

  /**
   * Spend a guess.
   * @param code - what the phone typed.
   * @returns what became of it; see {@link RedeemOutcome}.
   */
  redeem(code: string): RedeemOutcome {
    const live = this.outstanding
    if (live === undefined) return { kind: 'no-code' }
    if (this.deps.now() >= live.expiresAt) {
      this.outstanding = undefined
      return { kind: 'expired' }
    }
    if (constantTimeEquals(live.code, code)) {
      // Spent on success: a code that survived its own redemption would let a
      // second device in on the same yes.
      this.outstanding = undefined
      return { kind: 'ok' }
    }
    live.attemptsLeft -= 1
    if (live.attemptsLeft <= 0) {
      this.outstanding = undefined
      return { kind: 'locked' }
    }
    return { kind: 'mismatch', remaining: live.attemptsLeft }
  }

  /** Drop the outstanding code, if any. */
  clear(): void {
    this.outstanding = undefined
  }
}

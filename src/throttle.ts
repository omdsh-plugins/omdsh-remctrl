/**
 * How often one address may knock.
 *
 * This is the file that turns a ten-character passcode into a credential. Fifty
 * bits is not a key; fifty bits behind six guesses a minute per address is a
 * wall nobody walks through, and the whole argument for a passcode a person can
 * read off a screen and type into a phone rests on the number in this file
 * being small.
 *
 * Which makes the sign-in route the one place it truly matters: it is
 * unauthenticated, on the public internet, and it is the only door there is.
 *
 * A token bucket rather than a fixed window, because the fixed window's edge is
 * a free burst: 5-per-minute admits ten in the two seconds either side of the
 * boundary. Refill is continuous, so the honest phone that mistypes twice and
 * gets it right on the third try never notices this file exists.
 *
 * The clock is injected and nothing is imported, so the whole policy is decided
 * by tests rather than by how fast the machine running them happens to be.
 * @module @omdsh-plugins/omdsh-remctrl/throttle
 */

/** How much a bucket holds and how fast it comes back. */
export interface ThrottleRule {
  /** Tokens a fresh bucket holds; the size of an allowed burst. */
  capacity: number
  /** How long one token takes to come back, in milliseconds. */
  refillMs: number
  /**
   * The most addresses tracked at once.
   *
   * A bound rather than a hope: the key is attacker-chosen on a public
   * exposure, so an unbounded map is a memory-exhaustion primitive handed out
   * with the door. When the bound is reached the FULLEST buckets are evicted —
   * a bucket at capacity carries no information, so dropping it costs nothing,
   * while dropping a drained one would hand its owner a fresh budget.
   */
  maxKeys: number
}

/**
 * The budget for offering a passcode: six tries, one back a minute.
 *
 * Six is chosen for the person who mistypes, not for the attacker — at this
 * rate a 50-bit passcode takes on the order of 10^14 years to walk, so the
 * only property that matters is that an honest phone never notices.
 */
export const SIGN_IN_RULE: ThrottleRule = { capacity: 6, refillMs: 60_000, maxKeys: 4096 }

/**
 * The budget for presenting a session cookie that turns out to be wrong.
 *
 * Looser than sign-in because a browser whose session was revoked will retry a
 * few times before its owner notices — and a signed-out page reloads its own
 * assets — and tighter than nothing because a 256-bit token is not guessable
 * but a request that fails authentication is still free work for this process.
 */
export const AUTH_RULE: ThrottleRule = { capacity: 20, refillMs: 15_000, maxKeys: 4096 }

/** What {@link Throttle.take} decided. */
export type ThrottleVerdict =
  /** Allowed. `remaining` is how many are left in this bucket, floored. */
  | { ok: true; remaining: number }
  /** Refused. `retryAfterMs` is how long until one token is back. */
  | { ok: false; retryAfterMs: number }

/** One bucket's state. */
interface Bucket {
  /** Tokens left, fractional between refills. */
  tokens: number
  /** When {@link tokens} was last computed. */
  at: number
}

/** A per-key token bucket with a bounded key set. */
export class Throttle {
  private buckets = new Map<string, Bucket>()

  /**
   * @param rule - the budget; see {@link ThrottleRule}.
   * @param now - the clock, injected so a spec decides what time it is.
   */
  constructor(private readonly rule: ThrottleRule, private readonly now: () => number) {}

  /**
   * Spend one token against a key.
   * @param key - the address, or whatever else is being budgeted.
   * @returns the verdict; see {@link ThrottleVerdict}.
   */
  take(key: string): ThrottleVerdict {
    const at = this.now()
    const bucket = this.refill(key, at)
    if (bucket.tokens < 1) {
      // How long until the fractional balance reaches one whole token.
      const deficit = 1 - bucket.tokens
      return { ok: false, retryAfterMs: Math.ceil(deficit * this.rule.refillMs) }
    }
    bucket.tokens -= 1
    return { ok: true, remaining: Math.floor(bucket.tokens) }
  }

  /**
   * Read a key's balance without spending it.
   *
   * Used where the answer is needed before the work rather than after — the
   * door checks the budget, then reads a body, then decides.
   * @param key - the address.
   * @returns how many whole tokens are available.
   */
  peek(key: string): number {
    return Math.floor(this.refill(key, this.now()).tokens)
  }

  /**
   * Give a key its budget back.
   *
   * Called when a request that spent a token turned out to be legitimate, so a
   * phone that pairs on its second try is not still carrying the cost of its
   * first an hour later.
   * @param key - the address.
   */
  forgive(key: string): void {
    this.buckets.delete(key)
  }

  /** Drop every bucket. Used when the door rebinds — a new listener, a new slate. */
  clear(): void {
    this.buckets.clear()
  }

  /** How many keys are tracked. Exists so the eviction bound is observable. */
  get size(): number {
    return this.buckets.size
  }

  /**
   * Bring one bucket up to date, creating it if needed.
   * @param key - the address.
   * @param at - now.
   * @returns the bucket, refilled.
   */
  private refill(key: string, at: number): Bucket {
    const existing = this.buckets.get(key)
    if (existing === undefined) {
      if (this.buckets.size >= this.rule.maxKeys) this.evict()
      const fresh: Bucket = { tokens: this.rule.capacity, at }
      this.buckets.set(key, fresh)
      return fresh
    }
    const elapsed = at - existing.at
    if (elapsed > 0) {
      existing.tokens = Math.min(this.rule.capacity, existing.tokens + elapsed / this.rule.refillMs)
      existing.at = at
    }
    // A bucket back at capacity is indistinguishable from one that never
    // existed, so keeping it is pure cost. Dropping it here is what makes the
    // map shrink on its own between bursts.
    if (existing.tokens >= this.rule.capacity) this.buckets.delete(key)
    return existing
  }

  /**
   * Make room, fullest bucket first.
   *
   * A quarter of the map goes at once rather than one entry per admission: the
   * scan is linear, and paying for it on every request at the bound would be
   * the denial of service it exists to prevent.
   */
  private evict(): void {
    const ranked = [...this.buckets].sort((a, b) => b[1].tokens - a[1].tokens)
    const drop = Math.max(1, Math.ceil(ranked.length / 4))
    for (let index = 0; index < drop; index += 1) {
      const entry = ranked[index]
      if (entry !== undefined) this.buckets.delete(entry[0])
    }
  }
}

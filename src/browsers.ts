/**
 * Which browsers were signed in, and the only thing that turns a cookie back
 * into a session.
 *
 * The store is authoritative in memory and mirrored into settings, in that
 * order. A revocation has to stop a request that is already in flight, and a
 * write that has to reach a file first cannot promise that; the durable copy
 * exists so a restart does not sign a phone out, not so a lookup can wait on it.
 *
 * What is mirrored is a HASH. A settings section syncs, gets backed up, and
 * ends up pasted into bug reports; a stored token would be replayable from any
 * of those — and in this version a replayable token is a shell on this machine.
 * The hash function arrives as a dependency, which also keeps this module free
 * of imports and decidable by tests.
 * @module @omdsh-plugins/omdsh-remctrl/browsers
 */

import type { BrowserView } from './contract.ts'

/** One signed-in browser, as stored. */
export interface BrowserRecord {
  /** What the desktop card calls it. */
  label: string
  /** SHA-256 of the session token, hex. The token itself is never stored. */
  tokenHash: string
  /** When it signed in, epoch milliseconds. */
  signedInAt: number
  /** When it last presented its cookie, epoch milliseconds. */
  lastSeenAt: number
  /**
   * When the session stops resolving, epoch milliseconds; absent means never.
   *
   * A phone is a thing that gets lost, and a signed-in one holds the whole of
   * this harness. An expiry is the difference between "lost until somebody
   * remembers to open the card" and "lost until Tuesday" — so it exists, it
   * defaults to on, and a person who wants the other behaviour sets the TTL to
   * zero and has said so.
   */
  expiresAt?: number
  /** The User-Agent it signed in with, for telling two phones apart. */
  userAgent?: string
}

/** The durable shape: browser id → record. */
export type BrowserTable = Record<string, BrowserRecord>

/** What {@link BrowserStore} needs from the outside world. */
export interface BrowserDeps {
  /** The clock. */
  now: () => number
  /** One-way function over a token; see `secrets.ts`. */
  hashToken: (token: string) => string
  /**
   * Mirror the table durably.
   *
   * Called on every structural change — a sign-in, a revocation — and NOT on a
   * mere sighting, so a browser holding two WebSockets and polling assets does
   * not rewrite a settings file on every request. `lastSeenAt` therefore
   * reaches the durable copy on the next structural change, which is as much
   * precision as a "last seen" line needs.
   */
  persist?: (table: BrowserTable) => void
}

/**
 * A browser's default name, read off the User-Agent it signed in with.
 *
 * Deliberately coarse and deliberately untranslated: it names a piece of
 * hardware, and a value that needs a locale to render is the wrong thing to put
 * in a durable record.
 * @param userAgent - the header, if the request carried one.
 * @returns a short label.
 */
export function labelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent === '') return 'Browser'
  if (/\biPhone\b/i.test(userAgent)) return 'iPhone'
  if (/\biPad\b/i.test(userAgent)) return 'iPad'
  if (/\bAndroid\b/i.test(userAgent)) return 'Android'
  if (/\bMacintosh\b|\bMac OS X\b/i.test(userAgent)) return 'Mac'
  if (/\bWindows\b/i.test(userAgent)) return 'Windows'
  if (/\bLinux\b/i.test(userAgent)) return 'Linux'
  return 'Browser'
}

/** The signed-in browsers. */
export class BrowserStore {
  private records = new Map<string, BrowserRecord>()
  /** tokenHash → browserId. A lookup by hash, so authentication never walks the table. */
  private byHash = new Map<string, string>()

  private persist: BrowserDeps['persist']

  /**
   * @param deps - clock, hash, and the durable mirror; see {@link BrowserDeps}.
   */
  constructor(private readonly deps: BrowserDeps) {
    this.persist = deps.persist
  }

  /**
   * Attach the durable mirror after construction.
   *
   * The settings scope this writes through does not exist when the store does:
   * the store is built at `apply`, and the scope only once the settings service
   * is available, which is a fiber that may never run. So the store starts
   * memory-only — correct, just not durable — and gains persistence if and when
   * a provider shows up.
   * @param persist - the mirror, or undefined to go back to memory-only.
   */
  setPersist(persist: BrowserDeps['persist']): void {
    this.persist = persist
  }

  /**
   * Adopt a durable table, replacing whatever is held.
   *
   * Used once at mount, from the settings section. A record whose hash collides
   * with one already adopted is dropped rather than merged: two ids answering
   * to one token is a state no honest sequence of operations produces, and
   * keeping the first is the only resolution that does not silently widen
   * access.
   * @param table - the stored table; a missing or malformed one adopts nothing.
   */
  load(table: BrowserTable | undefined): void {
    this.records = new Map()
    this.byHash = new Map()
    if (table === undefined) return
    for (const [browserId, record] of Object.entries(table)) {
      if (typeof record?.tokenHash !== 'string') continue
      if (this.byHash.has(record.tokenHash)) continue
      this.records.set(browserId, { ...record })
      this.byHash.set(record.tokenHash, browserId)
    }
  }

  /**
   * Record a browser that has just presented the passcode.
   * @param options - the minted identity and what the request said about itself.
   * @returns the browser as the card lists it.
   */
  issue(options: {
    browserId: string
    token: string
    label: string
    /** How long the session lives, in milliseconds; `0` or absent means forever. */
    ttlMs?: number
    userAgent?: string
  }): BrowserView {
    const at = this.deps.now()
    const ttl = options.ttlMs ?? 0
    const record: BrowserRecord = {
      label: options.label,
      tokenHash: this.deps.hashToken(options.token),
      signedInAt: at,
      lastSeenAt: at,
      ...ttl > 0 ? { expiresAt: at + ttl } : {},
      ...options.userAgent === undefined ? {} : { userAgent: options.userAgent },
    }
    this.records.set(options.browserId, record)
    this.byHash.set(record.tokenHash, options.browserId)
    this.flush()
    return viewOf(options.browserId, record, at)
  }

  /**
   * Resolve a presented session token.
   *
   * A sighting is recorded in memory only; see {@link BrowserDeps.persist} for
   * why that does not reach the durable copy on its own.
   *
   * An EXPIRED record does not resolve and is not deleted. Deleting would be
   * tidier and worse: the card would show a phone that simply vanished, with
   * nothing to say why it stopped working. It stays, listed and marked, until
   * somebody revokes it or signs in again.
   * @param token - the cookie value as presented.
   * @returns the browser, or undefined when nothing live answers to it.
   */
  authenticate(token: string): { browserId: string; record: BrowserRecord } | undefined {
    const browserId = this.byHash.get(this.deps.hashToken(token))
    if (browserId === undefined) return undefined
    const record = this.records.get(browserId)
    if (record === undefined) return undefined
    const at = this.deps.now()
    if (record.expiresAt !== undefined && at >= record.expiresAt) return undefined
    record.lastSeenAt = at
    return { browserId, record }
  }

  /**
   * Forget one browser. Its cookie stops resolving immediately.
   * @param browserId - which one.
   * @returns whether it existed.
   */
  revoke(browserId: string): boolean {
    const record = this.records.get(browserId)
    if (record === undefined) return false
    this.records.delete(browserId)
    this.byHash.delete(record.tokenHash)
    this.flush()
    return true
  }

  /** Forget every browser. Used when a person resets the passcode and means it. */
  revokeAll(): number {
    const count = this.records.size
    if (count === 0) return 0
    this.records = new Map()
    this.byHash = new Map()
    this.flush()
    return count
  }

  /** Every browser, sign-in order, as the card lists them. */
  list(): BrowserView[] {
    const at = this.deps.now()
    return [...this.records].map(([browserId, record]) => viewOf(browserId, record, at))
  }

  /** How many browsers are signed in. */
  get size(): number {
    return this.records.size
  }

  /** The durable shape, for a caller writing it somewhere. */
  table(): BrowserTable {
    return Object.fromEntries([...this.records].map(([id, record]) => [id, { ...record }]))
  }

  private flush(): void {
    this.persist?.(this.table())
  }
}

/**
 * Project one record for the card. `tokenHash` is not in {@link BrowserView},
 * which is the point — nothing that leaves this module carries it.
 * @param browserId - the id.
 * @param record - the record.
 * @param at - now, for deciding whether the session has run out.
 * @returns the view.
 */
function viewOf(browserId: string, record: BrowserRecord, at: number): BrowserView {
  const expired = record.expiresAt !== undefined && at >= record.expiresAt
  return {
    browserId,
    label: record.label,
    signedInAt: record.signedInAt,
    lastSeenAt: record.lastSeenAt,
    ...record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt },
    ...expired ? { expired: true } : {},
  }
}

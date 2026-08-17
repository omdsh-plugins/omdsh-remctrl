/**
 * What happened at the door, kept.
 *
 * The passcode is the only fence this plugin has, so the question that matters
 * is not "can somebody get in" — it is **"did somebody get in while I was not
 * looking"**. A toast cannot answer that: it reaches whoever happens to be
 * watching, and the case worth catching is precisely the one nobody was
 * watching. So this is a record: bounded, persisted, and read off the card at
 * whatever hour a person thinks to look.
 *
 * Two decisions carry the module:
 *
 * - **Refusals coalesce.** One row per address per half hour, with a count on
 *   it. A machine grinding at the passcode is throttled to six a minute, which
 *   is still enough to push fifty real events out of a fifty-event log inside
 *   ten minutes — so the noisy case must not be able to erase the quiet one.
 * - **Writes are rate-limited, structural changes are not.** A new row reaches
 *   the settings file at once, because that is the news. A coalesced increment
 *   waits, because otherwise a sustained probe would rewrite a YAML file six
 *   times a minute for as long as it kept knocking.
 *
 * Nothing is imported but the vocabulary, so what is recorded and what is
 * dropped is decided by tests.
 * @module @omdsh-plugins/omdsh-remctrl/access
 */

import { ACCESS_LIMIT, COALESCE_MS, type AccessEvent, type AccessView } from './contract.ts'

/** The durable shape. */
export interface AccessTable {
  /** Newest first, at most {@link ACCESS_LIMIT}. */
  events: AccessEvent[]
  /** When the log was last marked read, epoch milliseconds. */
  seenAt: number
}

/** What {@link AccessJournal} needs from the outside world. */
export interface AccessDeps {
  /** The clock. */
  now: () => number
  /** Mirror the log durably. Called on a structural change, and rate-limited otherwise. */
  persist?: (table: AccessTable) => void
  /**
   * Say something out loud, once, when a line is worth a person's attention.
   *
   * A grant always is. A refusal is not, until it stops looking like a typo —
   * see {@link ANNOUNCE_AFTER}.
   */
  announce?: (line: string) => void
}

/**
 * How many refusals from one address before it is worth saying out loud.
 *
 * Six, which is exactly the throttle's capacity: below it somebody is
 * mistyping, at it their budget is spent and they are still going. One line at
 * that moment, and then silence however long they keep at it — the count on the
 * card carries the rest.
 */
export const ANNOUNCE_AFTER = 6

/** How long a coalesced increment may wait before it reaches the durable copy. */
export const FLUSH_INTERVAL_MS = 60_000

/** The door's log. */
export class AccessJournal {
  private events: AccessEvent[] = []
  private seenAt = 0
  private lastFlush = 0
  private persist: AccessDeps['persist']

  /**
   * @param deps - clock, mirror, and the announcer; see {@link AccessDeps}.
   */
  constructor(private readonly deps: AccessDeps) {
    this.persist = deps.persist
  }

  /**
   * Attach the durable mirror after construction.
   *
   * The settings scope does not exist when this does; see `browsers.ts` for the
   * same seam and the same reason.
   * @param persist - the mirror, or undefined to go back to memory-only.
   */
  setPersist(persist: AccessDeps['persist']): void {
    this.persist = persist
  }

  /**
   * Adopt a stored log, replacing whatever is held.
   * @param table - the stored table; a missing or malformed one adopts nothing.
   */
  load(table: AccessTable | undefined): void {
    this.events = []
    this.seenAt = 0
    if (table === undefined) return
    if (Array.isArray(table.events)) {
      this.events = table.events
        .filter(event => typeof event?.at === 'number' && typeof event.granted === 'boolean')
        .slice(0, ACCESS_LIMIT)
        .map(event => ({ ...event, attempts: event.attempts ?? 1 }))
    }
    if (typeof table.seenAt === 'number') this.seenAt = table.seenAt
  }

  /**
   * Record one sign-in that worked.
   * @param input - who, from where, and which browser it created.
   */
  granted(input: { label: string; address: string; browserId: string }): void {
    const at = this.deps.now()
    this.events.unshift({
      at,
      granted: true,
      label: input.label,
      address: input.address,
      attempts: 1,
      browserId: input.browserId,
    })
    this.trim()
    this.flush(true)
    // Every grant, always. A person who did not just sign in a phone needs to
    // see this the moment it happens, and there is no such thing as too many
    // lines here — a second one means a second device.
    this.deps.announce?.(
      `omdsh-remctrl: a new browser signed in — ${input.label} from ${input.address}.`,
    )
  }

  /**
   * Record one attempt that did not work.
   *
   * Folded into the most recent refusal from the same address when that is
   * recent enough, so the row counts rather than repeats.
   * @param input - who tried, and from where.
   */
  refused(input: { label: string; address: string }): void {
    const at = this.deps.now()
    const recent = this.events[0]
    // Only the HEAD is a candidate, not any matching row: folding into an older
    // one would reorder the log, and a log that reorders itself is one nobody
    // can read.
    if (
      recent !== undefined
      && !recent.granted
      && recent.address === input.address
      && at - recent.at <= COALESCE_MS
    ) {
      recent.attempts += 1
      recent.at = at
      this.flush(false)
      if (recent.attempts === ANNOUNCE_AFTER) {
        this.deps.announce?.(
          `omdsh-remctrl: ${String(recent.attempts)} failed passcode attempts from ${input.address}. `
          + 'That address is now throttled to one try a minute.',
        )
      }
      return
    }
    this.events.unshift({ at, granted: false, label: input.label, address: input.address, attempts: 1 })
    this.trim()
    this.flush(true)
  }

  /**
   * Empty the log, and leave a mark saying so.
   *
   * The mark is not decoration. Anyone who can sign in can clear this log —
   * it is behind the same passcode as everything else — so the question is not
   * whether an intruder can erase their tracks but whether the erasure is
   * itself visible. One row that says "N entries were removed, at this time"
   * costs nothing and makes a cleared log distinguishable from a log where
   * nothing ever happened.
   * @returns the log as it now reads.
   */
  clear(): AccessView {
    const removed = this.events.length
    const at = this.deps.now()
    this.events = removed === 0 ? [] : [{ at, granted: true, label: '', address: '', attempts: 0, cleared: removed }]
    // Read, by definition: the person clearing it is the person looking at it.
    this.seenAt = at
    this.flush(true)
    return this.view()
  }

  /** The log as the card reads it. */
  view(): AccessView {
    return {
      events: this.events.map(event => ({ ...event })),
      unseen: this.events.filter(event => event.at > this.seenAt).length,
    }
  }

  /**
   * Mark everything read.
   * @returns the log as it now reads.
   */
  acknowledge(): AccessView {
    this.seenAt = this.deps.now()
    this.flush(true)
    return this.view()
  }

  /** The durable shape, for a caller writing it somewhere. */
  table(): AccessTable {
    return { events: this.events.map(event => ({ ...event })), seenAt: this.seenAt }
  }

  /** How many events are held. Exists so the bound is observable. */
  get size(): number {
    return this.events.length
  }

  private trim(): void {
    if (this.events.length > ACCESS_LIMIT) this.events.length = ACCESS_LIMIT
  }

  /**
   * Mirror, unless this is a mere increment that has been mirrored recently.
   * @param structural - whether a row was added or the seen mark moved.
   */
  private flush(structural: boolean): void {
    const at = this.deps.now()
    if (!structural && at - this.lastFlush < FLUSH_INTERVAL_MS) return
    this.lastFlush = at
    this.persist?.(this.table())
  }
}

/**
 * Which devices were said yes to, and what each one is allowed to be.
 *
 * The store is authoritative in memory and mirrored into settings, in that
 * order. A revocation has to stop a request that is already in flight, and a
 * write that has to reach a file first cannot promise that; the durable copy
 * exists so a restart does not un-pair a phone, not so a lookup can wait on it.
 *
 * What is mirrored is a HASH. A settings section syncs, gets backed up, and
 * ends up pasted into bug reports; a stored token would be replayable from any
 * of those. The hash function arrives as a dependency, which also keeps this
 * module — one of the four that carry this plugin's security — free of imports
 * and decidable by tests.
 * @module @omdsh-plugins/omdsh-remctrl/devices
 */

import type { DeviceView, Tier } from './contract.ts'

/** One paired device, as stored. */
export interface DeviceRecord {
  /** What the desktop panel calls it. */
  label: string
  /** SHA-256 of the token, hex. The token itself is never stored. */
  tokenHash: string
  /** How much of the harness it may reach. */
  tier: Tier
  /** When it paired, epoch milliseconds. */
  createdAt: number
  /** When it last presented its token, epoch milliseconds. */
  lastSeenAt: number
  /** The User-Agent it paired with, for telling two phones apart. */
  userAgent?: string
}

/** The durable shape: device id → record. */
export type DeviceTable = Record<string, DeviceRecord>

/** What {@link DeviceStore} needs from the outside world. */
export interface DeviceDeps {
  /** The clock. */
  now: () => number
  /** One-way function over a token; see `secrets.ts`. */
  hashToken: (token: string) => string
  /**
   * Mirror the table durably.
   *
   * Called on every structural change — an issue, a rename, a revocation — and
   * NOT on a mere sighting, so a phone polling a stream does not rewrite a
   * settings file every few seconds. `lastSeenAt` therefore reaches the durable
   * copy on the next structural change, which is as much precision as a
   * "last seen" line needs.
   */
  persist?: (table: DeviceTable) => void
}

/**
 * A device's default name, read off the User-Agent it paired with.
 *
 * Deliberately coarse and deliberately untranslated: it names a piece of
 * hardware, it is editable from the panel the moment it is wrong, and a value
 * that needs a locale to render is the wrong thing to put in a durable record.
 * @param userAgent - the header, if the request carried one.
 * @returns a short label.
 */
export function labelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent === '') return 'Device'
  if (/\biPhone\b/i.test(userAgent)) return 'iPhone'
  if (/\biPad\b/i.test(userAgent)) return 'iPad'
  if (/\bAndroid\b/i.test(userAgent)) return 'Android'
  if (/\bMacintosh\b|\bMac OS X\b/i.test(userAgent)) return 'Mac'
  if (/\bWindows\b/i.test(userAgent)) return 'Windows'
  if (/\bLinux\b/i.test(userAgent)) return 'Linux'
  return 'Device'
}

/** The paired devices, and the only thing that turns a token into a tier. */
export class DeviceStore {
  private records = new Map<string, DeviceRecord>()
  /** tokenHash → deviceId. A lookup by hash, so authentication never walks the table. */
  private byHash = new Map<string, string>()

  private persist: DeviceDeps['persist']

  /**
   * @param deps - clock, hash, and the durable mirror; see {@link DeviceDeps}.
   */
  constructor(private readonly deps: DeviceDeps) {
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
  setPersist(persist: DeviceDeps['persist']): void {
    this.persist = persist
  }

  /**
   * Adopt a durable table, replacing whatever is held.
   *
   * Used once at mount, from the settings section. A record whose hash collides
   * with one already adopted is dropped rather than merged: two ids answering to
   * one token is a state no honest sequence of operations produces, and keeping
   * the first is the only resolution that does not silently widen access.
   * @param table - the stored table; a missing or malformed one adopts nothing.
   */
  load(table: DeviceTable | undefined): void {
    this.records = new Map()
    this.byHash = new Map()
    if (table === undefined) return
    for (const [deviceId, record] of Object.entries(table)) {
      if (this.byHash.has(record.tokenHash)) continue
      this.records.set(deviceId, { ...record })
      this.byHash.set(record.tokenHash, deviceId)
    }
  }

  /**
   * Record a device that has just redeemed a code.
   * @param options - the minted identity and what the request said about itself.
   * @returns the device as the panel lists it.
   */
  issue(options: {
    deviceId: string
    token: string
    label: string
    tier: Tier
    userAgent?: string
  }): DeviceView {
    const at = this.deps.now()
    const record: DeviceRecord = {
      label: options.label,
      tokenHash: this.deps.hashToken(options.token),
      tier: options.tier,
      createdAt: at,
      lastSeenAt: at,
      ...options.userAgent === undefined ? {} : { userAgent: options.userAgent },
    }
    this.records.set(options.deviceId, record)
    this.byHash.set(record.tokenHash, options.deviceId)
    this.flush()
    return viewOf(options.deviceId, record)
  }

  /**
   * Resolve a presented token.
   *
   * A sighting is recorded in memory only; see {@link DeviceDeps.persist} for
   * why that does not reach the durable copy on its own.
   * @param token - the bearer token as presented.
   * @returns the device, or undefined when nothing answers to it.
   */
  authenticate(token: string): { deviceId: string; record: DeviceRecord } | undefined {
    const deviceId = this.byHash.get(this.deps.hashToken(token))
    if (deviceId === undefined) return undefined
    const record = this.records.get(deviceId)
    if (record === undefined) return undefined
    record.lastSeenAt = this.deps.now()
    return { deviceId, record }
  }

  /**
   * Rename one device.
   * @param deviceId - which one.
   * @param label - the new name.
   * @returns whether it existed.
   */
  rename(deviceId: string, label: string): boolean {
    const record = this.records.get(deviceId)
    if (record === undefined) return false
    record.label = label
    this.flush()
    return true
  }

  /**
   * Forget one device. Its token stops resolving immediately.
   * @param deviceId - which one.
   * @returns whether it existed.
   */
  revoke(deviceId: string): boolean {
    const record = this.records.get(deviceId)
    if (record === undefined) return false
    this.records.delete(deviceId)
    this.byHash.delete(record.tokenHash)
    this.flush()
    return true
  }

  /** Every device, creation order, as the panel lists them. */
  list(): DeviceView[] {
    return [...this.records].map(([deviceId, record]) => viewOf(deviceId, record))
  }

  /** How many devices are paired. */
  get size(): number {
    return this.records.size
  }

  /** The durable shape, for a caller writing it somewhere. */
  table(): DeviceTable {
    return Object.fromEntries([...this.records].map(([id, record]) => [id, { ...record }]))
  }

  private flush(): void {
    this.persist?.(this.table())
  }
}

/**
 * Project one record for the panel. `tokenHash` is not in {@link DeviceView},
 * which is the point — nothing that leaves this module carries it.
 * @param deviceId - the id.
 * @param record - the record.
 * @returns the view.
 */
function viewOf(deviceId: string, record: DeviceRecord): DeviceView {
  return {
    deviceId,
    label: record.label,
    tier: record.tier,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
  }
}

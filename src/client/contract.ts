/**
 * The face the card is handed, and the reason it is an interface rather than a
 * set of imports.
 *
 * The card is a slot registrant: the hub renders it, so everything it can reach
 * has to arrive through the props the slot composes. Naming that seam here —
 * instead of letting the component reach for `ctx` — is what makes the card
 * renderable by a spec with five functions and no harness at all, which for a
 * panel whose job is to explain a security posture is worth more than the
 * indirection costs.
 * @module @omdsh-plugins/omdsh-remctrl/client/contract
 */

import type { ConfigView, RemctrlPatch } from '../contract.ts'
import type { CardSnapshot } from './api.ts'
import type { RemctrlKey } from './locales.ts'

/** What this plugin's own half supplies to its card. */
export interface RemctrlInjected {
  /** Read everything the card shows. */
  read: (signal?: AbortSignal) => Promise<CardSnapshot>
  /** Write part of the settings section. */
  write: (patch: RemctrlPatch) => Promise<ConfigView>
  /** Sign one browser out. */
  revoke: (browserId: string) => Promise<void>
  /** Sign every browser out, and say how many that was. */
  revokeAll: () => Promise<number>
  /** Mint a new passcode. */
  reset: () => Promise<string>
  /** Mark the access log as read. */
  acknowledge: () => Promise<void>
  /** Empty the access log. */
  clearLog: () => Promise<void>
  /** Copy one string to the clipboard, reporting whether it landed. */
  copy: (value: string) => Promise<boolean>
}

/** Translate one key, interpolating `{name}` placeholders. */
export type Translate = (key: RemctrlKey, values?: Record<string, string | number>) => string

/** Everything the card is rendered with: this plugin's face, plus the hub's. */
export interface RemctrlCardProps extends RemctrlInjected {
  /** Whether the settings provider accepts writes at all in this deployment. */
  writable: boolean
  /** The card's own copy. */
  t: Translate
}

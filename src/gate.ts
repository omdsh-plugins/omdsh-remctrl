/**
 * What a paired device is allowed to do.
 *
 * Two rules, and the whole security posture of this plugin is in them.
 *
 * **The table is an allowlist, and absence means no.** A method not named
 * below cannot be called by a phone, whatever tier it holds. This matters
 * because `apiProxy` is a HOST-INTERNAL interface with no stability promise:
 * the harness grows methods without consulting us, and the failure mode of a
 * denylist is that a new one leaks the day it ships. With an allowlist a new
 * method is unreachable until somebody writes a line for it, and writing that
 * line is where the thinking happens.
 *
 * **Whole domains are excluded, not individual methods.** No `host.*`, no
 * `settings.*`, no `credentials.*`, no `llm.*` — stated as domains because a
 * rule a person can hold in their head is worth more than the one or two
 * convenience methods that a case-by-case reading would let through. The
 * harness locks most of these to loopback on its own; this table does not rely
 * on that, because relying on somebody else's lock is how you find out it moved.
 *
 * `apply()` never reads this file in M0 — the `/rpc` route it gates is M1. It
 * is written now, with its invariants under test, because the allowlist is the
 * artifact the rest of the design rests on and it is cheaper to be right about
 * it before there is a caller than after.
 * @module @omdsh-plugins/omdsh-remctrl/gate
 */

import { TIER_ORDER, type Tier } from './contract.ts'

export type { Tier } from './contract.ts'
export { TIER_ORDER } from './contract.ts'

/**
 * Every method a phone may call, and the tier it costs.
 *
 * Read it as four bands:
 *
 * - **observe** — reading what happened. The whole of it is history and
 *   listings; nothing here changes anything.
 * - **respond** — answering what the agent asked, plus STOPPING it. Cancel and
 *   interrupt sit a tier below the ability to start work on purpose: somebody
 *   who is trusted to watch a run should be able to end one going wrong
 *   without being trusted to launch another.
 * - **drive** — handing the agent work. The default tier a device pairs at.
 * - **full** — reshaping the workspace: what a session forks from, which model
 *   it runs, which directories exist. Rarely wanted on a phone screen and
 *   never wanted by accident.
 */
export const METHOD_TIER: Readonly<Record<string, Tier>> = {
  'session.list': 'observe',
  'session.search': 'observe',
  'session.history': 'observe',
  'subagent.list': 'observe',
  'subagent.history': 'observe',
  'workspace.list': 'observe',
  'skill.list': 'observe',
  'agentPreset.list': 'observe',

  'session.cancel': 'respond',
  'subagent.interrupt': 'respond',

  'session.prompt': 'drive',
  'session.create': 'drive',
  'session.rename': 'drive',
  'session.updateQueue': 'drive',
  'session.attachment': 'drive',
  'subagent.prompt': 'drive',

  'session.fork': 'full',
  'session.models': 'full',
  'session.selectModel': 'full',
  'workspace.create': 'full',
  'workspace.rename': 'full',
  'workspace.delete': 'full',
  'workspace.insertBefore': 'full',
  'workspace.insertSessionBefore': 'full',
  'workspace.archiveSession': 'full',
  'agentPreset.select': 'full',
  'agentPreset.read': 'full',
  'agentPreset.copy': 'full',
  'agentPreset.remove': 'full',
  'goal.create': 'full',
  'goal.edit': 'full',
  'goal.pause': 'full',
  'goal.resume': 'full',
  'goal.complete': 'full',
  'goal.clear': 'full',
}

/**
 * The domains {@link METHOD_TIER} may name. Anything else is refused before
 * anyone asks what tier it would take.
 *
 * A second gate over the same decision, and not redundant with it: the table
 * is a list a person edits, this is the rule that list must satisfy. An
 * accidental `host.openPath` row is caught by the invariant rather than by
 * review.
 */
export const EXPOSED_DOMAINS: readonly string[] = [
  'session', 'subagent', 'workspace', 'skill', 'agentPreset', 'goal',
]

/**
 * Domains no tier ever reaches, named so the reason travels with the rule.
 *
 * - `settings` and `credentials` are the configuration plane. A phone that can
 *   rewrite provider credentials is not a remote control, it is a second
 *   administrator.
 * - `host` acts on the machine outside the session: picking directories,
 *   opening paths in whatever the desktop registers for them.
 * - `llm` enumerates providers and probes endpoints with stored credentials.
 * - `agentPreset.openDocument` opens a file on the host desktop, which is
 *   `host.openPath` wearing another domain's name — the one method excluded
 *   individually, because its domain is otherwise reachable.
 */
export const NEVER_EXPOSED: readonly string[] = [
  'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
  'credentials.describe', 'credentials.set', 'credentials.unset',
  'host.describe', 'host.pickDirectory', 'host.listDirectory', 'host.createDirectory', 'host.openPath',
  'llm.providers', 'llm.models', 'llm.discoverModels',
  'agentPreset.openDocument',
]

/**
 * Whether a device holding `granted` may do something costing `required`.
 * @param granted - the device's tier.
 * @param required - the tier the action costs.
 * @returns true when `granted` is at least `required`.
 */
export function allows(granted: Tier, required: Tier): boolean {
  return TIER_ORDER.indexOf(granted) >= TIER_ORDER.indexOf(required)
}

/** Whether a string is one of the four tiers — the check a stored value needs. */
export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIER_ORDER as readonly string[]).includes(value)
}

/** What {@link authorize} decided. */
export type Authorization =
  /** Allowed; `tier` is what it cost. */
  | { kind: 'allowed'; method: string; tier: Tier }
  /** No such row. Indistinguishable, on purpose, from a method that does not exist. */
  | { kind: 'unlisted'; method: string }
  /** Listed, and this device does not hold enough. */
  | { kind: 'forbidden'; method: string; granted: Tier; required: Tier }

/**
 * Decide one call.
 * @param granted - the calling device's tier.
 * @param method - the `domain.method` name it asked for.
 * @returns the decision; see {@link Authorization}.
 */
export function authorize(granted: Tier, method: string): Authorization {
  const required = METHOD_TIER[method]
  if (required === undefined) return { kind: 'unlisted', method }
  if (!allows(granted, required)) return { kind: 'forbidden', method, granted, required }
  return { kind: 'allowed', method, tier: required }
}

/**
 * Whether a device may see one session's frames.
 *
 * The mux stream aggregates EVERY session on the host, so without a filter one
 * paired phone sees all of them. That is right for one person on their own
 * tailnet and wrong the moment a tailnet is shared, which is the M5 milestone.
 *
 * It returns true today. The seam exists now because retrofitting a filter
 * through a stream that was written without one is the expensive version of
 * this change, and because a call site that already asks the question is the
 * cheapest possible place to put the answer.
 * @returns true, until per-device scoping lands.
 */
export function visibleTo(): boolean {
  return true
}

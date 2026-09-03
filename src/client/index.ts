/**
 * `@omdsh-plugins/omdsh-remctrl` — the browser half: one card in the Plugin hub,
 * and nothing else.
 *
 * ## Why this half exists at all
 *
 * Because the settings section is not a list of independent fields. An EMPTY
 * `publicHost` is the interesting case rather than a missing value;
 * `allowInsecure` is an acknowledgement that means nothing unless a public host
 * is set; and most of what a person needs — the URL to open, the link that
 * carries the passcode, whether the tunnel came up, which browsers are signed
 * in — is not a setting at all. The hub's generic form draws every one of these
 * field shapes correctly and still shows the wrong thing, which is exactly the
 * case its card slot exists for.
 *
 * The values still live in this plugin's own settings namespace and still go
 * through the same seam: rule 6 exactly — the escape hatch changes what the
 * control looks like, never where the value lives.
 *
 * ## Nothing is claimed on this half's own authority
 *
 * One card in a slot another plugin declares, one locale namespace, no service,
 * no route, no HTTP. Every call rides `ctx.connection.rpc` at the host's
 * `authority: 'loopback'`, so the fence in front of the controls is the
 * harness's rather than one written here.
 *
 * Unmounting removes the card and the hub falls back to the generic form for
 * this plugin, which is a working, if worse, panel.
 * @module @omdsh-plugins/omdsh-remctrl/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the hub declares the card slot this half registers into. A VALUE
// import of another plugin would be inlined as a second copy of its runtime;
// the purity gate in `tsdown.config.ts` refuses one.
import type {} from '@omdsh-plugins/omdsh-plughub/client'
import {
  ackAccess, clearAccess, readCard, resetPasscode, revokeAllBrowsers, revokeBrowser, writeConfig,
  type ConnectionRpcLike,
} from './api.ts'
import { copyToClipboard } from './clipboard.ts'
import type { RemctrlInjected } from './contract.ts'
import { en, zh, type RemctrlKey } from './locales.ts'
import { RemctrlCard } from './RemctrlCard.tsx'

export {
  ackAccess, clearAccess, ControlError, readCard, resetPasscode, revokeAllBrowsers, revokeBrowser,
  writeConfig,
} from './api.ts'
export type { CardSnapshot, ConnectionRpcLike } from './api.ts'
export type { RemctrlCardProps, RemctrlInjected, Translate } from './contract.ts'
export { en, zh } from './locales.ts'
export type { RemctrlKey } from './locales.ts'
export { RemctrlCard, relative, tunnelText } from './RemctrlCard.tsx'
export { copyToClipboard } from './clipboard.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This panel's copy. Named for the package: a namespace has one owner. */
    'omdsh-remctrl': RemctrlKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'omdsh-remctrl'

/** The hub's card slot. Restated rather than imported: a value import of another plugin is forbidden. */
export const PLUGIN_CARD_SLOT = 'omdsh.plugin.card'

/**
 * This card's id in that slot: the PACKAGE name.
 *
 * That is how the hub knows which installed plugin the card belongs to, and it
 * is what makes the card render in place of the generic form rather than beside
 * it.
 */
export const CARD_ID = '@omdsh-plugins/omdsh-remctrl'

/**
 * Required services (cordis fiber inject).
 *
 * `connection` carries every call this half makes. `slots` is the seat.
 * `locale` is the copy.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Contribute the remote-control card to the Plugin hub.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'omdsh-remctrl: dictionaries')

  // `t` is not built here: naming `locale: NS` on the registration is what makes
  // the slot renderer bind the dictionary and hand the card its own translator,
  // already in the language the panel is currently open in. Binding one here
  // would freeze the language at registration time.
  const connection = ctx.get('connection') as unknown as ConnectionRpcLike

  const injected = (): RemctrlInjected => ({
    read: async signal => readCard(connection, signal),
    write: async patch => writeConfig(connection, patch),
    revoke: async (browserId) => { await revokeBrowser(connection, browserId) },
    revokeAll: async () => (await revokeAllBrowsers(connection)).removed,
    reset: async () => (await resetPasscode(connection)).passcode,
    acknowledge: async () => { await ackAccess(connection) },
    clearLog: async () => { await clearAccess(connection) },
    copy: async value => copyToClipboard(value),
  })

  // `slots.inject` rather than a bare `register`: it waits for the declaration,
  // withdraws with it, and re-registers if it returns — so this card appears
  // when the hub is installed, disappears when it is removed, and needs no
  // ordering between the two plugins.
  ctx.slots.inject(PLUGIN_CARD_SLOT, () => ctx.slots.register({
    name: PLUGIN_CARD_SLOT,
    id: CARD_ID,
    locale: NS,
    inject: injected,
  }, RemctrlCard))
}

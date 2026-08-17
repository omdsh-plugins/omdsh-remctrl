/**
 * The Plugin hub card: one switch, one address, and everything that decides
 * whether the address works.
 *
 * ## Why a card and not the generic form
 *
 * The hub's form draws strings, numbers and booleans, and this section is all
 * three — so on shape alone it would render. It renders the wrong thing anyway:
 *
 * - `enabled` is not a checkbox among checkboxes. It is the moment this harness
 *   goes onto the internet, and what belongs next to it is a paragraph about
 *   what the passcode is holding.
 * - `publicHost` being EMPTY is the interesting case, and a text field with a
 *   placeholder cannot say "leave this alone and a tunnel will fetch you an
 *   address".
 * - `allowInsecure` is an acknowledgement rather than a preference, and it
 *   means nothing at all unless `publicHost` is set — so it is only drawn then.
 * - Most of what a person needs is not a setting: the URL to open, the link
 *   that carries the passcode, whether the tunnel came up, and which browsers
 *   are signed in right now.
 *
 * The values still live in the same settings namespace and still travel through
 * the same seam — rule 6 exactly: the escape hatch changes what the control
 * looks like, never where the value lives.
 * @module @omdsh-plugins/omdsh-remctrl/client/RemctrlCard
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type {
  AccessEvent, BrowserView, RemctrlPatch, StatusView, TunnelState, Warning,
} from '../contract.ts'
import type { CardSnapshot } from './api.ts'
import type { RemctrlCardProps, Translate } from './contract.ts'
import type { RemctrlKey } from './locales.ts'
import css from './RemctrlCard.module.css'

/** How often the card re-reads itself, so a tunnel coming up shows without a click. */
const POLL_MS = 4_000

/** The session lifetimes the card offers, in days. Zero is drawn separately. */
const TTL_CHOICES: readonly number[] = [1, 7, 30, 90, 365]

/** Warning codes that describe a state rather than a fault. */
const QUIET_WARNINGS: ReadonlySet<string> = new Set(['disabled', 'tailnet', 'fronted'])

/**
 * The card.
 * @param props - this plugin's face plus the hub's; see {@link RemctrlCardProps}.
 * @returns the panel.
 */
export function RemctrlCard(props: RemctrlCardProps) {
  const { read, t } = props
  const [snapshot, setSnapshot] = useState<CardSnapshot | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await read(signal)
      if (signal?.aborted === true) return
      setSnapshot(next)
      setFailure(undefined)
    } catch (error) {
      if (signal?.aborted === true) return
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [read])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = setInterval(() => { void refresh(controller.signal) }, POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [refresh])

  if (snapshot === undefined) {
    return failure === undefined
      ? <p className={css['muted']}>{t('loading')}</p>
      : (
          <p className={css['bad']}>
            {t('failed', { reason: failure })}{' '}
            <button type="button" className={css['quiet']} onClick={() => { void refresh() }}>{t('retry')}</button>
          </p>
        )
  }

  const section = { ...props, snapshot, refresh }
  return (
    <div className={css['card']}>
      <SwitchSection {...section} />
      {snapshot.status.enabled && <AddressSection {...section} />}
      <CarrierSection {...section} />
      {snapshot.status.enabled && <BrowsersSection {...section} />}
      {/* Drawn whether or not the switch is on: the interesting case is coming
          back to a machine you left running and finding out what happened. */}
      {snapshot.access.events.length > 0 && <AccessSection {...section} />}
      {failure !== undefined && <p className={css['bad']}>{t('failed', { reason: failure })}</p>}
    </div>
  )
}

/** What each section is handed. */
interface SectionProps extends RemctrlCardProps {
  snapshot: CardSnapshot
  refresh: (signal?: AbortSignal) => Promise<void>
}

/** The one switch, and the paragraph that belongs beside it. */
function SwitchSection(props: SectionProps) {
  const { t, snapshot, write, refresh, writable } = props
  const on = snapshot.status.enabled
  const [busy, setBusy] = useState(false)

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await write({ enabled: !on })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css['section']}>
      <div className={css['switchRow']}>
        <div className={css['switchText']}>
          <h4 className={css['title']}>{t('switch.title')}</h4>
          <p className={css['muted']}>{t('switch.lede')}</p>
        </div>
        <button
          type="button"
          className={on ? css['toggleOn'] : css['toggleOff']}
          disabled={busy || !writable}
          onClick={() => { void toggle() }}
        >
          {on ? t('switch.disable') : t('switch.enable')}
        </button>
      </div>
      <p className={on ? css['danger'] : css['muted']}>{t('switch.danger')}</p>
      {!writable && <p className={css['muted']}>{t('readonly')}</p>}
      <Warnings warnings={snapshot.status.warnings} t={t} />
      {on && <StatusLine status={snapshot.status} t={t} />}
    </section>
  )
}

/** The address, the sign-in link, and the passcode. */
function AddressSection(props: SectionProps) {
  const { t, snapshot, copy, reset, refresh } = props
  const { url, signInUrl, passcode } = snapshot.status
  const days = snapshot.config.config.sessionTtlDays

  if (url === '') {
    const waiting = snapshot.status.tunnel.state.kind === 'starting'
    return (
      <section className={css['section']}>
        <h4 className={css['title']}>{t('open.title')}</h4>
        <p className={css['muted']}>{waiting ? t('open.waiting') : t('open.none')}</p>
      </section>
    )
  }

  return (
    <section className={css['section']}>
      <h4 className={css['title']}>{t('open.title')}</h4>

      <Field label={t('open.url')}>
        <a className={css['url']} href={url} target="_blank" rel="noreferrer noopener">{url}</a>
        <CopyButton value={url} copy={copy} t={t} />
      </Field>

      {signInUrl !== '' && (
        <Field label={t('open.link')} hint={t('open.link.hint')}>
          <code className={css['code']}>{signInUrl}</code>
          <CopyButton value={signInUrl} copy={copy} t={t} />
        </Field>
      )}

      <Field
        label={t('open.passcode')}
        hint={days === 0 ? t('open.passcode.forever') : t('open.passcode.hint', { days })}
      >
        <code className={css['passcode']}>{passcode}</code>
        <CopyButton value={passcode} copy={copy} t={t} />
        <button
          type="button"
          className={css['quiet']}
          title={t('open.reset.hint')}
          onClick={() => { void reset().then(async () => refresh()) }}
        >
          {t('open.reset')}
        </button>
      </Field>
    </section>
  )
}

/** How the door is reached: the one field that decides it, and its consequences. */
function CarrierSection(props: SectionProps) {
  const { t, snapshot, write, refresh, writable } = props
  const config = snapshot.config.config
  const { carrier } = snapshot.status
  const direct = carrier === 'direct'
  const fronted = carrier === 'fronted'
  const [host, setHost] = useState(config.publicHost)
  const [port, setPort] = useState(String(config.port))
  const [problem, setProblem] = useState<string | undefined>(undefined)

  // The stored value wins whenever it changes underneath — another card, or a
  // hand edit of the settings file — and the effect is keyed on the stored
  // value so it does not fight a field somebody is typing in.
  useEffect(() => { setHost(config.publicHost) }, [config.publicHost])
  useEffect(() => { setPort(String(config.port)) }, [config.port])

  const commit = async (patch: RemctrlPatch): Promise<void> => {
    try {
      await write(patch)
      setProblem(undefined)
      await refresh()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className={css['section']}>
      <h4 className={css['title']}>{t('carrier.title')}</h4>
      <p className={css['muted']}>
        {fronted ? t('carrier.fronted.hint') : direct ? t('carrier.direct.hint') : t('carrier.tunnel.hint')}
      </p>
      {fronted && snapshot.status.url.startsWith('https://') && (
        <p className={css['muted']}>{t('carrier.fronted.secure')}</p>
      )}

      <Field label={t('carrier.publicHost')} hint={t('carrier.publicHost.hint')}>
        <input
          className={css['input']}
          type="text"
          value={host}
          disabled={!writable}
          placeholder={t('carrier.publicHost.placeholder')}
          onChange={(event) => { setHost(event.target.value) }}
          onBlur={() => { if (host.trim() !== config.publicHost) void commit({ publicHost: host.trim() }) }}
        />
        {/* What it ACTUALLY bound, which is not always what was typed: an
            address this machine holds is bound exactly, and one it cannot hold
            falls back to every interface. A field that hid that difference
            would be hiding the one thing that decides the exposure. */}
        {snapshot.status.bindHost !== '' && snapshot.status.bindHost !== host.trim() && (
          <span className={css['muted']}>{t('carrier.bound', { host: snapshot.status.bindHost })}</span>
        )}
      </Field>

      {/* Offered rather than explained: the difference between a plaintext port
          on the tailnet and one on every network the laptop joins is one click,
          and nobody types a 100.x address from memory. */}
      {!fronted && snapshot.status.tailnetAddresses.length > 0 && snapshot.status.bindScope !== 'tailnet' && (
        <div className={css['field']}>
          <span className={css['fieldLabel']}>{t('carrier.tailnet.offer')}</span>
          <div className={css['fieldBody']}>
            {snapshot.status.tailnetAddresses.map(address => (
              <button
                key={address}
                type="button"
                className={css['quiet']}
                disabled={!writable}
                onClick={() => { setHost(address); void commit({ publicHost: address }) }}
              >
                {address} — {t('carrier.tailnet.use')}
              </button>
            ))}
          </div>
          <span className={css['muted']}>{t('carrier.tailnet.hint')}</span>
        </div>
      )}

      <Field label={t('carrier.port')} hint={t('carrier.port.hint')}>
        <input
          className={css['port']}
          type="number"
          min={1}
          max={65535}
          value={port}
          disabled={!writable}
          onChange={(event) => { setPort(event.target.value) }}
          onBlur={() => {
            const next = Number(port)
            if (Number.isInteger(next) && next !== config.port) void commit({ port: next })
          }}
        />
      </Field>

      {/* Only where it still decides something. Under the tunnel there is
          nothing to acknowledge; bound to a tailnet address the plaintext is
          inside WireGuard, and a checkbox about unencrypted traffic beside that
          would be teaching the wrong lesson. */}
      {((direct && snapshot.status.bindScope === 'wide') || (fronted && !snapshot.status.url.startsWith('https://'))) && (
        <label className={css['check']}>
          <input
            type="checkbox"
            checked={config.allowInsecure}
            disabled={!writable}
            onChange={(event) => { void commit({ allowInsecure: event.target.checked }) }}
          />
          <span className={css['checkText']}>
            <strong>{t('carrier.insecure')}</strong>
            <span className={css['muted']}>{t('carrier.insecure.hint')}</span>
          </span>
        </label>
      )}

      <Field label={t('carrier.ttl')}>
        <select
          className={css['input']}
          value={String(config.sessionTtlDays)}
          disabled={!writable}
          onChange={(event) => { void commit({ sessionTtlDays: Number(event.target.value) }) }}
        >
          {TTL_CHOICES.map(days => (
            <option key={days} value={String(days)}>{t('carrier.ttl.days', { days })}</option>
          ))}
          <option value="0">{t('carrier.ttl.forever')}</option>
        </select>
      </Field>

      {problem !== undefined && <p className={css['bad']}>{problem}</p>}
    </section>
  )
}

/** Who is signed in, and the buttons that end it. */
function BrowsersSection(props: SectionProps) {
  const { t, snapshot, revoke, revokeAll, refresh } = props
  const rows = snapshot.browsers.browsers
  const [confirming, setConfirming] = useState(false)

  // The confirmation resets whenever the list changes underneath, so a button
  // that says "sign out all 3" can never be the one that signs out five.
  useEffect(() => { setConfirming(false) }, [rows.length])

  return (
    <section className={css['section']}>
      <h4 className={css['title']}>{t('browsers.title')}</h4>
      {rows.length === 0
        ? <p className={css['muted']}>{t('browsers.none')}</p>
        : (
            <>
              <ul className={css['list']}>
                {rows.map(row => (
                  <BrowserRow
                    key={row.browserId}
                    row={row}
                    t={t}
                    onRevoke={() => { void revoke(row.browserId).then(async () => refresh()) }}
                  />
                ))}
              </ul>
              {/* Two steps, because the phone this signs out may be running
                  something. One step would make it a mis-click. */}
              {confirming
                ? (
                    <div className={css['confirmRow']}>
                      <button
                        type="button"
                        className={css['danger-button']}
                        onClick={() => {
                          setConfirming(false)
                          void revokeAll().then(async () => refresh())
                        }}
                      >
                        {t('browsers.revokeAll.confirm', { count: rows.length })}
                      </button>
                      <button type="button" className={css['quiet']} onClick={() => { setConfirming(false) }}>
                        {t('browsers.revokeAll.cancel')}
                      </button>
                    </div>
                  )
                : (
                    <button
                      type="button"
                      className={css['quiet']}
                      title={t('browsers.revokeAll.hint')}
                      onClick={() => { setConfirming(true) }}
                    >
                      {t('browsers.revokeAll')}
                    </button>
                  )}
              <p className={css['muted']}>{t('browsers.revokeAll.hint')}</p>
            </>
          )}
    </section>
  )
}

/**
 * What has happened at the door.
 *
 * A record rather than a notification, and the distinction is the whole point:
 * a notification reaches whoever is looking, and the case worth catching is
 * the one nobody was looking at.
 */
function AccessSection(props: SectionProps) {
  const { t, snapshot, acknowledge, clearLog, refresh } = props
  const { events, unseen } = snapshot.access
  const [confirming, setConfirming] = useState(false)

  // The confirmation resets whenever the log moves underneath, so a button that
  // says "clear 17" can never be the one that clears twenty.
  useEffect(() => { setConfirming(false) }, [events.length])

  // The row a previous clear left behind does not count as something to clear.
  const clearable = events.filter(event => event.cleared === undefined).length

  return (
    <section className={css['section']}>
      <div className={css['switchRow']}>
        <h4 className={css['title']}>
          {t('access.title')}
          {unseen > 0 && <span className={css['badge']}>{t('access.unseen', { count: unseen })}</span>}
        </h4>
        <div className={css['confirmRow']}>
          {unseen > 0 && (
            <button
              type="button"
              className={css['quiet']}
              onClick={() => { void acknowledge().then(async () => refresh()) }}
            >
              {t('access.ack')}
            </button>
          )}
          {clearable > 0 && (confirming
            ? (
                <>
                  <button
                    type="button"
                    className={css['danger-button']}
                    onClick={() => {
                      setConfirming(false)
                      void clearLog().then(async () => refresh())
                    }}
                  >
                    {t('access.clear.confirm', { count: clearable })}
                  </button>
                  <button type="button" className={css['quiet']} onClick={() => { setConfirming(false) }}>
                    {t('access.clear.cancel')}
                  </button>
                </>
              )
            : (
                <button
                  type="button"
                  className={css['quiet']}
                  title={t('access.clear.hint')}
                  onClick={() => { setConfirming(true) }}
                >
                  {t('access.clear')}
                </button>
              ))}
        </div>
      </div>
      <ul className={css['list']}>
        {events.map(event => <AccessRow key={`${String(event.at)}-${event.address}`} event={event} t={t} />)}
      </ul>
      <p className={css['muted']}>{confirming ? t('access.clear.hint') : t('access.hint')}</p>
    </section>
  )
}

/** One thing that happened at the door. */
function AccessRow(props: { event: AccessEvent; t: Translate }) {
  const { event, t } = props
  // The mark a clear left behind. Rendered quietly — it is not an access event,
  // it is the reason the ones above it are missing.
  if (event.cleared !== undefined) {
    return (
      <li className={css['row']}>
        <span className={css['muted']}>{t('access.cleared', { count: event.cleared })}</span>
        <span className={css['muted']}>{relative(event.at)}</span>
      </li>
    )
  }
  const what = event.granted
    ? t('access.granted', { label: event.label })
    : event.attempts > 1
      ? t('access.refused.many', { label: event.label, attempts: event.attempts })
      : t('access.refused', { label: event.label })
  return (
    <li className={css['row']}>
      <span className={css['rowText']}>
        <span className={event.granted ? css['label'] : css['warn']}>{what}</span>
        <span className={css['muted']}>{t('access.from', { address: event.address })}</span>
      </span>
      <span className={css['muted']}>{relative(event.at)}</span>
    </li>
  )
}

/** One signed-in browser. */
function BrowserRow(props: { row: BrowserView; t: Translate; onRevoke: () => void }) {
  const { row, t, onRevoke } = props
  return (
    <li className={css['row']}>
      <span className={css['rowText']}>
        <span className={css['label']}>{row.label}</span>
        {row.expired === true && <span className={css['tag']}>{t('browsers.expired')}</span>}
        <span className={css['muted']}>{t('browsers.lastSeen', { when: relative(row.lastSeenAt) })}</span>
      </span>
      <button type="button" className={css['quiet']} title={t('browsers.revoke.hint')} onClick={onRevoke}>
        {t('browsers.revoke')}
      </button>
    </li>
  )
}

/** The one-line "is it actually up" report. */
function StatusLine(props: { status: StatusView; t: Translate }) {
  const { status, t } = props
  const tunnel = status.carrier === 'tunnel' ? tunnelText(status.tunnel.state, t) : ''
  return (
    <p className={css['muted']}>
      {status.listening ? t('status.listening', { port: status.port }) : t('status.down')}
      {status.upstreamPort !== null && ` · ${t('status.upstream', { port: status.upstreamPort })}`}
      {tunnel !== '' && ` · ${tunnel}`}
    </p>
  )
}

/**
 * What the tunnel is doing, in one clause.
 * @param state - the tunnel state.
 * @param t - the translator.
 * @returns the clause, or `''` when there is nothing to say.
 */
export function tunnelText(state: TunnelState, t: Translate): string {
  switch (state.kind) {
    case 'off': return ''
    case 'starting': return t('status.tunnel.starting', { attempt: state.attempt })
    case 'up': return t('status.tunnel.up')
    default: return state.retryInMs > 0
      ? `${t('status.tunnel.failed')} — ${t('status.tunnel.retry', { seconds: Math.ceil(state.retryInMs / 1000) })}`
      : t('status.tunnel.failed')
  }
}

/** Everything standing in the way, in the host's own words. */
function Warnings(props: { warnings: Warning[]; t: Translate }) {
  const { warnings, t } = props
  if (warnings.length === 0) return null
  return (
    <ul className={css['warnings']}>
      {warnings.map(warning => (
        // `disabled` and `tailnet` are states rather than faults; painting them
        // the colour of a problem is how a card teaches somebody to ignore it.
        <li key={warning.code} className={QUIET_WARNINGS.has(warning.code) ? css['muted'] : css['warn']}>
          <strong>{t(`warn.${warning.code}` as RemctrlKey)}</strong>
          <span> — {warning.detail}</span>
        </li>
      ))}
    </ul>
  )
}

/** One labelled control, with the sentence that explains it underneath. */
function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={css['field']}>
      <span className={css['fieldLabel']}>{props.label}</span>
      <div className={css['fieldBody']}>{props.children}</div>
      {props.hint !== undefined && <span className={css['muted']}>{props.hint}</span>}
    </div>
  )
}

/** Copy, and say so for a moment. */
function CopyButton(props: { value: string; copy: (value: string) => Promise<boolean>; t: Translate }) {
  const { value, copy, t } = props
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return undefined
    const timer = setTimeout(() => { setDone(false) }, 1_500)
    return () => { clearTimeout(timer) }
  }, [done])
  return (
    <button
      type="button"
      className={css['quiet']}
      onClick={() => { void copy(value).then((ok) => { setDone(ok) }) }}
    >
      {done ? t('copied') : t('copy')}
    </button>
  )
}

/**
 * A timestamp as "3m", without a formatting library.
 *
 * Deliberately coarse: this line exists so somebody can tell a phone that was
 * used a minute ago from one that has not been touched since Tuesday, and no
 * decision anyone makes here turns on the difference between 61 and 62 minutes.
 * @param at - epoch milliseconds.
 * @returns a short relative string.
 */
export function relative(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)}h`
  return `${String(Math.round(hours / 24))}d`
}

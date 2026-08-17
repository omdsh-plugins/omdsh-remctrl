// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { AccessEvent, BrowserView, ConfigView, StatusView, TunnelState } from '../src/contract.ts'
import type { CardSnapshot } from '../src/client/api.ts'
import type { RemctrlCardProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { RemctrlCard, relative } from '../src/client/RemctrlCard.tsx'

afterEach(cleanup)

/** The English dictionary, with `{name}` interpolation, as the slot hands it over. */
const t: RemctrlCardProps['t'] = (key, values) => {
  const raw = en[key]
  if (values === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => String(values[name] ?? whole))
}

/** A status, with whatever the case is about. */
function status(over: Partial<StatusView> = {}): StatusView {
  return {
    enabled: true,
    listening: true,
    carrier: 'tunnel',
    bindHost: '127.0.0.1',
    bindScope: 'loopback',
    tailnetAddresses: [],
    port: 3081,
    upstreamPort: 62_886,
    url: 'https://x.trycloudflare.com',
    signInUrl: 'https://x.trycloudflare.com/?k=ABC123XYZ0',
    passcode: 'ABC123XYZ0',
    tunnel: { state: { kind: 'up', url: 'https://x.trycloudflare.com' } as TunnelState, binary: '/usr/bin/cloudflared' },
    browsers: 0,
    warnings: [],
    ...over,
  }
}

/** A section, with whatever the case is about. */
function config(over: Partial<ConfigView['config']> = {}): ConfigView {
  return {
    config: { enabled: true, publicHost: '', port: 3081, allowInsecure: false, sessionTtlDays: 30, ...over },
    writable: true,
  }
}

/** Render the card over a snapshot, with every action recorded. */
function draw(snapshot: Partial<CardSnapshot> = {}, over: Partial<RemctrlCardProps> = {}) {
  const full: CardSnapshot = {
    status: snapshot.status ?? status(),
    config: snapshot.config ?? config(),
    browsers: snapshot.browsers ?? { browsers: [] },
    access: snapshot.access ?? { events: [], unseen: 0 },
  }
  const props: RemctrlCardProps = {
    read: vi.fn(async () => full),
    write: vi.fn(async () => full.config),
    revoke: vi.fn(async () => {}),
    revokeAll: vi.fn(async () => 2),
    reset: vi.fn(async () => 'NEWPASSCODE'),
    acknowledge: vi.fn(async () => {}),
    clearLog: vi.fn(async () => {}),
    copy: vi.fn(async () => true),
    writable: true,
    t,
    ...over,
  }
  render(<RemctrlCard {...props} />)
  return props
}

describe('while it is loading', () => {
  it('says so, and then says what went wrong if it did', async () => {
    draw({}, { read: vi.fn(async () => { throw new Error('no channel') }) })
    await waitFor(() => { expect(screen.getByText(/no channel/)).toBeTruthy() })
  })
})

describe('the switch', () => {
  it('offers to turn it on when it is off, and says what that means', async () => {
    draw({ status: status({ enabled: false }), config: config({ enabled: false }) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['switch.enable'] })).toBeTruthy() })
    // The paragraph is the point of the card: it is the last thing somebody
    // reads before putting an agent on the internet.
    expect(screen.getByText(/everything you can do here/)).toBeTruthy()
  })

  it('writes the switch through the same seam the form would have used', async () => {
    const props = draw({ status: status({ enabled: false }), config: config({ enabled: false }) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['switch.enable'] })).toBeTruthy() })
    screen.getByRole('button', { name: en['switch.enable'] }).click()
    await waitFor(() => { expect(props.write).toHaveBeenCalledWith({ enabled: true }) })
  })

  it('offers to turn it off when it is on', async () => {
    draw()
    await waitFor(() => { expect(screen.getByRole('button', { name: en['switch.disable'] })).toBeTruthy() })
  })

  it('says settings are read-only when they are, and disables the switch', async () => {
    draw({}, { writable: false })
    await waitFor(() => { expect(screen.getByText(en['readonly'])).toBeTruthy() })
    expect(screen.getByRole('button', { name: en['switch.disable'] }).hasAttribute('disabled')).toBe(true)
  })
})

describe('the address', () => {
  it('shows the URL, the sign-in link, and the passcode', async () => {
    draw()
    await waitFor(() => { expect(screen.getByText('https://x.trycloudflare.com')).toBeTruthy() })
    expect(screen.getByText('https://x.trycloudflare.com/?k=ABC123XYZ0')).toBeTruthy()
    expect(screen.getByText('ABC123XYZ0')).toBeTruthy()
  })

  it('is not drawn at all while remote control is off', async () => {
    draw({ status: status({ enabled: false }), config: config({ enabled: false }) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['switch.enable'] })).toBeTruthy() })
    expect(screen.queryByText(en['open.title'])).toBeNull()
  })

  it('says the tunnel is coming rather than showing an empty field', async () => {
    draw({
      status: status({
        url: '', signInUrl: '', tunnel: { state: { kind: 'starting', attempt: 1 }, binary: '/usr/bin/cloudflared' },
      }),
    })
    await waitFor(() => { expect(screen.getByText(en['open.waiting'])).toBeTruthy() })
  })

  it('copies what it shows', async () => {
    const props = draw()
    await waitFor(() => { expect(screen.getAllByRole('button', { name: en['copy'] }).length).toBeGreaterThan(0) })
    screen.getAllByRole('button', { name: en['copy'] })[0]?.click()
    await waitFor(() => { expect(props.copy).toHaveBeenCalledWith('https://x.trycloudflare.com') })
  })

  it('mints a new passcode on request', async () => {
    const props = draw()
    await waitFor(() => { expect(screen.getByRole('button', { name: en['open.reset'] })).toBeTruthy() })
    screen.getByRole('button', { name: en['open.reset'] }).click()
    await waitFor(() => { expect(props.reset).toHaveBeenCalled() })
  })
})

describe('the carrier', () => {
  it('explains the tunnel when no public host is set', async () => {
    draw()
    await waitFor(() => { expect(screen.getByText(en['carrier.tunnel.hint'])).toBeTruthy() })
  })

  it('explains the direct bind when one is', async () => {
    draw({ status: status({ carrier: 'direct' }), config: config({ publicHost: '1.2.3.4' }) })
    await waitFor(() => { expect(screen.getByText(en['carrier.direct.hint'])).toBeTruthy() })
  })

  it('offers the acknowledgement ONLY where it means something', async () => {
    // Under the tunnel `allowInsecure` has nothing to acknowledge, and a
    // checkbox about unencrypted traffic beside an https URL is a lie.
    draw()
    await waitFor(() => { expect(screen.getByText(en['carrier.title'])).toBeTruthy() })
    expect(screen.queryByText(en['carrier.insecure'])).toBeNull()

    cleanup()
    draw({
      status: status({ carrier: 'direct', bindScope: 'wide', bindHost: '0.0.0.0' }),
      config: config({ publicHost: '1.2.3.4' }),
    })
    await waitFor(() => { expect(screen.getByText(en['carrier.insecure'])).toBeTruthy() })
  })

  it('does NOT offer the acknowledgement on a tailnet bind', async () => {
    // Inside WireGuard there is nothing to acknowledge, and a checkbox about
    // unencrypted traffic beside it would be teaching the wrong lesson.
    draw({
      status: status({ carrier: 'direct', bindScope: 'tailnet', bindHost: '100.101.102.103' }),
      config: config({ publicHost: '100.101.102.103' }),
    })
    await waitFor(() => { expect(screen.getByText(en['carrier.title'])).toBeTruthy() })
    expect(screen.queryByText(en['carrier.insecure'])).toBeNull()
  })

  it('offers this machine\'s tailnet address, and fills it in on a click', async () => {
    const props = draw({ status: status({ tailnetAddresses: ['100.101.102.103'] }) })
    const offer = await screen.findByRole('button', { name: /100\.101\.102\.103/ })
    offer.click()
    await waitFor(() => { expect(props.write).toHaveBeenCalledWith({ publicHost: '100.101.102.103' }) })
  })

  it('stops offering it once it is what got bound', async () => {
    draw({
      status: status({
        carrier: 'direct', bindScope: 'tailnet', bindHost: '100.101.102.103',
        tailnetAddresses: ['100.101.102.103'],
      }),
      config: config({ publicHost: '100.101.102.103' }),
    })
    await waitFor(() => { expect(screen.getByText(en['carrier.title'])).toBeTruthy() })
    expect(screen.queryByRole('button', { name: /Use it/ })).toBeNull()
  })

  it('says what it ACTUALLY bound when that is not what was typed', async () => {
    // They differ on a cloud VM, and hiding the difference would hide the one
    // thing that decides the exposure.
    draw({
      status: status({ carrier: 'direct', bindScope: 'wide', bindHost: '0.0.0.0' }),
      config: config({ publicHost: '121.43.252.12' }),
    })
    await waitFor(() => { expect(screen.getByText('bound to 0.0.0.0')).toBeTruthy() })
  })

  it('is drawn even while remote control is off, so it can be set up first', async () => {
    draw({ status: status({ enabled: false }), config: config({ enabled: false }) })
    await waitFor(() => { expect(screen.getByText(en['carrier.title'])).toBeTruthy() })
  })
})

describe('warnings', () => {
  it('shows the host\'s own words, under a translated heading', async () => {
    draw({
      status: status({
        warnings: [{ code: 'missing-binary', detail: 'cloudflared is not installed. On macOS: `brew install cloudflared`.' }],
      }),
    })
    await waitFor(() => { expect(screen.getByText(en['warn.missing-binary'])).toBeTruthy() })
    expect(screen.getByText(/brew install cloudflared/)).toBeTruthy()
  })
})

describe('signed-in browsers', () => {
  const phone: BrowserView = {
    browserId: 'b1', label: 'iPhone', signedInAt: Date.now() - 60_000, lastSeenAt: Date.now() - 30_000,
  }

  it('lists them, and signs one out', async () => {
    const props = draw({ browsers: { browsers: [phone] } })
    await waitFor(() => { expect(screen.getByText('iPhone')).toBeTruthy() })
    screen.getByRole('button', { name: en['browsers.revoke'] }).click()
    await waitFor(() => { expect(props.revoke).toHaveBeenCalledWith('b1') })
  })

  it('marks one whose session ran out, rather than hiding it', async () => {
    draw({ browsers: { browsers: [{ ...phone, expired: true }] } })
    await waitFor(() => { expect(screen.getByText(en['browsers.expired'])).toBeTruthy() })
  })

  it('says so when nothing has signed in', async () => {
    draw()
    await waitFor(() => { expect(screen.getByText(en['browsers.none'])).toBeTruthy() })
  })

  it('signs everything out, but only after a second click', async () => {
    // The phone this signs out may be running something. One step would make
    // it a mis-click.
    const props = draw({ browsers: { browsers: [phone, { ...phone, browserId: 'b2', label: 'Mac' }] } })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['browsers.revokeAll'] })).toBeTruthy() })
    screen.getByRole('button', { name: en['browsers.revokeAll'] }).click()
    expect(props.revokeAll).not.toHaveBeenCalled()

    const confirm = await screen.findByRole('button', { name: /Really sign out all 2/ })
    confirm.click()
    await waitFor(() => { expect(props.revokeAll).toHaveBeenCalled() })
  })

  it('lets the confirmation be backed out of', async () => {
    const props = draw({ browsers: { browsers: [phone] } })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['browsers.revokeAll'] })).toBeTruthy() })
    screen.getByRole('button', { name: en['browsers.revokeAll'] }).click()
    ;(await screen.findByRole('button', { name: en['browsers.revokeAll.cancel'] })).click()
    await waitFor(() => { expect(screen.getByRole('button', { name: en['browsers.revokeAll'] })).toBeTruthy() })
    expect(props.revokeAll).not.toHaveBeenCalled()
  })

  it('offers nothing to sign out when nothing is signed in', async () => {
    draw()
    await waitFor(() => { expect(screen.getByText(en['browsers.none'])).toBeTruthy() })
    expect(screen.queryByRole('button', { name: en['browsers.revokeAll'] })).toBeNull()
  })
})

describe('the access log', () => {
  const granted: AccessEvent = {
    at: Date.now() - 60_000, granted: true, label: 'iPhone', address: '203.0.113.9', attempts: 1, browserId: 'b1',
  }
  const refused: AccessEvent = {
    at: Date.now() - 120_000, granted: false, label: 'Browser', address: '198.51.100.4', attempts: 14,
  }

  it('says who got in, and from where', async () => {
    draw({ access: { events: [granted], unseen: 0 } })
    await waitFor(() => { expect(screen.getByText('iPhone signed in')).toBeTruthy() })
    expect(screen.getByText('from 203.0.113.9')).toBeTruthy()
  })

  it('carries the count on a run of failed attempts', async () => {
    draw({ access: { events: [refused], unseen: 0 } })
    await waitFor(() => { expect(screen.getByText(/got the passcode wrong ×14/)).toBeTruthy() })
  })

  it('shows how many are new, and marks them read on request', async () => {
    const props = draw({ access: { events: [granted, refused], unseen: 2 } })
    await waitFor(() => { expect(screen.getByText('2 new')).toBeTruthy() })
    screen.getByRole('button', { name: en['access.ack'] }).click()
    await waitFor(() => { expect(props.acknowledge).toHaveBeenCalled() })
  })

  it('offers nothing to acknowledge when there is nothing new', async () => {
    draw({ access: { events: [granted], unseen: 0 } })
    await waitFor(() => { expect(screen.getByText('iPhone signed in')).toBeTruthy() })
    expect(screen.queryByRole('button', { name: en['access.ack'] })).toBeNull()
  })

  it('is drawn even while remote control is off', async () => {
    // The interesting case is coming back to a machine you left running and
    // finding out what happened on it.
    draw({
      status: status({ enabled: false }),
      config: config({ enabled: false }),
      access: { events: [granted], unseen: 1 },
    })
    await waitFor(() => { expect(screen.getByText(en['access.title'])).toBeTruthy() })
  })

  it('clears the log, but only after a second click', async () => {
    const props = draw({ access: { events: [granted, refused], unseen: 0 } })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['access.clear'] })).toBeTruthy() })
    screen.getByRole('button', { name: en['access.clear'] }).click()
    expect(props.clearLog).not.toHaveBeenCalled()
    ;(await screen.findByRole('button', { name: /Really clear 2/ })).click()
    await waitFor(() => { expect(props.clearLog).toHaveBeenCalled() })
  })

  it('renders the mark a previous clear left behind', async () => {
    // A log that can go from fifty rows to a blank page with no explanation is
    // a log an intruder empties on the way out.
    draw({ access: { events: [{ at: Date.now() - 5_000, granted: true, label: '', address: '', attempts: 0, cleared: 17 }], unseen: 0 } })
    await waitFor(() => { expect(screen.getByText(/Log cleared — 17 entries removed/)).toBeTruthy() })
  })

  it('does not offer to clear a log that holds only that mark', async () => {
    draw({ access: { events: [{ at: Date.now(), granted: true, label: '', address: '', attempts: 0, cleared: 3 }], unseen: 0 } })
    await waitFor(() => { expect(screen.getByText(en['access.title'])).toBeTruthy() })
    expect(screen.queryByRole('button', { name: en['access.clear'] })).toBeNull()
  })

  it('is not drawn at all when nothing has ever happened', async () => {
    draw()
    await waitFor(() => { expect(screen.getByText(en['carrier.title'])).toBeTruthy() })
    expect(screen.queryByText(en['access.title'])).toBeNull()
  })
})

describe('relative', () => {
  it('is coarse on purpose', () => {
    expect(relative(Date.now())).toBe('0s')
    expect(relative(Date.now() - 90_000)).toBe('2m')
    expect(relative(Date.now() - 3 * 3_600_000)).toBe('3h')
    expect(relative(Date.now() - 5 * 86_400_000)).toBe('5d')
  })

  it('never reports the future as a negative', () => {
    expect(relative(Date.now() + 10_000)).toBe('0s')
  })
})

describe('the dictionaries', () => {
  it('cover exactly the same keys', () => {
    // A missing key renders as the key itself, which is how a panel ships with
    // `warn.tunnel-down` written across it in one language and not the other.
    // The zh dictionary is the key-set source of truth.
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has a heading for every warning the host can report', () => {
    const codes = [
      'disabled', 'no-upstream', 'missing-binary', 'tunnel-down',
      'no-public-host', 'insecure-unacknowledged', 'plaintext', 'refused',
    ]
    for (const code of codes) expect(Object.keys(en)).toContain(`warn.${code}`)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ENDPOINTS, type AccessView, type BrowserList, type ConfigView, type Mutation,
  type PasscodeState, type RemctrlPatch, type RemctrlWire, type RevokeAll, type StatusView,
} from '../src/contract.ts'
import { AccessJournal } from '../src/access.ts'
import { BrowserStore } from '../src/browsers.ts'
import { checkPublicHost, createControlHandler, parsePatch } from '../src/control.ts'

/** The section the bench reports. */
const CONFIG: RemctrlWire = {
  enabled: true,
  publicHost: '',
  port: 3081,
  allowInsecure: false,
  sessionTtlDays: 30,
}

/** Everything the handler needs, with the writes recorded. */
function bench(options: { refusal?: string } = {}) {
  const browsers = new BrowserStore({ now: () => 1_000, hashToken: token => `h:${token}` })
  const clock = { now: 1_000 }
  const access = new AccessJournal({ now: () => clock.now })
  const writes: RemctrlPatch[] = []
  const status = vi.fn((): StatusView => ({
    enabled: true,
    listening: true,
    carrier: 'tunnel',
    bindHost: '127.0.0.1',
    bindScope: 'loopback',
    tailnetAddresses: [],
    port: 3081,
    upstreamPort: 62886,
    url: 'https://x.trycloudflare.com',
    signInUrl: 'https://x.trycloudflare.com/?k=ABC',
    passcode: 'ABC',
    tunnel: { state: { kind: 'up', url: 'https://x.trycloudflare.com' }, binary: '/usr/bin/cloudflared' },
    browsers: browsers.size,
    warnings: [],
  }))
  const handler = createControlHandler({
    browsers,
    access,
    status,
    config: () => ({ config: CONFIG, writable: true }),
    writeConfig: async (patch) => {
      writes.push(patch)
      return options.refusal
    },
    resetPasscode: async () => 'NEWPASSCODE',
  })
  return {
    browsers,
    access,
    clock,
    writes,
    status,
    call: async (endpoint: string, payload: unknown = {}) =>
      handler(endpoint, payload, new AbortController().signal),
  }
}

describe('reads', () => {
  it('answers the status, computed fresh on every call', async () => {
    const held = bench()
    const first = await held.call(CONTROL_ENDPOINTS.readStatus)
    await held.call(CONTROL_ENDPOINTS.readStatus)
    expect(first.ok).toBe(true)
    // A card left open must not go stale.
    expect(held.status).toHaveBeenCalledTimes(2)
    if (!first.ok) throw new Error('unreachable')
    expect((first.value as StatusView).url).toBe('https://x.trycloudflare.com')
  })

  it('answers the configuration and whether it can be written', async () => {
    const result = await bench().call(CONTROL_ENDPOINTS.readConfig)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value as ConfigView).toEqual({ config: CONFIG, writable: true })
  })

  it('lists the signed-in browsers', async () => {
    const held = bench()
    held.browsers.issue({ browserId: 'b1', token: 't1', label: 'iPhone' })
    const result = await held.call(CONTROL_ENDPOINTS.listBrowsers)
    if (!result.ok) throw new Error('unreachable')
    expect((result.value as BrowserList).browsers).toEqual([expect.objectContaining({ label: 'iPhone' })])
  })
})

describe('writes', () => {
  it('passes a narrowed patch through and answers with the section', async () => {
    const held = bench()
    const result = await held.call(CONTROL_ENDPOINTS.writeConfig, { enabled: false })
    expect(result.ok).toBe(true)
    expect(held.writes).toEqual([{ enabled: false }])
  })

  it('carries the seam\'s refusal back as a message a person can read', async () => {
    const held = bench({ refusal: 'port 3081 is already held' })
    const result = await held.call(CONTROL_ENDPOINTS.writeConfig, { port: 3081 })
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toBe('port 3081 is already held')
  })

  it('refuses an empty write rather than storing nothing loudly', async () => {
    const result = await bench().call(CONTROL_ENDPOINTS.writeConfig, {})
    expect(result.ok).toBe(false)
  })
})

describe('browsers', () => {
  it('signs one out', async () => {
    const held = bench()
    held.browsers.issue({ browserId: 'b1', token: 't1', label: 'iPhone' })
    const result = await held.call(CONTROL_ENDPOINTS.revokeBrowser, { browserId: 'b1' })
    if (!result.ok) throw new Error('unreachable')
    expect((result.value as Mutation).changed).toBe(true)
    expect(held.browsers.authenticate('t1')).toBeUndefined()
  })

  it('reports a miss rather than throwing, so two cards can race', async () => {
    const result = await bench().call(CONTROL_ENDPOINTS.revokeBrowser, { browserId: 'nobody' })
    if (!result.ok) throw new Error('unreachable')
    expect((result.value as Mutation).changed).toBe(false)
  })

  it('needs a browserId', async () => {
    const result = await bench().call(CONTROL_ENDPOINTS.revokeBrowser, {})
    expect(result.ok).toBe(false)
  })

  it('signs every one of them out at once, and says how many', async () => {
    const held = bench()
    held.browsers.issue({ browserId: 'b1', token: 't1', label: 'iPhone' })
    held.browsers.issue({ browserId: 'b2', token: 't2', label: 'Mac' })
    const result = await held.call(CONTROL_ENDPOINTS.revokeAllBrowsers)
    if (!result.ok) throw new Error('unreachable')
    expect((result.value as RevokeAll).removed).toBe(2)
    expect(held.browsers.authenticate('t1')).toBeUndefined()
    expect(held.browsers.authenticate('t2')).toBeUndefined()
  })

  it('does not ask for a confirmation of its own', async () => {
    // The card asks, twice. A channel that second-guessed its caller would be a
    // channel with a second policy in it.
    const result = await bench().call(CONTROL_ENDPOINTS.revokeAllBrowsers)
    if (!result.ok) throw new Error('unreachable')
    expect((result.value as RevokeAll).removed).toBe(0)
  })
})

describe('the access log', () => {
  it('answers what happened at the door, newest first', async () => {
    const held = bench()
    held.access.refused({ label: 'Browser', address: '198.51.100.4' })
    held.clock.now += 1_000
    held.access.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b1' })
    const result = await held.call(CONTROL_ENDPOINTS.readAccess)
    if (!result.ok) throw new Error('unreachable')
    const view = result.value as AccessView
    expect(view.events.map(event => event.granted)).toEqual([true, false])
    expect(view.unseen).toBe(2)
  })

  it('marks it read, and the count starts again', async () => {
    const held = bench()
    held.access.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b1' })
    const acked = await held.call(CONTROL_ENDPOINTS.ackAccess)
    if (!acked.ok) throw new Error('unreachable')
    expect((acked.value as AccessView).unseen).toBe(0)

    held.clock.now += 1_000
    held.access.granted({ label: 'Mac', address: '198.51.100.4', browserId: 'b2' })
    const after = await held.call(CONTROL_ENDPOINTS.readAccess)
    if (!after.ok) throw new Error('unreachable')
    expect((after.value as AccessView).unseen).toBe(1)
  })
})

describe('the passcode', () => {
  it('mints a new one and hands it back', async () => {
    const result = await bench().call(CONTROL_ENDPOINTS.resetPasscode)
    if (!result.ok) throw new Error('unreachable')
    expect((result.value as PasscodeState).passcode).toBe('NEWPASSCODE')
  })

  it('does NOT sign anybody out', async () => {
    // The passcode is how you get in, not what keeps you in. Conflating the two
    // would mean every reset signs out the laptop you are holding.
    const held = bench()
    held.browsers.issue({ browserId: 'b1', token: 't1', label: 'iPhone' })
    await held.call(CONTROL_ENDPOINTS.resetPasscode)
    expect(held.browsers.authenticate('t1')).toBeDefined()
  })
})

describe('unknown endpoints', () => {
  it('are refused by name', async () => {
    const result = await bench().call('nothing/here')
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('nothing/here')
  })
})

describe('parsePatch', () => {
  it('takes each editable field at its own type', () => {
    expect(parsePatch({ enabled: true, publicHost: ' x.example ', port: 80, allowInsecure: true, sessionTtlDays: 7 }))
      .toEqual({ enabled: true, publicHost: 'x.example', port: 80, allowInsecure: true, sessionTtlDays: 7 })
  })

  it('REFUSES to carry a field that is not editable', () => {
    // The section also holds the passcode and the browser table; a write that
    // reached those could install a session token hash of its own choosing.
    expect(parsePatch({ passcode: 'MINE', browsers: { b: {} }, enabled: true }))
      .toEqual({ enabled: true })
  })

  it('names the type it wanted', () => {
    expect(parsePatch({ enabled: 'yes' })).toMatch(/boolean/)
    expect(parsePatch({ port: 'eighty' })).toMatch(/number/)
    expect(parsePatch({ publicHost: 7 })).toMatch(/string/)
    expect(parsePatch({ sessionTtlDays: -1 })).toMatch(/days/)
    expect(parsePatch(null)).toMatch(/object/)
  })

  it('refuses a port outside the range a socket can hold', () => {
    expect(parsePatch({ port: 0 })).toMatch(/between 1 and 65535/)
    expect(parsePatch({ port: 70000 })).toMatch(/between 1 and 65535/)
  })
})

describe('checkPublicHost', () => {
  it('accepts a bare host or address, and empty', () => {
    expect(checkPublicHost('')).toBeUndefined()
    expect(checkPublicHost('121.43.252.12')).toBeUndefined()
    expect(checkPublicHost('harness.example.com')).toBeUndefined()
    expect(checkPublicHost('[2001:db8::1]')).toBeUndefined()
  })

  it('ACCEPTS a whole URL, which is how you say "I am reached there, not here"', () => {
    expect(checkPublicHost('http://121.43.252.12:7860')).toBeUndefined()
    expect(checkPublicHost('https://dsh.example.com')).toBeUndefined()
    expect(checkPublicHost('https://dsh.example.com/')).toBeUndefined()
  })

  it('refuses a port on a BARE address, which would disagree with the port field', () => {
    // Somebody who means a port is writing a URL; a bare address with one would
    // show a number on the card that the listener does not hold.
    expect(checkPublicHost('121.43.252.12:7860')).toMatch(/whole URL/)
  })

  it('refuses a path, because this forward serves an origin rather than a subdirectory', () => {
    expect(checkPublicHost('example.com/dsh')).toMatch(/no path/)
    expect(checkPublicHost('https://dsh.example.com/harness')).toMatch(/subdirectory/)
  })

  it('refuses a scheme it cannot stand behind, and credentials in the URL', () => {
    expect(checkPublicHost('ftp://dsh.example.com')).toMatch(/http or https/)
    expect(checkPublicHost('https://me:secret@dsh.example.com')).toMatch(/credentials/)
  })

  it('refuses a query or a fragment', () => {
    expect(checkPublicHost('https://dsh.example.com/?a=1')).toMatch(/query/)
  })

  it('refuses a space', () => {
    expect(checkPublicHost('a b')).toMatch(/space/)
  })
})

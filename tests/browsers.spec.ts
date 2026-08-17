import { describe, expect, it, vi } from 'vitest'
import { BrowserStore, labelFromUserAgent, type BrowserTable } from '../src/browsers.ts'

/** A store on a clock a spec can move. */
function store(at = { now: 1_000 }) {
  const persist = vi.fn()
  const held = new BrowserStore({
    now: () => at.now,
    hashToken: token => `hash:${token}`,
    persist,
  })
  return { held, persist, at }
}

describe('issuing a session', () => {
  it('resolves the token it was given, once', () => {
    const { held } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'iPhone' })
    expect(held.authenticate('t1')?.browserId).toBe('b1')
    expect(held.authenticate('t2')).toBeUndefined()
  })

  it('mirrors the table, holding a hash and never a token', () => {
    // A settings section syncs, gets backed up and ends up pasted into bug
    // reports; in this version a replayable token is a shell on this machine.
    const persist = vi.fn()
    const held = new BrowserStore({ now: () => 1_000, hashToken: () => 'opaque-digest', persist })
    held.issue({ browserId: 'b1', token: 'the-real-token', label: 'iPhone' })
    const table = persist.mock.calls[0]?.[0] as BrowserTable
    expect(table['b1']?.tokenHash).toBe('opaque-digest')
    expect(JSON.stringify(table)).not.toContain('the-real-token')
  })

  it('records an expiry from the lifetime, and none when it is zero', () => {
    const { held } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a', ttlMs: 500 })
    held.issue({ browserId: 'b2', token: 't2', label: 'b', ttlMs: 0 })
    expect(held.table()['b1']?.expiresAt).toBe(1_500)
    expect(held.table()['b2']?.expiresAt).toBeUndefined()
  })
})

describe('expiry', () => {
  it('stops resolving once the moment passes', () => {
    const { held, at } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a', ttlMs: 500 })
    at.now = 1_499
    expect(held.authenticate('t1')).toBeDefined()
    at.now = 1_500
    expect(held.authenticate('t1')).toBeUndefined()
  })

  it('keeps the row and marks it, rather than deleting it', () => {
    // A phone that simply vanished from the card, with nothing to say why it
    // stopped working, is a worse answer than a row with `expired` on it.
    const { held, at } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a', ttlMs: 500 })
    at.now = 2_000
    expect(held.list()).toEqual([expect.objectContaining({ browserId: 'b1', expired: true })])
  })
})

describe('sightings', () => {
  it('records the last seen time without touching the durable copy', () => {
    // A browser holding two WebSockets and polling assets must not rewrite a
    // settings file on every request.
    const { held, persist, at } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a' })
    persist.mockClear()
    at.now = 5_000
    held.authenticate('t1')
    expect(persist).not.toHaveBeenCalled()
    expect(held.list()[0]?.lastSeenAt).toBe(5_000)
  })
})

describe('revocation', () => {
  it('stops the token at once and mirrors the removal', () => {
    const { held, persist } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a' })
    persist.mockClear()
    expect(held.revoke('b1')).toBe(true)
    expect(held.authenticate('t1')).toBeUndefined()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('reports a miss rather than throwing, so two cards can race', () => {
    const { held } = store()
    expect(held.revoke('nobody')).toBe(false)
  })

  it('can clear everything at once', () => {
    const { held } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a' })
    held.issue({ browserId: 'b2', token: 't2', label: 'b' })
    expect(held.revokeAll()).toBe(2)
    expect(held.size).toBe(0)
    expect(held.authenticate('t1')).toBeUndefined()
  })
})

describe('adoption', () => {
  it('takes a stored table and resolves its tokens', () => {
    const { held } = store()
    held.load({ b1: { label: 'iPhone', tokenHash: 'hash:t1', signedInAt: 1, lastSeenAt: 1 } })
    expect(held.authenticate('t1')?.browserId).toBe('b1')
  })

  it('drops a second row claiming a hash already taken', () => {
    // Two ids answering to one token is a state no honest sequence produces,
    // and keeping the first is the only resolution that does not widen access.
    const { held } = store()
    held.load({
      b1: { label: 'a', tokenHash: 'hash:t1', signedInAt: 1, lastSeenAt: 1 },
      b2: { label: 'b', tokenHash: 'hash:t1', signedInAt: 1, lastSeenAt: 1 },
    })
    expect(held.size).toBe(1)
    expect(held.authenticate('t1')?.browserId).toBe('b1')
  })

  it('survives a row that is not a record at all', () => {
    const { held } = store()
    held.load({ b1: null as never, b2: { label: 'b', tokenHash: 'hash:t2', signedInAt: 1, lastSeenAt: 1 } })
    expect(held.size).toBe(1)
  })

  it('adopts nothing from an absent table', () => {
    const { held } = store()
    held.issue({ browserId: 'b1', token: 't1', label: 'a' })
    held.load(undefined)
    expect(held.size).toBe(0)
  })
})

describe('labelFromUserAgent', () => {
  it('names the hardware it can recognise', () => {
    expect(labelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')).toBe('iPhone')
    expect(labelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac')
    expect(labelFromUserAgent('Mozilla/5.0 (Linux; Android 14)')).toBe('Android')
  })

  it('has an answer for a request that carried none', () => {
    expect(labelFromUserAgent(undefined)).toBe('Browser')
  })
})

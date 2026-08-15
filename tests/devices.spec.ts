import { describe, expect, it, vi } from 'vitest'
import { DeviceStore, labelFromUserAgent, type DeviceTable } from '../src/devices.ts'
import { hashToken } from '../src/secrets.ts'

/** A store with a clock a spec moves and a hash a spec can read. */
function bench(persist?: (table: DeviceTable) => void) {
  const clock = { at: 1_000 }
  const store = new DeviceStore({
    now: () => clock.at,
    hashToken: (token) => `hash:${token}`,
    ...persist === undefined ? {} : { persist },
  })
  return { store, clock }
}

describe('issuing', () => {
  it('records a device and resolves its token', () => {
    const { store } = bench()
    const view = store.issue({ deviceId: 'd1', token: 'secret', label: 'iPhone', tier: 'drive' })
    expect(view).toEqual({
      deviceId: 'd1', label: 'iPhone', tier: 'drive', createdAt: 1_000, lastSeenAt: 1_000,
    })
    expect(store.authenticate('secret')?.deviceId).toBe('d1')
    expect(store.size).toBe(1)
  })

  it('stores a hash and never the token', () => {
    // The REAL hash, not this file's readable stand-in: the stand-in spells the
    // token out, so it would pass this assertion while proving nothing. This is
    // the one property worth testing against the function that actually ships.
    const store = new DeviceStore({ now: () => 1_000, hashToken })
    store.issue({ deviceId: 'd1', token: 'secret', label: 'iPhone', tier: 'drive' })
    expect(JSON.stringify(store.table())).not.toContain('secret')
    expect(store.table()['d1']?.tokenHash).toBe(hashToken('secret'))
    expect(store.authenticate('secret')?.deviceId).toBe('d1')
  })

  it('keeps the User-Agent when one was offered and omits the key when not', () => {
    const { store } = bench()
    store.issue({ deviceId: 'd1', token: 't1', label: 'A', tier: 'drive', userAgent: 'UA/1' })
    store.issue({ deviceId: 'd2', token: 't2', label: 'B', tier: 'drive' })
    expect(store.table()['d1']?.userAgent).toBe('UA/1')
    expect(store.table()['d2']).not.toHaveProperty('userAgent')
  })
})

describe('authenticating', () => {
  it('answers nothing to an unknown token', () => {
    const { store } = bench()
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    expect(store.authenticate('other')).toBeUndefined()
    expect(store.authenticate('')).toBeUndefined()
  })

  it('records the sighting in memory', () => {
    const { store, clock } = bench()
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    clock.at = 9_000
    store.authenticate('secret')
    expect(store.list()[0]?.lastSeenAt).toBe(9_000)
  })

  it('stops the moment a device is revoked', () => {
    const { store } = bench()
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    expect(store.revoke('d1')).toBe(true)
    expect(store.authenticate('secret')).toBeUndefined()
    expect(store.revoke('d1')).toBe(false)
  })
})

describe('the durable mirror', () => {
  it('is written on a structural change', () => {
    const persist = vi.fn()
    const { store } = bench(persist)
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    expect(persist).toHaveBeenCalledTimes(1)
    store.rename('d1', 'B')
    expect(persist).toHaveBeenCalledTimes(2)
    store.revoke('d1')
    expect(persist).toHaveBeenCalledTimes(3)
    expect(persist.mock.calls.at(-1)?.[0]).toEqual({})
  })

  it('is NOT written on a mere sighting', () => {
    // A phone holding a stream open would otherwise rewrite a settings file
    // every few seconds.
    const persist = vi.fn()
    const { store } = bench(persist)
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    persist.mockClear()
    store.authenticate('secret')
    store.authenticate('secret')
    expect(persist).not.toHaveBeenCalled()
  })

  it('can be attached after construction, because the settings scope arrives later', () => {
    const persist = vi.fn()
    const { store } = bench()
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    expect(persist).not.toHaveBeenCalled()
    store.setPersist(persist)
    store.rename('d1', 'B')
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

describe('adopting a stored table', () => {
  it('resolves tokens against what was loaded', () => {
    const { store } = bench()
    store.load({
      d1: { label: 'A', tokenHash: 'hash:secret', tier: 'observe', createdAt: 1, lastSeenAt: 2 },
    })
    expect(store.authenticate('secret')?.record.tier).toBe('observe')
  })

  it('replaces rather than merges', () => {
    const { store } = bench()
    store.issue({ deviceId: 'd1', token: 'secret', label: 'A', tier: 'drive' })
    store.load({
      d2: { label: 'B', tokenHash: 'hash:other', tier: 'drive', createdAt: 1, lastSeenAt: 2 },
    })
    expect(store.authenticate('secret')).toBeUndefined()
    expect(store.authenticate('other')?.deviceId).toBe('d2')
  })

  it('drops a second id claiming a hash already taken', () => {
    // Two ids answering to one token is a state no honest sequence produces;
    // keeping the first is the only resolution that does not widen access.
    const { store } = bench()
    store.load({
      d1: { label: 'A', tokenHash: 'hash:secret', tier: 'observe', createdAt: 1, lastSeenAt: 2 },
      d2: { label: 'B', tokenHash: 'hash:secret', tier: 'full', createdAt: 3, lastSeenAt: 4 },
    })
    expect(store.size).toBe(1)
    expect(store.authenticate('secret')?.deviceId).toBe('d1')
  })

  it('adopts nothing from an absent table', () => {
    const { store } = bench()
    store.load(undefined)
    expect(store.size).toBe(0)
  })
})

describe('labelFromUserAgent', () => {
  it('names the common phones and desktops', () => {
    expect(labelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('iPhone')
    expect(labelFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('iPad')
    expect(labelFromUserAgent('Mozilla/5.0 (Linux; Android 14)')).toBe('Android')
    expect(labelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('Mac')
    expect(labelFromUserAgent('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows')
    expect(labelFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux')
  })

  it('reads Android before the Linux it also claims', () => {
    expect(labelFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('Android')
  })

  it('falls back rather than inventing a name', () => {
    expect(labelFromUserAgent(undefined)).toBe('Device')
    expect(labelFromUserAgent('')).toBe('Device')
    expect(labelFromUserAgent('curl/8.4.0')).toBe('Device')
  })
})

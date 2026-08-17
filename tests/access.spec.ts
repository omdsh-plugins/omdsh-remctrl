import { describe, expect, it, vi } from 'vitest'
import { ACCESS_LIMIT, COALESCE_MS } from '../src/contract.ts'
import { AccessJournal, ANNOUNCE_AFTER, FLUSH_INTERVAL_MS } from '../src/access.ts'

/** A journal on a clock a spec can move. */
function bench() {
  const at = { now: 1_000 }
  const persist = vi.fn()
  const announce = vi.fn()
  return { held: new AccessJournal({ now: () => at.now, persist, announce }), at, persist, announce }
}

describe('grants', () => {
  it('records who, from where, and which browser it made', () => {
    const { held } = bench()
    held.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b1' })
    expect(held.view().events).toEqual([
      { at: 1_000, granted: true, label: 'iPhone', address: '203.0.113.9', attempts: 1, browserId: 'b1' },
    ])
  })

  it('says every one of them out loud', () => {
    // Somebody who did not just sign in a phone needs to see this at the moment
    // it happens, and a second line means a second device.
    const { held, announce } = bench()
    held.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b1' })
    held.granted({ label: 'Mac', address: '198.51.100.4', browserId: 'b2' })
    expect(announce).toHaveBeenCalledTimes(2)
    expect(announce.mock.calls[0]?.[0]).toContain('iPhone')
    expect(announce.mock.calls[0]?.[0]).toContain('203.0.113.9')
  })

  it('reaches the durable copy at once', () => {
    const { held, persist } = bench()
    held.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b1' })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('never coalesces with anything', () => {
    const { held } = bench()
    held.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b1' })
    held.granted({ label: 'iPhone', address: '203.0.113.9', browserId: 'b2' })
    expect(held.size).toBe(2)
  })
})

describe('refusals', () => {
  it('fold into one row per address, with a count', () => {
    // A machine grinding at the passcode is throttled to six a minute, which is
    // still enough to push fifty real events out of a fifty-event log inside
    // ten minutes. The noisy case must not be able to erase the quiet one.
    const { held, at } = bench()
    for (let round = 0; round < 20; round += 1) {
      at.now += 1_000
      held.refused({ label: 'Browser', address: '203.0.113.9' })
    }
    expect(held.size).toBe(1)
    expect(held.view().events[0]).toMatchObject({ granted: false, attempts: 20 })
  })

  it('carry the LAST attempt as their time', () => {
    const { held, at } = bench()
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    at.now = 5_000
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    expect(held.view().events[0]?.at).toBe(5_000)
  })

  it('start a new row once the window has passed', () => {
    const { held, at } = bench()
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    at.now += COALESCE_MS + 1
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    expect(held.size).toBe(2)
  })

  it('start a new row for a different address', () => {
    const { held } = bench()
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    held.refused({ label: 'Browser', address: '198.51.100.4' })
    expect(held.size).toBe(2)
  })

  it('do not fold into a row that is no longer the head', () => {
    // Folding into an older row would reorder the log, and a log that reorders
    // itself is one nobody can read.
    const { held } = bench()
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    held.granted({ label: 'iPhone', address: '198.51.100.4', browserId: 'b1' })
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    expect(held.size).toBe(3)
  })

  it('say nothing until it stops looking like a typo, then say it once', () => {
    const { held, announce } = bench()
    for (let round = 0; round < ANNOUNCE_AFTER - 1; round += 1) {
      held.refused({ label: 'Browser', address: '203.0.113.9' })
    }
    expect(announce).not.toHaveBeenCalled()
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    expect(announce).toHaveBeenCalledTimes(1)
    for (let round = 0; round < 50; round += 1) {
      held.refused({ label: 'Browser', address: '203.0.113.9' })
    }
    // However long they keep at it. The count on the card carries the rest.
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it('rate-limit the durable write on a coalesced increment', () => {
    // Otherwise a sustained probe would rewrite a YAML file six times a minute
    // for as long as it kept knocking.
    const { held, persist, at } = bench()
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    expect(persist).toHaveBeenCalledTimes(1)
    for (let round = 0; round < 30; round += 1) {
      at.now += 1_000
      held.refused({ label: 'Browser', address: '203.0.113.9' })
    }
    // 30 seconds of attempts, one flush interval.
    expect(persist.mock.calls.length).toBeLessThanOrEqual(2)
    at.now += FLUSH_INTERVAL_MS
    held.refused({ label: 'Browser', address: '203.0.113.9' })
    expect(persist.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the bound', () => {
  it('keeps the newest and drops the rest', () => {
    const { held, at } = bench()
    for (let index = 0; index < ACCESS_LIMIT + 10; index += 1) {
      at.now += 1_000
      held.granted({ label: `d${String(index)}`, address: '203.0.113.9', browserId: `b${String(index)}` })
    }
    expect(held.size).toBe(ACCESS_LIMIT)
    expect(held.view().events[0]?.label).toBe(`d${String(ACCESS_LIMIT + 9)}`)
  })
})

describe('clearing', () => {
  it('empties the log and leaves ONE row saying so', () => {
    // Anyone who can sign in can clear this log, so the question is not whether
    // an intruder can erase their tracks but whether the erasure is visible.
    const { held } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    held.refused({ label: 'b', address: 'y' })
    const view = held.clear()
    expect(view.events).toHaveLength(1)
    expect(view.events[0]?.cleared).toBe(2)
  })

  it('counts as read, because the person clearing it is the person looking', () => {
    const { held } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    expect(held.clear().unseen).toBe(0)
  })

  it('leaves nothing at all when there was nothing to clear', () => {
    const { held } = bench()
    expect(held.clear().events).toEqual([])
  })

  it('reaches the durable copy at once', () => {
    const { held, persist } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    persist.mockClear()
    held.clear()
    expect(persist).toHaveBeenCalledTimes(1)
    expect((persist.mock.calls[0]?.[0] as { events: unknown[] }).events).toHaveLength(1)
  })

  it('a clear of a cleared log leaves one mark, not a growing pile', () => {
    const { held, at } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    held.clear()
    at.now += 1_000
    held.granted({ label: 'b', address: 'y', browserId: 'b2' })
    const view = held.clear()
    expect(view.events).toHaveLength(1)
    expect(view.events[0]?.cleared).toBe(2)
  })
})

describe('unseen', () => {
  it('counts what arrived since the last acknowledgement', () => {
    const { held, at } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    at.now += 1_000
    held.acknowledge()
    expect(held.view().unseen).toBe(0)
    at.now += 1_000
    held.granted({ label: 'b', address: 'x', browserId: 'b2' })
    expect(held.view().unseen).toBe(1)
  })

  it('counts everything on a log nobody has read', () => {
    const { held, at } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    at.now += 1_000
    held.refused({ label: 'b', address: 'y' })
    expect(held.view().unseen).toBe(2)
  })
})

describe('adoption', () => {
  it('takes a stored log back, seen mark and all', () => {
    const { held } = bench()
    held.load({
      events: [{ at: 500, granted: true, label: 'iPhone', address: 'x', attempts: 1 }],
      seenAt: 400,
    })
    expect(held.view()).toEqual({
      events: [{ at: 500, granted: true, label: 'iPhone', address: 'x', attempts: 1 }],
      unseen: 1,
    })
  })

  it('survives a stored row that is not an event', () => {
    const { held } = bench()
    held.load({ events: [null as never, { at: 1, granted: false, label: 'a', address: 'x', attempts: 2 }], seenAt: 0 })
    expect(held.size).toBe(1)
  })

  it('fills in a count a older record did not have', () => {
    const { held } = bench()
    held.load({ events: [{ at: 1, granted: false, label: 'a', address: 'x' } as never], seenAt: 0 })
    expect(held.view().events[0]?.attempts).toBe(1)
  })

  it('adopts nothing from an absent table', () => {
    const { held } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    held.load(undefined)
    expect(held.size).toBe(0)
  })

  it('never hands out its own array', () => {
    const { held } = bench()
    held.granted({ label: 'a', address: 'x', browserId: 'b1' })
    const view = held.view()
    view.events[0]!.label = 'tampered'
    expect(held.view().events[0]?.label).toBe('a')
  })
})

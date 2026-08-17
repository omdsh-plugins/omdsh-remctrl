import { describe, expect, it } from 'vitest'
import { AUTH_RULE, SIGN_IN_RULE, Throttle } from '../src/throttle.ts'

/** A throttle on a clock a spec can move. */
function bench(rule = { capacity: 3, refillMs: 1_000, maxKeys: 8 }) {
  const at = { now: 0 }
  return { held: new Throttle(rule, () => at.now), at, rule }
}

describe('spending', () => {
  it('admits a burst up to the capacity, then refuses', () => {
    const { held, rule } = bench()
    for (let round = 0; round < rule.capacity; round += 1) expect(held.take('a').ok).toBe(true)
    expect(held.take('a').ok).toBe(false)
  })

  it('says how long until one token is back', () => {
    const { held } = bench()
    for (let round = 0; round < 3; round += 1) held.take('a')
    const verdict = held.take('a')
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.retryAfterMs).toBe(1_000)
  })

  it('refills continuously, so the honest phone never notices', () => {
    // A fixed window's edge is a free burst: 3-per-second admits six in the two
    // milliseconds either side of the boundary.
    const { held, at } = bench()
    for (let round = 0; round < 3; round += 1) held.take('a')
    at.now = 500
    expect(held.take('a').ok).toBe(false)
    at.now = 1_000
    expect(held.take('a').ok).toBe(true)
  })

  it('keys separately, so one address cannot spend what another was given', () => {
    const { held } = bench()
    for (let round = 0; round < 3; round += 1) held.take('a')
    expect(held.take('b').ok).toBe(true)
  })
})

describe('forgiving', () => {
  it('gives a key its budget back after a legitimate request', () => {
    const { held } = bench()
    held.take('a')
    held.take('a')
    held.forgive('a')
    expect(held.peek('a')).toBe(3)
  })
})

describe('the key bound', () => {
  it('never tracks more keys than the rule allows', () => {
    // The key is attacker-chosen on a public gate, so an unbounded map is a
    // memory-exhaustion primitive handed out with the door.
    const { held, rule } = bench()
    for (let index = 0; index < rule.maxKeys * 4; index += 1) {
      held.take(`key-${String(index)}`)
      held.take(`key-${String(index)}`)
    }
    expect(held.size).toBeLessThanOrEqual(rule.maxKeys)
  })

  it('evicts the FULLEST buckets, so a drained one is not handed a fresh budget', () => {
    const { held, rule } = bench()
    // Drain one key hard, then flood the map.
    for (let round = 0; round < rule.capacity; round += 1) held.take('drained')
    for (let index = 0; index < rule.maxKeys * 2; index += 1) held.take(`filler-${String(index)}`)
    expect(held.take('drained').ok).toBe(false)
  })

  it('forgets a bucket that is back at capacity, so the map shrinks on its own', () => {
    const { held, at } = bench()
    held.take('a')
    at.now = 10_000
    held.peek('a')
    expect(held.size).toBe(0)
  })
})

describe('clearing', () => {
  it('drops every bucket, for when the door rebinds', () => {
    const { held } = bench()
    for (let round = 0; round < 3; round += 1) held.take('a')
    held.clear()
    expect(held.take('a').ok).toBe(true)
  })
})

describe('the shipped rules', () => {
  it('gives sign-in six tries a minute, which is what makes ten characters enough', () => {
    expect(SIGN_IN_RULE.capacity).toBe(6)
    expect(SIGN_IN_RULE.refillMs).toBe(60_000)
  })

  it('is looser on a cookie that does not resolve, and still bounded', () => {
    expect(AUTH_RULE.capacity).toBeGreaterThan(SIGN_IN_RULE.capacity)
    expect(AUTH_RULE.maxKeys).toBeGreaterThan(0)
  })
})

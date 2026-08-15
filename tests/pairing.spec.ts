import { describe, expect, it } from 'vitest'
import { constantTimeEquals, PairingCodes } from '../src/pairing.ts'

/** A codes object on a clock and a code source a spec controls completely. */
function bench(options: { codes?: string[]; ttlMs?: number; maxAttempts?: number } = {}) {
  const queue = [...options.codes ?? ['123456', '654321', '111111']]
  const clock = { at: 1_000 }
  const pairing = new PairingCodes({
    now: () => clock.at,
    mintCode: () => queue.shift() ?? '000000',
    get ttlMs() { return options.ttlMs ?? 60_000 },
    get maxAttempts() { return options.maxAttempts ?? 3 },
  })
  return { pairing, clock }
}

describe('minting', () => {
  it('hands back the code, its deadline, and its budget', () => {
    const { pairing } = bench({ ttlMs: 60_000, maxAttempts: 3 })
    expect(pairing.mint()).toEqual({ code: '123456', expiresAt: 61_000, remaining: 3 })
  })

  it('replaces the outstanding code rather than adding to it', () => {
    // Two live codes would be two independent guess budgets against one door.
    const { pairing } = bench()
    pairing.mint()
    pairing.mint()
    expect(pairing.redeem('123456')).toEqual({ kind: 'mismatch', remaining: 2 })
    expect(pairing.redeem('654321')).toEqual({ kind: 'ok' })
  })

  it('reads its budgets at mint time, so a settings change reaches the next code', () => {
    const options = { ttlMs: 60_000, maxAttempts: 3 }
    const clock = { at: 1_000 }
    const pairing = new PairingCodes({
      now: () => clock.at,
      mintCode: () => '123456',
      get ttlMs() { return options.ttlMs },
      get maxAttempts() { return options.maxAttempts },
    })
    expect(pairing.mint().expiresAt).toBe(61_000)
    options.ttlMs = 10_000
    expect(pairing.mint().expiresAt).toBe(11_000)
  })
})

describe('redeeming', () => {
  it('accepts the right code once and only once', () => {
    const { pairing } = bench()
    pairing.mint()
    expect(pairing.redeem('123456')).toEqual({ kind: 'ok' })
    // A code that survived its own redemption would let a second device in on
    // the same yes.
    expect(pairing.redeem('123456')).toEqual({ kind: 'no-code' })
  })

  it('reports no-code before anything has been minted', () => {
    const { pairing } = bench()
    expect(pairing.redeem('123456')).toEqual({ kind: 'no-code' })
  })

  it('expires exactly at the deadline, not after it', () => {
    const { pairing, clock } = bench({ ttlMs: 60_000 })
    pairing.mint()
    clock.at = 60_999
    expect(pairing.redeem('123456')).toEqual({ kind: 'ok' })

    const second = bench({ ttlMs: 60_000 })
    second.pairing.mint()
    second.clock.at = 61_000
    expect(second.pairing.redeem('123456')).toEqual({ kind: 'expired' })
    expect(second.pairing.redeem('123456')).toEqual({ kind: 'no-code' })
  })

  it('spends the budget on wrong guesses and burns the code at the end of it', () => {
    const { pairing } = bench({ maxAttempts: 3 })
    pairing.mint()
    expect(pairing.redeem('000000')).toEqual({ kind: 'mismatch', remaining: 2 })
    expect(pairing.redeem('000000')).toEqual({ kind: 'mismatch', remaining: 1 })
    expect(pairing.redeem('000000')).toEqual({ kind: 'locked' })
    // Burned, not merely exhausted: the right code no longer works either, so
    // a person has to mint another — which is the point of the budget.
    expect(pairing.redeem('123456')).toEqual({ kind: 'no-code' })
  })

  it('does not spend the budget on an expired code', () => {
    const { pairing, clock } = bench({ ttlMs: 1_000, maxAttempts: 3 })
    pairing.mint()
    clock.at = 5_000
    expect(pairing.redeem('000000')).toEqual({ kind: 'expired' })
  })
})

describe('peeking', () => {
  it('shows the outstanding code and its remaining budget', () => {
    const { pairing } = bench({ maxAttempts: 3 })
    pairing.mint()
    pairing.redeem('000000')
    expect(pairing.peek()).toEqual({ code: '123456', expiresAt: 61_000, remaining: 2 })
  })

  it('drops an expired code on its own, so a panel that polls sees it go', () => {
    const { pairing, clock } = bench({ ttlMs: 1_000 })
    pairing.mint()
    clock.at = 9_000
    expect(pairing.peek()).toBeUndefined()
    expect(pairing.redeem('123456')).toEqual({ kind: 'no-code' })
  })

  it('shows nothing after a clear', () => {
    const { pairing } = bench()
    pairing.mint()
    pairing.clear()
    expect(pairing.peek()).toBeUndefined()
  })
})

describe('constantTimeEquals', () => {
  it('agrees with ===', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true)
    expect(constantTimeEquals('123456', '123457')).toBe(false)
    expect(constantTimeEquals('123456', '023456')).toBe(false)
    expect(constantTimeEquals('', '')).toBe(true)
    expect(constantTimeEquals('12345', '123456')).toBe(false)
  })
})

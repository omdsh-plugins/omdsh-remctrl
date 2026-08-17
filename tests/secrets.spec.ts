import { describe, expect, it } from 'vitest'
import { PASSCODE_ALPHABET, PASSCODE_LENGTH } from '../src/contract.ts'
import {
  constantTimeEquals, hashToken, mintBrowserId, mintPasscode, mintToken, normalizePasscode,
} from '../src/secrets.ts'

describe('mintPasscode', () => {
  it('is the configured length, in the configured alphabet', () => {
    for (let round = 0; round < 50; round += 1) {
      const passcode = mintPasscode()
      expect(passcode).toHaveLength(PASSCODE_LENGTH)
      for (const character of passcode) expect(PASSCODE_ALPHABET).toContain(character)
    }
  })

  it('has no ambiguous glyph in its alphabet', () => {
    // I, L, O and U are the four a person mistypes off a screen; the whole
    // reason `normalizePasscode` can fold them is that none is ever minted.
    for (const character of 'ILOU') expect(PASSCODE_ALPHABET).not.toContain(character)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintPasscode()))
    expect(seen.size).toBe(200)
  })
})

describe('normalizePasscode', () => {
  it('folds the four lookalikes onto what a person meant', () => {
    expect(normalizePasscode('I')).toBe('1')
    expect(normalizePasscode('l')).toBe('1')
    expect(normalizePasscode('O')).toBe('0')
    expect(normalizePasscode('u')).toBe('V')
  })

  it('drops separators, so a passcode written with a dash still works', () => {
    expect(normalizePasscode('abc12-345 67')).toBe('ABC1234567')
  })

  it('is idempotent, so comparing two normalised values is safe', () => {
    const once = normalizePasscode('aI-b0')
    expect(normalizePasscode(once)).toBe(once)
  })
})

describe('constantTimeEquals', () => {
  it('is true for equal strings and false otherwise', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
  })

  it('does not throw on a length mismatch', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false)
    expect(constantTimeEquals('', 'a')).toBe(false)
  })
})

describe('tokens', () => {
  it('mints 256 bits, url-safe', () => {
    const token = mintToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('hashes to stable lowercase hex, and never back', () => {
    expect(hashToken('t')).toBe(hashToken('t'))
    expect(hashToken('t')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('t')).not.toContain('t')
  })

  it('mints distinct browser ids', () => {
    expect(mintBrowserId()).not.toBe(mintBrowserId())
  })
})

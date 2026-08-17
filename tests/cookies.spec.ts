import { describe, expect, it } from 'vitest'
import { COOKIE_NAME } from '../src/contract.ts'
import { readCookie, signInCookie, signOutCookie, stripCookie } from '../src/cookies.ts'

describe('readCookie', () => {
  it('finds the value among others', () => {
    expect(readCookie(`theme=dark; ${COOKIE_NAME}=abc; lang=zh`)).toBe('abc')
  })

  it('matches the name exactly, not by prefix', () => {
    expect(readCookie(`${COOKIE_NAME}_other=abc`)).toBeUndefined()
  })

  it('keeps a value that contains an equals sign', () => {
    expect(readCookie(`${COOKIE_NAME}=a=b=c`)).toBe('a=b=c')
  })

  it('un-escapes, and survives an escape that will not decode', () => {
    expect(readCookie(`${COOKIE_NAME}=a%20b`)).toBe('a b')
    expect(readCookie(`${COOKIE_NAME}=100%`)).toBe('100%')
  })

  it('has nothing to find in an absent header', () => {
    expect(readCookie(undefined)).toBeUndefined()
  })
})

describe('stripCookie', () => {
  it('takes our cookie out and leaves the rest', () => {
    expect(stripCookie(`theme=dark; ${COOKIE_NAME}=abc; lang=zh`)).toBe('theme=dark; lang=zh')
  })

  it('returns undefined when ours was the only one', () => {
    // So the caller deletes the header rather than sending an empty one.
    expect(stripCookie(`${COOKIE_NAME}=abc`)).toBeUndefined()
  })

  it('leaves a header with none of ours alone', () => {
    expect(stripCookie('theme=dark')).toBe('theme=dark')
  })
})

describe('signInCookie', () => {
  it('is HttpOnly, Lax, and path-wide', () => {
    const cookie = signInCookie('tok', { secure: true, maxAgeSeconds: 60 })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })

  it('is Secure under the tunnel and NOT under a direct bind', () => {
    // Secure on a plaintext origin means the browser never sends it back — a
    // sign-in that appears to work and silently does not.
    expect(signInCookie('tok', { secure: true, maxAgeSeconds: 60 })).toContain('Secure')
    expect(signInCookie('tok', { secure: false, maxAgeSeconds: 60 })).not.toContain('Secure')
  })

  it('writes a session cookie when the lifetime is forever-or-nothing', () => {
    expect(signInCookie('tok', { secure: true, maxAgeSeconds: 0 })).not.toContain('Max-Age')
  })

  it('escapes the value', () => {
    expect(signInCookie('a b', { secure: false, maxAgeSeconds: 0 })).toContain('a%20b')
  })
})

describe('signOutCookie', () => {
  it('expires immediately at the same path, so the browser matches it', () => {
    const cookie = signOutCookie({ secure: true, maxAgeSeconds: 0 })
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Secure')
  })
})

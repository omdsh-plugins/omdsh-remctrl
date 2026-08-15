import { describe, expect, it } from 'vitest'
import { TIER_ORDER, type Tier } from '../src/contract.ts'
import {
  allows, authorize, isTier, EXPOSED_DOMAINS, METHOD_TIER, NEVER_EXPOSED,
} from '../src/gate.ts'

describe('tier ordering', () => {
  it('admits everything at or below the granted tier', () => {
    expect(allows('observe', 'observe')).toBe(true)
    expect(allows('drive', 'respond')).toBe(true)
    expect(allows('full', 'drive')).toBe(true)
    expect(allows('observe', 'respond')).toBe(false)
    expect(allows('respond', 'drive')).toBe(false)
    expect(allows('drive', 'full')).toBe(false)
  })

  it('recognizes exactly the four tiers', () => {
    for (const tier of TIER_ORDER) expect(isTier(tier)).toBe(true)
    for (const value of ['admin', '', 'OBSERVE', undefined, 3, null]) {
      expect(isTier(value)).toBe(false)
    }
  })
})

describe('authorize', () => {
  it('allows a listed method at or below the device tier', () => {
    expect(authorize('drive', 'session.prompt')).toEqual({
      kind: 'allowed', method: 'session.prompt', tier: 'drive',
    })
  })

  it('refuses a listed method the device cannot afford', () => {
    expect(authorize('observe', 'session.cancel')).toEqual({
      kind: 'forbidden', method: 'session.cancel', granted: 'observe', required: 'respond',
    })
  })

  it('refuses an unlisted method even at the top tier', () => {
    // The allowlist is the whole policy: `full` is not an escape hatch.
    expect(authorize('full', 'settings.mutate')).toEqual({
      kind: 'unlisted', method: 'settings.mutate',
    })
    expect(authorize('full', 'session.somethingAddedNextRelease')).toEqual({
      kind: 'unlisted', method: 'session.somethingAddedNextRelease',
    })
  })

  it('puts stopping a run a tier below starting one', () => {
    // The design decision this table exists to encode: somebody trusted to
    // watch should be able to end a run going wrong without being trusted to
    // launch another.
    expect(METHOD_TIER['session.cancel']).toBe('respond')
    expect(METHOD_TIER['session.prompt']).toBe('drive')
    expect(allows('respond', METHOD_TIER['session.cancel'] as Tier)).toBe(true)
    expect(allows('respond', METHOD_TIER['session.prompt'] as Tier)).toBe(false)
  })
})

describe('the allowlist itself', () => {
  it('never names a configuration, credential, or host-side method', () => {
    for (const method of NEVER_EXPOSED) {
      expect(METHOD_TIER[method], method).toBeUndefined()
    }
  })

  it('names only domains this plugin exposes', () => {
    // Stronger than the list above, and the one that catches a future mistake:
    // a `host.*` row added by somebody who never read NEVER_EXPOSED still
    // fails here.
    for (const method of Object.keys(METHOD_TIER)) {
      const domain = method.slice(0, method.indexOf('.'))
      expect(EXPOSED_DOMAINS, method).toContain(domain)
    }
  })

  it('spells every method as one domain and one name', () => {
    for (const method of Object.keys(METHOD_TIER)) {
      expect(method.split('.'), method).toHaveLength(2)
    }
  })

  it('grades every row with a real tier', () => {
    for (const [method, tier] of Object.entries(METHOD_TIER)) {
      expect(isTier(tier), method).toBe(true)
    }
  })

  it('excludes the one host-side method wearing another domain name', () => {
    // `agentPreset.openDocument` opens a file on the host desktop, which is
    // `host.openPath` under a domain that is otherwise reachable.
    expect(METHOD_TIER['agentPreset.openDocument']).toBeUndefined()
    expect(METHOD_TIER['agentPreset.list']).toBe('observe')
  })
})

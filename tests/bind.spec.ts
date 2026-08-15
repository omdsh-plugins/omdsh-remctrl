import { describe, expect, it } from 'vitest'
import {
  isTailnetAddress, reachableUrls, resolveBind, tailnetAddresses,
  type InterfaceTable,
} from '../src/bind.ts'

/** An interface table shaped like `os.networkInterfaces()`. */
function table(entries: Record<string, Array<[string, string, boolean]>>): InterfaceTable {
  return Object.fromEntries(Object.entries(entries).map(([name, addresses]) => [
    name,
    addresses.map(([family, address, internal]) => ({ family, address, internal })),
  ]))
}

describe('isTailnetAddress', () => {
  it('accepts the whole of 100.64.0.0/10 and nothing beside it', () => {
    expect(isTailnetAddress('100.64.0.0')).toBe(true)
    expect(isTailnetAddress('100.101.5.7')).toBe(true)
    expect(isTailnetAddress('100.127.255.255')).toBe(true)
    // One below and one above the block: the two boundaries a hand-written
    // mask gets wrong.
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.0')).toBe(false)
  })

  it('refuses ordinary private and public addresses', () => {
    for (const address of ['192.168.1.20', '10.0.0.5', '172.16.3.1', '8.8.8.8', '127.0.0.1']) {
      expect(isTailnetAddress(address)).toBe(false)
    }
  })

  it('refuses anything that is not four plain decimal octets', () => {
    for (const address of [
      '100.64.0', '100.64.0.1.1', '100.64.0.256', '100.64.0.-1',
      ' 100.64.0.1', '100.64.0.1 ', '0x64.64.0.1', '100.64.0.1e0', '',
      // Leading zeros: `inet_aton` would read this as octal, so one address
      // would have two spellings and only one could match what the OS reports.
      '100.064.0.1',
    ]) {
      expect(isTailnetAddress(address), address).toBe(false)
    }
  })
})

describe('tailnetAddresses', () => {
  it('keeps external IPv4 addresses inside the block, in table order, once each', () => {
    const found = tailnetAddresses(table({
      lo0: [['IPv4', '127.0.0.1', true]],
      en0: [['IPv4', '192.168.1.20', false], ['IPv6', 'fe80::1', false]],
      utun4: [['IPv4', '100.101.5.7', false], ['IPv6', 'fd7a:115c::1', false]],
      utun5: [['IPv4', '100.101.5.7', false], ['IPv4', '100.90.1.2', false]],
    }))
    expect(found).toEqual(['100.101.5.7', '100.90.1.2'])
  })

  it('ignores an internal interface even when its address is in the block', () => {
    expect(tailnetAddresses(table({ lo0: [['IPv4', '100.64.0.1', true]] }))).toEqual([])
  })

  it('is empty when Tailscale is not up', () => {
    expect(tailnetAddresses(table({ en0: [['IPv4', '192.168.1.20', false]] }))).toEqual([])
  })

  it('tolerates an absent interface entry', () => {
    expect(tailnetAddresses({ en0: undefined })).toEqual([])
  })
})

describe('resolveBind', () => {
  const held = ['100.101.5.7']

  it('accepts loopback, spelled either way', () => {
    expect(resolveBind('127.0.0.1', [])).toEqual({ kind: 'loopback', host: '127.0.0.1' })
    expect(resolveBind('localhost', [])).toEqual({ kind: 'loopback', host: '127.0.0.1' })
  })

  it('accepts a tailnet address this machine holds', () => {
    expect(resolveBind('100.101.5.7', held)).toEqual({ kind: 'tailnet', host: '100.101.5.7' })
  })

  it('refuses every-interface binds', () => {
    for (const host of ['0.0.0.0', '::', '*']) {
      const decision = resolveBind(host, held)
      expect(decision.kind, host).toBe('refused')
    }
  })

  it('refuses a LAN address, which is the mistake this policy exists for', () => {
    const decision = resolveBind('192.168.1.20', held)
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    // The refusal has to say what WOULD work, or it is just a boot that
    // silently did not happen.
    expect(decision.message).toContain('100.101.5.7')
  })

  it('refuses a tailnet address belonging to some other machine', () => {
    const decision = resolveBind('100.90.1.2', held)
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(decision.message).toContain('not one this machine holds')
  })

  it('refuses a tailnet address when Tailscale is down, and says so', () => {
    const decision = resolveBind('100.101.5.7', [])
    expect(decision.kind).toBe('refused')
    if (decision.kind !== 'refused') return
    expect(decision.message).toContain('Tailscale does not appear to be up')
  })
})

describe('reachableUrls', () => {
  it('names the tailnet URL a phone can type', () => {
    expect(reachableUrls({ kind: 'tailnet', host: '100.101.5.7' }, 3081))
      .toEqual(['http://100.101.5.7:3081/'])
  })

  it('offers nothing for a loopback bind rather than guessing a proxy hostname', () => {
    expect(reachableUrls({ kind: 'loopback', host: '127.0.0.1' }, 3081)).toEqual([])
    expect(reachableUrls({ kind: 'refused', host: 'x', message: 'no' }, 3081)).toEqual([])
  })
})

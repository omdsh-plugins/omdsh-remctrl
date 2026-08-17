import { describe, expect, it } from 'vitest'
import { LOOPBACK } from '../src/contract.ts'
import {
  bracket, carrierFor, heldAddress, isTailnetAddress, localAddresses, reachableUrl, resolveBind,
  signInLink, tailnetAddresses, WILDCARD, type BindRequest,
} from '../src/bind.ts'

/** A laptop on a café network, on Tailscale, with a LAN address too. */
const HELD = ['127.0.0.1', '192.168.1.42', '100.101.102.103', 'fe80::1']

/** A request, with whatever the case is about. */
function request(over: Partial<BindRequest> = {}): BindRequest {
  return {
    enabled: true,
    carrier: 'tunnel',
    publicHost: '',
    allowInsecure: false,
    hasUpstream: true,
    available: HELD,
    ...over,
  }
}

describe('carrierFor', () => {
  it('takes an empty public host to mean "go and get me one"', () => {
    expect(carrierFor('')).toBe('tunnel')
    expect(carrierFor('   ')).toBe('tunnel')
  })

  it('takes anything else to mean this machine is reached at an address of its own', () => {
    expect(carrierFor('121.43.252.12')).toBe('direct')
    expect(carrierFor('harness.example.com')).toBe('direct')
  })
})

describe('localAddresses', () => {
  it('flattens every interface, loopback included', () => {
    // Loopback is included deliberately: somebody who writes `127.0.0.1` into
    // publicHost is asking for a loopback bind, and refusing to match it would
    // silently give them every interface instead.
    expect(localAddresses({
      lo0: [{ address: '127.0.0.1' }],
      en0: [{ address: '192.168.1.42' }, { address: 'fe80::1%en0' }],
    })).toEqual(['127.0.0.1', '192.168.1.42', 'fe80::1'])
  })

  it('deduplicates, and drops what does not normalize', () => {
    expect(localAddresses({
      a: [{ address: '10.0.0.1' }],
      b: [{ address: '10.0.0.1' }, { address: '' }],
      c: undefined,
    })).toEqual(['10.0.0.1'])
  })
})

describe('isTailnetAddress', () => {
  it('is the whole of 100.64.0.0/10 and nothing either side', () => {
    expect(isTailnetAddress('100.64.0.0')).toBe(true)
    expect(isTailnetAddress('100.101.102.103')).toBe(true)
    expect(isTailnetAddress('100.127.255.255')).toBe(true)
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.1')).toBe(false)
    expect(isTailnetAddress('101.64.0.1')).toBe(false)
  })

  it('is false for anything that is not an IPv4 literal', () => {
    expect(isTailnetAddress('example.com')).toBe(false)
    expect(isTailnetAddress('fe80::1')).toBe(false)
    expect(isTailnetAddress('')).toBe(false)
  })

  it('picks the tailnet addresses out of a machine\'s list', () => {
    expect(tailnetAddresses(HELD)).toEqual(['100.101.102.103'])
  })
})

describe('heldAddress', () => {
  it('finds the address when this machine holds it', () => {
    expect(heldAddress('100.101.102.103', HELD)).toBe('100.101.102.103')
  })

  it('finds nothing for an address this machine does not hold', () => {
    // A cloud VM's public address belongs to the provider's NAT.
    expect(heldAddress('121.43.252.12', HELD)).toBeUndefined()
  })

  it('finds nothing for a NAME, which is the right answer for one', () => {
    // Somebody who writes a hostname has a DNS record pointing at a public
    // address, and a public address is exactly the case that binds the
    // wildcard. Resolving it here would also be I/O in a decidable function.
    expect(heldAddress('harness.example.com', HELD)).toBeUndefined()
  })

  it('matches through normalization, so brackets and case do not decide', () => {
    expect(heldAddress('[FE80::1]', HELD)).toBe('fe80::1')
  })
})

describe('resolveBind, under the tunnel', () => {
  it('binds loopback, because cloudflared is the only client', () => {
    expect(resolveBind(request())).toEqual({
      kind: 'ok', host: LOOPBACK, carrier: 'tunnel', scope: 'loopback',
    })
  })

  it('refuses while switched off, which is the default', () => {
    const decision = resolveBind(request({ enabled: false }))
    if (decision.kind !== 'refused') throw new Error('unreachable')
    expect(decision.message).toMatch(/switched off/)
  })

  it('refuses with nothing to forward, and says why', () => {
    const decision = resolveBind(request({ hasUpstream: false }))
    if (decision.kind !== 'refused') throw new Error('unreachable')
    expect(decision.message).toMatch(/no web interface/)
  })

  it('checks the switch before anything else', () => {
    const decision = resolveBind(request({ enabled: false, carrier: 'direct', publicHost: '1.2.3.4' }))
    if (decision.kind !== 'refused') throw new Error('unreachable')
    expect(decision.message).toMatch(/switched off/)
  })
})

describe('resolveBind, on an address this machine HOLDS', () => {
  it('binds a tailnet address exactly, and needs no acknowledgement', () => {
    // The whole point: binding the wildcard for a tailnet address would put a
    // plaintext port on every OTHER network the laptop is on as well.
    expect(resolveBind(request({ carrier: 'direct', publicHost: '100.101.102.103' }))).toEqual({
      kind: 'ok', host: '100.101.102.103', carrier: 'direct', scope: 'tailnet',
    })
  })

  it('still refuses a LAN address without the acknowledgement', () => {
    // A café Wi-Fi is a network you do not control, and 192.168.x is what you
    // hold on one.
    const decision = resolveBind(request({ carrier: 'direct', publicHost: '192.168.1.42' }))
    if (decision.kind !== 'refused') throw new Error('unreachable')
    expect(decision.message).toMatch(/not a tailnet address/)
  })

  it('binds a LAN address exactly once it is acknowledged', () => {
    expect(resolveBind(request({ carrier: 'direct', publicHost: '192.168.1.42', allowInsecure: true }))).toEqual({
      kind: 'ok', host: '192.168.1.42', carrier: 'direct', scope: 'wide',
    })
  })

  it('binds loopback when loopback is what was asked for, with no acknowledgement', () => {
    expect(resolveBind(request({ carrier: 'direct', publicHost: '127.0.0.1' }))).toEqual({
      kind: 'ok', host: '127.0.0.1', carrier: 'direct', scope: 'loopback',
    })
  })
})

describe('resolveBind, on an address this machine does NOT hold', () => {
  it('REFUSES without the acknowledgement, and says what it would do', () => {
    const decision = resolveBind(request({ carrier: 'direct', publicHost: '121.43.252.12' }))
    if (decision.kind !== 'refused') throw new Error('unreachable')
    expect(decision.message).toMatch(/every interface/)
    expect(decision.message).toMatch(/in the clear/)
  })

  it('binds every interface once it is acknowledged, not the literal', () => {
    // On a cloud VM the public address belongs to the provider's NAT and is on
    // no local interface, so binding it verbatim fails with EADDRNOTAVAIL on
    // precisely the machines this carrier exists for.
    expect(resolveBind(request({
      carrier: 'direct', publicHost: '121.43.252.12', allowInsecure: true,
    }))).toEqual({ kind: 'ok', host: WILDCARD, carrier: 'direct', scope: 'wide' })
  })

  it('treats a hostname the same way, because a hostname means a public address', () => {
    expect(resolveBind(request({
      carrier: 'direct', publicHost: 'harness.example.com', allowInsecure: true,
    }))).toMatchObject({ host: WILDCARD, scope: 'wide' })
  })

  it('does not accidentally admit a tailnet LITERAL this machine has stopped holding', () => {
    // Tailscale down, address gone: the configuration still says 100.x, and
    // binding the wildcard for it without an acknowledgement would be the exact
    // failure this rule exists to prevent.
    const decision = resolveBind(request({
      carrier: 'direct', publicHost: '100.101.102.103', available: ['192.168.1.42'],
    }))
    expect(decision.kind).toBe('refused')
  })
})

describe('reachableUrl', () => {
  const tunnelled = { kind: 'ok', host: LOOPBACK, carrier: 'tunnel', scope: 'loopback' } as const

  it('is the tunnel\'s own URL under the tunnel', () => {
    expect(reachableUrl({
      decision: tunnelled, publicHost: '', port: 3081, tunnelUrl: 'https://x.trycloudflare.com',
    })).toBe('https://x.trycloudflare.com')
  })

  it('is empty while the tunnel has not answered yet', () => {
    expect(reachableUrl({ decision: tunnelled, publicHost: '', port: 3081 })).toBe('')
  })

  it('is the host that was CONFIGURED, not the address that was bound', () => {
    // They differ on a cloud VM, and the configured one is the one people type.
    expect(reachableUrl({
      decision: { kind: 'ok', host: WILDCARD, carrier: 'direct', scope: 'wide' },
      publicHost: '121.43.252.12',
      port: 7860,
    })).toBe('http://121.43.252.12:7860')
  })

  it('offers nothing for a bind that was refused', () => {
    expect(reachableUrl({
      decision: { kind: 'refused', carrier: 'direct', message: 'no' },
      publicHost: '121.43.252.12',
      port: 7860,
      tunnelUrl: 'https://x.trycloudflare.com',
    })).toBe('')
  })

  it('brackets an IPv6 literal so the colons are not read as a port', () => {
    expect(reachableUrl({
      decision: { kind: 'ok', host: WILDCARD, carrier: 'direct', scope: 'wide' },
      publicHost: '2001:db8::1',
      port: 3081,
    })).toBe('http://[2001:db8::1]:3081')
  })
})

describe('signInLink', () => {
  it('puts the passcode on the URL', () => {
    expect(signInLink('https://x.trycloudflare.com', 'ABC123', 'k'))
      .toBe('https://x.trycloudflare.com/?k=ABC123')
  })

  it('is empty without a URL or without a passcode', () => {
    expect(signInLink('', 'ABC123', 'k')).toBe('')
    expect(signInLink('https://x.trycloudflare.com', '', 'k')).toBe('')
  })

  it('does not throw on a URL that will not parse', () => {
    expect(signInLink('not a url', 'ABC123', 'k')).toBe('')
  })
})

describe('bracket', () => {
  it('leaves a name or an IPv4 literal alone', () => {
    expect(bracket('example.com')).toBe('example.com')
    expect(bracket('10.0.0.1')).toBe('10.0.0.1')
  })

  it('does not double-bracket', () => {
    expect(bracket('[::1]')).toBe('[::1]')
  })
})

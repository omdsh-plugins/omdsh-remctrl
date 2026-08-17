import { describe, expect, it } from 'vitest'
import {
  checkTransport, clientAddress, headerList, normalizeAddress, proxyTrustFor, requestProto,
  NO_PROXY, type RequestFacts,
} from '../src/forward.ts'

/** A request, with whatever headers the case is about. */
function facts(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = '127.0.0.1',
): RequestFacts {
  return { headers, remoteAddress }
}

describe('proxyTrustFor', () => {
  it('believes exactly one hop under the tunnel', () => {
    // cloudflared is one process, and it is the one this plugin spawned.
    expect(proxyTrustFor('tunnel')).toEqual({ enabled: true, hops: 1 })
  })

  it('believes nothing under a direct bind', () => {
    // There the socket peer IS the client, and every x-forwarded-* header on
    // the request was written by that client.
    expect(proxyTrustFor('direct')).toEqual(NO_PROXY)
  })
})

describe('clientAddress', () => {
  it('is the socket peer with no proxy declared', () => {
    expect(clientAddress(facts({ 'x-forwarded-for': '1.2.3.4' }, '203.0.113.9'), NO_PROXY))
      .toEqual({ address: '203.0.113.9', forwarded: false, short: false })
  })

  it('counts in from the RIGHT of the chain', () => {
    // The header grows left to right, so the leftmost entry is whatever the
    // first client claimed. One declared hop means the last entry is ours.
    expect(clientAddress(facts({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }), { enabled: true, hops: 1 }).address)
      .toBe('203.0.113.7')
  })

  it('reports a chain shorter than the declared hops rather than trusting it', () => {
    const verdict = clientAddress(facts({ 'x-forwarded-for': '9.9.9.9' }), { enabled: true, hops: 2 })
    expect(verdict.short).toBe(true)
  })

  it('reads x-real-ip only when there is no chain', () => {
    expect(clientAddress(facts({ 'x-real-ip': '203.0.113.5' }), { enabled: true, hops: 1 }).address)
      .toBe('203.0.113.5')
  })

  it('flattens a repeated header the way RFC 7230 says to', () => {
    expect(headerList(facts({ 'x-forwarded-for': ['1.1.1.1, 2.2.2.2', '3.3.3.3'] }), 'x-forwarded-for'))
      .toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3'])
  })
})

describe('requestProto', () => {
  it('reads x-forwarded-proto from the LEFT', () => {
    // With two proxies, `https, http` means the client spoke https to the
    // outermost — and that is the fact worth knowing.
    expect(requestProto(facts({ 'x-forwarded-proto': 'https, http' }), { enabled: true, hops: 1 }))
      .toBe('https')
  })

  it('understands RFC 7239 Forwarded as a fallback', () => {
    expect(requestProto(facts({ forwarded: 'for=1.2.3.4;proto=https' }), { enabled: true, hops: 1 }))
      .toBe('https')
  })

  it('says nothing when nothing said', () => {
    expect(requestProto(facts({}), { enabled: true, hops: 1 })).toBeUndefined()
  })

  it('ignores the header entirely with no proxy declared', () => {
    expect(requestProto(facts({ 'x-forwarded-proto': 'https' }), NO_PROXY)).toBe('http')
  })
})

describe('checkTransport', () => {
  const trust = { enabled: true, hops: 1 }

  it('passes an https request under the tunnel', () => {
    expect(checkTransport({
      carrier: 'tunnel', allowInsecure: false, trust, facts: facts({ 'x-forwarded-proto': 'https' }),
    })).toEqual({ kind: 'ok' })
  })

  it('refuses a plaintext one, and says the tunnel must set the header', () => {
    const verdict = checkTransport({
      carrier: 'tunnel', allowInsecure: false, trust, facts: facts({ 'x-forwarded-proto': 'http' }),
    })
    expect(verdict.kind).toBe('refused')
  })

  it('refuses when nothing said, naming the missing header', () => {
    const verdict = checkTransport({ carrier: 'tunnel', allowInsecure: false, trust, facts: facts({}) })
    if (verdict.kind !== 'refused') throw new Error('unreachable')
    expect(verdict.message).toMatch(/x-forwarded-proto/)
  })

  it('has nothing to check under a direct bind, which is acknowledged plaintext', () => {
    expect(checkTransport({
      carrier: 'direct', allowInsecure: true, trust: NO_PROXY, facts: facts({}),
    })).toEqual({ kind: 'ok' })
  })

  it('can be waived under the tunnel too, for somebody terminating TLS themselves', () => {
    expect(checkTransport({
      carrier: 'tunnel', allowInsecure: true, trust, facts: facts({ 'x-forwarded-proto': 'http' }),
    })).toEqual({ kind: 'ok' })
  })
})

describe('normalizeAddress', () => {
  it('unwraps an IPv4-mapped IPv6 peer', () => {
    expect(normalizeAddress('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })

  it('drops a port from either spelling', () => {
    expect(normalizeAddress('203.0.113.7:5432')).toBe('203.0.113.7')
    expect(normalizeAddress('[2001:db8::1]:5432')).toBe('2001:db8::1')
  })

  it('drops a zone id, which names an interface rather than a party', () => {
    expect(normalizeAddress('fe80::1%en0')).toBe('fe80::1')
  })

  it('has one answer for nothing at all, so one bucket serves it', () => {
    expect(normalizeAddress('')).toBe('unknown')
  })
})

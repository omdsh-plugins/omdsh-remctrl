import { describe, expect, it } from 'vitest'
import { GATE_ROUTES } from '../src/contract.ts'
import { checkProvenance, decide, isNavigation, splitUrl, withoutKey } from '../src/gate.ts'
import { NO_PROXY, type RequestFacts } from '../src/forward.ts'

/** A request, with whatever headers the case is about. */
function facts(headers: Record<string, string | string[] | undefined> = {}): RequestFacts {
  return { headers, remoteAddress: '203.0.113.9' }
}

/** The tunnel's trust: one hop, forwarded headers believed. */
const TUNNELED = { enabled: true, hops: 1 }

/** A browser navigating over the tunnel, which is the shape most cases start from. */
function navigation(extra: Record<string, string> = {}) {
  return facts({
    'host': 'x.trycloudflare.com',
    'x-forwarded-proto': 'https',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    ...extra,
  })
}

/** The gate's input, with the tunnel's answers and a store that says no. */
function input(over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] {
  return {
    facts: navigation(),
    method: 'GET',
    url: '/',
    carrier: 'tunnel',
    allowInsecure: false,
    trust: TUNNELED,
    resolve: () => undefined,
    ...over,
  }
}

describe('the transport gate', () => {
  it('refuses a tunnelled request that did not arrive over https', () => {
    const verdict = decide(input({
      facts: facts({ host: 'x.trycloudflare.com', 'x-forwarded-proto': 'http', 'sec-fetch-mode': 'navigate' }),
    }))
    expect(verdict).toMatchObject({ kind: 'refused', status: 421 })
  })

  it('refuses when nothing upstream said what scheme was used', () => {
    const verdict = decide(input({ facts: facts({ host: 'x.trycloudflare.com', 'sec-fetch-mode': 'navigate' }) }))
    expect(verdict).toMatchObject({ kind: 'refused', status: 421 })
  })

  it('is asked BEFORE identity, so a plaintext request never reads a cookie', () => {
    const verdict = decide(input({
      facts: facts({
        'host': 'x.trycloudflare.com',
        'x-forwarded-proto': 'http',
        'sec-fetch-mode': 'navigate',
        'cookie': 'omdsh_remctrl=good',
      }),
      resolve: () => 'b1',
    }))
    expect(verdict.kind).toBe('refused')
  })

  it('does not apply to a direct bind, where there is no proxy to have lied', () => {
    const verdict = decide(input({
      carrier: 'direct',
      allowInsecure: true,
      trust: NO_PROXY,
      facts: facts({ host: '203.0.113.1:3081', 'sec-fetch-mode': 'navigate' }),
    }))
    expect(verdict.kind).not.toBe('refused')
  })
})

describe('the provenance gate', () => {
  it('lets any top-level navigation through, from anywhere', () => {
    // A QR in a photo, a link in a message and a bookmark all arrive
    // cross-site. A navigation cannot read the response cross-origin, and
    // SameSite=Lax is what decides whether the cookie rides.
    expect(checkProvenance(
      facts({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site', 'host': 'x.example' }),
      'https',
    )).toBeUndefined()
  })

  it('refuses a cross-site request that is NOT a navigation', () => {
    expect(checkProvenance(
      facts({ 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'host': 'x.example' }),
      'https',
    )).toMatch(/another site/)
  })

  it('refuses an Origin that is not the one this gate answers for', () => {
    expect(checkProvenance(
      facts({ 'sec-fetch-mode': 'cors', 'origin': 'https://evil.example', 'host': 'x.example' }),
      'https',
    )).toMatch(/evil\.example/)
  })

  it('accepts an Origin that matches, through URL normalisation', () => {
    expect(checkProvenance(
      facts({ 'sec-fetch-mode': 'cors', 'origin': 'https://X.Example:443', 'host': 'x.example' }),
      'https',
    )).toBeUndefined()
  })

  it('refuses the opaque origin a sandboxed frame sends', () => {
    expect(checkProvenance(
      facts({ 'sec-fetch-mode': 'cors', 'origin': 'null', 'host': 'x.example' }),
      'https',
    )).toMatch(/opaque/)
  })

  it('allows a request with no Origin at all, which is every non-browser client', () => {
    expect(checkProvenance(facts({ host: 'x.example' }), 'https')).toBeUndefined()
  })

  it('reads the scheme it was told, so an https Origin matches an https request', () => {
    // The socket is plaintext under the tunnel. Comparing against `http://`
    // would refuse every request the app makes.
    expect(checkProvenance(
      facts({ 'sec-fetch-mode': 'cors', 'origin': 'https://x.example', 'host': 'x.example' }),
      'https',
    )).toBeUndefined()
  })
})

describe('the identity gate', () => {
  it('forwards a request whose cookie resolves', () => {
    expect(decide(input({
      facts: navigation({ cookie: 'omdsh_remctrl=good' }),
      resolve: token => (token === 'good' ? 'b1' : undefined),
    }))).toEqual({ kind: 'forward', browserId: 'b1' })
  })

  it('shows the form to a navigation with no cookie', () => {
    expect(decide(input({ url: '/sessions/abc' })))
      .toEqual({ kind: 'sign-in-page', next: '/sessions/abc' })
  })

  it('answers 401 to a fetch with no cookie, rather than a page', () => {
    // An app that asked for JSON and got HTML back reports a parse error, which
    // is a worse thing to debug than a status it can read.
    expect(decide(input({
      method: 'POST',
      url: '/api/sessions/list',
      facts: facts({
        'host': 'x.trycloudflare.com',
        'x-forwarded-proto': 'https',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'origin': 'https://x.trycloudflare.com',
      }),
    }))).toEqual({ kind: 'unauthorized' })
  })

  it('takes a passcode off the query on a navigation', () => {
    expect(decide(input({ url: '/?k=ABC123' })))
      .toEqual({ kind: 'try-key', key: 'ABC123', next: '/' })
  })

  it('keeps the rest of the query when it strips the passcode', () => {
    expect(decide(input({ url: '/s/1?tab=diff&k=ABC123' })))
      .toEqual({ kind: 'try-key', key: 'ABC123', next: '/s/1?tab=diff' })
  })

  it('will NOT take a passcode off a subresource request', () => {
    // Otherwise any page anywhere could sign a visitor in by loading
    // `<img src="https://…/?k=guess">` a few thousand times, at a rate the
    // throttle would have to catch rather than the shape of the request.
    expect(decide(input({
      url: '/app.js?k=ABC123',
      facts: facts({
        'host': 'x.trycloudflare.com',
        'x-forwarded-proto': 'https',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'same-origin',
      }),
    }))).toEqual({ kind: 'unauthorized' })
  })

  it('sends an already-signed-in browser to the URL without the passcode on it', () => {
    expect(decide(input({
      url: '/?k=ABC123',
      facts: navigation({ cookie: 'omdsh_remctrl=good' }),
      resolve: () => 'b1',
    }))).toEqual({ kind: 'strip-key', next: '/' })
  })

  it('routes the gate\'s own paths before it looks at anything', () => {
    expect(decide(input({ url: GATE_ROUTES.signIn, method: 'POST' })))
      .toEqual({ kind: 'gate', route: 'sign-in' })
    expect(decide(input({ url: GATE_ROUTES.signOut })))
      .toEqual({ kind: 'gate', route: 'sign-out' })
  })
})

describe('isNavigation', () => {
  it('believes sec-fetch-mode where a browser sends it', () => {
    expect(isNavigation(facts({ 'sec-fetch-mode': 'navigate' }), 'GET')).toBe(true)
    expect(isNavigation(facts({ 'sec-fetch-mode': 'cors' }), 'GET')).toBe(false)
  })

  it('falls back to Accept where it is absent', () => {
    expect(isNavigation(facts({ accept: 'text/html,*/*' }), 'GET')).toBe(true)
    expect(isNavigation(facts({ accept: 'application/json' }), 'GET')).toBe(false)
  })

  it('is never true of a POST', () => {
    expect(isNavigation(facts({ 'sec-fetch-mode': 'navigate' }), 'POST')).toBe(false)
  })
})

describe('URL handling', () => {
  it('splits a path from its query without throwing on either', () => {
    expect(splitUrl('/a/b?c=d')).toEqual({ pathname: '/a/b', search: 'c=d' })
    expect(splitUrl('/a/b')).toEqual({ pathname: '/a/b', search: '' })
  })

  it('rebuilds a path with the passcode gone', () => {
    expect(withoutKey('/a', 'k=1&b=2')).toBe('/a?b=2')
    expect(withoutKey('/a', 'k=1')).toBe('/a')
    expect(withoutKey('', '')).toBe('/')
  })
})

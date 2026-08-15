import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOBILE_ROUTES } from '../src/contract.ts'
import { DeviceStore, labelFromUserAgent } from '../src/devices.ts'
import { PairingCodes } from '../src/pairing.ts'
import { BODY_LIMIT, createRemctrlHandler } from '../src/server.ts'

/**
 * The real door on an ephemeral loopback port.
 *
 * A live listener rather than a mocked request: what M0 has to be right about
 * is statuses, headers, and the gate, and every one of those is a property of
 * the wire rather than of a function.
 */
function door() {
  const clock = { at: 1_000 }
  const devices = new DeviceStore({ now: () => clock.at, hashToken: (token) => `hash:${token}` })
  const pairing = new PairingCodes({
    now: () => clock.at, mintCode: () => '123456', ttlMs: 60_000, maxAttempts: 3,
  })
  let minted = 0
  const handler = createRemctrlHandler({
    devices,
    pairing,
    defaultTier: 'drive',
    labelFor: labelFromUserAgent,
    mintToken: () => { minted += 1; return `token-${minted}` },
    mintDeviceId: () => `device-${minted}`,
  })
  const server: Server = createServer((req, res) => { void handler(req, res) })
  return {
    devices,
    pairing,
    clock,
    listen: async (): Promise<string> => {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    },
    close: async (): Promise<void> => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

let bench: ReturnType<typeof door>
let base: string

beforeEach(async () => {
  bench = door()
  base = await bench.listen()
})

afterEach(async () => { await bench.close() })

/** POST a pairing request. */
async function pair(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${MOBILE_ROUTES.pair}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** GET the authenticated probe. */
async function session(token?: string): Promise<Response> {
  return fetch(`${base}${MOBILE_ROUTES.session}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
}

describe('the page', () => {
  it('serves a shell under a content policy that admits nothing external', () => {
    return fetch(`${base}/`).then(async (response) => {
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const csp = response.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      // The page is written to need neither, so neither is granted.
      expect(csp).not.toContain('unsafe-inline')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await response.text()).toContain('<title>omdsh remote</title>')
    })
  })

  it('serves the script and stylesheet the shell references', async () => {
    const script = await fetch(`${base}${MOBILE_ROUTES.js}`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')

    const style = await fetch(`${base}${MOBILE_ROUTES.css}`)
    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toContain('text/css')
  })

  it('refuses a write to an asset', async () => {
    const response = await fetch(`${base}/`, { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('answers 404 for anything it does not serve', async () => {
    const response = await fetch(`${base}/api/session.prompt`)
    expect(response.status).toBe(404)
  })
})

describe('cross-origin posture', () => {
  it('grants no origin, anywhere', async () => {
    // The absence of this header IS the policy: every route worth reaching
    // needs an `authorization` header or a JSON content type, both of which
    // make the request non-simple, so the browser asks a preflight question
    // this door never answers.
    for (const path of ['/', MOBILE_ROUTES.js, MOBILE_ROUTES.session]) {
      const response = await fetch(`${base}${path}`)
      expect(response.headers.get('access-control-allow-origin'), path).toBeNull()
    }
    const posted = await pair({ code: '000000' }, { origin: 'https://evil.example' })
    expect(posted.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses the one shape a cross-origin page could send without a preflight', async () => {
    // `text/plain` (and the form encodings) make a POST a SIMPLE request: the
    // browser sends it and only refuses to show the answer. Reading the reply
    // was never the attack — spending the pairing budget was.
    bench.pairing.mint()
    const response = await fetch(`${base}${MOBILE_ROUTES.pair}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ code: '000000' }),
    })
    expect(response.status).toBe(415)
    expect(bench.pairing.peek()?.remaining).toBe(3)
  })
})

describe('pairing', () => {
  it('refuses when nothing has been minted', async () => {
    const response = await pair({ code: '123456' })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'no-code' })
  })

  it('spends the budget on a wrong code and says how much is left', async () => {
    bench.pairing.mint()
    const response = await pair({ code: '000000' })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ reason: 'mismatch', remaining: 2 })
  })

  it('reports a burned code as locked', async () => {
    bench.pairing.mint()
    await pair({ code: '000000' })
    await pair({ code: '000000' })
    const response = await pair({ code: '000000' })
    expect(await response.json()).toMatchObject({ reason: 'locked' })
    // And the right code no longer helps.
    expect(await (await pair({ code: '123456' })).json()).toMatchObject({ reason: 'no-code' })
  })

  it('reports an expired code as expired', async () => {
    bench.pairing.mint()
    bench.clock.at = 999_999
    expect(await (await pair({ code: '123456' })).json()).toMatchObject({ reason: 'expired' })
  })

  it('issues a token once, on the right code', async () => {
    bench.pairing.mint()
    const response = await pair({ code: '123456' }, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })
    expect(response.status).toBe(200)
    const body = await response.json() as { token: string; label: string; tier: string; deviceId: string }
    expect(body).toMatchObject({ token: 'token-1', label: 'iPhone', tier: 'drive' })
    expect(bench.devices.size).toBe(1)
    // Spent: a second device cannot ride the same yes.
    expect(await (await pair({ code: '123456' })).json()).toMatchObject({ reason: 'no-code' })
  })

  it('takes a label the phone proposes, trimmed and bounded', async () => {
    bench.pairing.mint()
    const body = await (await pair({ code: '123456', label: `  ${'x'.repeat(200)}  ` })).json() as { label: string }
    expect(body.label).toHaveLength(64)
  })

  it('falls back to the User-Agent when the proposed label is unusable', async () => {
    bench.pairing.mint()
    const body = await (await pair({ code: '123456', label: '   ' }, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14)' })).json() as { label: string }
    expect(body.label).toBe('Android')
  })

  it('refuses a body that is not a pairing request', async () => {
    bench.pairing.mint()
    expect((await pair('not json')).status).toBe(400)
    expect((await pair({ nope: true })).status).toBe(400)
    expect(await (await pair({ code: 42 })).json()).toMatchObject({ reason: 'malformed' })
  })

  it('refuses an oversized body without buffering it', async () => {
    bench.pairing.mint()
    const response = await pair(JSON.stringify({ code: '123456', label: 'x'.repeat(BODY_LIMIT * 2) }))
    expect(response.status).toBe(413)
  })

  it('is posted, not read', async () => {
    const response = await fetch(`${base}${MOBILE_ROUTES.pair}`)
    expect(response.status).toBe(405)
  })
})

describe('the authenticated probe', () => {
  /** Pair, and hand back the token. */
  async function paired(): Promise<string> {
    bench.pairing.mint()
    const body = await (await pair({ code: '123456' })).json() as { token: string }
    return body.token
  }

  it('reports who a live token is', async () => {
    const token = await paired()
    const response = await session(token)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      deviceId: 'device-1', label: 'Device', tier: 'drive', pairedAt: 1_000,
    })
  })

  it('refuses a request with no token', async () => {
    expect((await session()).status).toBe(401)
  })

  it('answers an unknown token exactly as it answers no token', async () => {
    // A revoked device learns that it is not paired, and learns nothing about
    // whether the token it holds was ever real.
    const without = await session()
    const wrong = await session('not-a-real-token')
    expect(wrong.status).toBe(without.status)
    expect(await wrong.json()).toEqual(await without.json())
  })

  it('stops answering the moment the device is revoked', async () => {
    const token = await paired()
    expect((await session(token)).status).toBe(200)
    bench.devices.revoke('device-1')
    expect((await session(token)).status).toBe(401)
  })

  it('ignores an authorization header that is not a bearer', async () => {
    await paired()
    const response = await fetch(`${base}${MOBILE_ROUTES.session}`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(response.status).toBe(401)
  })

  it('is read, not written', async () => {
    const response = await fetch(`${base}${MOBILE_ROUTES.session}`, { method: 'POST' })
    expect(response.status).toBe(405)
  })
})

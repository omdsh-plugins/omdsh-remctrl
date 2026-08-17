import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { COOKIE_NAME, GATE_ROUTES, KEY_PARAM, type Carrier } from '../src/contract.ts'
import { BrowserStore, labelFromUserAgent } from '../src/browsers.ts'
import { readBody, safeNext, startDoor, type Door } from '../src/door.ts'
import { AUTH_RULE, SIGN_IN_RULE, Throttle } from '../src/throttle.ts'

/**
 * The door, end to end, over a real socket.
 *
 * Not a handler called with fakes: the thing under test is a request path with
 * a redirect, a `Set-Cookie`, a form body and a socket upgrade in it, and every
 * one of those is a place where a handler that looks right behaves differently
 * once Node is holding the response.
 */

const open: Array<() => void> = []
afterEach(() => { for (const close of open.splice(0).reverse()) close() })

/** The passcode every case signs in with. */
const PASSCODE = 'ABC123XYZ0'

/** A stub upstream that reports what it saw, so "forwarded" is observable. */
async function upstream(): Promise<{ port: number; seen: string[]; hosts: string[] }> {
  const seen: string[] = []
  const hosts: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`)
    hosts.push(String(req.headers.host))
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('THE HARNESS')
  })
  server.on('upgrade', (req, socket) => {
    seen.push(`UPGRADE ${req.url ?? ''}`)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n')
    socket.write('frame')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  open.push(() => { server.closeAllConnections(); server.close() })
  return { port: (server.address() as AddressInfo).port, seen, hosts }
}

/** A door in front of a stub upstream. */
async function bench(options: {
  carrier?: Carrier
  secure?: boolean
  allowInsecure?: boolean
  passcode?: string
  sessionTtlMs?: number
  withUpstream?: boolean
} = {}) {
  const up = options.withUpstream === false ? undefined : await upstream()
  const browsers = new BrowserStore({ now: () => Date.now(), hashToken: token => `h:${token}` })
  const carrier = options.carrier ?? 'tunnel'
  const access: Array<{ granted: boolean; label: string; address: string; browserId?: string }> = []
  let door: Door
  await new Promise<void>((resolve) => {
    door = startDoor(
      {
        browsers,
        signIn: new Throttle(SIGN_IN_RULE, () => Date.now()),
        auth: new Throttle(AUTH_RULE, () => Date.now()),
        passcode: () => options.passcode ?? PASSCODE,
        carrier: () => carrier,
        secure: () => options.secure ?? false,
        allowInsecure: () => options.allowInsecure ?? false,
        sessionTtlMs: () => options.sessionTtlMs ?? 86_400_000,
        upstreamPort: () => up?.port,
        mintToken: () => 'minted-token',
        mintBrowserId: () => 'b1',
        labelFor: labelFromUserAgent,
        onAccess: event => { access.push(event) },
        onError: () => {},
      },
      { host: '127.0.0.1', port: 0 },
      () => {},
      resolve,
    )
  })
  open.push(() => { door.close() })
  return { port: (door!.server.address() as AddressInfo).port, browsers, upstream: up, access }
}

/** One answer from the door. */
interface Answer {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

/** The headers a browser sends over the tunnel, unless a case says otherwise. */
const TUNNELLED = {
  'host': 'x.trycloudflare.com',
  'x-forwarded-proto': 'https',
  'x-forwarded-for': '203.0.113.9',
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)',
}

/** A top-level navigation. */
const NAVIGATE = { ...TUNNELLED, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' }

/** A request the page itself made. */
const XHR = {
  ...TUNNELLED,
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'origin': 'https://x.trycloudflare.com',
}

/** One request at the door. */
async function ask(port: number, path: string, init: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...init.headers }
    if (init.body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      headers['content-length'] = String(Buffer.byteLength(init.body))
    }
    const req = httpRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** The cookie value out of a `Set-Cookie`, or undefined. */
function issued(answer: Answer): string | undefined {
  const raw = answer.headers['set-cookie']?.[0]
  if (raw === undefined) return undefined
  return /omdsh_remctrl=([^;]*)/.exec(raw)?.[1]
}

describe('a browser that has not signed in', () => {
  it('is shown the passcode form on a navigation, at the path it asked for', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/sessions/abc', { headers: NAVIGATE })
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toMatch(/text\/html/)
    expect(answer.body).toContain('name="passcode"')
    // So the form takes them where they were going, not to the root.
    expect(answer.body).toContain('value="/sessions/abc"')
  })

  it('gets 401 on a request the page made, rather than a page it cannot parse', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/api/sessions/list', { method: 'POST', headers: XHR, body: '{}' })
    expect(answer.status).toBe(401)
  })

  it('reaches nothing upstream at all', async () => {
    const { port, upstream: up } = await bench()
    await ask(port, '/', { headers: NAVIGATE })
    await ask(port, '/api/x', { method: 'POST', headers: XHR, body: '{}' })
    expect(up?.seen).toEqual([])
  })

  it('cannot upgrade a WebSocket', async () => {
    const { port, upstream: up } = await bench()
    expect((await handshake(port, '/api/events.mux', XHR)).status).toBe(401)
    expect(up?.seen).toEqual([])
  })

  it('speaks the language the phone asked for', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/', { headers: { ...NAVIGATE, 'accept-language': 'zh-CN,zh;q=0.9' } })
    expect(answer.body).toContain('通行码')
    expect(answer.body).toContain('lang="zh-CN"')
  })
})

describe('signing in', () => {
  it('takes the passcode on the form and hands back a cookie', async () => {
    const { port, browsers } = await bench()
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: { ...NAVIGATE },
      body: `passcode=${PASSCODE}&next=%2Fsessions%2Fabc`,
    })
    expect(answer.status).toBe(303)
    expect(answer.headers['location']).toBe('/sessions/abc')
    expect(issued(answer)).toBe('minted-token')
    expect(browsers.size).toBe(1)
    // The row is named from the User-Agent, so a person can tell two devices apart.
    expect(browsers.list()[0]?.label).toBe('iPhone')
  })

  it('accepts a passcode typed in any case, with the lookalikes folded', async () => {
    const { port } = await bench({ passcode: 'ABC123XYZ0' })
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: 'passcode=abc-123-xyzo&next=%2F',
    })
    expect(answer.status).toBe(303)
  })

  it('shows the form again on a wrong one, and issues nothing', async () => {
    const { port, browsers } = await bench()
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: 'passcode=WRONG&next=%2F',
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('name="passcode"')
    expect(issued(answer)).toBeUndefined()
    expect(browsers.size).toBe(0)
  })

  it('runs out of tries, which is what makes ten characters enough', async () => {
    const { port } = await bench()
    const attempt = async (): Promise<Answer> => ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: 'passcode=WRONG&next=%2F',
    })
    for (let round = 0; round < SIGN_IN_RULE.capacity; round += 1) await attempt()
    const answer = await attempt()
    expect(answer.body).toMatch(/Too many attempts/)
    // And the correct passcode is refused too while the bucket is empty —
    // otherwise the throttle would only cost an attacker the wrong guesses.
    const good = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F`,
    })
    expect(good.status).toBe(200)
  })

  it('signs in on a link that carries the passcode, then strips it', async () => {
    const { port } = await bench()
    const answer = await ask(port, `/?${KEY_PARAM}=${PASSCODE}`, { headers: NAVIGATE })
    expect(answer.status).toBe(303)
    expect(answer.headers['location']).toBe('/')
    expect(issued(answer)).toBe('minted-token')
  })

  it('offers the form, not a refusal, when the link\'s passcode is stale', async () => {
    // The likeliest reason is that somebody minted a new one since the QR was
    // photographed, and the next thing they need is somewhere to type it.
    const { port } = await bench()
    const answer = await ask(port, `/?${KEY_PARAM}=OLDCODE`, { headers: NAVIGATE })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('name="passcode"')
  })

  it('says so, rather than failing quietly, when no passcode is set at all', async () => {
    const { port } = await bench({ passcode: '' })
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: 'passcode=anything&next=%2F',
    })
    expect(answer.body).toMatch(/No passcode is set/)
  })

  it('refuses to redirect off this origin', async () => {
    const { port } = await bench()
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F%2Fevil.example`,
    })
    expect(answer.headers['location']).toBe('/')
  })

  it('marks the cookie Secure under the tunnel and not under a direct bind', async () => {
    const tunnelled = await bench({ carrier: 'tunnel' })
    const secure = await ask(tunnelled.port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F`,
    })
    expect(secure.headers['set-cookie']?.[0]).toContain('Secure')

    const plain = await bench({ carrier: 'direct', allowInsecure: true })
    const answer = await ask(plain.port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: { host: '203.0.113.1:3081', 'sec-fetch-mode': 'navigate' },
      body: `passcode=${PASSCODE}&next=%2F`,
    })
    // Secure on a plaintext origin means the browser never sends it back.
    expect(answer.headers['set-cookie']?.[0]).not.toContain('Secure')
  })
})

describe('a browser that has signed in', () => {
  /** Sign in, and hand back the cookie header to send with everything after. */
  async function signedIn(port: number): Promise<Record<string, string>> {
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F`,
    })
    return { cookie: `${COOKIE_NAME}=${String(issued(answer))}` }
  }

  it('reaches the harness, with the Host rewritten to loopback', async () => {
    const { port, upstream: up } = await bench()
    const cookie = await signedIn(port)
    const answer = await ask(port, '/api/sessions/list', { method: 'POST', headers: { ...XHR, ...cookie }, body: '{}' })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('THE HARNESS')
    expect(up?.hosts.at(-1)).toBe(`127.0.0.1:${String(up?.port)}`)
  })

  it('can upgrade a WebSocket', async () => {
    const { port, upstream: up } = await bench()
    const cookie = await signedIn(port)
    const seen = await handshake(port, '/api/events.mux', { ...XHR, ...cookie })
    expect(seen.status).toBe(101)
    expect(up?.seen).toContain('UPGRADE /api/events.mux')
  })

  it('stops reaching anything the moment it is revoked', async () => {
    const { port, browsers } = await bench()
    const cookie = await signedIn(port)
    browsers.revoke(browsers.list()[0]!.browserId)
    const answer = await ask(port, '/api/x', { method: 'POST', headers: { ...XHR, ...cookie }, body: '{}' })
    expect(answer.status).toBe(401)
  })

  it('stops when the session expires', async () => {
    const { port } = await bench({ sessionTtlMs: 1 })
    const cookie = await signedIn(port)
    await new Promise(resolve => setTimeout(resolve, 5))
    const answer = await ask(port, '/api/x', { method: 'POST', headers: { ...XHR, ...cookie }, body: '{}' })
    expect(answer.status).toBe(401)
  })

  it('can sign itself out, which drops the row and clears the cookie', async () => {
    const { port, browsers } = await bench()
    const cookie = await signedIn(port)
    const answer = await ask(port, GATE_ROUTES.signOut, { headers: { ...NAVIGATE, ...cookie } })
    expect(answer.status).toBe(303)
    expect(answer.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    expect(browsers.size).toBe(0)
  })
})

describe('the transport gate', () => {
  it('refuses a tunnelled request that did not arrive over https, in prose', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/', {
      headers: { ...NAVIGATE, 'x-forwarded-proto': 'http' },
    })
    expect(answer.status).toBe(421)
    expect(answer.body).toMatch(/https/)
  })

  it('refuses before it reads a cookie', async () => {
    const { port } = await bench()
    const signedIn = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F`,
    })
    const answer = await ask(port, '/', {
      headers: {
        ...NAVIGATE,
        'x-forwarded-proto': 'http',
        'cookie': `${COOKIE_NAME}=${String(issued(signedIn))}`,
      },
    })
    expect(answer.status).toBe(421)
  })
})

describe('the provenance gate', () => {
  it('refuses a cross-site request that is not a navigation', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/api/x', {
      method: 'POST',
      headers: { ...TUNNELLED, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    expect(answer.status).toBe(403)
  })

  it('refuses an Origin that is not this gate\'s', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/api/x', {
      method: 'POST',
      headers: { ...XHR, origin: 'https://evil.example' },
      body: '{}',
    })
    expect(answer.status).toBe(403)
  })
})

describe('the access hook', () => {
  it('reports a grant with who, where, and which browser it made', async () => {
    const { port, access } = await bench()
    await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F`,
    })
    expect(access).toEqual([
      { granted: true, label: 'iPhone', address: '203.0.113.9', browserId: 'b1' },
    ])
  })

  it('reports a wrong passcode', async () => {
    const { port, access } = await bench()
    await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: 'passcode=WRONG&next=%2F',
    })
    expect(access).toEqual([{ granted: false, label: 'iPhone', address: '203.0.113.9' }])
  })

  it('reports a throttled knock too, because it is still a knock', async () => {
    const { port, access } = await bench()
    for (let round = 0; round < SIGN_IN_RULE.capacity + 2; round += 1) {
      await ask(port, GATE_ROUTES.signIn, {
        method: 'POST', headers: NAVIGATE, body: 'passcode=WRONG&next=%2F',
      })
    }
    expect(access).toHaveLength(SIGN_IN_RULE.capacity + 2)
    expect(access.every(event => !event.granted)).toBe(true)
  })

  it('says nothing when there is no passcode to attack', async () => {
    const { port, access } = await bench({ passcode: '' })
    await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: 'passcode=anything&next=%2F',
    })
    expect(access).toEqual([])
  })

  it('catches the `?k=` path as well as the form', async () => {
    // `trySignIn` is the one choke point, which is the property an access log
    // has to have to be worth keeping.
    const { port, access } = await bench()
    await ask(port, `/?${KEY_PARAM}=${PASSCODE}`, { headers: NAVIGATE })
    expect(access).toEqual([{ granted: true, label: 'iPhone', address: '203.0.113.9', browserId: 'b1' }])
  })

  it('keys on the forwarded address, not on the tunnel\'s socket', async () => {
    const { port, access } = await bench()
    await ask(port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: { ...NAVIGATE, 'x-forwarded-for': '198.51.100.77' },
      body: 'passcode=WRONG&next=%2F',
    })
    expect(access[0]?.address).toBe('198.51.100.77')
  })
})

describe('a fronted deployment', () => {
  it('answers over plain http when the declared URL is http', async () => {
    // `ssh -R` sets no headers at all, so there is nothing to check and nothing
    // to believe: the acknowledgement was given when the door opened.
    const { port } = await bench({ carrier: 'fronted', secure: false, allowInsecure: true })
    const answer = await ask(port, '/', {
      headers: { host: '121.43.252.12:7860', 'sec-fetch-mode': 'navigate' },
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('name="passcode"')
  })

  it('REFUSES a plaintext request when the declared URL is https', async () => {
    // A Caddy that stopped terminating TLS is then one 421 rather than a
    // session cookie in the clear.
    const { port } = await bench({ carrier: 'fronted', secure: true })
    const answer = await ask(port, '/', {
      headers: { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate' },
    })
    expect(answer.status).toBe(421)
  })

  it('accepts it once the proxy says https', async () => {
    const { port } = await bench({ carrier: 'fronted', secure: true })
    const answer = await ask(port, '/', {
      headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https', 'sec-fetch-mode': 'navigate' },
    })
    expect(answer.status).toBe(200)
  })

  it('marks the cookie Secure behind an https carrier, and not behind an http one', async () => {
    const secure = await bench({ carrier: 'fronted', secure: true })
    const one = await ask(secure.port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https', 'sec-fetch-mode': 'navigate' },
      body: `passcode=${PASSCODE}&next=%2F`,
    })
    expect(one.headers['set-cookie']?.[0]).toContain('Secure')

    const plain = await bench({ carrier: 'fronted', secure: false, allowInsecure: true })
    const two = await ask(plain.port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: { host: '1.2.3.4:7860', 'sec-fetch-mode': 'navigate' },
      body: `passcode=${PASSCODE}&next=%2F`,
    })
    expect(two.headers['set-cookie']?.[0]).not.toContain('Secure')
  })

  it('believes x-forwarded-for behind https, and NOT behind http', async () => {
    // An ssh reverse forward writes no headers, so one on the request came from
    // the client — believing it would hand one attacker a bucket per address.
    const secure = await bench({ carrier: 'fronted', secure: true })
    await ask(secure.port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: {
        'host': 'dsh.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.9',
        'sec-fetch-mode': 'navigate',
      },
      body: 'passcode=WRONG&next=%2F',
    })
    expect(secure.access[0]?.address).toBe('203.0.113.9')

    const plain = await bench({ carrier: 'fronted', secure: false, allowInsecure: true })
    await ask(plain.port, GATE_ROUTES.signIn, {
      method: 'POST',
      headers: { 'host': '1.2.3.4:7860', 'x-forwarded-for': '203.0.113.9', 'sec-fetch-mode': 'navigate' },
      body: 'passcode=WRONG&next=%2F',
    })
    expect(plain.access[0]?.address).toBe('127.0.0.1')
  })
})

describe('the phone assets', () => {
  it('are served by the gate, not forwarded', async () => {
    const { port, upstream: up } = await bench()
    const signIn = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${PASSCODE}&next=%2F`,
    })
    const cookie = { cookie: `${COOKIE_NAME}=${String(issued(signIn))}` }
    const css = await ask(port, GATE_ROUTES.mobileCss, { headers: { ...XHR, ...cookie } })
    expect(css.status).toBe(200)
    expect(css.headers['content-type']).toMatch(/text\/css/)
    expect(css.body).toContain('data-shell-overlay')
    expect(up?.seen).not.toContain(`GET ${GATE_ROUTES.mobileCss}`)
  })

  it('are BEHIND the passcode, like everything else that is not the form', async () => {
    const { port } = await bench()
    const css = await ask(port, GATE_ROUTES.mobileCss, { headers: XHR })
    expect(css.status).toBe(401)
  })
})

describe('serving the gate\'s own pages', () => {
  it('marks them no-store, nosniff, and un-frameable', async () => {
    const { port } = await bench()
    const answer = await ask(port, '/', { headers: NAVIGATE })
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.headers['x-content-type-options']).toBe('nosniff')
    expect(answer.headers['x-frame-options']).toBe('DENY')
  })
})

describe('safeNext', () => {
  it('keeps a same-origin path', () => {
    expect(safeNext('/a/b?c=1')).toBe('/a/b?c=1')
  })

  it('refuses everything that could leave this origin', () => {
    // An open redirect on a sign-in page is how a phishing link borrows a
    // trusted hostname.
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext(null)).toBe('/')
    expect(safeNext('')).toBe('/')
  })
})

describe('readBody', () => {
  it('refuses a body longer than the limit rather than buffering it', async () => {
    const { port } = await bench()
    const answer = await ask(port, GATE_ROUTES.signIn, {
      method: 'POST', headers: NAVIGATE, body: `passcode=${'x'.repeat(4000)}`,
    })
    expect(answer.status).toBe(413)
  })

  it('is a function a spec can call with a stream', async () => {
    const { Readable } = await import('node:stream')
    const stream = Readable.from(['ab', 'cd']) as unknown as IncomingMessage
    expect(await readBody(stream, 10)).toBe('abcd')
  })
})

/** One upgrade attempt at the door. */
async function handshake(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    })
    req.end()
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 0 })
    })
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0 })
    })
    req.on('error', reject)
  })
}

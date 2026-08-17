import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { COOKIE_NAME } from '../src/contract.ts'
import { HOP_BY_HOP, isRewritableHtml, proxyHttp, proxyUpgrade, upstreamHeaders } from '../src/reverse.ts'

/** Everything opened by a case, closed after it. */
const open: Array<() => void> = []
afterEach(() => {
  for (const close of open.splice(0).reverse()) close()
})

/** What the stub upstream recorded about the request it was handed. */
interface Seen {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * A stand-in for the harness: records what it was sent, answers what the case
 * asked for, and upgrades anything that asks to.
 */
async function upstream(options: {
  status?: number
  headers?: Record<string, string>
  body?: string
} = {}): Promise<{ port: number; seen: Seen[]; upgrades: Seen[] }> {
  const seen: Seen[] = []
  const upgrades: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(options.status ?? 200, {
        'content-type': 'text/plain; charset=utf-8',
        ...options.headers,
      })
      res.end(options.body ?? 'upstream')
    })
  })
  server.on('upgrade', (req, socket) => {
    upgrades.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.write('hello-from-upstream')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  open.push(() => { server.closeAllConnections(); server.close() })
  return { port: (server.address() as AddressInfo).port, seen, upgrades }
}

/** A listener that forwards everything to `port`. */
async function forwarder(port: number | undefined, transformHtml?: (html: string) => string): Promise<number> {
  const deps = {
    upstreamPort: () => port,
    ...transformHtml === undefined ? {} : { transformHtml },
    onError: () => {},
  }
  const server: Server = createServer((req, res) => { proxyHttp(req, res, deps) })
  server.on('upgrade', (req, socket, head) => { proxyUpgrade(req, socket, head, deps) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  open.push(() => { server.closeAllConnections(); server.close() })
  return (server.address() as AddressInfo).port
}

/** One request through the forwarder. */
async function fetchThrough(port: number, path: string, init: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers ?? {},
    }, (res) => {
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

describe('upstreamHeaders', () => {
  it('rewrites Host to the upstream authority', () => {
    // Without this the harness's own trust fence answers 403 — proved against
    // the real thing before this module existed.
    const out = upstreamHeaders({ host: 'x.trycloudflare.com' }, '127.0.0.1:5000')
    expect(out.host).toBe('127.0.0.1:5000')
  })

  it('rewrites Origin to match, because the fence compares the two', () => {
    const out = upstreamHeaders(
      { host: 'x.trycloudflare.com', origin: 'https://x.trycloudflare.com' },
      '127.0.0.1:5000',
    )
    expect(out.origin).toBe('http://127.0.0.1:5000')
  })

  it('leaves an absent Origin absent', () => {
    expect(upstreamHeaders({ host: 'x' }, '127.0.0.1:5000').origin).toBeUndefined()
  })

  it('drops every hop-by-hop header', () => {
    const headers = Object.fromEntries([...HOP_BY_HOP].map(name => [name, 'x']))
    const out = upstreamHeaders({ ...headers, host: 'x' }, '127.0.0.1:5000')
    for (const name of HOP_BY_HOP) expect(out[name]).toBeUndefined()
  })

  it('takes the gate\'s own cookie out and keeps the others', () => {
    const out = upstreamHeaders({ host: 'x', cookie: `theme=dark; ${COOKIE_NAME}=secret` }, '127.0.0.1:5000')
    expect(out.cookie).toBe('theme=dark')
  })

  it('deletes the header entirely when ours was the only cookie', () => {
    const out = upstreamHeaders({ host: 'x', cookie: `${COOKIE_NAME}=secret` }, '127.0.0.1:5000')
    expect(out.cookie).toBeUndefined()
  })

  it('drops Referer rather than rewriting it into a page that does not exist', () => {
    const out = upstreamHeaders({ host: 'x', referer: 'https://x.trycloudflare.com/a' }, '127.0.0.1:5000')
    expect(out.referer).toBeUndefined()
  })
})

describe('isRewritableHtml', () => {
  it('is true for an uncompressed HTML response', () => {
    expect(isRewritableHtml({ 'content-type': 'text/html; charset=utf-8' })).toBe(true)
  })

  it('is false for anything else, and for anything encoded', () => {
    expect(isRewritableHtml({ 'content-type': 'application/json' })).toBe(false)
    expect(isRewritableHtml({ 'content-type': 'text/html', 'content-encoding': 'gzip' })).toBe(false)
    expect(isRewritableHtml({})).toBe(false)
  })
})

describe('forwarding, against a real upstream', () => {
  it('carries the method, path, headers and body through', async () => {
    const up = await upstream()
    const port = await forwarder(up.port)
    const answer = await fetchThrough(port, '/api/x?y=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'host': 'x.trycloudflare.com' },
      body: '{"a":1}',
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('upstream')
    expect(up.seen[0]).toMatchObject({ method: 'POST', url: '/api/x?y=1', body: '{"a":1}' })
    expect(up.seen[0]?.headers['host']).toBe(`127.0.0.1:${String(up.port)}`)
  })

  it('never lets the session cookie reach the harness', async () => {
    const up = await upstream()
    const port = await forwarder(up.port)
    await fetchThrough(port, '/', { headers: { cookie: `${COOKIE_NAME}=secret; theme=dark` } })
    expect(up.seen[0]?.headers['cookie']).toBe('theme=dark')
  })

  it('answers 502 rather than hanging when there is no upstream at all', async () => {
    const port = await forwarder(undefined)
    const answer = await fetchThrough(port, '/')
    expect(answer.status).toBe(502)
    expect(answer.body).toMatch(/no web interface/)
  })

  it('answers 502 when the upstream is not listening', async () => {
    const dead = await upstream()
    const port = await forwarder(dead.port)
    for (const close of open.splice(open.length - 2, 1)) close()
    const answer = await fetchThrough(port, '/')
    expect(answer.status).toBe(502)
  })

  it('rewrites an HTML body and fixes the length', async () => {
    const up = await upstream({ headers: { 'content-type': 'text/html', 'etag': '"old"' }, body: '<p>hi</p>' })
    const port = await forwarder(up.port, html => html.replace('hi', 'hello there'))
    const answer = await fetchThrough(port, '/')
    expect(answer.body).toBe('<p>hello there</p>')
    expect(answer.headers['content-length']).toBe(String('<p>hello there</p>'.length))
    // The length changed, so an etag describing the old bytes would tell a
    // browser 304 for a page it never received.
    expect(answer.headers['etag']).toBeUndefined()
  })

  it('leaves a non-HTML body alone even with a transform installed', async () => {
    const up = await upstream({ headers: { 'content-type': 'application/json' }, body: '{"hi":1}' })
    const port = await forwarder(up.port, () => 'REPLACED')
    expect((await fetchThrough(port, '/')).body).toBe('{"hi":1}')
  })
})

describe('upgrading, against a real upstream', () => {
  it('replays the handshake and pipes both ways', async () => {
    const up = await upstream()
    const port = await forwarder(up.port)
    const seen = await handshake(port, '/api/events.mux')
    expect(seen.status).toBe(101)
    expect(seen.first).toBe('hello-from-upstream')
    expect(up.upgrades[0]?.headers['host']).toBe(`127.0.0.1:${String(up.port)}`)
  })

  it('closes the socket when there is no upstream', async () => {
    const port = await forwarder(undefined)
    const seen = await handshake(port, '/api/events.mux')
    expect(seen.status).toBe(502)
  })
})

/** One upgrade attempt through the forwarder, reported as a status and the first bytes after it. */
async function handshake(port: number, path: string): Promise<{ status: number; first: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    })
    req.end()
    req.on('upgrade', (res, socket, head) => {
      if (head.length > 0) {
        socket.destroy()
        resolve({ status: res.statusCode ?? 0, first: head.toString('utf8') })
        return
      }
      socket.once('data', (chunk: Buffer) => {
        socket.destroy()
        resolve({ status: res.statusCode ?? 0, first: chunk.toString('utf8') })
      })
    })
    // A refusal arrives as an ordinary response, or as a status line on a
    // socket the far end then closes.
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, first: '' })
    })
    req.on('error', reject)
  })
}

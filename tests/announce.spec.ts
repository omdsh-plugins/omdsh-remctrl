import { describe, expect, it } from 'vitest'
import { GATE_ROUTES, KEY_PARAM, LOOPBACK, type TunnelState } from '../src/contract.ts'
import { announcement, resolve, tunnelLine, tunnelWanted, warningsFor, type Options } from '../src/index.ts'
import type { BindDecision } from '../src/bind.ts'

/** A resolved section, with whatever the case is about. */
function options(over: Partial<Options> = {}): Options {
  return { ...resolve({ enabled: true }), ...over }
}

/** A bind that came up under the tunnel. */
const BOUND: BindDecision = { kind: 'ok', host: LOOPBACK, carrier: 'tunnel', scope: 'loopback' }

/** A bind that came up on a public address. */
const DIRECT: BindDecision = { kind: 'ok', host: '0.0.0.0', carrier: 'direct', scope: 'wide' }

/** A bind onto a tailnet address this machine holds. */
const TAILNET: BindDecision = { kind: 'ok', host: '100.101.102.103', carrier: 'direct', scope: 'tailnet' }

describe('resolve', () => {
  it('defaults to OFF, which is the whole point of this version', () => {
    expect(resolve({}).enabled).toBe(false)
  })

  it('defaults to the tunnel, by leaving the public host empty', () => {
    expect(resolve({}).publicHost).toBe('')
  })

  it('trims a public host somebody pasted with a space on the end', () => {
    expect(resolve({ publicHost: ' 1.2.3.4 ' }).publicHost).toBe('1.2.3.4')
  })
})

describe('announcement', () => {
  it('says nothing at all while switched off', () => {
    // Off on every install that never asked for it, so a line here would be
    // noise in every terminal in the world.
    expect(announcement({
      options: options({ enabled: false }),
      decision: { kind: 'refused', carrier: 'tunnel', message: 'off' },
      url: '',
      passcode: '',
      tunnel: { kind: 'off' },
    })).toEqual([])
  })

  it('prints the URL and the passcode, which is the pair a person needs', () => {
    const lines = announcement({
      options: options(),
      decision: BOUND,
      url: 'https://x.trycloudflare.com',
      passcode: 'ABC123XYZ0',
      tunnel: { kind: 'up', url: 'https://x.trycloudflare.com' },
    })
    expect(lines[0]).toContain('https://x.trycloudflare.com')
    expect(lines[1]).toContain('ABC123XYZ0')
    expect(lines[1]).toContain(`?${KEY_PARAM}=ABC123XYZ0`)
  })

  it('says where to sign a browser out again', () => {
    const lines = announcement({
      options: options(),
      decision: BOUND,
      url: 'https://x.trycloudflare.com',
      passcode: 'ABC',
      tunnel: { kind: 'up', url: 'https://x.trycloudflare.com' },
    })
    expect(lines.at(-1)).toContain(GATE_ROUTES.signOut)
  })

  it('says what a plaintext bind costs, on the line under the URL', () => {
    const lines = announcement({
      options: options({ publicHost: '1.2.3.4', allowInsecure: true }),
      decision: DIRECT,
      url: 'http://1.2.3.4:3081',
      passcode: 'ABC',
      tunnel: { kind: 'off' },
    })
    expect(lines.join('\n')).toMatch(/plain HTTP/)
  })

  it('says a tailnet bind is narrow rather than dangerous', () => {
    // "plain HTTP" and "safe" look contradictory until somebody explains why
    // they are not, and the boot line is where that explanation belongs.
    const lines = announcement({
      options: options({ publicHost: '100.101.102.103' }),
      decision: TAILNET,
      url: 'http://100.101.102.103:3081',
      passcode: 'ABC',
      tunnel: { kind: 'off' },
    })
    const joined = lines.join('\n')
    expect(joined).toMatch(/WireGuard/)
    expect(joined).not.toMatch(/open internet/)
  })

  it('carries a refusal verbatim, because it is the whole answer', () => {
    expect(announcement({
      options: options(),
      decision: { kind: 'refused', carrier: 'direct', message: 'set allowInsecure to say you meant it' },
      url: '',
      passcode: '',
      tunnel: { kind: 'off' },
    })).toEqual(['set allowInsecure to say you meant it'])
  })

  it('says it is waiting while the tunnel has not answered', () => {
    expect(announcement({
      options: options(),
      decision: BOUND,
      url: '',
      passcode: 'ABC',
      tunnel: { kind: 'starting', attempt: 1 },
    })).toEqual([expect.stringContaining('waiting for the tunnel')])
  })

  it('stays quiet when the tunnel has already reported its own failure', () => {
    // `tunnelLine` printed the reason; repeating "no address yet" underneath it
    // would only bury it.
    expect(announcement({
      options: options(),
      decision: BOUND,
      url: '',
      passcode: 'ABC',
      tunnel: { kind: 'failed', reason: 'missing-binary', detail: 'x', retryInMs: 0 },
    })).toEqual([])
  })
})

describe('tunnelWanted', () => {
  it('is true only under the tunnel carrier, on a bind that came up', () => {
    expect(tunnelWanted(BOUND)).toBe(true)
  })

  it('is FALSE the moment a public host is set', () => {
    // Writing publicHost takes the tunnel down as a consequence of the bind,
    // rather than as a separate thing somebody has to remember to do.
    expect(tunnelWanted(DIRECT)).toBe(false)
    expect(tunnelWanted(TAILNET)).toBe(false)
  })

  it('is false for a bind that refused, whatever the carrier', () => {
    // Including a refusal UNDER the tunnel: a tunnel to a door that did not
    // open is a public name for a connection refused.
    expect(tunnelWanted({ kind: 'refused', carrier: 'tunnel', message: 'off' })).toBe(false)
    expect(tunnelWanted({ kind: 'refused', carrier: 'direct', message: 'no' })).toBe(false)
  })
})

describe('tunnelLine', () => {
  it('says it is starting, once', () => {
    expect(tunnelLine({ kind: 'starting', attempt: 1 })).toMatch(/opening a cloudflared tunnel/)
    expect(tunnelLine({ kind: 'starting', attempt: 2 })).toBeUndefined()
  })

  it('says nothing on success, because the announcement says it better', () => {
    expect(tunnelLine({ kind: 'up', url: 'https://x' })).toBeUndefined()
  })

  it('says how to install the binary when that is what is missing', () => {
    expect(tunnelLine({ kind: 'failed', reason: 'missing-binary', detail: 'x', retryInMs: 0 }))
      .toMatch(/brew install cloudflared/)
  })

  it('reports any other failure verbatim', () => {
    expect(tunnelLine({ kind: 'failed', reason: 'exited', detail: 'code 1', retryInMs: 2_000 }))
      .toContain('code 1')
  })
})

describe('warningsFor', () => {
  const up: TunnelState = { kind: 'up', url: 'https://x.trycloudflare.com' }

  it('says it is off, and nothing else', () => {
    const warnings = warningsFor({
      options: options({ enabled: false }), decision: BOUND, hasUpstream: true, tunnel: { kind: 'off' }, url: '',
    })
    expect(warnings).toEqual([{ code: 'disabled', detail: expect.any(String) }])
  })

  it('says there is nothing to forward before anything else about the door', () => {
    const warnings = warningsFor({
      options: options(), decision: BOUND, hasUpstream: false, tunnel: { kind: 'off' }, url: '',
    })
    expect(warnings[0]?.code).toBe('no-upstream')
  })

  it('names the unacknowledged plaintext as its own thing, not a generic refusal', () => {
    const warnings = warningsFor({
      options: options({ publicHost: '1.2.3.4' }),
      decision: { kind: 'refused', carrier: 'direct', message: 'set allowInsecure' },
      hasUpstream: true,
      tunnel: { kind: 'off' },
      url: '',
    })
    expect(warnings[0]?.code).toBe('insecure-unacknowledged')
  })

  it('keeps warning about plaintext even once it is running', () => {
    // The acknowledgement stops the refusal; it does not stop it being true.
    const warnings = warningsFor({
      options: options({ publicHost: '1.2.3.4', allowInsecure: true }),
      decision: DIRECT,
      hasUpstream: true,
      tunnel: { kind: 'off' },
      url: 'http://1.2.3.4:3081',
    })
    expect(warnings[0]?.code).toBe('plaintext')
  })

  it('reports a tailnet bind as a state, with the address in it', () => {
    const warnings = warningsFor({
      options: options({ publicHost: '100.101.102.103' }),
      decision: TAILNET,
      hasUpstream: true,
      tunnel: { kind: 'off' },
      url: 'http://100.101.102.103:3081',
    })
    expect(warnings[0]?.code).toBe('tailnet')
    expect(warnings[0]?.detail).toContain('100.101.102.103')
    expect(warnings[0]?.detail).toMatch(/WireGuard/)
  })

  it('says when a bind this machine holds reaches nobody but itself', () => {
    const warnings = warningsFor({
      options: options({ publicHost: '127.0.0.1' }),
      decision: { kind: 'ok', host: LOOPBACK, carrier: 'direct', scope: 'loopback' },
      hasUpstream: true,
      tunnel: { kind: 'off' },
      url: 'http://127.0.0.1:3081',
    })
    expect(warnings[0]?.code).toBe('loopback-only')
  })

  it('names the bound address in the plaintext warning, not the configured one', () => {
    // They differ on a cloud VM, and the one that decides the exposure is the
    // one that was bound.
    const warnings = warningsFor({
      options: options({ publicHost: '1.2.3.4', allowInsecure: true }),
      decision: DIRECT,
      hasUpstream: true,
      tunnel: { kind: 'off' },
      url: 'http://1.2.3.4:3081',
    })
    expect(warnings[0]?.detail).toContain('0.0.0.0')
  })

  it('says how to install cloudflared when that is the whole problem', () => {
    const warnings = warningsFor({
      options: options(),
      decision: BOUND,
      hasUpstream: true,
      tunnel: { kind: 'failed', reason: 'missing-binary', detail: 'x', retryInMs: 0 },
      url: '',
    })
    expect(warnings[0]?.code).toBe('missing-binary')
    expect(warnings[0]?.detail).toMatch(/brew install/)
  })

  it('is quiet when everything works', () => {
    expect(warningsFor({
      options: options(), decision: BOUND, hasUpstream: true, tunnel: up, url: 'https://x.trycloudflare.com',
    })).toEqual([])
  })

  it('says the tunnel is still coming up when there is no URL yet', () => {
    const warnings = warningsFor({
      options: options(), decision: BOUND, hasUpstream: true, tunnel: { kind: 'starting', attempt: 1 }, url: '',
    })
    expect(warnings[0]?.code).toBe('tunnel-down')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ENDPOINTS, PASSCODE_LENGTH,
  type AccessView, type ConfigView, type PasscodeState, type RevokeAll, type RpcResult, type StatusView,
} from '../src/contract.ts'
import type { BrowserTable } from '../src/browsers.ts'
import { apply, type RemctrlConfig, type RemctrlContext } from '../src/index.ts'

/** The control-channel handler, as `connection.rpc.handle` receives it. */
type ControlHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>

/** Everything a case mounted, unmounted after it. */
const open: Array<() => void> = []
afterEach(() => {
  for (const teardown of open.splice(0).reverse()) teardown()
  vi.restoreAllMocks()
})

/** One browser already signed in, so a revocation has something to write about. */
const SIGNED_IN: BrowserTable = {
  b1: { label: 'iPhone', tokenHash: 'hash:t1', signedInAt: 1_000, lastSeenAt: 1_000 },
}

/**
 * `apply` on a hand-built tree.
 *
 * `enabled: false` by default so the bench binds no port and spawns no
 * process: what is under test is what the plugin does with its seams.
 */
function bench(options: {
  update?: () => Promise<void>
  seed?: RemctrlConfig
  /** Names of services this composition does NOT have. */
  without?: readonly string[]
  /** The harness port to report, when there is a webServer. */
  upstreamPort?: number
} = {}) {
  const update = options.update ?? (async () => {})
  const seed = options.seed ?? { enabled: false, browsers: SIGNED_IN }
  const warn = vi.fn()
  const writes: Array<Partial<RemctrlConfig>> = []
  let control: ControlHandler | undefined
  let stored: RemctrlConfig = seed
  let watcher: ((next: RemctrlConfig) => void) | undefined

  const scope = {
    get: () => stored,
    watch: (callback: (next: RemctrlConfig) => void) => {
      watcher = callback
      return () => { watcher = undefined }
    },
    update: async (patch: Partial<RemctrlConfig>) => {
      writes.push(patch)
      stored = { ...stored, ...patch }
      await update()
    },
  }
  const services: Record<string, unknown> = {
    settings: { register: () => scope },
    connection: {
      rpc: {
        handle: (_channel: string, handler: ControlHandler) => {
          control = handler
          return () => {}
        },
      },
    },
    webServer: { port: options.upstreamPort ?? 62_886 },
  }
  for (const absent of options.without ?? []) delete services[absent]

  const teardowns: Array<() => void> = []
  const ctx: RemctrlContext = {
    effect: (setup) => { teardowns.push(setup()) },
    inject: (deps, callback) => {
      if (deps.some(dep => services[dep] === undefined)) return
      callback(ctx)
    },
    get: serviceName => services[serviceName],
    logger: { warn },
  }

  apply(ctx, seed)
  open.push(() => { for (const teardown of teardowns.reverse()) teardown() })

  return {
    warn,
    writes,
    stored: () => stored,
    /** Push a settings change the way the watch would. */
    change: (patch: Partial<RemctrlConfig>) => {
      stored = { ...stored, ...patch }
      watcher?.(stored)
    },
    call: async (endpoint: string, payload: unknown = {}): Promise<RpcResult<unknown>> => {
      if (control === undefined) throw new Error('the control channel was never registered')
      return control(endpoint, payload, new AbortController().signal)
    },
    hasControl: () => control !== undefined,
  }
}

/** Unwrap a result, or fail with its message. */
function value<T>(result: RpcResult<unknown>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

describe('mounting', () => {
  it('registers the control channel', () => {
    expect(bench().hasControl()).toBe(true)
  })

  it('boots without a settings provider, and says writes go nowhere', async () => {
    const held = bench({ without: ['settings'] })
    const view = value<ConfigView>(await held.call(CONTROL_ENDPOINTS.readConfig))
    expect(view.writable).toBe(false)
    const refused = await held.call(CONTROL_ENDPOINTS.writeConfig, { enabled: true })
    expect(refused.ok).toBe(false)
  })

  it('boots without a webServer, and says there is nothing to forward', async () => {
    const held = bench({ without: ['webServer'], seed: { enabled: true } })
    const status = value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus))
    expect(status.upstreamPort).toBeNull()
    expect(status.warnings.map(warning => warning.code)).toContain('no-upstream')
  })

  it('boots without a connection service at all', () => {
    expect(() => bench({ without: ['connection'] })).not.toThrow()
  })

  it('reports the harness port it will forward to', async () => {
    const held = bench({ upstreamPort: 4321 })
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).upstreamPort).toBe(4321)
  })
})

describe('the passcode', () => {
  it('is NOT minted while switched off', async () => {
    // A plugin nobody turned on has no business writing a credential into
    // somebody's settings file.
    const held = bench()
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).passcode).toBe('')
    expect(held.writes).toEqual([])
  })

  it('is minted and stored the moment it is turned on', async () => {
    const held = bench({ seed: { enabled: true } })
    const status = value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus))
    expect(status.passcode).toHaveLength(PASSCODE_LENGTH)
    expect(held.stored().passcode).toBe(status.passcode)
  })

  it('survives a restart, rather than handing out a new one every boot', async () => {
    const held = bench({ seed: { enabled: true, passcode: 'KEPTITHERE' } })
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).passcode).toBe('KEPTITHERE')
    expect(held.writes.some(write => 'passcode' in write)).toBe(false)
  })

  it('can be replaced, and the new one is stored', async () => {
    const held = bench({ seed: { enabled: true, passcode: 'OLDONE' } })
    const minted = value<PasscodeState>(await held.call(CONTROL_ENDPOINTS.resetPasscode)).passcode
    expect(minted).not.toBe('OLDONE')
    expect(held.stored().passcode).toBe(minted)
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).passcode).toBe(minted)
  })

  it('is on the sign-in link once there is a URL to put it on', async () => {
    const held = bench({ seed: { enabled: true, passcode: 'ABCDEFGHJK', publicHost: '1.2.3.4', allowInsecure: true } })
    const status = value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus))
    expect(status.url).toBe('http://1.2.3.4:3081')
    expect(status.signInUrl).toBe('http://1.2.3.4:3081/?k=ABCDEFGHJK')
  })
})

describe('the settings seam', () => {
  it('reads back what it just wrote, not the value it replaced', async () => {
    // `options` only refreshes when the watch fires, which is a fiber hop after
    // `update` resolves; a card reading through `options` would re-render with
    // the old value and look like the write was ignored.
    const held = bench()
    const view = value<ConfigView>(await held.call(CONTROL_ENDPOINTS.writeConfig, { port: 4000 }))
    expect(view.config.port).toBe(4000)
  })

  it('refuses a public host it cannot stand behind, before it reaches the file', async () => {
    const held = bench()
    const refused = await held.call(CONTROL_ENDPOINTS.writeConfig, { publicHost: 'https://dsh.example.com/harness' })
    expect(refused.ok).toBe(false)
    expect(held.writes).toEqual([])
  })

  it('takes a whole URL, and reports the deployment it describes', async () => {
    // The shape of what you write says which deployment you have: a URL means
    // something else carries the traffic, so the door binds loopback and shows
    // the URL rather than rebuilding one from the bound address.
    const held = bench({
      seed: { enabled: true, publicHost: 'https://dsh.example.com', passcode: 'ABCDEFGHJK', port: 0 },
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    const status = value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus))
    expect(status.carrier).toBe('fronted')
    expect(status.bindHost).toBe('127.0.0.1')
    expect(status.url).toBe('https://dsh.example.com')
    expect(status.signInUrl).toBe('https://dsh.example.com/?k=ABCDEFGHJK')
    expect(status.warnings.map(warning => warning.code)).toContain('fronted')
  })

  it('refuses a plaintext fronted URL until it is acknowledged', async () => {
    const held = bench({ seed: { enabled: true, publicHost: 'http://121.43.252.12:7860' } })
    const status = value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus))
    expect(status.listening).toBe(false)
    expect(status.warnings.map(warning => warning.code)).toContain('insecure-unacknowledged')
  })

  it('adopts a change made elsewhere', async () => {
    const held = bench()
    held.change({ port: 9999 })
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).port).toBe(9999)
  })

  it('mirrors a sign-out without letting a failed write kill the process', async () => {
    // `settings.update` rejecting unhandled is `fatal load failure` and
    // `exit(1)` — one phone signing out would take the agent host with it.
    const held = bench({ update: async () => { throw new Error('read-only disk') } })
    const result = await held.call(CONTROL_ENDPOINTS.revokeBrowser, { browserId: 'b1' })
    expect(result.ok).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(held.warn).toHaveBeenCalledWith(expect.stringContaining('read-only disk'))
  })
})

describe('the access log', () => {
  it('is adopted from the stored section, so a restart does not blank it', async () => {
    // The case worth catching is the one nobody was watching; a log that
    // started empty on every restart would be blank exactly when it mattered.
    const held = bench({
      seed: {
        enabled: false,
        access: {
          events: [{ at: 5_000, granted: true, label: 'iPhone', address: '203.0.113.9', attempts: 1 }],
          seenAt: 0,
        },
      },
    })
    const view = value<AccessView>(await held.call(CONTROL_ENDPOINTS.readAccess))
    expect(view.events).toHaveLength(1)
    expect(view.unseen).toBe(1)
  })

  it('mirrors an acknowledgement into settings', async () => {
    const held = bench({
      seed: {
        enabled: false,
        access: { events: [{ at: 5_000, granted: true, label: 'iPhone', address: 'x', attempts: 1 }], seenAt: 0 },
      },
    })
    await held.call(CONTROL_ENDPOINTS.ackAccess)
    expect(held.stored().access?.seenAt).toBeGreaterThan(0)
  })

  it('signs every browser out on request', async () => {
    const held = bench({ seed: { enabled: false, browsers: SIGNED_IN } })
    const removed = value<RevokeAll>(await held.call(CONTROL_ENDPOINTS.revokeAllBrowsers))
    expect(removed.removed).toBe(1)
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).browsers).toBe(0)
    expect(held.writes.some(write => Object.keys(write.browsers ?? {}).length === 0)).toBe(true)
  })
})

describe('the door', () => {
  it('stays shut by default and reports it', async () => {
    const status = value<StatusView>(await bench().call(CONTROL_ENDPOINTS.readStatus))
    expect(status.enabled).toBe(false)
    expect(status.listening).toBe(false)
    expect(status.warnings.map(warning => warning.code)).toEqual(['disabled'])
  })

  it('refuses a public host with no acknowledgement, and stays shut', async () => {
    const held = bench({ seed: { enabled: true, publicHost: '1.2.3.4' } })
    const status = value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus))
    expect(status.listening).toBe(false)
    expect(status.carrier).toBe('direct')
    expect(status.warnings.map(warning => warning.code)).toContain('insecure-unacknowledged')
  })

  it('binds when it is turned on, and lets go when it is turned off', async () => {
    const held = bench({ seed: { enabled: true, port: 0, publicHost: '127.0.0.1', allowInsecure: true } })
    // `port: 0` takes an OS-assigned port, so the spec never collides with a
    // real dsh on this machine.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).listening).toBe(true)
    held.change({ enabled: false })
    expect(value<StatusView>(await held.call(CONTROL_ENDPOINTS.readStatus)).listening).toBe(false)
  })
})

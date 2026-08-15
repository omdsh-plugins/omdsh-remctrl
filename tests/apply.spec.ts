import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_ENDPOINTS, type RpcResult } from '../src/contract.ts'
import { apply, type RemctrlConfig, type RemctrlContext } from '../src/index.ts'

/** The control-channel handler, as `connection.rpc.handle` receives it. */
type ControlHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>

/** One device already paired, so a revocation has something to write about. */
const SEED: RemctrlConfig = {
  enabled: false,
  devices: {
    d1: { label: 'iPhone', tokenHash: 'hash:t1', tier: 'drive', createdAt: 1_000, lastSeenAt: 1_000 },
  },
}

/**
 * `apply` on a hand-built tree: a loopback channel, and a settings provider
 * whose writes do whatever the spec says.
 *
 * `enabled: false` keeps the door shut, so this bench binds no port and the
 * only thing under test is what the plugin does with the mirror.
 */
function bench(update: () => Promise<void>) {
  const warn = vi.fn()
  const writes: unknown[] = []
  let control: ControlHandler | undefined

  const scope = {
    get: () => SEED,
    watch: (_callback: (next: RemctrlConfig) => void) => () => {},
    update: (patch: Partial<RemctrlConfig>) => {
      writes.push(patch)
      return update()
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
  }
  const ctx: RemctrlContext = {
    effect: (setup) => { setup() },
    inject: (_deps, callback) => { callback(ctx) },
    get: (serviceName) => services[serviceName],
    logger: { warn },
  }

  apply(ctx, SEED)
  return {
    warn,
    writes,
    /** Revoke the seeded device, which is the shortest path to a mirrored write. */
    revoke: async (): Promise<RpcResult<unknown>> => {
      if (control === undefined) throw new Error('the control channel was never registered')
      return control(CONTROL_ENDPOINTS.revokeDevice, { deviceId: 'd1' }, new AbortController().signal)
    },
  }
}

// The refusal line `rebind` prints is boot status for a person watching a
// terminal, and this is not one.
const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
afterEach(() => { printed.mockClear() })

describe('the durable mirror', () => {
  it('writes the table through the settings scope', async () => {
    const tree = bench(() => Promise.resolve())
    expect(await tree.revoke()).toEqual({ ok: true, value: { changed: true } })
    expect(tree.writes).toEqual([{ devices: {} }])
    expect(tree.warn).not.toHaveBeenCalled()
  })

  it('survives a write the settings service refuses', async () => {
    // The one that matters. `settings.update` rejects on a read-only provider,
    // on a scope this fiber has dropped, and on this namespace's own
    // `validate` — which refuses a stored bindHost the machine has stopped
    // holding, so a laptop whose Tailscale went down rejects every later
    // write. An unhandled rejection is `fatal load failure` and `exit(1)` in
    // this harness, which would make a phone pairing take the agent host down
    // with it. This spec fails on the rejection itself, not just the missing
    // line.
    const tree = bench(() => Promise.reject(new Error('settings provider is read-only')))
    expect(await tree.revoke()).toEqual({ ok: true, value: { changed: true } })
    await vi.waitFor(() => { expect(tree.warn).toHaveBeenCalledTimes(1) })
    expect(String(tree.warn.mock.calls[0])).toContain('read-only')
  })
})

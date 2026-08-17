import { describe, expect, it, vi } from 'vitest'
import type { TunnelState } from '../src/contract.ts'
import {
  Cloudflared, EXTRA_PATHS, RETRY_CEILING_MS, RETRY_FLOOR_MS, URL_TIMEOUT_MS,
  locateBinary, readTunnelUrl, tunnelArgs, type ChildLike,
} from '../src/cloudflared.ts'

/** The banner a real `cloudflared` prints, verbatim from one that ran. */
const BANNER = `2026-08-17T06:49:42Z INF +------------------------------------------+
2026-08-17T06:49:42Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-08-17T06:49:42Z INF |  https://limitations-reflect-promoted-showing.trycloudflare.com  |
2026-08-17T06:49:42Z INF +------------------------------------------+`

describe('readTunnelUrl', () => {
  it('finds the URL inside the banner', () => {
    expect(readTunnelUrl(BANNER)).toBe('https://limitations-reflect-promoted-showing.trycloudflare.com')
  })

  it('finds nothing in ordinary chatter', () => {
    expect(readTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined()
  })
})

describe('locateBinary', () => {
  it('takes the first PATH entry that has it', () => {
    expect(locateBinary('/a:/b', candidate => candidate === '/b/cloudflared')).toBe('/b/cloudflared')
  })

  it('looks in Homebrew\'s prefixes even when PATH does not mention them', () => {
    // A GUI application on macOS inherits launchd's PATH, not a login shell's,
    // which is exactly how cloudflared ends up invisible to the app.
    expect(locateBinary('/nothing', candidate => candidate === '/opt/homebrew/bin/cloudflared'))
      .toBe('/opt/homebrew/bin/cloudflared')
    expect(EXTRA_PATHS).toContain('/opt/homebrew/bin')
  })

  it('is undefined when it is nowhere', () => {
    expect(locateBinary('/a:/b', () => false)).toBeUndefined()
  })

  it('survives an empty PATH', () => {
    expect(locateBinary(undefined, candidate => candidate === '/usr/local/bin/cloudflared'))
      .toBe('/usr/local/bin/cloudflared')
  })
})

describe('tunnelArgs', () => {
  it('points a quick tunnel at the gate on loopback', () => {
    expect(tunnelArgs(3081)).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3081'])
  })
})

/** A fake process, and the timers to drive it. */
function bench(options: { binary?: string | undefined } = {}) {
  const states: TunnelState[] = []
  const spawns: Array<{ binary: string; args: string[] }> = []
  const children: Array<ChildLike & { emitStderr: (text: string) => void; exit: (code: number | null) => void; killed: string[] }> = []
  const timers: Array<{ id: number; callback: () => void; ms: number }> = []
  let nextTimer = 1

  const make = (): (typeof children)[number] => {
    const listeners = new Map<string, Array<(arg: unknown) => void>>()
    const dataListeners: Array<(chunk: unknown) => void> = []
    const killed: string[] = []
    const child = {
      stderr: { on: (_event: 'data', listener: (chunk: unknown) => void) => { dataListeners.push(listener) } },
      stdout: null,
      on: (event: 'exit' | 'error', listener: (arg: unknown) => void) => {
        const held = listeners.get(event) ?? []
        held.push(listener)
        listeners.set(event, held)
      },
      kill: (signal?: NodeJS.Signals) => { killed.push(signal ?? 'SIGTERM') },
      killed,
      emitStderr: (text: string) => { for (const listener of dataListeners) listener(text) },
      exit: (code: number | null) => { for (const listener of listeners.get('exit') ?? []) listener(code) },
    }
    return child
  }

  const tunnel = new Cloudflared({
    spawn: (binary, args) => {
      spawns.push({ binary, args })
      const child = make()
      children.push(child)
      return child
    },
    findBinary: () => ('binary' in options ? options.binary : '/usr/bin/cloudflared'),
    setTimer: (callback, ms) => {
      const id = nextTimer
      nextTimer += 1
      timers.push({ id, callback, ms })
      return id
    },
    clearTimer: (handle) => {
      const at = timers.findIndex(timer => timer.id === handle)
      if (at >= 0) timers.splice(at, 1)
    },
    onState: state => { states.push(state) },
  })

  return {
    tunnel,
    states,
    spawns,
    children,
    timers,
    /** Run the pending timer closest to the given delay. */
    fire: (ms: number) => {
      const at = timers.findIndex(timer => timer.ms === ms)
      if (at < 0) throw new Error(`no timer scheduled at ${String(ms)}ms; have ${timers.map(t => t.ms).join(', ')}`)
      const [timer] = timers.splice(at, 1)
      timer!.callback()
    },
  }
}

describe('supervision', () => {
  it('spawns, then reports the URL it printed', () => {
    const held = bench()
    held.tunnel.start(3081)
    expect(held.spawns).toHaveLength(1)
    expect(held.states[0]).toEqual({ kind: 'starting', attempt: 1 })

    held.children[0]?.emitStderr(BANNER)
    expect(held.tunnel.url()).toBe('https://limitations-reflect-promoted-showing.trycloudflare.com')
    expect(held.states.at(-1)?.kind).toBe('up')
  })

  it('does not re-announce the same URL when it appears again', () => {
    const held = bench()
    held.tunnel.start(3081)
    held.children[0]?.emitStderr(BANNER)
    const count = held.states.length
    held.children[0]?.emitStderr(BANNER)
    expect(held.states).toHaveLength(count)
  })

  it('restarts on exit, doubling the wait each time', () => {
    const held = bench()
    held.tunnel.start(3081)
    held.children[0]?.exit(1)
    expect(held.states.at(-1)).toMatchObject({ kind: 'failed', reason: 'exited', retryInMs: RETRY_FLOOR_MS })

    held.fire(RETRY_FLOOR_MS)
    held.children[1]?.exit(1)
    expect(held.states.at(-1)).toMatchObject({ retryInMs: RETRY_FLOOR_MS * 2 })

    held.fire(RETRY_FLOOR_MS * 2)
    held.children[2]?.exit(1)
    expect(held.states.at(-1)).toMatchObject({ retryInMs: RETRY_FLOOR_MS * 4 })
  })

  it('never waits longer than the ceiling', () => {
    const held = bench()
    held.tunnel.start(3081)
    for (let round = 0; round < 12; round += 1) {
      held.children.at(-1)?.exit(1)
      const state = held.states.at(-1) as { retryInMs: number }
      if (round < 11) held.fire(state.retryInMs)
    }
    expect((held.states.at(-1) as { retryInMs: number }).retryInMs).toBe(RETRY_CEILING_MS)
  })

  it('resets the backoff once it comes up', () => {
    const held = bench()
    held.tunnel.start(3081)
    held.children[0]?.exit(1)
    held.fire(RETRY_FLOOR_MS)
    held.children[1]?.emitStderr(BANNER)
    held.children[1]?.exit(1)
    expect(held.states.at(-1)).toMatchObject({ retryInMs: RETRY_FLOOR_MS })
  })

  it('gives up on a process that runs and never prints a URL', () => {
    const held = bench()
    held.tunnel.start(3081)
    held.fire(URL_TIMEOUT_MS)
    expect(held.states.at(-1)).toMatchObject({ kind: 'failed', reason: 'no-url' })
    expect(held.children[0]?.killed).toContain('SIGTERM')
  })

  it('reports a missing binary once and does NOT retry it', () => {
    // A missing binary is a fact about this machine that will not change while
    // the process runs; a supervisor reporting it every two seconds forever
    // would be noise rather than news.
    const held = bench({ binary: undefined })
    held.tunnel.start(3081)
    expect(held.states.at(-1)).toMatchObject({ kind: 'failed', reason: 'missing-binary', retryInMs: 0 })
    expect(held.timers).toHaveLength(0)
    expect(held.spawns).toHaveLength(0)
  })

  it('is idempotent on an unchanged port', () => {
    // Otherwise a settings write that touched something else would hand the
    // person a brand new hostname for no reason.
    const held = bench()
    held.tunnel.start(3081)
    held.children[0]?.emitStderr(BANNER)
    held.tunnel.start(3081)
    expect(held.spawns).toHaveLength(1)
    expect(held.tunnel.url()).toBe('https://limitations-reflect-promoted-showing.trycloudflare.com')
  })

  it('restarts on a port change', () => {
    const held = bench()
    held.tunnel.start(3081)
    held.tunnel.start(3082)
    expect(held.spawns.map(spawn => spawn.args.at(-1)))
      .toEqual(['http://127.0.0.1:3081', 'http://127.0.0.1:3082'])
  })

  it('stops wanting one, kills it, and stays stopped when it exits', () => {
    const held = bench()
    held.tunnel.start(3081)
    const child = held.children[0]!
    held.tunnel.stop()
    expect(child.killed).toContain('SIGTERM')
    expect(held.tunnel.view().state).toEqual({ kind: 'off' })
    child.exit(null)
    expect(held.tunnel.view().state).toEqual({ kind: 'off' })
    expect(held.spawns).toHaveLength(1)
  })

  it('ignores a late exit from a process it already replaced', () => {
    const held = bench()
    held.tunnel.start(3081)
    const first = held.children[0]!
    held.tunnel.start(3082)
    const before = held.states.length
    first.exit(1)
    expect(held.states).toHaveLength(before)
  })

  it('reports a spawn that throws outright', () => {
    const held = bench()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(held.tunnel as any).deps.spawn = () => { throw new Error('EACCES') }
    held.tunnel.start(3081)
    expect(held.states.at(-1)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('EACCES') })
  })

  it('says where the binary was found', () => {
    const held = bench()
    held.tunnel.start(3081)
    expect(held.tunnel.view().binary).toBe('/usr/bin/cloudflared')
  })
})

describe('spawning for real', () => {
  it('does not throw when the binary is absent from this machine', () => {
    // `findBinary` is the guard; this is the belt-and-braces case where a spec
    // runs on a machine that has no cloudflared at all.
    const states: TunnelState[] = []
    const tunnel = new Cloudflared({
      spawn: () => { throw new Error('ENOENT') },
      findBinary: () => '/nope/cloudflared',
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      onState: state => { states.push(state) },
    })
    expect(() => { tunnel.start(1) }).not.toThrow()
    expect(states.at(-1)?.kind).toBe('failed')
  })
})

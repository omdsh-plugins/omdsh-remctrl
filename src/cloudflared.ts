/**
 * The default way out: a `cloudflared` quick tunnel, supervised.
 *
 * The whole of this version's setup story is "turn it on", and this module is
 * what makes that true for a machine with no public address — which is nearly
 * every laptop. `cloudflared tunnel --url` opens an OUTBOUND connection to
 * Cloudflare and gets back a name on `trycloudflare.com`; nothing has to be
 * forwarded, no firewall opened, and TLS is terminated by somebody whose job
 * that is. The gate binds loopback and `cloudflared` is its only client.
 *
 * What it costs, said out loud because a person choosing this should know:
 * every byte between the phone and this machine passes through Cloudflare in
 * the clear on their side of the TLS. A quick tunnel is also anonymous and
 * ephemeral — the name changes on every restart, which is why nothing here
 * stores it, and why the card shows the current one rather than a saved one.
 *
 * The process is a dependency rather than an import, so the supervision — the
 * backoff, the "it started and never printed a URL" timeout, the restart on
 * exit — is decided by tests rather than by a real network.
 * @module @omdsh-plugins/omdsh-remctrl/cloudflared
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { TunnelFailure, TunnelState, TunnelView } from './contract.ts'

/** How long to wait for the first URL before calling the attempt a failure. */
export const URL_TIMEOUT_MS = 45_000

/** The first retry delay. Each failure doubles it. */
export const RETRY_FLOOR_MS = 2_000

/** The longest this will ever wait between attempts. */
export const RETRY_CEILING_MS = 60_000

/** How long a stopping process gets before it is killed outright. */
export const KILL_GRACE_MS = 2_000

/**
 * Where to look for the binary when `PATH` does not have it.
 *
 * A GUI application on macOS inherits the `PATH` of `launchd`, not of a login
 * shell — which is precisely how `cloudflared` ends up installed, on `PATH` in
 * every terminal the person owns, and invisible to the app they are actually
 * running. Naming Homebrew's two prefixes is the difference between "it works"
 * and a support question with no good answer.
 */
export const EXTRA_PATHS: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/snap/bin',
]

/** As much of a child process as this module uses. */
export interface ChildLike {
  /** Diagnostics; `cloudflared` writes everything here, including the URL. */
  stderr?: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null
  /** Empty in practice, read anyway so a future version cannot go unnoticed. */
  stdout?: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null
  on: (event: 'exit' | 'error', listener: (arg: unknown) => void) => void
  kill: (signal?: NodeJS.Signals) => void
}

/** What {@link Cloudflared} needs from the outside world. */
export interface CloudflaredDeps {
  /** Start one. Returns undefined when the binary could not be started at all. */
  spawn: (binary: string, args: string[]) => ChildLike
  /** Where the binary is, or undefined when it is not installed. */
  findBinary: () => string | undefined
  /** Deferred work; handed in so a spec can drive the backoff without waiting. */
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Told on every transition, so the card and the boot line can say what changed. */
  onState?: (state: TunnelState) => void
  /** Where a diagnostic that is not a state change goes. */
  onLog?: (line: string) => void
}

/**
 * The URL a quick tunnel prints.
 *
 * Matched rather than parsed out of the banner: `cloudflared` draws the URL
 * inside an ASCII box whose padding has changed between versions, and the one
 * stable thing in it is the name itself.
 */
const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

/**
 * Find the URL in one chunk of `cloudflared` output.
 * @param text - whatever the process just wrote.
 * @returns the URL, or undefined.
 */
export function readTunnelUrl(text: string): string | undefined {
  return URL_PATTERN.exec(text)?.[0]
}

/**
 * Look for the binary on `PATH` and in the places a GUI app cannot see.
 * @param path - the `PATH` value, or undefined.
 * @param exists - whether one absolute path is an executable file.
 * @param name - the binary's name.
 * @returns the first match, or undefined.
 */
export function locateBinary(
  path: string | undefined,
  exists: (candidate: string) => boolean,
  name = 'cloudflared',
): string | undefined {
  const dirs = [...(path ?? '').split(delimiter).filter(part => part !== ''), ...EXTRA_PATHS]
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** Whether one path is a file this process may execute. */
export function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The arguments a quick tunnel is opened with. */
export function tunnelArgs(port: number): string[] {
  return [
    'tunnel',
    '--no-autoupdate',
    // The gate is on loopback and `cloudflared` runs beside it, so this is the
    // whole of the exposure: one process on this machine talking to one port
    // on this machine.
    '--url', `http://127.0.0.1:${String(port)}`,
  ]
}

/**
 * A supervised quick tunnel.
 *
 * One process at a time, restarted with a doubling backoff, and a state a card
 * can draw. Every transition is reported once; a retry that is merely the next
 * attempt is a state change too, because a person watching a card that says
 * "starting" needs to know whether it is the first attempt or the ninth.
 */
export class Cloudflared {
  private child: ChildLike | undefined
  private timer: unknown
  private urlTimer: unknown
  private attempt = 0
  private wanted = false
  private port = 0
  private binary = ''
  private state: TunnelState = { kind: 'off' }

  /**
   * @param deps - see {@link CloudflaredDeps}.
   */
  constructor(private readonly deps: CloudflaredDeps) {}

  /** What it is doing, as the card shows it. */
  view(): TunnelView {
    return { state: this.state, binary: this.binary }
  }

  /** The URL, when there is one. */
  url(): string | undefined {
    return this.state.kind === 'up' ? this.state.url : undefined
  }

  /**
   * Want a tunnel to this port.
   *
   * Idempotent on an unchanged port, so a settings write that touched
   * something else does not tear down a working tunnel and hand the person a
   * new hostname for no reason.
   * @param port - the gate's port.
   */
  start(port: number): void {
    if (this.wanted && this.port === port) return
    // Torn down without transitioning through `off`: a restart is not a stop,
    // and a card that flashed "off" between two ports would be reporting a
    // state this tunnel was never in.
    this.clearTimers()
    this.takeDown()
    this.wanted = true
    this.port = port
    this.attempt = 0
    this.launch()
  }

  /** Stop wanting one, and take down whatever is running. */
  stop(): void {
    this.wanted = false
    this.clearTimers()
    this.takeDown()
    this.transition({ kind: 'off' })
  }

  private launch(): void {
    if (!this.wanted) return
    const binary = this.deps.findBinary()
    if (binary === undefined) {
      this.binary = ''
      // NOT retried. A missing binary is a fact about this machine that will
      // not change while the process runs, and a supervisor that reported it
      // every two seconds forever would be noise rather than news. The card
      // says what to install; setting `enabled` again is the retry.
      this.fail('missing-binary', 'cloudflared is not installed, or not on a PATH this process can see', 0)
      return
    }
    this.binary = binary
    this.attempt += 1
    this.transition({ kind: 'starting', attempt: this.attempt })

    let child: ChildLike
    try {
      child = this.deps.spawn(binary, tunnelArgs(this.port))
    } catch (error) {
      this.retry('other', error instanceof Error ? error.message : String(error))
      return
    }
    this.child = child

    const read = (chunk: unknown): void => {
      const text = String(chunk)
      const url = readTunnelUrl(text)
      if (url === undefined) return
      // Only the FIRST one matters. `cloudflared` prints the URL inside a
      // banner and then mentions it again in later lines; re-transitioning on
      // each would redraw the card and re-print the boot line for no change.
      if (this.state.kind === 'up' && this.state.url === url) return
      this.clearUrlTimer()
      this.attempt = 0
      this.transition({ kind: 'up', url })
    }
    child.stderr?.on('data', read)
    child.stdout?.on('data', read)

    child.on('error', (error) => {
      if (this.child !== child) return
      this.retry('other', error instanceof Error ? error.message : String(error))
    })
    child.on('exit', (code) => {
      // A late exit from a process we already replaced is not news.
      if (this.child !== child) return
      this.child = undefined
      if (!this.wanted) return
      this.retry('exited', `cloudflared exited (${code === null || code === undefined ? 'signal' : `code ${String(code)}`})`)
    })

    this.urlTimer = this.deps.setTimer(() => {
      this.urlTimer = undefined
      if (this.child !== child) return
      this.takeDown()
      this.retry('no-url', `cloudflared ran for ${String(Math.round(URL_TIMEOUT_MS / 1000))}s without printing a tunnel URL`)
    }, URL_TIMEOUT_MS)
  }

  private retry(reason: TunnelFailure, detail: string): void {
    this.clearTimers()
    this.takeDown()
    if (!this.wanted) {
      this.transition({ kind: 'off' })
      return
    }
    const delay = Math.min(RETRY_CEILING_MS, RETRY_FLOOR_MS * 2 ** Math.max(0, this.attempt - 1))
    this.fail(reason, detail, delay)
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined
      this.launch()
    }, delay)
  }

  private fail(reason: TunnelFailure, detail: string, retryInMs: number): void {
    this.transition({ kind: 'failed', reason, detail, retryInMs })
  }

  private transition(next: TunnelState): void {
    this.state = next
    this.deps.onState?.(next)
  }

  private takeDown(): void {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    try {
      child.kill('SIGTERM')
    } catch (error) {
      this.deps.onLog?.(`omdsh-remctrl: could not signal cloudflared — ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // A quick tunnel that will not close its QUIC connections would otherwise
    // hold the port this process is about to rebind.
    this.deps.setTimer(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone, which is the outcome this was for.
      }
    }, KILL_GRACE_MS)
  }

  private clearTimers(): void {
    if (this.timer !== undefined) {
      this.deps.clearTimer(this.timer)
      this.timer = undefined
    }
    this.clearUrlTimer()
  }

  private clearUrlTimer(): void {
    if (this.urlTimer === undefined) return
    this.deps.clearTimer(this.urlTimer)
    this.urlTimer = undefined
  }
}

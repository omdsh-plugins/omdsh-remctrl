# omdsh-remctrl

English | [中文](README.zh.md)

Remote control for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a second front door on its own port, behind device pairing and a tiered method
allowlist, so a phone on your tailnet can watch a session, approve what it asks
for, and hand it new work.

**Status: M0** — the door and the lock, and nothing behind them yet. What a
phone can do today is pair against a running harness and see itself reported as
paired; reading sessions, the live stream, approvals, and sending work are M1
through M4.

The design and the reasoning behind it are in [DESIGN.md](DESIGN.md); the
harness APIs it stands on are in
[RESEARCH-harness-host-api.md](RESEARCH-harness-host-api.md). Both are written
in Chinese.

## What it adds

| Surface | Where it comes from |
|---|---|
| A second HTTP listener on port `3081`, on loopback or a tailnet address | `src/server.ts` — its own `node:http` server, never `ctx.webServer`, whose runtime schema admits only `127.0.0.1` and `0.0.0.0` |
| A phone page that pairs and says so | `src/mobile/assets.ts` — three assets at `/`, `/app.css` and `/app.js`, none of them inline, so the page serves under a strict CSP |
| `/pair` and `/session` | The token door: a six-digit code redeemed once, and a bearer token that proves the device from then on |
| A loopback-only control channel — mint, read, list, rename, revoke, status | `ctx.connection.rpc.handle(…, { authority: 'loopback' })`, so the fence around the controls is the harness's rather than one written here |
| The `omdsh-remctrl` settings namespace | `ctx.inject(['settings'])`, holding the bind, the pairing budgets, and the device table as token hashes |

Milestone by milestone:

- ✅ Its own HTTP listener, with a bind policy that **cannot** be configured onto a public interface
- ✅ Pairing: a six-digit code, one outstanding at a time, five minutes, five guesses
- ✅ Device tokens, stored as hashes, surviving a restart, revocable
- ✅ A loopback-only control channel for the desktop: mint, read, list, rename, revoke, status
- ✅ A phone page that pairs and says so
- ⬜ Reading sessions, the live stream, approvals, sending work — M1 through M4

**There is no desktop pairing panel yet.** The control channel is registered and
answers; nothing in the GUI calls it. So the only way in at M0 is the pairing
code printed at boot — and that line appears only while nothing is paired, which
means that after the first device there is no in-app way to mint a second code
until the panel lands.

## Reaching it

Two deployments, both over Tailscale, neither over the public internet.

**Plain HTTP over WireGuard.** Set `bindHost` to one of this machine's tailnet
addresses and open `http://100.x.y.z:3081/` on the phone. Nothing to configure
beyond Tailscale being up. No TLS, so no PWA and no push.

**TLS, via `tailscale serve`.** Leave `bindHost` at `127.0.0.1` and run:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3081
```

Tailscale terminates TLS with a real Let's Encrypt certificate for
`<node>.<tailnet>.ts.net`, so the phone can install the page as a PWA and — from
M4 — receive push. Requires HTTPS and MagicDNS enabled for the tailnet.

**Never enable Tailscale Funnel on this port.** Funnel is the one switch that
puts it on the public internet.

## Configuration

Settings namespace `omdsh-remctrl`, editable from `omdsh-plughub`.

| Field | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Whether the door opens at all |
| `bindHost` | `127.0.0.1` | Loopback, or a tailnet address this machine holds |
| `port` | `3081` | The phone's port — not the harness's `3080` |
| `defaultTier` | `drive` | What a newly paired device may do |
| `pairingTtlSeconds` | `300` | How long a code lives |
| `maxPairingAttempts` | `5` | Wrong guesses a code survives |
| `devices` | — | Written by the plugin; holds token hashes, never tokens |

Every field is `applies: 'live'`. Moving `bindHost`, `port` or `enabled` rebinds
the listener where it stands; a tier change and a revocation are in force on the
next request. Nothing here asks for a restart.

Two behaviours are worth knowing before editing:

- **A `bindHost` this machine does not hold is refused as you save it**, not at
  the next boot. The namespace validates a write by running the same bind policy
  the listener runs, so a laptop whose Tailscale is down cannot store an address
  it would then fail to listen on — the panel reports the refusal and the stored
  value stays as it was.
- **The device table is authoritative in memory.** Mirroring it back into
  settings can fail — a read-only provider, a disk that will not take the write —
  and when it does, this plugin logs a line and carries on: pairings hold until
  the process ends rather than taking the whole agent host down with them.

### Tiers

Each admits everything below it.

| Tier | May |
| --- | --- |
| `observe` | List and read sessions, subagents, workspaces, skills, presets |
| `respond` | …and cancel a run or interrupt a subagent |
| `drive` | …and send messages, steer, edit the queue, start and rename sessions |
| `full` | …and fork, pick models, edit workspaces and goals |

`cancel` sits in `respond` rather than `drive` on purpose: somebody trusted to
watch a run should be able to end one going wrong without being trusted to
launch another.

## Install

```sh
dsh plugin --profile web add @omdsh-plugins/omdsh-remctrl
```

Or from a checkout, which is what M0 wants:

```sh
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

Then `dsh web`. Boot prints where to point a phone, and — only when nothing is
paired yet — a code to get in with:

```
omdsh-remctrl: listening on 127.0.0.1:3081; nothing off this machine can reach it yet.
omdsh-remctrl: put Tailscale in front of it — `tailscale serve --bg --https=443 http://127.0.0.1:3081` — …
omdsh-remctrl: no device is paired yet; pairing code 483212, good for 300s.
```

Remove it the same way:

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-remctrl
```

**What it needs from a profile.** One harness service: `connection`, which
carries the loopback control channel the desktop controls will call. The web
surface bundle composes it, so this row belongs in a profile that has a surface —
the one the line above installs it into. cordis waits for an injected service
forever and the boot audit fails the app for any entry left `pending`, so a
headless profile, which composes no `connection`, must not carry this row: that
is a dead boot rather than a quiet no-op.

No service published by another plugin appears in this plugin's `inject`, and
none is needed. There is no companion to install beside it and nothing here that
goes dark because one is missing — the rule, and why it is a rule, is in
[CONVENTIONS.md](https://omdsh-plugins.github.io/conventions/?lang=en#rule-9).
Removing the row takes the listener, the control channel and the settings
namespace with it, and leaves the rest of the profile exactly as it was.

Settings are additive, the way that convention asks. With no settings provider
composed — a test bench, a hand-built tree — the door still opens on whatever
the profile's patch entry configured, and the device table lives in memory only:
a phone paired against it pairs again after a restart. `dsh web` composes one,
so in the deployment above the table is durable and the rest is editable.

## Commands

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test          # 95 specs, and no harness checkout needed
```

The four files carrying the whole of this plugin's security — `bind.ts`,
`gate.ts`, `pairing.ts`, `devices.ts` — import nothing and take their clock,
their randomness, and their hash as arguments, so their behaviour is decided by
tests rather than by the machine running them.

## Known limitations

- **It will not listen on a public interface.** `bindHost` accepts loopback or
  an address this machine holds inside `100.64.0.0/10`, and nothing else. There
  is no override flag. A LAN address is refused; `0.0.0.0` is refused; a tailnet
  address belonging to another machine is refused. A refusal is printed at boot
  and the door stays shut.
- **It will not expose the configuration plane.** No `settings.*`, no
  `credentials.*`, no `host.*`, no `llm.*`, and no `agentPreset.openDocument` —
  as whole domains, at every tier, including `full`. A preset can be listed and
  read; the document behind it never opens. The method table is an allowlist and
  absence means no.
- **It will not put `/api` behind its door.** The harness carrier keeps its own
  port and its own fence; this listener serves this plugin and nothing else.
- **The pairing code is a boot line, not a control.** Until the desktop panel
  lands, the code is minted once, while nothing is paired; a second device has
  to wait for a restart of a harness with no devices on it, or for M1.

# omdsh-remctrl

English | [中文](README.zh.md)

Remote control for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
turn it on and this machine's own dsh window appears at a public address, behind
a passcode. Not a companion app and not a subset — the same sessions, the same
buttons, the same everything, because it *is* dsh, forwarded.

## What it adds

| Surface | Where it comes from |
|---|---|
| A second listener, in front of the harness's own | A `node:http` server this plugin binds; the harness's `webServer` never moves |
| The whole interface, at a public address | An HTTP and WebSocket reverse proxy to `127.0.0.1:<webServer.port>` |
| A passcode form at any path | The gate's own page, served in place of the app until a browser signs in |
| A session cookie | `HttpOnly; SameSite=Lax`, `Secure` under the tunnel; the only credential a foreign web app carries by itself |
| An `https://` address with no setup | A supervised `cloudflared` quick tunnel, spawned as a child process |
| One card in the Plugin hub | An entry in `omdsh.plugin.card`, `@omdsh-plugins/omdsh-plughub`'s slot |
| The switch, the passcode, the browser list, the door's log | `ctx.connection.rpc` at `authority: 'loopback'` |

## One way in

There is a single door and it is a reverse proxy. Requests arrive on a port this
plugin binds, the passcode decides whether they go any further, and the ones that
do are handed to the harness's own loopback port — HTTP and both WebSocket
downlinks, verbatim.

How that port becomes reachable is the only choice you have, and it has a
default:

- **Leave `publicHost` empty.** `cloudflared` opens an outbound quick tunnel and
  hands back an `https://….trycloudflare.com` name. Nothing to forward, no
  firewall to open, no certificate to arrange. This is the case for every laptop,
  and it is what happens if you change nothing but the switch.
- **Set `publicHost`** when this machine already has a public address —
  `121.43.252.12`, `harness.example.com`. The door binds every interface and
  people reach it directly. That is plain HTTP, so it stays shut until you set
  `allowInsecure` by hand.

Nothing else is configurable, because nothing else needs to be.

## What the passcode is holding

Everything.

An earlier version of this plugin served a small purpose-built app through a
method allowlist, at a tier the desktop chose, and could honestly say a phone was
less powerful than the desktop. Forwarding the real interface ends that promise,
and ends it deliberately: the proxy rewrites the `Host` header to loopback, which
is what makes the harness's own trust fence pass, and which means a signed-in
browser reaches every loopback-fenced method the desktop can — settings,
credentials, tool approvals, a shell.

So the controls around the passcode are not features. They are the design:

1. **Off by default.** `enabled` is `false`. Installing this plugin changes
   nothing about the machine until somebody opens its card and turns it on.
2. **Nothing is forwarded before the cookie resolves.** Not the index, not an
   asset, not a WebSocket handshake. A signed-out browser reaches the passcode
   form and two files, and that is the whole of the public surface.
3. **Six tries a minute, per address.** A ten-character passcode is fifty bits,
   which is not a key — it is a passcode with a token bucket in front of it, and
   the bucket is what makes ten characters enough to type on a phone.
4. **The provenance fence, re-imposed at the public boundary.** The harness
   refuses cross-site requests and mismatched `Origin`s, and rewriting `Host`
   upstream would remove its copy of that check — so the gate asks the same three
   questions first, about the address the browser actually used.
5. **A transport check.** Under the tunnel a request that did not arrive over
   HTTPS is refused with `421` *before* a credential is read off it, so a
   misconfigured carrier is one refusal rather than a session cookie in the clear.

A sixth thing follows from the shape rather than being added to it: the controls
ride `ctx.connection.rpc` at `authority: 'loopback'`, so they are the harness's
fence and not one written here. That fence now admits a signed-in browser too —
by design, and it cuts the useful way as often as not, because you can turn
remote control off from the phone you left the building with.

## Signing in

The card shows three things: the address, a link with the passcode already on it,
and the passcode itself.

Send the link to your phone and tap it. The gate takes the passcode off the
query, sets the cookie, and redirects to the same URL without it — so it is gone
from the address bar, though not from that browser's history, which is what a
magic link costs. Type the passcode instead if you would rather; case does not
matter and neither do dashes, and the alphabet has no `I`, `L`, `O` or `U` in it
so nothing is ambiguous on a screen.

A browser stays signed in for `sessionTtlDays`. The card lists every one that is,
signs any of them out at once, and signs out all of them together behind a
two-step confirmation. Minting a new passcode changes only the way
*in* — browsers already signed in stay signed in, because a passcode read over
your shoulder and a phone left in a taxi are different problems with different
answers.

## What happened at the door

The card keeps a log of it: every sign-in that worked, and every one that did
not, with the address it came from. A grant also prints a line the moment it
happens — `a new browser signed in — iPhone from 203.0.113.9` — so a terminal
that is open says it out loud.

A record rather than a notification, and the distinction is the point: a
notification reaches whoever is looking, and the case worth catching is the one
nobody was looking at. The log survives a restart, holds the last 50 events, and
carries a count of what is new since you last read it.

Failed attempts from one address fold into a single row with a count on it —
otherwise a machine grinding at the passcode, throttled to six a minute, would
still push every real event out of a bounded log inside ten minutes. Nothing is
said out loud until the sixth failure from an address, which is the point at
which it stops looking like somebody mistyping and its throttle budget is spent.

The log can be cleared, and clearing it **leaves one row saying so**. Anyone who
can sign in can clear it — it is behind the same passcode as everything else —
so the question is not whether an intruder can erase their tracks but whether
the erasure is visible. One row naming the time and the count costs nothing and
is what keeps a wiped log from looking exactly like a log where nothing ever
happened.

## On a phone

The harness's interface has no width media query anywhere in it. What it does
have is one breakpoint in JavaScript: below 1024px it collapses the sidebar to a
56px rail, so a phone already gets a rail plus a conversation rather than three
columns fighting over 390px.

Two things it does not handle, and this plugin adds both — to the forwarded copy
only, never to the window on your desk:

- **The keyboard.** The harness sizes itself at `height: 100%`, which on iOS
  resolves against the layout viewport — and the layout viewport does not shrink
  when the on-screen keyboard appears, so the composer ends up behind it with no
  page scroll to reach it. A few lines of script publish `visualViewport` as a
  custom property and the app is sized from that instead.
- **The expanded sidebar.** Tapping the rail re-expands it to 280px and leaves
  the conversation about 110px wide. On a narrow viewport it overlays the
  conversation instead of taking a track from it.

Both hang off `data-shell-overlay` and `data-sidebar-collapsed`, the two
attributes the harness's frame writes deliberately — never a CSS-module class,
every one of which is a build hash. A harness that stopped writing them leaves
the page exactly as it ships rather than broken.

## Configuration

Everything lives in the `omdsh-remctrl` settings namespace, and the card in the
Plugin hub is the form for it. Five fields, of which most people touch one.

| Field | Default | What it is |
|---|---|---|
| `enabled` | `false` | The switch. Nothing listens until it is on. |
| `publicHost` | `''` | The address people reach this machine at, if it has one. Empty means `cloudflared` fetches one. No scheme, no port. |
| `port` | `3081` | The port the door listens on — not the harness's own. |
| `allowInsecure` | `false` | Serve a `publicHost` over plain HTTP. Required before one will open at all. |
| `sessionTtlDays` | `30` | How long a signed-in browser stays signed in. `0` means forever. |

Three more are written by the plugin: `passcode`, minted the first time you turn
it on and declared `.role('secret')`; `browsers`, which holds a hash of each
session token and never a token; and `access`, the door's log.

## Install

```sh
npx @omdsh-plugins/omdsh-plughub add omdsh-remctrl
```

That is the [plugin hub](https://github.com/omdsh-plugins/omdsh-plughub)'s own
installer with argv instead of a button. It resolves this plugin through the
collection's [registry](https://github.com/omdsh-plugins/registry), installs it
from its GitHub repository, and writes the pnpm build-allowlist entry — which a
bare `dsh plugin add github:…` leaves to you, and which carries a commit hash
pnpm resolves, so it can only be copied out of an error message afterwards.

`dsh plugin --profile web add @omdsh-plugins/omdsh-remctrl` is **not** that
command yet: this package is not on npm, and pnpm answers
`ERR_PNPM_FETCH_404`. The same install is also a button, on this plugin's card
under **Settings → Plugins → Plugin hub**, whenever the hub is already in the
profile.

Or from a checkout, which is what an unpublished build wants:

```sh
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

Remove it the same way:

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-remctrl
```

`cloudflared` is not bundled and is not installed for you. On macOS:
`brew install cloudflared`; otherwise see
[Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
The card says so when it is missing, and a machine with a `publicHost` never
needs it.

The off states, per CONVENTIONS rule 9. Without
`@omdsh-plugins/omdsh-plughub` the card has no slot to sit in and withdraws;
every value stays editable through the hub's generic form or the settings file.
Without a `webServer` — a TUI profile — there is no interface to forward, and the
plugin says so instead of opening a door onto nothing. Without `settings` the
passcode and the signed-in browsers live in memory until restart. A `remove`
leaves the settings section behind, so reinstalling keeps the passcode.

## Commands

```sh
pnpm install
pnpm run build        # tsdown bundles the host and browser halves
pnpm run typecheck
pnpm run test
pnpm run harness:local   # point the harness dependencies at a local checkout
pnpm run harness:npm     # point them back at the published versions
pnpm run check:harness-pin
```

## Known limitations

- **A signed-in browser is the desktop.** There are no tiers and no read-only
  mode. That is what forwarding the real interface means, and it is why the
  passcode is the whole of the security.
- **A quick tunnel's hostname changes on every restart.** Cloudflare's
  account-less tunnels are ephemeral and carry no uptime guarantee, so the card
  shows the current address rather than a saved one, and a link you sent
  yesterday will not work today. A named tunnel is not supported yet.
- **Everything crosses Cloudflare.** Under the default carrier the TLS is
  theirs, so the traffic is in the clear on their side of it. `publicHost` with
  your own reverse proxy in front is the answer if that matters.
- **The details pane is unreachable on a phone.** The harness's column solver
  closes it whenever the conversation would fall below 640px, which is always on
  a phone, and nothing in the forwarded DOM distinguishes "closed because it
  does not fit" from "closed because you closed it".
- **The phone stylesheet is unverified on hardware.** It is written from the
  harness's own layout source and covered by tests that read it, not by a device.
- **One tunnel, one door.** Two harnesses on one machine need two ports, set by
  hand; nothing here discovers a free one.

# omdsh-remctrl — design notes

The decisions behind `@omdsh-plugins/omdsh-remctrl` 0.2, written down where the
reasoning is not obvious from the code. Not a specification: the modules carry
their own contracts, and the tests carry the behaviour. What is here is the
argument.

## 0. What changed in 0.2, and why the old design is gone

0.1 was a **companion app**. It served four hand-written screens on its own
port, spoke to the harness through an allowlist of `apiProxy` methods, and
issued device tokens at one of four tiers (`observe`, `respond`, `drive`,
`full`). A phone at `observe` could watch and nothing else. The whole design
rested on the phone reaching a *different, smaller* surface than the desktop.

0.2 forwards the harness's own interface instead. The instruction was explicit:
one way in, one field to fill, and what you see remotely must be what you see
locally — same UI, same interaction, no second implementation to drift.

That is not a refinement of 0.1, it is the opposite of it, and it costs the one
property 0.1 was built around:

> **A signed-in browser is the desktop.** Tiers cannot exist, because the thing
> being served is not ours to subset.

Everything below follows from taking that seriously rather than working around
it. Deleted with the old design: `pairing.ts` (ephemeral codes), `gate.ts`'s
tier tables, `proxy.ts` (the method allowlist), `stream.ts` (SSE), `tunnel.ts`
and `knownhosts.ts` (the ssh2 reverse tunnel), and all four `mobile/` screens.

## 1. The Host header, and why rewriting it is not a hole

`@deepseek-ai/dsh-client-connection` fences `/api` and both WebSocket downlinks
behind `isTrustedApiRequest`, which asks three questions:

1. Is `Host` loopback, or a declared `trustedHosts` authority?
2. Is `sec-fetch-site` anything other than `cross-site`?
3. If an `Origin` is present, does it equal the `Host`?

Measured against the running harness before any of this was written:

```
POST /api/sessions/list   Host: 127.0.0.1:62886    → passes
POST /api/sessions/list   Host: example.com        → 403
```

So forwarding a request with `Host: something.trycloudflare.com` gets a 403, and
every reverse proxy in the world answers that the same way: it rewrites `Host`,
because a reverse proxy **is** the client as far as the upstream is concerned.
`reverse.ts` rewrites `Host` and `Origin` together, since the fence compares
them.

The objection 0.1's own module comment raised against exactly this — *"a proxy
that rewrote Host to loopback would open every privileged method to whoever
reached the proxy"* — is correct, and it is answered rather than dismissed:

**The fence is not removed. It is moved one hop out, to the only place that can
see the name the browser actually typed.** `gate.ts` asks the same three
questions about the public origin, before anything is forwarded. Rebinding is
still caught (a rebound page carries the attacker's domain in `Host`, and the
gate compares `Origin` against that same `Host`); cross-site reads are still
caught (`sec-fetch-site`); and the thing 0.1 relied on instead — a narrow
allowlist — is replaced by a credential the harness never had.

What genuinely changes is the authority a signed-in browser holds. That is the
feature.

## 2. Why the credential is a cookie

Not a preference. The thing being carried is a whole web application this plugin
did not write:

- its RPC calls are `fetch` with no `Authorization` header,
- its two downlinks are `new WebSocket(url)`, which cannot set request headers
  at all,
- its assets are `<script src>` and `<link rel=stylesheet>`.

Nothing in this process can attach a header to any of those. A cookie is the one
credential every one of them carries by itself — so the attributes are the
security, not decoration:

| Attribute | What it buys |
|---|---|
| `HttpOnly` | An XSS in the harness's page cannot walk off with the session |
| `SameSite=Lax` | The cookie rides a top-level navigation (a QR, a link in a message, a bookmark) and rides nothing else — the whole CSRF defence for an app with no CSRF tokens |
| `Secure`, under the tunnel only | Setting it on a plaintext origin means the browser never sends it back: a sign-in that appears to work and silently does not |
| `Path=/` | The forward serves the whole origin |

`stripCookie` removes it again on the way upstream. The harness reads no
cookies, so this changes no behaviour — what it changes is *where the token
exists*: a credential granting shell access never appears in a second server's
request headers, and therefore never in anything that server logs.

## 3. The gate asks three questions, in this order

`gate.ts` is one pure function with no I/O anywhere near it, because everything
this plugin protects is behind one `if`.

1. **Transport.** Under the tunnel, a request whose `x-forwarded-proto` is not
   `https` is refused `421` — *before* a credential is read off it. A
   misconfigured carrier is then one refusal rather than a session cookie in the
   clear. Ordering is the point: putting identity first would mean the cookie
   had already been read and compared.
2. **Provenance.** A cross-site request that is **not** a top-level navigation
   is refused, and so is a mismatched `Origin`. A cross-site *navigation* is
   allowed, deliberately: a QR in a photo, a link in a chat app and a bookmark
   all arrive `sec-fetch-site: cross-site`, a navigation cannot read the
   response cross-origin, and `SameSite=Lax` already decides whether the cookie
   rides (a cross-site POST navigation arrives signed out).
3. **Identity.** Only then does a cookie mean anything.

Two verdicts rather than one for the unauthenticated case, and it matters:
a **navigation** gets the passcode form at the path it asked for, so the form
can send you back there; anything else gets `401`. An app that asked for JSON
and received HTML reports a parse error, which is a much worse thing to debug
than a status it can read.

## 4. Ten characters, and the bucket that makes them enough

The passcode is 10 characters of Crockford base32 without `I`, `L`, `O`, `U` —
50 bits. On its own that is not a key. With `SIGN_IN_RULE` (6 tries, one back a
minute, per address) walking it takes on the order of 10^14 years, and the
number was chosen for the person who mistypes rather than for the attacker.

Three details that are not incidental:

- **The lookalikes are folded, not refused.** Somebody reading `0` off a screen
  types `O` about half the time. `normalizePasscode` maps `I`/`L`→`1`, `O`→`0`,
  `U`→`V` — safe precisely because none of the four is ever minted.
- **The throttle is spent before the comparison and refunded after a correct
  one.** A wrong answer costs a token whether or not it was close; a person who
  mistypes once is not still paying for it a minute later. Spending only on
  failure would make the throttle free to probe.
- **The comparison is constant-time.** The bucket bounds how fast a prefix could
  be walked, but a comparison that does not leak is cheaper than an argument
  about how much leaking the bucket absorbs.

`resetPasscode` does **not** sign anybody out. The passcode is how you get in,
not what keeps you in, and conflating the two would mean every reset signs out
the laptop you are holding. A passcode read over your shoulder and a phone left
in a taxi are different problems: one is fixed by minting, the other by
revoking.

## 5. The carrier is derived, and so is the proxy trust

0.1 had a four-rung exposure ladder (`loopback` / `tailnet` / `proxied` /
`public`), a separate `bindHost` override, and a `trustedProxyHops` number. Any
two of them could contradict each other, and finding out took a boot line.

0.2 has one field, and the **shape** of what you write in it says which
deployment you have. A second setting saying "and there is a proxy in front"
could disagree with the first, and in 0.1 it regularly did; a field cannot
disagree with itself.

| `publicHost` | Carrier | Binds | `x-forwarded-*` | Acknowledgement |
|---|---|---|---|---|
| `''` | `tunnel` | `127.0.0.1` | believed, exactly 1 hop | — |
| a tailnet address this machine holds | `direct` | that address | not believed | **none** |
| any other address it holds | `direct` | that address | not believed | `allowInsecure` |
| an address it cannot hold, or a bare name | `direct` | `0.0.0.0` | not believed | `allowInsecure` |
| `https://…` | `fronted` | `127.0.0.1` | believed, 1 hop | **none** |
| `http://…` | `fronted` | `127.0.0.1` | not believed | `allowInsecure` |

The `fronted` rows are one insight: **every way of putting something in front —
a Caddy on this box, an `ssh -R` from a VPS, an `frp`, a named Cloudflare tunnel
— reaches this process on loopback.** So the bind is not a choice, and what is
left to decide is what that carrier promised, which is exactly what the URL's
scheme records. `https` means it terminated TLS, which means it is a reverse
proxy, which means it sets `x-forwarded-*`. `http` means it did not, and the
`ssh -R` shape sets no headers at all — so nothing is believed, and the throttle
keys every sign-in to `127.0.0.1`. One shared bucket is a weaker throttle and a
safer one: nobody mints themselves fresh budgets, and exhausting it locks out
sign-in but not the browsers already signed in.

Turning a URL from "a paste mistake to be refused" into "the way to say *I am
reached THERE, not here*" is what let this stay at one field. The field is still
called `publicHost`, which is now slightly narrow for what it holds — renaming a
settings key that live deployments already carry is a worse trade than a name
that needs its description read.

Both header rules are forced rather than chosen. Under the tunnel every request
arrives from a `cloudflared` **this process spawned**, on this machine's own
loopback, so the socket address is useless and the header is the only place the
client's address exists — and it is exactly one hop because it is exactly one
process. Under a direct bind the socket peer *is* the client and every
`x-forwarded-*` header on the request was written by that client; believing one
would hand a single attacker a throttle bucket per address they care to invent.

The three `direct` rows are one rule, not three cases: **bind the address if
this machine holds it, the wildcard if it cannot.** Both halves are forced.

- A cloud VM's public address belongs to the provider's NAT and is on no local
  interface, so binding it verbatim fails with `EADDRNOTAVAIL` on precisely the
  machines that carrier exists for. The wildcard is the only thing that works.
- A tailnet address IS on a local interface, and binding the wildcard for it
  would put a plaintext port on every OTHER network the laptop joins — the café
  Wi-Fi, the hotel LAN — for no benefit whatsoever.

Matching is on **literals only**. Resolving a name would be I/O inside a
decision that has to stay decidable, and it would also be the wrong answer most
of the time: somebody who writes `harness.example.com` has a DNS record pointing
at a public address, and a public address is exactly the case that must bind the
wildcard. The cost is that a name plus a narrow bind — a Caddy on loopback in
front — cannot be expressed. Written down in the README as a limitation rather
than papered over.

`allowInsecure` survives from 0.1 as the one acknowledgement in the plugin, and
it is a refusal rather than a warning: a wide `direct` bind does not open
without it. **A tailnet bind needs none**, and that is not a shortcut: the
acknowledgement exists because the session cookie would cross a wire somebody
else can read, and inside WireGuard it does not. `100.64.0.0/10` on a local
interface is not *proof* of WireGuard — an ISP doing carrier-grade NAT uses the
same block — but such an address is not routable from the internet either way,
so the worst case is a plaintext port reachable by other customers of one ISP
rather than by everybody.

## 6. cloudflared, supervised

A child process, not a library, and the process is a dependency injected into
`Cloudflared` so the supervision is decided by tests rather than by a network.

- **The URL is matched, not parsed.** `cloudflared` prints it inside an ASCII
  box whose padding has changed between versions; the name is the only stable
  thing in it. Everything goes to **stderr**, including the banner — verified
  against 2026.8.2.
- **`EXTRA_PATHS` names Homebrew's prefixes.** A GUI application on macOS
  inherits `launchd`'s `PATH`, not a login shell's, which is exactly how
  `cloudflared` ends up on `PATH` in every terminal the person owns and
  invisible to the app they are actually running.
- **A missing binary is reported once and never retried.** It is a fact about
  the machine that will not change while the process runs; a supervisor
  reporting it every two seconds forever is noise rather than news. The card
  says what to install; turning the switch again is the retry.
- **`start()` is idempotent on an unchanged port.** A settings write that
  touched something else must not tear down a working tunnel and hand the person
  a new hostname for no reason — quick tunnel names are ephemeral, so a restart
  invalidates every link already sent.
- **A run that never prints a URL is a failure.** `URL_TIMEOUT_MS` catches the
  process that starts, stays up, and carries nothing.
- **Retry timers are `unref`'d.** A pending retry must not be the reason the
  process stays alive through shutdown.

## 7. Injecting into another repository's DOM

The harness's interface has **no width media query anywhere in it**. It has one
breakpoint in JavaScript: below `SIDEBAR_AUTO_COLLAPSE` (1024px) `AppFrame`
collapses the sidebar to a 56px rail. On a 390px iPhone `computeColumns` then
resolves to a 56px rail and a 334px conversation — usable, which is why
`mobile.ts` is a stylesheet rather than a rewrite.

Two things that breakpoint does not cover:

- **`height: 100%`** (`base.css`) resolves against the *layout* viewport, and
  iOS does not shrink that for the on-screen keyboard. The composer ends up
  behind it with no page scroll to reach it — you can type and you cannot send.
  `MOBILE_JS` publishes `visualViewport.height` and `.offsetTop` as custom
  properties; `MOBILE_CSS` sizes the app from them, falling back to the
  harness's own rule when the script did not run.
  `interactive-widget=resizes-content` in the viewport meta is the declarative
  half — Chrome honours it, iOS Safari does not, so both ship.
- **The expanded sidebar** takes a 280px track and leaves the conversation about
  110px. Below `PHONE_WIDTH` it overlays instead. The **collapsed** rail keeps
  its track, because the rail's logo is the only control that reopens the
  drawer.

The selectors hang off `data-shell-overlay` and `data-sidebar-collapsed` — the
two attributes `AppFrame` writes deliberately — and never off a class name,
every one of which is a CSS-module build hash. A harness that stopped writing
them leaves the page exactly as it ships rather than broken.

The injection happens **in the proxy**, not through `webServer.tapIndex`. A tap
would change the page for the person sitting at the machine too.

## 8. Where the controls live

Minting a passcode, revoking a browser, and every editable field ride
`ctx.connection.rpc` at `authority: 'loopback'`. The fence is therefore the
harness's `isTrustedApiRequest` rather than one written here.

In 0.1 that fence was a wall: the phone was on a different door and could not
address the channel at all. **In 0.2 it is not**, and that is worth stating
rather than discovering: the forward rewrites `Host` to loopback, so a signed-in
browser reaches the control channel too. It can read the passcode, change the
port, and switch the whole thing off.

That is not a hole in the gate — it is what "the same interface" means, and it
cuts the useful way as often as not: a person who left remote control on can turn
it off from the phone they left with. What still holds is that **nothing**
reaches it before the passcode does.

`parsePatch` remains field-by-field for the same reason it always was: the
settings section also holds `passcode` and `browsers`, and a whole-object cast
would let a write install a session token hash of its own choosing. Twenty lines,
defence in depth.

## 9. What Cloudflare actually sends

Measured at the origin through a live quick tunnel, because two gates read these
headers and getting either wrong is silent:

```
x-forwarded-proto: https          ← the transport gate passes on this
x-forwarded-for:   <client IP>    ← one entry, so `hops: 1` from the right is the client
cf-connecting-ip:  <same>
cf-visitor:        {"scheme":"https"}
accept-encoding:   gzip           ← REWRITTEN; the client's value never arrives
sec-fetch-mode:    <passed through unchanged>
```

Two consequences worth writing down:

- **`accept-encoding` is replaced with `gzip` by Cloudflare**, whatever the
  browser asked for. `isRewritableHtml` therefore skips a body the upstream
  chose to compress — which today is none, because the harness's static server
  compresses nothing, but it is why that guard exists rather than being a
  hypothetical.
- **`sec-fetch-*` passes through**, so the provenance gate sees what the browser
  sent. Worth knowing because Node's own `fetch` (undici) stamps
  `sec-fetch-mode: cors` on every request and forbids overriding it — a spec
  that reaches the door with `fetch` is *never* a navigation, and the two checks
  that looked like failures were the client, not the gate.

## 10. What is verified, and what is not

Verified through the **`direct`** carrier against the running desktop app
(12/12):

- an unauthenticated navigation gets the form, not the app; `/api` gets 401; the
  WebSocket upgrade is refused
- a wrong passcode issues nothing; the right one issues a cookie
- the **real** harness index comes through, with the viewport rewritten exactly
  once, and its hashed assets with it
- `/api` passes the harness's own Host fence through the rewrite
- `/api/events.mux` upgrades and carries live `server-request` frames
- a cross-site request with a valid cookie is refused
- sign-out revokes the session immediately

Verified through the **`tunnel`** carrier over a live `cloudflared` quick tunnel,
against a throwaway upstream so nothing real was exposed (8/8):

- the binary is found, spawned, and its URL parsed out of the banner
- the public URL answers with the passcode form, in the language the request
  asked for
- the transport gate passes, which is `x-forwarded-proto` arriving as `https`
- the cookie comes back marked `Secure`
- a signed-in request reaches the upstream with `Host` rewritten to loopback
- the `?k=` link signs in and redirects to the URL without it
- the phone stylesheet is served by the gate rather than forwarded

Not verified:

- **the phone stylesheet on hardware.** It is written from the harness's layout
  source and covered by tests that read it, not by a device.
- **the card in a real browser.** Covered by jsdom rendering only.
- **a real public IP.** The `direct` carrier has been exercised end to end, but
  bound to loopback — never on a machine with a public address in front of it.
- **a real reverse proxy.** The `fronted` carrier is verified end to end (5/5)
  against a hand-built proxy that sets the headers Caddy sets, in front of the
  live harness — including that a request bypassing the carrier is refused 421 —
  but never against Caddy, nginx or an actual `ssh -R`.
- **a real tailnet.** The bind rule and the acknowledgement waiver are covered
  by tests over a synthetic address list; no machine in the loop has run
  Tailscale.
- **the harness's own interface, on a phone, through the tunnel.** Each half of
  that is verified; the composition is not.

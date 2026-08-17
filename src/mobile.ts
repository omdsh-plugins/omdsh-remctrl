/**
 * The one edit this plugin makes to what it forwards, and the only thing here
 * that is about phones.
 *
 * The harness's interface has **no width media query anywhere in it**. It is a
 * desktop application that happens to run in a browser, and it was never asked
 * to be anything else. What it does have is one breakpoint in JavaScript:
 * below 1024px `AppFrame` auto-collapses the sidebar to a 56px rail, so an
 * iPhone already gets a rail plus a conversation rather than three columns
 * fighting over 390px. That is most of the way there, and it is why this file
 * is a stylesheet rather than a rewrite.
 *
 * Two things it does not handle, and both are load-bearing on a real phone:
 *
 * 1. **The keyboard.** `base.css` sizes `html, body, #root` at `height: 100%`,
 *    which on iOS resolves against the LAYOUT viewport — and the layout
 *    viewport does not shrink when the on-screen keyboard appears. A composer
 *    pinned to the bottom of a full-height column therefore ends up behind the
 *    keyboard, with no page scroll to reach it: you can type and you cannot
 *    send. `visualViewport` is the only thing that reports the area actually
 *    visible, so a few lines of script publish it as a custom property and the
 *    stylesheet sizes the app from that.
 * 2. **The expanded sidebar.** Tapping the rail's logo re-expands the sidebar
 *    to its 280px preference, and `computeColumns` gives the center whatever is
 *    left — about 110px on an iPhone. The panel is reachable and the
 *    conversation behind it is not. Overlaying the sidebar instead of granting
 *    it a track keeps both usable.
 *
 * ## How it identifies another repository's DOM
 *
 * Not by class name: every one of them is a CSS-module hash that changes when
 * the harness rebuilds. The hooks used here are the two things `AppFrame`
 * writes deliberately and would have to mean to change — `data-shell-overlay`
 * on the overlay layer it owns, and `data-sidebar-collapsed` on the frame — so
 * the selectors survive a rebuild, and a harness that dropped them leaves the
 * page exactly as it ships rather than broken.
 *
 * Injected here rather than through the harness's own `webServer.tapIndex`,
 * and the distinction is the whole reason this file is small: a tap would
 * change the page for the person sitting at the machine too. This runs inside
 * the proxy, so only a browser that came through the gate sees it.
 * @module @omdsh-plugins/omdsh-remctrl/mobile
 */

import { GATE_ROUTES } from './contract.ts'

/**
 * The viewport declaration a phone needs.
 *
 * `width=device-width` is what stops mobile Safari rendering at 980px and
 * shrinking; the harness's own index already has it. What it does not have is
 * `viewport-fit=cover` (so the page reaches under the notch and the home
 * indicator, with `env(safe-area-inset-*)` available to pad back) or
 * `interactive-widget=resizes-content` (so the on-screen keyboard shrinks the
 * layout viewport rather than sliding a fixed-height page up behind itself).
 *
 * The second is the declarative half of the keyboard fix. Chrome on Android
 * honours it; iOS Safari does not, which is why {@link MOBILE_JS} exists —
 * both are shipped because each covers what the other misses.
 */
export const VIEWPORT
  = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content'

/** The `<meta name="viewport">` tag as it should end up. */
const VIEWPORT_TAG = `<meta name="viewport" content="${VIEWPORT}">`

/**
 * The referrer policy the forwarded page gets, and the harness's own does not.
 *
 * The harness index declares no policy, so browsers apply their default —
 * `strict-origin-when-cross-origin`, which sends `Referer: <origin>/` on a
 * cross-origin navigation. Locally that leaks `http://127.0.0.1:62886`, which
 * is nobody's business and also nothing. Through a tunnel it leaks the tunnel's
 * hostname to whatever site the agent just rendered a link to.
 *
 * That hostname is not a credential — the passcode is — but it is the one thing
 * standing between "a stranger has to find this door" and "a stranger has been
 * handed its address". `no-referrer` costs nothing: the harness reads no
 * `Referer` of its own, and `reverse.ts` drops the header on the way upstream
 * anyway.
 */
const REFERRER_TAG = '<meta name="referrer" content="no-referrer">'

/** Finds the existing viewport meta, however it was spelled. */
const VIEWPORT_PATTERN = /<meta\s+[^>]*name=["']?viewport["']?[^>]*>/i

/** The marker that says this document has already been through here. */
const MARKER = 'data-omdsh-remctrl'

/**
 * The custom property carrying the height actually visible right now.
 *
 * Named with the package prefix because it is set on `documentElement`, which
 * belongs to somebody else's application.
 */
export const VH_PROPERTY = '--omdsh-remctrl-vh'

/** The custom property carrying how far the visual viewport has scrolled down. */
export const VT_PROPERTY = '--omdsh-remctrl-vt'

/**
 * The width below which this plugin considers the browser a phone.
 *
 * Wider than a phone in portrait and narrower than the harness's own 1024px
 * sidebar breakpoint, so a tablet in landscape keeps the desktop layout and an
 * iPhone in landscape (up to 956px on a Pro Max) does not.
 */
export const PHONE_WIDTH = 760

/**
 * Whether the viewport meta is not already the one this module writes.
 * @param html - the document.
 * @returns whether {@link withViewport} would change anything.
 */
export function needsViewportFix(html: string): boolean {
  return !html.includes(VIEWPORT_TAG)
}

/**
 * Whether this document has already been through {@link indexTransform}.
 *
 * A transform that ran twice would stack two stylesheets and two scripts, and
 * which one wins differs between browsers. The marker is an attribute on the
 * tags themselves rather than a separate comment, so it cannot survive a
 * document the tags did not.
 * @param html - the document.
 * @returns whether the tags are already in it.
 */
export function isRewritten(html: string): boolean {
  return html.includes(MARKER)
}

/**
 * Replace the index's viewport declaration, or add one.
 * @param html - the document.
 * @returns the document, with exactly one viewport meta.
 */
export function withViewport(html: string): string {
  if (!needsViewportFix(html)) return html
  if (VIEWPORT_PATTERN.test(html)) return html.replace(VIEWPORT_PATTERN, VIEWPORT_TAG)
  // No viewport at all: put one immediately after the opening head tag, which
  // is early enough for every engine that reads it.
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) return html
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n${VIEWPORT_TAG}${html.slice(at)}`
}

/**
 * The stylesheet a remote phone gets, and the desktop does not.
 *
 * Everything is inside one width query, so a laptop reaching the same URL gets
 * a document that differs from the local one by a viewport meta and two
 * inert tags.
 */
export const MOBILE_CSS = `/* omdsh-remctrl: served only to browsers that came through the gate. */
@media (max-width: ${String(PHONE_WIDTH)}px) {
  /* The app box follows the VISUAL viewport rather than the layout one, so the
     on-screen keyboard shrinks the app instead of covering its composer. The
     fallback is the harness's own rule, so a browser without visualViewport —
     or one where the script did not run — is exactly where it started. */
  html, body, #root {
    height: var(${VH_PROPERTY}, 100%);
  }
  #root {
    position: relative;
    /* iOS scrolls the page under the keyboard as well as shrinking the visual
       viewport; without this the app is the right size and in the wrong place. */
    top: var(${VT_PROPERTY}, 0px);
  }
  body {
    /* Rubber-banding a fixed-height app reveals the page background and drags
       the whole layout with it. */
    overscroll-behavior: none;
    /* Safari inflates text in landscape unless told not to. */
    -webkit-text-size-adjust: 100%;
  }

  /* The frame, identified by the overlay layer it owns rather than by a
     CSS-module hash that changes on every harness build. Expanded, the sidebar
     overlays the conversation instead of squeezing it to about 110px; the
     collapsed rail keeps its track, because the rail's logo is the only way
     to open the drawer again. */
  div:has(> [data-shell-overlay]):not([data-sidebar-collapsed]) {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  div:has(> [data-shell-overlay]):not([data-sidebar-collapsed]) > :first-child {
    position: absolute;
    inset: 0 auto 0 0;
    width: min(86vw, 320px);
    z-index: 25;
    /* The scrim is the drawer's own shadow rather than an element, because an
       element would have to be inserted into a tree this plugin does not own. */
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 45%);
  }
}
`

/**
 * The script a remote phone gets.
 *
 * Fifteen lines, no framework, and it touches nothing but two custom
 * properties on `documentElement`. Written as a string rather than built,
 * because building it would put a second bundle target in this package for
 * something a person can read in one screen.
 */
export const MOBILE_JS = `(function () {
  var viewport = window.visualViewport
  if (!viewport) return
  var root = document.documentElement
  var apply = function () {
    root.style.setProperty('${VH_PROPERTY}', viewport.height + 'px')
    root.style.setProperty('${VT_PROPERTY}', viewport.offsetTop + 'px')
  }
  viewport.addEventListener('resize', apply)
  viewport.addEventListener('scroll', apply)
  window.addEventListener('orientationchange', apply)
  apply()
})()
`

/**
 * The transform the forward applies to every `text/html` response.
 * @param html - the document, as the harness produced it.
 * @returns the document a remote browser receives.
 */
export function indexTransform(html: string): string {
  if (isRewritten(html)) return html
  const withMeta = withViewport(html)
  const tags = REFERRER_TAG
    + `<link rel="stylesheet" href="${GATE_ROUTES.mobileCss}" ${MARKER}>`
    + `<script src="${GATE_ROUTES.mobileJs}" ${MARKER} defer></script>`
  const close = withMeta.toLowerCase().lastIndexOf('</head>')
  // Last in the head, so the stylesheet's `!important` lands after the
  // harness's own sheets in source order as well as in specificity.
  if (close < 0) return `${withMeta}${tags}`
  return `${withMeta.slice(0, close)}${tags}${withMeta.slice(close)}`
}

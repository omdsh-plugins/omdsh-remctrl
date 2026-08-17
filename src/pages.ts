/**
 * The only pages this plugin writes: a passcode form and two refusals.
 *
 * Everything else a browser sees here is the harness's own interface, forwarded
 * byte for byte. These three exist because they are answers the harness cannot
 * give — it does not know it is behind a gate, and a person looking at a blank
 * tab after scanning a QR needs a sentence rather than a status code.
 *
 * Self-contained documents with inline styles, deliberately: they are served
 * before a browser is signed in, so anything they linked to would have to be
 * reachable before a browser is signed in, and a second public route is a
 * second thing to get wrong.
 * @module @omdsh-plugins/omdsh-remctrl/pages
 */

import { GATE_ROUTES, PASSCODE_LENGTH } from './contract.ts'

/** The two languages the gate's own pages speak. */
export type PageLang = 'en' | 'zh'

/**
 * Which language to write a page in.
 *
 * The gate's pages are served before any harness code runs, so the harness's
 * own locale setting is not available to them — and would be the wrong answer
 * anyway. The person reading this page is on a phone that may not be the
 * machine the harness is configured on, and `Accept-Language` is what that
 * phone says about itself.
 * @param header - the `Accept-Language` header, if there was one.
 * @returns the language to write in.
 */
export function pickLang(header: string | string[] | undefined): PageLang {
  const raw = (Array.isArray(header) ? header[0] : header) ?? ''
  return /(^|,|\s)zh\b/i.test(raw) ? 'zh' : 'en'
}

/** Everything the gate's pages say, in both languages. */
const TEXT = {
  en: {
    title: 'Remote control',
    lede: 'This is a DeepSeek Harness, opened for remote use. Enter the passcode shown on the desktop.',
    label: 'Passcode',
    submit: 'Continue',
    wrong: 'That passcode is not right.',
    throttled: 'Too many attempts. Wait a moment and try again.',
    noPasscode: 'No passcode is set, so nothing can sign in. Open the plugin\'s card on the desktop.',
    hint: `${String(PASSCODE_LENGTH)} characters, letters and digits. Case does not matter.`,
    refusedTitle: 'This request was refused',
    insecure: 'Reach this page over https.',
  },
  zh: {
    title: '远程控制',
    lede: '这是一台开放了远程访问的 DeepSeek Harness。请输入桌面端显示的通行码。',
    label: '通行码',
    submit: '继续',
    wrong: '通行码不对。',
    throttled: '尝试次数过多，请稍后再试。',
    noPasscode: '尚未设置通行码，因此无法登录。请在桌面端打开本插件的卡片。',
    hint: `${String(PASSCODE_LENGTH)} 位，字母和数字，不区分大小写。`,
    refusedTitle: '这个请求被拒绝了',
    insecure: '请通过 https 打开本页面。',
  },
} as const

/** Why a sign-in page is being shown again. */
export type SignInError = 'wrong' | 'throttled' | 'no-passcode'

/**
 * The passcode form.
 * @param options - where to go afterwards, what went wrong last time, and the language.
 * @returns the whole document.
 */
export function signInPage(options: {
  next: string
  error?: SignInError
  lang: PageLang
}): string {
  const text = TEXT[options.lang]
  const problem = options.error === undefined
    ? ''
    : `<p class="bad" role="alert">${escapeHtml(
      options.error === 'wrong' ? text.wrong : options.error === 'throttled' ? text.throttled : text.noPasscode,
    )}</p>`
  return document(options.lang, text.title, `
<form method="post" action="${GATE_ROUTES.signIn}">
  <h1>${escapeHtml(text.title)}</h1>
  <p class="lede">${escapeHtml(text.lede)}</p>
  ${problem}
  <label for="passcode">${escapeHtml(text.label)}</label>
  <input id="passcode" name="passcode" type="text" required
         autocapitalize="characters" autocorrect="off" autocomplete="off"
         spellcheck="false" enterkeyhint="go" autofocus
         maxlength="64" aria-describedby="hint">
  <p id="hint" class="hint">${escapeHtml(text.hint)}</p>
  <input type="hidden" name="next" value="${escapeHtml(options.next)}">
  <button type="submit">${escapeHtml(text.submit)}</button>
</form>`)
}

/**
 * A refusal, in prose.
 *
 * Served at the moment of the refusal rather than fetched, because the person
 * reading it typed something into a phone and needs a sentence — not an empty
 * screen and a failed request in a console they do not have.
 * @param options - the message, the status, and the language.
 * @returns the whole document.
 */
export function refusalPage(options: {
  message: string
  status: number
  lang: PageLang
  /** Whether to add the "use https" line, which only helps on a transport refusal. */
  insecure?: boolean
}): string {
  const text = TEXT[options.lang]
  const extra = options.insecure === true ? `<p class="hint">${escapeHtml(text.insecure)}</p>` : ''
  return document(options.lang, text.refusedTitle, `
<div>
  <h1>${escapeHtml(text.refusedTitle)}</h1>
  <p class="lede">${escapeHtml(options.message)}.</p>
  ${extra}
  <p class="hint">HTTP ${String(options.status)}</p>
</div>`)
}

/**
 * The shell every gate page shares.
 *
 * One stylesheet, inline, sized for a phone first — this page's whole job is
 * to be readable on the device that just scanned a code, and the desktop is
 * the case where the same layout happens to also look fine.
 */
function document(lang: PageLang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68;
  --line: #e0e0dd; --field: #ffffff; --accent: #2b6cb0; --bad: #b42318;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171a; --fg: #ececef; --muted: #9a9aa2;
    --line: #2f2f35; --field: #202024; --accent: #6ea8fe; --bad: #ff8f85;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100dvh; display: grid; place-items: center;
  padding: max(1.5rem, env(safe-area-inset-top)) 1.25rem max(1.5rem, env(safe-area-inset-bottom));
  background: var(--bg); color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
form, body > div { width: 100%; max-width: 24rem; }
h1 { margin: 0 0 .5rem; font-size: 1.35rem; font-weight: 620; letter-spacing: -.01em; }
.lede { margin: 0 0 1.25rem; color: var(--muted); }
label { display: block; margin-bottom: .4rem; font-size: .9rem; font-weight: 560; }
input[type=text] {
  width: 100%; padding: .8rem .9rem; font: inherit; font-size: 1.1rem;
  letter-spacing: .14em; text-transform: uppercase;
  color: var(--fg); background: var(--field);
  border: 1px solid var(--line); border-radius: .6rem;
}
input[type=text]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hint { margin: .5rem 0 0; font-size: .82rem; color: var(--muted); }
.bad { margin: 0 0 1rem; padding: .6rem .8rem; border-radius: .5rem; font-size: .9rem;
       color: var(--bad); border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent); }
button {
  margin-top: 1.1rem; width: 100%; padding: .8rem 1rem; font: inherit; font-weight: 580;
  color: var(--bg); background: var(--fg);
  border: 0; border-radius: .6rem; cursor: pointer;
}
button:active { opacity: .85; }
</style>
</head>
<body>${body}
</body>
</html>
`
}

/**
 * Escape a string for HTML text content or a double-quoted attribute.
 *
 * Every interpolation in this module goes through it, including the ones whose
 * inputs this plugin wrote — `next` comes off a request URL, and an escape
 * that exists is one that cannot be forgotten when a second value starts
 * coming from outside.
 * @param value - the text.
 * @returns the text, safe between tags and inside quotes.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

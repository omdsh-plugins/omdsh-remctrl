/**
 * The phone's page, as three strings.
 *
 * Three files rather than one, and none of them inline, so the page can be
 * served under `default-src 'self'` with no `unsafe-inline` anywhere. A door
 * that hands out agent access is the wrong place to start relaxing a content
 * policy, and starting strict costs two extra routes.
 *
 * Strings rather than a build because M0's page is a code box and a sentence.
 * When it becomes the conversation view it earns a real bundle; the routes it
 * is served from will not change when it does.
 * @module @omdsh-plugins/omdsh-remctrl/mobile/assets
 */

import { MOBILE_ROUTES } from '../contract.ts'

/** The page shell. */
export const MOBILE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>omdsh remote</title>
<link rel="stylesheet" href="${MOBILE_ROUTES.css}">
</head>
<body>
<main id="app">
  <h1 id="title">omdsh</h1>

  <section id="pair" hidden>
    <p id="pair-hint"></p>
    <input id="code" type="text" inputmode="numeric" pattern="[0-9]*"
           autocomplete="one-time-code" maxlength="6" aria-labelledby="pair-hint">
    <button id="submit" type="button"></button>
    <p id="error" role="alert"></p>
  </section>

  <section id="paired" hidden>
    <p class="badge" id="paired-state"></p>
    <dl>
      <dt id="label-key"></dt><dd id="label-value"></dd>
      <dt id="tier-key"></dt><dd id="tier-value"></dd>
    </dl>
    <button id="forget" type="button" class="quiet"></button>
  </section>

  <section id="loading"><p id="loading-text"></p></section>
</main>
<script src="${MOBILE_ROUTES.js}"></script>
</body>
</html>
`

/** Its stylesheet. */
export const MOBILE_CSS = `:root {
  --bg: #f6f6f7;
  --fg: #17171a;
  --muted: #6b6b74;
  --card: #ffffff;
  --line: #e0e0e4;
  --accent: #2f6df6;
  --danger: #c0392b;
  --ok: #1f8b4c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131316;
    --fg: #ececf0;
    --muted: #9a9aa4;
    --card: #1c1c21;
    --line: #2e2e36;
    --accent: #6c9bff;
    --danger: #ff7a6b;
    --ok: #57c98a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  padding: max(24px, env(safe-area-inset-top)) 20px 32px;
}
main { max-width: 26rem; margin: 0 auto; }
h1 { font-size: 1.05rem; font-weight: 600; letter-spacing: .02em; color: var(--muted); margin: 0 0 1.5rem; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
p { margin: 0 0 1rem; }
#pair-hint, #loading-text { color: var(--muted); }
input {
  width: 100%;
  font: 600 2rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .35em;
  text-align: center;
  padding: 14px 0 14px .35em;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  color: var(--fg);
}
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button {
  width: 100%;
  margin-top: 14px;
  padding: 14px;
  font: 600 1rem/1 inherit;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
}
button[disabled] { opacity: .5; }
button.quiet { background: transparent; color: var(--danger); border: 1px solid var(--line); }
#error { margin: 1rem 0 0; color: var(--danger); min-height: 1.5rem; }
#error:empty { margin: 0; min-height: 0; }
.badge { color: var(--ok); font-weight: 600; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0 0 1.25rem; }
dt { color: var(--muted); }
dd { margin: 0; }
`

/** Its script. */
export const MOBILE_JS = `(function () {
  'use strict'

  var TOKEN_KEY = 'omdsh-remctrl.token'
  var zh = String(navigator.language || '').toLowerCase().indexOf('zh') === 0

  var text = zh ? {
    title: 'omdsh 远程控制',
    hint: '输入桌面端显示的 6 位配对码',
    submit: '配对',
    submitting: '配对中…',
    loading: '正在检查…',
    paired: '已配对',
    label: '设备',
    tier: '权限',
    forget: '在本机解除配对',
    network: '连不上宿主，检查 Tailscale 是否在线。',
    malformed: '请输入 6 位数字。',
    'no-code': '桌面端还没有出码，或者上一个码已经用掉了。',
    expired: '这个码过期了，请在桌面端重新出码。',
    mismatch: '码不对，还可以再试 ',
    mismatchTail: ' 次。',
    locked: '试错次数用完，这个码已作废，请在桌面端重新出码。'
  } : {
    title: 'omdsh remote',
    hint: 'Enter the 6-digit code shown on the desktop',
    submit: 'Pair',
    submitting: 'Pairing…',
    loading: 'Checking…',
    paired: 'Paired',
    label: 'Device',
    tier: 'Access',
    forget: 'Forget on this device',
    network: 'Cannot reach the host. Check that Tailscale is up.',
    malformed: 'Six digits, please.',
    'no-code': 'No code is outstanding. Mint one on the desktop.',
    expired: 'That code expired. Mint another on the desktop.',
    mismatch: 'Wrong code. ',
    mismatchTail: ' tries left.',
    locked: 'Out of tries; the code is gone. Mint another on the desktop.'
  }

  var el = function (id) { return document.getElementById(id) }
  var views = { pair: el('pair'), paired: el('paired'), loading: el('loading') }

  function show(name) {
    for (var key in views) views[key].hidden = key !== name
  }

  function token() { try { return localStorage.getItem(TOKEN_KEY) } catch (e) { return null } }
  function store(value) { try { localStorage.setItem(TOKEN_KEY, value) } catch (e) { /* private mode */ } }
  function drop() { try { localStorage.removeItem(TOKEN_KEY) } catch (e) { /* private mode */ } }

  // The shell ships the language of the fallback strings, because a static
  // file cannot know which set will be used. Every visible string is chosen
  // here, so the declaration has to move with them: a phone reading English
  // under \`lang="zh"\` gets offered a translation it does not need and hears
  // the wrong voice from its screen reader.
  document.documentElement.lang = zh ? 'zh' : 'en'

  el('title').textContent = text.title
  el('pair-hint').textContent = text.hint
  el('submit').textContent = text.submit
  el('loading-text').textContent = text.loading
  el('paired-state').textContent = text.paired
  el('label-key').textContent = text.label
  el('tier-key').textContent = text.tier
  el('forget').textContent = text.forget

  function renderPaired(session) {
    el('label-value').textContent = session.label
    el('tier-value').textContent = session.tier
    show('paired')
  }

  function probe() {
    var held = token()
    if (!held) { show('pair'); el('code').focus(); return }
    show('loading')
    fetch('${MOBILE_ROUTES.session}', { headers: { authorization: 'Bearer ' + held } })
      .then(function (response) {
        if (response.status === 401) { drop(); show('pair'); return null }
        if (!response.ok) throw new Error('probe')
        return response.json()
      })
      .then(function (session) { if (session) renderPaired(session) })
      .catch(function () { show('pair'); el('error').textContent = text.network })
  }

  function refusalText(body) {
    if (!body || !body.reason) return text.network
    if (body.reason === 'mismatch') {
      return text.mismatch + String(body.remaining) + text.mismatchTail
    }
    return text[body.reason] || text.network
  }

  function pair() {
    var code = el('code').value.replace(/\\D/g, '')
    el('error').textContent = ''
    if (code.length !== 6) { el('error').textContent = text.malformed; return }
    var button = el('submit')
    button.disabled = true
    button.textContent = text.submitting
    fetch('${MOBILE_ROUTES.pair}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code })
    })
      .then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body } })
      })
      .then(function (result) {
        if (!result.ok) {
          el('error').textContent = refusalText(result.body)
          el('code').value = ''
          el('code').focus()
          return
        }
        store(result.body.token)
        renderPaired({ label: result.body.label, tier: result.body.tier })
      })
      .catch(function () { el('error').textContent = text.network })
      .then(function () {
        button.disabled = false
        button.textContent = text.submit
      })
  }

  el('submit').addEventListener('click', pair)
  el('code').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') pair()
  })
  el('forget').addEventListener('click', function () {
    drop()
    el('code').value = ''
    show('pair')
    el('code').focus()
  })

  probe()
})()
`

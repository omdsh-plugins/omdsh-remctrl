import { describe, expect, it } from 'vitest'
import { GATE_ROUTES } from '../src/contract.ts'
import { escapeHtml, pickLang, refusalPage, signInPage } from '../src/pages.ts'
import {
  indexTransform, needsViewportFix, withViewport,
  MOBILE_CSS, MOBILE_JS, PHONE_WIDTH, VH_PROPERTY, VIEWPORT, VT_PROPERTY,
} from '../src/mobile.ts'

describe('pickLang', () => {
  it('reads the phone\'s own preference, not the harness\'s', () => {
    // The gate's pages are served before any harness code runs, and the person
    // reading them is on a device that may not be the configured machine.
    expect(pickLang('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(pickLang('en-GB,en;q=0.9')).toBe('en')
    expect(pickLang(undefined)).toBe('en')
  })

  it('does not mistake a language that merely contains zh', () => {
    expect(pickLang('azh')).toBe('en')
  })
})

describe('signInPage', () => {
  it('posts to the gate\'s own route and carries where to go next', () => {
    const html = signInPage({ next: '/sessions/abc', lang: 'en' })
    expect(html).toContain(`action="${GATE_ROUTES.signIn}"`)
    expect(html).toContain('value="/sessions/abc"')
  })

  it('says what went wrong last time', () => {
    expect(signInPage({ next: '/', error: 'wrong', lang: 'en' })).toMatch(/not right/)
    expect(signInPage({ next: '/', error: 'throttled', lang: 'en' })).toMatch(/Too many/)
    expect(signInPage({ next: '/', error: 'no-passcode', lang: 'en' })).toMatch(/No passcode/)
  })

  it('escapes the value it was handed', () => {
    const html = signInPage({ next: '/a"><script>alert(1)</script>', lang: 'en' })
    expect(html).not.toContain('<script>alert(1)')
  })

  it('is a whole self-contained document, with no external reference', () => {
    // It is served before a browser is signed in, so anything it linked to
    // would have to be reachable before a browser is signed in.
    const html = signInPage({ next: '/', lang: 'en' })
    expect(html).toContain('<!doctype html>')
    expect(html).not.toMatch(/<link[^>]+href/)
    expect(html).not.toMatch(/<script[^>]+src/)
  })

  it('sets the document language, so a screen reader is not lied to', () => {
    expect(signInPage({ next: '/', lang: 'zh' })).toContain('lang="zh-CN"')
    expect(signInPage({ next: '/', lang: 'en' })).toContain('lang="en"')
  })
})

describe('refusalPage', () => {
  it('carries the status and the sentence', () => {
    const html = refusalPage({ message: 'this request arrived over http', status: 421, lang: 'en' })
    expect(html).toContain('421')
    expect(html).toContain('arrived over http')
  })

  it('adds the "use https" line only where it would help', () => {
    expect(refusalPage({ message: 'x', status: 421, lang: 'en', insecure: true })).toMatch(/https/)
    expect(refusalPage({ message: 'x', status: 403, lang: 'en' })).not.toMatch(/Reach this page over/)
  })
})

describe('escapeHtml', () => {
  it('closes every hole a value could open in text or an attribute', () => {
    expect(escapeHtml('<&">\'')).toBe('&lt;&amp;&quot;&gt;&#39;')
  })
})

describe('the index transform', () => {
  const INDEX = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1" />'
    + '<title>DeepSeek Harness</title></head><body></body></html>'

  it('replaces the harness\'s desktop viewport with one a phone can use', () => {
    const out = withViewport(INDEX)
    expect(out).toContain(VIEWPORT)
    expect(out).not.toContain('content="width=device-width, initial-scale=1" />')
  })

  it('leaves exactly one viewport meta, however often it runs', () => {
    const once = withViewport(INDEX)
    const twice = withViewport(once)
    expect(twice).toBe(once)
    expect(twice.match(/name="viewport"/g)).toHaveLength(1)
    expect(needsViewportFix(twice)).toBe(false)
  })

  it('adds one to a document that had none', () => {
    const out = withViewport('<html><head><meta charset="utf-8"></head><body></body></html>')
    expect(out).toContain(VIEWPORT)
  })

  it('leaves a document with no head alone rather than guessing', () => {
    expect(withViewport('not html at all')).toBe('not html at all')
  })

  it('asks for the two things the harness\'s own meta does not', () => {
    // `viewport-fit=cover` so `env(safe-area-inset-*)` exists under the notch;
    // `interactive-widget=resizes-content` so the keyboard shrinks the layout
    // rather than sliding a full-height page up behind itself.
    expect(VIEWPORT).toContain('viewport-fit=cover')
    expect(VIEWPORT).toContain('interactive-widget=resizes-content')
  })

  it('is what the door installs, and it is idempotent end to end', () => {
    expect(indexTransform(indexTransform(INDEX))).toBe(indexTransform(INDEX))
  })

  it('links exactly one stylesheet and one script, inside the head', () => {
    const out = indexTransform(INDEX)
    expect(out.match(new RegExp(GATE_ROUTES.mobileCss, 'g'))).toHaveLength(1)
    expect(out.match(new RegExp(GATE_ROUTES.mobileJs, 'g'))).toHaveLength(1)
    expect(out.indexOf(GATE_ROUTES.mobileCss)).toBeLessThan(out.indexOf('</head>'))
  })

  it('loads the script deferred, so it never blocks the app\'s own bundle', () => {
    expect(indexTransform(INDEX)).toMatch(/<script[^>]+defer><\/script>/)
  })

  it('declares no-referrer, so the tunnel hostname does not leak to sites the agent links to', () => {
    // The harness index declares no policy, so browsers apply
    // `strict-origin-when-cross-origin` — which sends `Referer: <origin>/` on
    // any cross-origin navigation. The hostname is not a credential, but it is
    // what stands between "a stranger has to find this door" and "a stranger
    // has been handed its address".
    const out = indexTransform(INDEX)
    expect(out).toContain('<meta name="referrer" content="no-referrer">')
    expect(out.match(/name="referrer"/g)).toHaveLength(1)
  })
})

describe('the phone stylesheet', () => {
  it('changes nothing above the phone width', () => {
    // A laptop reaching the same URL should get the document it would have got
    // locally, plus two inert tags.
    const outside = MOBILE_CSS.split(`@media (max-width: ${String(PHONE_WIDTH)}px) {`)[0] ?? ''
    expect(outside.replace(/\/\*[\s\S]*?\*\//g, '').trim()).toBe('')
  })

  it('sizes the app from the VISUAL viewport, falling back to the harness\'s own rule', () => {
    // `height: 100%` resolves against the layout viewport, which iOS does not
    // shrink for the keyboard — the composer ends up behind it with no page
    // scroll to reach it.
    expect(MOBILE_CSS).toContain(`height: var(${VH_PROPERTY}, 100%)`)
    expect(MOBILE_CSS).toContain(`top: var(${VT_PROPERTY}, 0px)`)
  })

  it('finds the frame by a data attribute, never by a CSS-module hash', () => {
    // Every class name in the harness is a build-time hash. These two
    // attributes are written deliberately by AppFrame.
    expect(MOBILE_CSS).toContain('[data-shell-overlay]')
    expect(MOBILE_CSS).toContain('[data-sidebar-collapsed]')
    expect(MOBILE_CSS).not.toMatch(/\._[a-zA-Z]+_[a-z0-9]{5}/)
  })

  it('overlays only the EXPANDED sidebar, so the rail that reopens it survives', () => {
    // Collapsed, the rail's logo is the only way to open the drawer again;
    // taking its track away would make the sidebar unreachable.
    expect(MOBILE_CSS).toContain(':not([data-sidebar-collapsed])')
  })
})

describe('the phone script', () => {
  it('does nothing at all where visualViewport does not exist', () => {
    expect(MOBILE_JS).toMatch(/if \(!viewport\) return/)
  })

  it('publishes both properties and follows the keyboard', () => {
    expect(MOBILE_JS).toContain(VH_PROPERTY)
    expect(MOBILE_JS).toContain(VT_PROPERTY)
    expect(MOBILE_JS).toContain("addEventListener('resize'")
    expect(MOBILE_JS).toContain("addEventListener('scroll'")
  })

  it('touches nothing in the harness but two custom properties', () => {
    // It is injected into somebody else's application; anything it wrote to
    // the DOM would be a change that application did not ask for.
    expect(MOBILE_JS).not.toMatch(/querySelector|createElement|innerHTML|classList/)
  })

  it('runs, and reports what the visual viewport says', () => {
    // Evaluated for real rather than pattern-matched, with a fake window.
    const properties: Record<string, string> = {}
    const listeners: string[] = []
    const viewport = {
      height: 500,
      offsetTop: 120,
      addEventListener: (event: string) => { listeners.push(event) },
    }
    const fakeWindow = {
      visualViewport: viewport,
      addEventListener: (event: string) => { listeners.push(event) },
    }
    const fakeDocument = {
      documentElement: { style: { setProperty: (name: string, value: string) => { properties[name] = value } } },
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('window', 'document', MOBILE_JS)(fakeWindow, fakeDocument)
    expect(properties[VH_PROPERTY]).toBe('500px')
    expect(properties[VT_PROPERTY]).toBe('120px')
    expect(listeners).toContain('resize')
    expect(listeners).toContain('scroll')
  })
})

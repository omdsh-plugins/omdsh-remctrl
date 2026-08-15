import { describe, expect, it } from 'vitest'
import { announcement, bootstrapLine, type Options } from '../src/index.ts'

const options: Options = {
  enabled: true,
  bindHost: '127.0.0.1',
  port: 3081,
  defaultTier: 'drive',
  pairingTtlSeconds: 300,
  maxPairingAttempts: 5,
}

describe('what boot says', () => {
  it('prints the URL a phone can type when bound to a tailnet address', () => {
    const lines = announcement({
      decision: { kind: 'tailnet', host: '100.101.5.7' },
      options: { ...options, bindHost: '100.101.5.7' },
      available: ['100.101.5.7'],
    })
    expect(lines).toEqual(['omdsh-remctrl: http://100.101.5.7:3081/'])
  })

  it('explains the loopback case rather than printing a URL nothing can reach', () => {
    const lines = announcement({ decision: { kind: 'loopback', host: '127.0.0.1' }, options, available: [] })
    expect(lines[0]).toContain('nothing off this machine can reach it yet')
    expect(lines.join('\n')).toContain('tailscale serve --bg --https=443 http://127.0.0.1:3081')
  })

  it('names this machine\'s tailnet addresses as the simpler alternative', () => {
    const lines = announcement({
      decision: { kind: 'loopback', host: '127.0.0.1' },
      options,
      available: ['100.101.5.7'],
    })
    expect(lines.join('\n')).toContain('100.101.5.7')
  })

  it('never carries the bootstrap code, which is answered later', () => {
    // Whether anything is paired is only known once the settings section has
    // been adopted, and that happens on a fiber running after this plugin's
    // own effects. Folding the code in here is how a working install gets told
    // it is empty — and handed a live pairing window on every restart.
    const lines = announcement({
      decision: { kind: 'tailnet', host: '100.101.5.7' }, options, available: [],
    })
    expect(lines.join('\n')).not.toContain('pairing code')
  })

  it('says the refusal and nothing else, because nothing else happened', () => {
    const lines = announcement({
      decision: { kind: 'refused', host: '192.168.1.20', message: 'omdsh-remctrl refuses to bind 192.168.1.20: …' },
      options,
      available: [],
    })
    expect(lines).toEqual(['omdsh-remctrl refuses to bind 192.168.1.20: …'])
  })
})

describe('the bootstrap offer', () => {
  it('names the code and how long it lasts', () => {
    // First contact must not require the desktop GUI to already be open; a
    // fresh install on a headless box is the case that needs this most.
    expect(bootstrapLine('123456', 300))
      .toBe('omdsh-remctrl: no device is paired yet; pairing code 123456, good for 300s.')
  })
})

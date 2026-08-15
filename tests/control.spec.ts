import { describe, expect, it, vi } from 'vitest'
import { CONTROL_ENDPOINTS, type ReachabilityView } from '../src/contract.ts'
import { createControlHandler } from '../src/control.ts'
import { DeviceStore } from '../src/devices.ts'
import { PairingCodes } from '../src/pairing.ts'

/** The control handler over a store and a code source a spec controls. */
function bench(options: { onRevoke?: (deviceId: string) => void } = {}) {
  const clock = { at: 1_000 }
  const devices = new DeviceStore({ now: () => clock.at, hashToken: (token) => `hash:${token}` })
  const pairing = new PairingCodes({
    now: () => clock.at, mintCode: () => '123456', ttlMs: 60_000, maxAttempts: 3,
  })
  const status: ReachabilityView = {
    bindHost: '100.101.5.7',
    port: 3081,
    kind: 'tailnet',
    tailnetAddresses: ['100.101.5.7'],
    urls: ['http://100.101.5.7:3081/'],
    paired: 0,
  }
  const handle = createControlHandler({
    devices,
    pairing,
    status: () => ({ ...status, paired: devices.size }),
    ...options.onRevoke === undefined ? {} : { onRevoke: options.onRevoke },
  })
  return { handle, devices, pairing, clock }
}

describe('codes', () => {
  it('mints one and reads it back', async () => {
    const { handle } = bench()
    const minted = await handle(CONTROL_ENDPOINTS.mintCode, {})
    expect(minted).toEqual({ ok: true, value: { code: '123456', expiresAt: 61_000 } })

    const read = await handle(CONTROL_ENDPOINTS.readCode, {})
    expect(read).toEqual({ ok: true, value: { code: { code: '123456', expiresAt: 61_000 } } })
  })

  it('reads null when nothing is outstanding, so a reopened panel does not mint a second', async () => {
    const { handle } = bench()
    expect(await handle(CONTROL_ENDPOINTS.readCode, {})).toEqual({ ok: true, value: { code: null } })
  })

  it('reads null once the code has expired', async () => {
    const { handle, clock } = bench()
    await handle(CONTROL_ENDPOINTS.mintCode, {})
    clock.at = 999_999
    expect(await handle(CONTROL_ENDPOINTS.readCode, {})).toEqual({ ok: true, value: { code: null } })
  })
})

describe('devices', () => {
  it('lists what is paired', async () => {
    const { handle, devices } = bench()
    devices.issue({ deviceId: 'd1', token: 't1', label: 'iPhone', tier: 'drive' })
    expect(await handle(CONTROL_ENDPOINTS.listDevices, {})).toEqual({
      ok: true,
      value: {
        devices: [{
          deviceId: 'd1', label: 'iPhone', tier: 'drive', createdAt: 1_000, lastSeenAt: 1_000,
        }],
      },
    })
  })

  it('never puts a token hash on the wire', async () => {
    const { handle, devices } = bench()
    devices.issue({ deviceId: 'd1', token: 'secret', label: 'iPhone', tier: 'drive' })
    const listed = await handle(CONTROL_ENDPOINTS.listDevices, {})
    expect(JSON.stringify(listed)).not.toContain('hash:')
  })

  it('renames one', async () => {
    const { handle, devices } = bench()
    devices.issue({ deviceId: 'd1', token: 't1', label: 'iPhone', tier: 'drive' })
    expect(await handle(CONTROL_ENDPOINTS.renameDevice, { deviceId: 'd1', label: '  Work phone  ' }))
      .toEqual({ ok: true, value: { changed: true } })
    expect(devices.list()[0]?.label).toBe('Work phone')
  })

  it('reports an unchanged rename rather than failing, because two panels can race', async () => {
    const { handle } = bench()
    expect(await handle(CONTROL_ENDPOINTS.renameDevice, { deviceId: 'gone', label: 'x' }))
      .toEqual({ ok: true, value: { changed: false } })
  })

  it('revokes one, and says so exactly once', async () => {
    const onRevoke = vi.fn()
    const { handle, devices } = bench({ onRevoke })
    devices.issue({ deviceId: 'd1', token: 'secret', label: 'iPhone', tier: 'drive' })
    expect(await handle(CONTROL_ENDPOINTS.revokeDevice, { deviceId: 'd1' }))
      .toEqual({ ok: true, value: { changed: true } })
    expect(devices.authenticate('secret')).toBeUndefined()
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith('d1')

    // A second revocation changed nothing, so nothing is announced.
    expect(await handle(CONTROL_ENDPOINTS.revokeDevice, { deviceId: 'd1' }))
      .toEqual({ ok: true, value: { changed: false } })
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('refuses a malformed mutation', async () => {
    const { handle } = bench()
    for (const payload of [{}, { deviceId: 1 }, { deviceId: 'd1' }, { deviceId: 'd1', label: '   ' }]) {
      const result = await handle(CONTROL_ENDPOINTS.renameDevice, payload)
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('bad-request')
    }
    const revoked = await handle(CONTROL_ENDPOINTS.revokeDevice, {})
    expect(revoked.ok).toBe(false)
  })
})

describe('status', () => {
  it('is computed fresh, so a panel left open does not go stale', async () => {
    const { handle, devices } = bench()
    expect(await handle(CONTROL_ENDPOINTS.readStatus, {}))
      .toMatchObject({ ok: true, value: { paired: 0 } })
    devices.issue({ deviceId: 'd1', token: 't1', label: 'iPhone', tier: 'drive' })
    expect(await handle(CONTROL_ENDPOINTS.readStatus, {}))
      .toMatchObject({ ok: true, value: { paired: 1, urls: ['http://100.101.5.7:3081/'] } })
  })
})

describe('the channel itself', () => {
  it('refuses an endpoint it does not own', async () => {
    const { handle } = bench()
    const result = await handle('pair/steal', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad-request')
    expect(result.error.message).toContain('pair/steal')
  })
})

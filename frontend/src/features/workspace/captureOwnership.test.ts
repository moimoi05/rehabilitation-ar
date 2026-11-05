import { afterEach, expect, it, vi } from 'vitest'
import { acquireCaptureOwnership } from './captureOwnership'

afterEach(() => vi.unstubAllGlobals())

it('excludes another tab until the active recorder releases its capture lock', async () => {
  const held = new Set<string>()
  const request = vi.fn(async (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void> | void) => {
    expect(options).toEqual({ mode: 'exclusive', ifAvailable: true })
    if (held.has(name)) return callback(null)
    held.add(name)
    try { await callback({ name, mode: 'exclusive' } as Lock) } finally { held.delete(name) }
  })
  vi.stubGlobal('navigator', { locks: { request } })
  const release = await acquireCaptureOwnership('capture-a')
  await expect(acquireCaptureOwnership('capture-a')).rejects.toThrow('tab khác')
  const releaseOther = await acquireCaptureOwnership('capture-b')
  releaseOther(); release(); release()
  await vi.waitFor(() => expect(held.size).toBe(0))
  const recoveredRelease = await acquireCaptureOwnership('capture-a')
  recoveredRelease()
})

it('fails safely when cross-tab ownership cannot be verified', async () => {
  vi.stubGlobal('navigator', {})
  await expect(acquireCaptureOwnership('capture-a')).rejects.toThrow('Web Locks')
})

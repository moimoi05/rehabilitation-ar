import { describe, expect, it } from 'vitest'
import { TRACKING_PROFILES, getTrackingProfile, resolveCameraResolution } from './trackingProfiles'

describe('tracking profiles', () => {
  it('defaults invalid or missing values to balanced', () => {
    expect(getTrackingProfile(undefined)).toBe(TRACKING_PROFILES.balanced)
    expect(getTrackingProfile('invalid')).toBe(TRACKING_PROFILES.balanced)
  })
  it('uses distinct bounded budgets and camera sizes', () => {
    expect(TRACKING_PROFILES.economy.handFps).toBeLessThan(TRACKING_PROFILES.balanced.handFps)
    expect(TRACKING_PROFILES.quality.poseFps).toBeGreaterThan(TRACKING_PROFILES.balanced.poseFps)
    for (const profile of Object.values(TRACKING_PROFILES)) {
      expect(profile.handFps).toBeLessThanOrEqual(30)
      expect(profile.poseFps).toBeLessThanOrEqual(30)
      expect(profile.width).toBeGreaterThan(0)
      expect(profile.height).toBeGreaterThan(0)
    }
  })
  it('requests Hand30 and Pose15 independently in the balanced default', () => {
    expect(TRACKING_PROFILES.balanced).toMatchObject({ handFps: 30, poseFps: 15, width: 1280, height: 720 })
  })
  it('uses the manually selected resolution unless explicitly opted in', () => {
    expect(resolveCameraResolution('economy', undefined, '1920x1080')).toEqual({ width: 1920, height: 1080 })
    expect(resolveCameraResolution('economy', 'true', '1920x1080')).toEqual({ width: 1920, height: 1080 })
    expect(resolveCameraResolution('economy', true, '1920x1080')).toEqual({ width: 640, height: 480 })
    expect(resolveCameraResolution('quality', true, '640x480')).toEqual({ width: 1920, height: 1080 })
    expect(resolveCameraResolution('economy', false, '1920x1080')).toEqual({ width: 1920, height: 1080 })
  })
  it('falls back safely for invalid stored preference, profile or resolution', () => {
    expect(resolveCameraResolution('invalid', true, '640x480')).toEqual({ width: 1280, height: 720 })
    for (const invalid of [undefined, null, '0x480', '640x0', '999999x100', '1280xNaN', '1280x720x480']) {
      expect(resolveCameraResolution('economy', false, invalid)).toEqual({ width: 1280, height: 720 })
    }
  })
})

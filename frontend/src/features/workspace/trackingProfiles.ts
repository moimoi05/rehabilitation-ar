export type TrackingProfileName = 'economy' | 'balanced' | 'quality'
export type TrackingProfile = { label: string; poseFps: number; handFps: number; width: number; height: number }

// Input dimensions are camera constraints. File video is always processed at its native resolution.
export const TRACKING_PROFILES: Record<TrackingProfileName, TrackingProfile> = {
  economy: { label: 'Economy', poseFps: 15, handFps: 8, width: 640, height: 480 },
  balanced: { label: 'Balanced', poseFps: 24, handFps: 12, width: 1280, height: 720 },
  quality: { label: 'Quality', poseFps: 30, handFps: 20, width: 1920, height: 1080 },
}

export function getTrackingProfile(value: unknown): TrackingProfile {
  return typeof value === 'string' && Object.hasOwn(TRACKING_PROFILES, value)
    ? TRACKING_PROFILES[value as TrackingProfileName] : TRACKING_PROFILES.balanced
}

const defaultResolution = '1280x720'

/** Preserve a valid manually saved request; reject malformed or unreasonable values. */
export function normalizeManualResolution(value: unknown): string {
  if (typeof value !== 'string') return defaultResolution
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(value)
  if (!match) return defaultResolution
  const width = Number(match[1]), height = Number(match[2])
  return width >= 16 && height >= 16 && width <= 8192 && height <= 8192 ? `${width}x${height}` : defaultResolution
}

/** Profile dimensions are requested only after explicit opt-in. */
export function resolveCameraResolution(profile: unknown, profileCameraResolution: unknown, manualResolution: unknown): { width: number; height: number } {
  if (profileCameraResolution === true) {
    const { width, height } = getTrackingProfile(profile)
    return { width, height }
  }
  const [width, height] = normalizeManualResolution(manualResolution).split('x').map(Number)
  return { width, height }
}

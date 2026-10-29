/** Display-only filtering. Raw MediaPipe observations must remain the source for analysis. */
export type SmoothingConfig = {
  minCutoff: number
  beta: number
  dCutoff: number
  resetAfterMs: number
}

export const DEFAULT_SMOOTHING_CONFIG: Readonly<SmoothingConfig> = Object.freeze({
  minCutoff: 1,
  beta: 0.5,
  dCutoff: 1,
  resetAfterMs: 500,
})
export type SmoothingProfileName = 'standard' | 'responsive'
/** Responsive favors closer tracking of raw output, at the cost of visible jitter. */
export const SMOOTHING_PROFILES: Readonly<Record<SmoothingProfileName, Readonly<SmoothingConfig>>> = Object.freeze({
  standard: DEFAULT_SMOOTHING_CONFIG,
  responsive: Object.freeze({ ...DEFAULT_SMOOTHING_CONFIG, minCutoff: 2 }),
})
// v3 additionally resets Pose point history when visibility is missing.
export const SMOOTHING_VERSION = 'one-euro-v3'
export const POSE_SMOOTHING_POLICY = Object.freeze({ requireVisibility: true })

type Landmark = { x: number; y: number; z?: number; visibility?: number }
type Axis = 'x' | 'y' | 'z'
type AxisState = { raw: number; value: number; derivative: number }
type Track = { timestamp: number; points: Map<number, Partial<Record<Axis, AxisState>>> }
const axes: Axis[] = ['x', 'y', 'z']

function alpha(cutoff: number, dt: number): number {
  const rate = 2 * Math.PI * cutoff * dt
  return rate / (rate + 1)
}

function step(raw: number, previous: AxisState | undefined, dt: number, config: SmoothingConfig): AxisState {
  if (!previous) return { raw, value: raw, derivative: 0 }
  const derivative = (raw - previous.raw) / dt
  const derivativeAlpha = alpha(config.dCutoff, dt)
  const filteredDerivative = derivativeAlpha * derivative + (1 - derivativeAlpha) * previous.derivative
  const valueAlpha = alpha(config.minCutoff + config.beta * Math.abs(filteredDerivative), dt)
  return { raw, value: valueAlpha * raw + (1 - valueAlpha) * previous.value, derivative: filteredDerivative }
}

/** One identity per pose or reliably identified hand. Times are monotonic observation times in ms. */
export class LandmarkSmoother {
  readonly config: Readonly<SmoothingConfig>
  private tracks = new Map<string, Track>()

  constructor(config: Partial<SmoothingConfig> = {}) {
    this.config = Object.freeze({ ...DEFAULT_SMOOTHING_CONFIG, ...config })
    if (!Object.values(this.config).every(Number.isFinite) || !(this.config.minCutoff > 0 && this.config.dCutoff > 0 && this.config.beta >= 0 && this.config.resetAfterMs > 0)) {
      throw new RangeError('Invalid One Euro smoothing configuration')
    }
  }

  reset(identity?: string): void {
    if (identity === undefined) this.tracks.clear()
    else this.tracks.delete(identity)
  }

  filter<T extends Landmark>(identity: string, landmarks: readonly T[], timestampMs: number, policy: { requireVisibility?: boolean } = {}): T[] {
    if (!Number.isFinite(timestampMs)) throw new RangeError('Observation timestamp must be finite')
    if (!landmarks.length) return []
    const oldTrack = this.tracks.get(identity)
    const elapsed = oldTrack ? timestampMs - oldTrack.timestamp : 0
    const previous = oldTrack && elapsed > 0 && elapsed <= this.config.resetAfterMs ? oldTrack : undefined
    const dt = elapsed / 1000
    const points = new Map<number, Partial<Record<Axis, AxisState>>>()
    const output = landmarks.map((landmark, index) => {
      const result = { ...landmark }
      if ((policy.requireVisibility && landmark.visibility === undefined) || (landmark.visibility !== undefined && (!Number.isFinite(landmark.visibility) || landmark.visibility < 0.4))) return result
      // An invalid/out-of-frame observation must remain invalid in the display
      // data, and must not seed the next valid observation's filter history.
      if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) ||
          landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1) return result
      const state: Partial<Record<Axis, AxisState>> = {}
      for (const axis of axes) {
        const value = landmark[axis]
        if (value === undefined || !Number.isFinite(value)) continue
        const next = step(value, previous?.points.get(index)?.[axis], dt, this.config)
        state[axis] = next
        result[axis] = next.value
      }
      points.set(index, state)
      return result
    })
    this.tracks.set(identity, { timestamp: timestampMs, points })
    return output
  }
}

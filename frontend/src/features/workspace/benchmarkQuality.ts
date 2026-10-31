import { LandmarkSmoother, POSE_SMOOTHING_POLICY, SMOOTHING_PROFILES } from './landmarkSmoothing'
import type { Point } from './drawing'

export type BenchmarkFilter = 'raw' | 'standard' | 'responsive'
const valid = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
export const validPose = (points: Point[]) => [11, 12, 13, 14, 15, 16].every(index => {
  const p = points[index]; return p && valid(p) && p.visibility !== undefined && p.visibility >= .4
})
export const validHand = (points: Point[]) => points.length === 21 && points.every(valid)

/** Compare filters on identical observations; these are signal proxies, not ground-truth accuracy. */
export class BenchmarkQuality {
  private filters = { standard: new LandmarkSmoother(SMOOTHING_PROFILES.standard), responsive: new LandmarkSmoother(SMOOTHING_PROFILES.responsive) }
  private previous = new Map<string, { raw: Point[]; standard: Point[]; responsive: Point[]; timestamp: number }>()
  private stats = { raw: { distance: 0, step: 0, count: 0 }, standard: { distance: 0, step: 0, count: 0 }, responsive: { distance: 0, step: 0, count: 0 } }
  private discontinuities = 0
  reset(identity: string) { this.filters.standard.reset(identity); this.filters.responsive.reset(identity); if (this.previous.delete(identity)) this.discontinuities++ }
  filter(identity: string, points: Point[], timestamp: number, selected: BenchmarkFilter): Point[] {
    if (!points.length) { this.reset(identity); return [] }
    // Hand API visibility is not a confidence field. Keep raw metadata but don't use it to suppress filtering.
    const input = identity === 'pose' ? points : points.map(point => { const copy = { ...point }; delete copy.visibility; return copy })
    const policy = identity === 'pose' ? POSE_SMOOTHING_POLICY : {}
    const output = { raw: points, standard: this.filters.standard.filter(identity, input, timestamp, policy), responsive: this.filters.responsive.filter(identity, input, timestamp, policy) }
    const previous = this.previous.get(identity)
    const contiguous = previous && timestamp - previous.timestamp > 0 && timestamp - previous.timestamp <= 500
    if (previous && !contiguous) this.discontinuities++
    for (const name of ['raw', 'standard', 'responsive'] as const) {
      const stat = this.stats[name]
      output[name].forEach((point, index) => {
        const raw = points[index], old = contiguous ? previous[name][index] : undefined
        if (!valid(point) || !valid(raw) || (identity === 'pose' && (raw.visibility ?? 0) < .4)) return
        stat.distance += Math.hypot(point.x - raw.x, point.y - raw.y)
        if (old && valid(old)) stat.step += Math.hypot(point.x - old.x, point.y - old.y)
        stat.count++
      })
    }
    this.previous.set(identity, { ...output, timestamp })
    return output[selected].map((point, index) => ({ ...points[index], ...point }))
  }
  summary() {
    return { discontinuities: this.discontinuities, units: 'normalized image coordinates', interpretation: 'Distance to simultaneous raw observation and per-observation motion are signal proxies, not clinical accuracy or measured time lag; no ground-truth motion is available.', filters: Object.fromEntries(Object.entries(this.stats).map(([key, value]) => [key, { mean_distance_to_raw: value.count ? value.distance / value.count : null, mean_step_distance: value.count ? value.step / value.count : null, samples: value.count }])) }
  }
}

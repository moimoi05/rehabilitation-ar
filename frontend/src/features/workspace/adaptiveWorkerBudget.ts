type Stream = 'pose' | 'hand'
type WorkerSample = { timestamp: number; receivedAt: number; inferenceMs?: number }
type StreamMetrics = { inferenceMs: number | null; roundTripMs: number | null; baselineMs: number | null; samples: number; lastTimestamp: number; lastSubmission: number }
type Options = { poseMaxFps: number; handMaxFps: number }

/** Maximum requested frame rates, subject to source and device performance. */
export const AUTO_WORKER_MAX_FPS = Object.freeze({ poseMaxFps: 30, handMaxFps: 20 })

const WINDOW_MS = 2000
// Matches the application's display freshness limit; stale results are not workload samples.
const MAX_SAMPLE_AGE_MS = 700
const fresh = (): StreamMetrics => ({ inferenceMs: null, roundTripMs: null, baselineMs: null, samples: 0, lastTimestamp: -Infinity, lastSubmission: -Infinity })
const blend = (old: number | null, value: number) => old === null ? value : old * .8 + value * .2

/** Opt-in experimental frame budget. It has no timers, queues, or CPU access.
 * Feed UI event-loop delay only while the page is visible; pause/reset on source change.
 * A Worker must still reject submissions while busy. Call submitted only after acceptance.
 */
export class AdaptiveWorkerBudget {
  private readonly max: Record<Stream, number>
  private readonly min: Record<Stream, number>
  private fps: Record<Stream, number>
  private metrics: Record<Stream, StreamMetrics> = { pose: fresh(), hand: fresh() }
  private epoch = 0
  private windowStart = 0
  private lastUiTime = -Infinity
  private uiSamples = 0
  private delayed = 0
  private moderate = 0
  private poseSamples = 0
  private badWindows = 0
  private goodWindows = 0
  private handAvailable = true

  constructor(options: Options) {
    if (![options.poseMaxFps, options.handMaxFps].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Worker FPS caps must be positive')
    this.max = { pose: options.poseMaxFps, hand: options.handMaxFps }
    this.min = { pose: Math.min(8, options.poseMaxFps), hand: Math.min(3, options.handMaxFps) }
    this.fps = { ...this.max }
  }

  reset(now: number): void {
    if (!Number.isFinite(now) || now < 0) throw new RangeError('Invalid epoch')
    this.epoch = now; this.windowStart = now; this.lastUiTime = -Infinity
    this.metrics = { pose: fresh(), hand: fresh() }; this.fps = { ...this.max }
    this.clearWindow(); this.badWindows = 0; this.goodWindows = 0
  }

  canSubmit(stream: Stream, now: number): boolean {
    return Number.isFinite(now) && now >= this.epoch && now >= this.metrics[stream].lastSubmission && now - this.metrics[stream].lastSubmission >= 1000 / this.fps[stream]
  }

  submitted(stream: Stream, now: number): void {
    if (this.canSubmit(stream, now)) this.metrics[stream].lastSubmission = now
  }

  /** Keep this false after Hand failure until a new Hand worker is usable. */
  setHandAvailable(available: boolean): void { this.handAvailable = available }

  recordResult(stream: Stream, sample: WorkerSample): void {
    const { timestamp, receivedAt, inferenceMs } = sample
    const item = this.metrics[stream]
    if (!Number.isFinite(timestamp) || !Number.isFinite(receivedAt) || timestamp < this.epoch || timestamp <= item.lastTimestamp || receivedAt < timestamp || receivedAt - timestamp > MAX_SAMPLE_AGE_MS) return
    item.lastTimestamp = timestamp
    const trip = receivedAt - timestamp
    item.roundTripMs = blend(item.roundTripMs, trip)
    if (inferenceMs !== undefined && Number.isFinite(inferenceMs) && inferenceMs >= 0) item.inferenceMs = blend(item.inferenceMs, inferenceMs)
    item.samples++
    if (item.samples <= 5) item.baselineMs = item.baselineMs === null ? trip : Math.min(item.baselineMs, trip)
    else if (item.roundTripMs !== null && item.baselineMs !== null && item.roundTripMs < item.baselineMs) item.baselineMs = item.roundTripMs
    if (stream === 'pose') this.poseSamples++
  }

  recordUiDelay(now: number, delayMs: number): void {
    if (!Number.isFinite(now) || !Number.isFinite(delayMs) || now < this.epoch || now <= this.lastUiTime || delayMs < 0) return
    this.lastUiTime = now; this.uiSamples++
    if (delayMs >= 80) this.delayed++
    if (delayMs >= 45) this.moderate++
    if (now - this.windowStart < WINDOW_MS) return
    const pose = this.metrics.pose
    const worse = pose.samples >= 5 && pose.roundTripMs !== null && pose.baselineMs !== null && pose.roundTripMs > pose.baselineMs * 1.6 && pose.roundTripMs - pose.baselineMs >= 80
    const observed = this.uiSamples >= 2 && this.poseSamples > 0
    // Two repeated severe event-loop delays are actionable even if no fresh Pose
    // result arrives. Callers must only sample a visible, actively playing source.
    const bad = this.uiSamples >= 2 && (this.delayed >= 2 || (this.poseSamples > 0 && this.moderate >= 2 && worse))
    if (bad) { this.badWindows++; this.goodWindows = 0 }
    else if (observed && this.moderate === 0) { this.goodWindows++; this.badWindows = 0 }
    else { this.badWindows = 0; this.goodWindows = 0 }
    if (this.badWindows >= 2) { this.reduce(); this.badWindows = 0 }
    if (this.goodWindows >= 4) { this.recover(); this.goodWindows = 0 }
    this.windowStart = now; this.clearWindow()
  }

  snapshot() {
    return { poseFps: this.fps.pose, handFps: this.fps.hand, handAvailable: this.handAvailable, phase: this.fps.pose < this.max.pose || (this.handAvailable && this.fps.hand < this.max.hand) ? 'reduced' as const : 'normal' as const,
      poseInferenceMs: this.metrics.pose.inferenceMs, poseRoundTripMs: this.metrics.pose.roundTripMs,
      handInferenceMs: this.metrics.hand.inferenceMs, handRoundTripMs: this.metrics.hand.roundTripMs }
  }

  private clearWindow() { this.uiSamples = 0; this.delayed = 0; this.moderate = 0; this.poseSamples = 0 }
  private reduce() {
    const stream = this.handAvailable && this.fps.hand > this.min.hand ? 'hand' : 'pose'
    this.fps[stream] = Math.max(this.min[stream], this.fps[stream] * .8)
  }
  private recover() {
    if (this.fps.pose >= this.max.pose && !this.handAvailable) return
    const stream = this.fps.pose < this.max.pose ? 'pose' : 'hand'
    this.fps[stream] = Math.min(this.max[stream], this.fps[stream] * 1.1 + .1)
  }
}

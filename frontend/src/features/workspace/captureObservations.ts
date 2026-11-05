import { landmarkRows } from './captureLandmarks'
import type { CaptureFrame, CaptureLandmark } from './captureUploader'
import type { ScheduledVideoFrame } from './videoFrameScheduler'
import type { SourceFrameIdentity, WorkerResult } from './workerTracker'

type Model = 'pose' | 'hand'
type Status = 'not_run' | 'detected' | 'not_detected' | 'error' | 'missing_result'
type ModelObservation = { performed: boolean | null; status: Status; detected: boolean | null; inferenceMs: number | null; error?: string; landmarks: CaptureLandmark[] }
export type CaptureObservationFrame = Omit<CaptureFrame, 'frame_id' | 'timestamp_ms' | 'utc_time'> & { timestamp: number }
export type CaptureObservationIdentity = SourceFrameIdentity & { sourceObservationId: number; sourcePerformanceMs: number; captureScope: string | null }
type Pending = { identity: CaptureObservationIdentity; skipped: number; sealed: boolean; expected: Record<Model, boolean>; pose?: ModelObservation; hand?: ModelObservation }
const notRun = (): ModelObservation => ({ performed: false, status: 'not_run', detected: null, inferenceMs: null, landmarks: [] })
const missing = (): ModelObservation => ({ performed: null, status: 'missing_result', detected: null, inferenceMs: null, landmarks: [] })

/** Research-only join by main-thread input identity. Never changes inference scheduling
 * or joins cached display landmarks. Missing callbacks expire on new observations/flush. */
export class CaptureObservationCollector {
  private sequence = 0
  private pending = new Map<number, Pending>()
  private settlers = new Map<string, Set<() => void>>()
  private readonly maxPending: number
  private readonly maxWaitMs: number

  constructor(private readonly emit: (frame: CaptureObservationFrame, captureScope: string) => void, limits: { maxPending?: number; maxWaitMs?: number } = {}) {
    this.maxPending = Math.max(1, limits.maxPending ?? 120)
    this.maxWaitMs = Math.max(1, limits.maxWaitMs ?? 2000)
  }

  get pendingCount() { return this.pending.size }

  observe(frame: Pick<ScheduledVideoFrame, 'now' | 'mediaTime' | 'sourceFrameId' | 'skippedSourceFrames'>, captureScope: string | null): CaptureObservationIdentity {
    this.expire(frame.now)
    const identity: CaptureObservationIdentity = { sourceObservationId: ++this.sequence, sourcePerformanceMs: frame.now, sourceFrameId: frame.sourceFrameId ?? null, sourceMediaTimeMs: Number.isFinite(frame.mediaTime) ? frame.mediaTime * 1000 : null, captureScope }
    if (!captureScope) return identity
    while (this.pending.size >= this.maxPending) this.finish(this.pending.keys().next().value!)
    this.pending.set(identity.sourceObservationId, { identity, skipped: frame.skippedSourceFrames ?? 0, sealed: false, expected: { pose: false, hand: false } })
    return identity
  }

  submitted(source: SourceFrameIdentity, expected: Record<Model, boolean>) {
    const pending = this.match(source)
    if (!pending) return
    pending.expected = { ...expected }; pending.sealed = true
    this.maybeFinish(pending)
  }

  workerResult(result: WorkerResult, models: Model | 'both' = 'both') {
    const pending = this.match(result)
    if (!pending) return
    for (const model of ['pose', 'hand'] as const) {
      if (models !== 'both' && models !== model || pending[model]) continue
      pending[model] = modelObservation(result, model)
    }
    this.maybeFinish(pending)
  }

  /** Main results use exactly the same input identity and unsmoothed output contract. */
  mainResult(result: WorkerResult) { this.workerResult(result) }

  expire(now: number) {
    const scopes = new Set<string | null>()
    for (const [id, pending] of this.pending) if (now - pending.identity.sourcePerformanceMs >= this.maxWaitMs) { scopes.add(pending.identity.captureScope); this.finish(id) }
    for (const scope of scopes) this.drainReady(scope)
  }

  flush() { for (const id of [...this.pending.keys()]) this.finish(id) }

  /** End capture without waiting on render/gameplay: only observations already
   * submitted for this scope may settle; another trial's pending data is untouched. */
  settle(scope: string | null, maxWaitMs = 2000): Promise<void> {
    if (!scope || !this.hasPending(scope)) return Promise.resolve()
    return new Promise(resolve => {
      const callbacks = this.settlers.get(scope) ?? new Set<() => void>()
      const done = () => { clearTimeout(timer); callbacks.delete(done); if (!callbacks.size) this.settlers.delete(scope); resolve() }
      const timer = setTimeout(() => {
        for (const [id, pending] of this.pending) if (pending.identity.captureScope === scope) this.finish(id)
        done()
      }, Math.max(0, Math.min(2000, maxWaitMs)))
      callbacks.add(done); this.settlers.set(scope, callbacks)
    })
  }

  private hasPending(scope: string) { return [...this.pending.values()].some(pending => pending.identity.captureScope === scope) }

  private match(source: SourceFrameIdentity) {
    if (source.sourceObservationId == null) return undefined
    const pending = this.pending.get(source.sourceObservationId)
    return pending && source.captureScope === pending.identity.captureScope && source.sourcePerformanceMs === pending.identity.sourcePerformanceMs ? pending : undefined
  }

  private maybeFinish(pending: Pending) {
    this.drainReady(pending.identity.captureScope)
  }

  private drainReady(scope: string | null) {
    for (const [id, pending] of this.pending) {
      if (pending.identity.captureScope !== scope) continue
      if (!pending.sealed || pending.expected.pose && !pending.pose || pending.expected.hand && !pending.hand) return
      this.finish(id)
    }
  }

  private finish(id: number) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const pose = pending.pose ?? (pending.expected.pose ? missing() : notRun())
    const hand = pending.hand ?? (pending.expected.hand ? missing() : notRun())
    const { identity } = pending
    this.emit({ timestamp: identity.sourcePerformanceMs, source_frame_id: identity.sourceFrameId, source_observation_id: id, video_media_time_ms: identity.sourceMediaTimeMs ?? null, skipped_frames: pending.skipped, inference_performed: pose.performed !== false || hand.performed !== false, pose_inference_performed: pose.performed, hand_inference_performed: hand.performed, pose_inference_status: pose.status, hand_inference_status: hand.status, pose_detected: pose.detected, hand_detected: hand.detected, pose_inference_ms: pose.inferenceMs, hand_inference_ms: hand.inferenceMs, inference_ms: pose.inferenceMs === null && hand.inferenceMs === null ? null : (pose.inferenceMs ?? 0) + (hand.inferenceMs ?? 0), ...(pose.error ? { pose_error: pose.error } : {}), ...(hand.error ? { hand_error: hand.error } : {}), landmarks: [...pose.landmarks, ...hand.landmarks] }, identity.captureScope!)
    if (identity.captureScope && !this.hasPending(identity.captureScope)) for (const done of [...(this.settlers.get(identity.captureScope) ?? [])]) done()
  }
}

function modelObservation(result: WorkerResult, model: Model): ModelObservation {
  const processed = model === 'pose' ? result.poseProcessed : result.handProcessed
  const failed = model === 'pose' ? result.poseFailed : result.handFailed
  const attempted = model === 'pose' ? result.poseAttempted : result.handAttempted
  const duration = model === 'pose' ? result.poseInferenceMs : result.handInferenceMs
  const inferenceMs = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null
  if (failed) return { performed: attempted ?? true, status: 'error', detected: null, inferenceMs, error: (model === 'pose' ? result.poseError : result.handError) || 'Inference failed', landmarks: [] }
  if (processed === false) return notRun()
  if (processed !== true) return missing()
  if ((model === 'pose' ? result.poseResultReceived : result.handResultReceived) === false) return { ...missing(), performed: true, inferenceMs }
  const landmarks = model === 'pose' ? [...landmarkRows(result.pose, 'pose', 'normalized_image'), ...landmarkRows(result.poseWorldLandmarks ?? [], 'pose', 'world')] : handRows(result)
  const detected = model === 'pose' ? result.pose.length > 0 || !!result.poseWorldLandmarks?.length : !!result.hands?.some(points => points.length > 0) || !!result.handWorldLandmarks?.some(points => points.length > 0)
  return { performed: true, status: detected ? 'detected' : 'not_detected', detected, inferenceMs, landmarks }
}

function handRows(result: WorkerResult) {
  return Array.from({ length: Math.max(result.hands?.length ?? 0, result.handWorldLandmarks?.length ?? 0) }, (_, index) => index).flatMap(index => [
    ...landmarkRows(result.hands?.[index] ?? [], 'hand', 'normalized_image', 'raw', result.handedness?.[index] ?? undefined, index),
    ...landmarkRows(result.handWorldLandmarks?.[index] ?? [], 'hand', 'world', 'raw', result.handedness?.[index] ?? undefined, index),
  ])
}

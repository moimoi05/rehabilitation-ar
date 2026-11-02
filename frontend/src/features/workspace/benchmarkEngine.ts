import { FilesetResolver } from '@mediapipe/tasks-vision'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { initializeHand, initializePose } from './mediaPipeModels'
import { createWorkerTracker, waitForWorkerDisposals } from './workerTracker'
import type { WorkerFrameComplete, WorkerHandResult, WorkerPoseResult, WorkerResult, WorkerTracker } from './workerTracker'
import type { Point } from './drawing'
import type { ScheduledVideoFrame } from './videoFrameScheduler'
import { createRTMPoseEngine, waitForRTMPoseDrain } from './rtmposeEngine'
import { captureInferenceBitmapWithTimings } from './inferenceResolution'
import type { ResolutionDimensions } from './inferenceResolution'

export type BenchmarkConfig = {
  name: string
  gpu: boolean
  engine: 'main' | 'worker' | 'rtmpose'
  hands: boolean
  poseFps: number
  handFps: number
  schedule: 'independent' | 'legacy'
  repeat: number
  filter: 'raw' | 'standard' | 'responsive'
  comparison?: boolean
  personDetection?: boolean
  roi?: { x: number; y: number; width: number; height: number }
  handFirst?: boolean
  inferenceResolution?: ResolutionDimensions | null
}
export type Observation = {
  frame: ScheduledVideoFrame
  requestId?: number
  frameComplete?: boolean
  pose: Point[] | null
  hands: Point[][] | null
  poseMs: number | null
  handMs: number | null
  poseWorld: Point[] | null
  handWorld: Point[][] | null
  handedness: { categoryName: string; score: number }[][] | null
  completedAt?: number
  rawKeypoints?: unknown
  timings?: Record<string, number>
  pipelineMs?: number
  trackingRegion?: unknown
  runtimeTimestamps?: Record<string, number> | null
  transferMs?: number | null
  captureMs?: number | null
  captureResizeTotalMs?: number | null
  transferAndDispatchMs?: number | null
  poseFailed?: boolean
  handFailed?: boolean
  poseProcessed?: boolean
  handProcessed?: boolean
}
export type BenchmarkEngine = {
  delegates: { pose: string | null; hand: string | null }
  runtimeInfo?: unknown
  errors: string[]
  submit: (frame: ScheduledVideoFrame, doPose: boolean, doHand: boolean) => boolean
  close: () => void | Promise<void>
  idle: () => boolean
}

export async function createBenchmarkEngine(
  config: BenchmarkConfig,
  video: HTMLVideoElement,
  onResult: (observation: Observation) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal,
): Promise<BenchmarkEngine> {
  const checkCancelled = () => { if (signal?.aborted) throw new Error('Benchmark initialization cancelled') }
  checkCancelled()
  await waitForWorkerDisposals()
  checkCancelled()
  await waitForRTMPoseDrain()
  checkCancelled()
  if (config.engine === 'rtmpose') {
    let frame: ScheduledVideoFrame | null = null
    const engine = await createRTMPoseEngine({
      roi: config.roi,
      personDetection: config.personDetection,
      onError,
      onResult: result => {
        const observed = frame
        frame = null
        if (!observed) return
        onResult({
          frame: observed,
          pose: result.pose,
          hands: result.hands,
          handedness: result.handedness ?? null,
          poseMs: Number.isFinite(result.timings.inferenceMs) ? result.timings.inferenceMs : null,
          handMs: null,
          poseWorld: null,
          handWorld: null,
          completedAt: result.deliveredAt,
          rawKeypoints: result.rawKeypoints,
          timings: result.timings,
          pipelineMs: result.inferenceMs,
          runtimeTimestamps: result.stageTimestamps,
          trackingRegion: result.trackingRegion,
        })
      },
    })
    return {
      delegates: { pose: 'GPU', hand: 'GPU' },
      get runtimeInfo() { return engine.runtimeInfo },
      errors: [],
      close: () => engine.close(),
      idle: () => engine.idle(),
      submit(observed) {
        if (!engine.idle()) return false
        frame = observed
        if (engine.submit(video, observed.inferenceTimestamp)) return true
        frame = null
        return false
      },
    }
  }

  let pose: PoseLandmarker | null = null
  let hand: HandLandmarker | null = null
  let worker: WorkerTracker | null = null
  let inferenceDevices: Record<string, unknown> = {}

  const inspectCanvas = (canvas: OffscreenCanvas) => {
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!context) return { renderer: null, verified: false }
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      evidence: 'Actual canvas passed to this MediaPipe task',
      verified: !!debug,
    }
  }

  const delegates: BenchmarkEngine['delegates'] = { pose: null, hand: null }
  const errors: string[] = []
  let pending: { frame: ScheduledVideoFrame; requestId?: number; handDelivered: boolean; poseDelivered: boolean; timingsRecorded: boolean } | null = null
  let closed = false, runtimeFailed = false
  let closing: Promise<void> | null = null

  const close = () => {
    if (closing) return closing
    signal?.removeEventListener('abort', abort)
    closed = true
    pending = null
    const oldWorker = worker
    worker = null
    const oldPose = pose, oldHand = hand
    pose = null; hand = null
    closing = (async () => {
      const failures: string[] = []
      try { await oldWorker?.dispose() } catch (error) { failures.push(String(error)) }
      for (const model of [oldPose, oldHand]) {
        try { model?.close() } catch (error) { failures.push(String(error)) }
      }
      if (failures.length) throw new Error(`Model cleanup failed: ${failures.join('; ')}`)
    })()
    return closing
  }
  const abort = () => { void close().catch(error => onError(error instanceof Error ? error : new Error(String(error)))) }
  const inferenceFailure = (error: string) => { runtimeFailed = true; onError(new Error(error)) }

  const matchingFrame = (result: WorkerHandResult | WorkerPoseResult | WorkerFrameComplete | WorkerResult) => {
    if (closed || !pending) return null
    const { frame } = pending
    if (result.timestamp !== frame.inferenceTimestamp || result.sourceFrameId !== (frame.sourceFrameId ?? null)
      || result.sourceMediaTimeMs !== frame.mediaTime * 1000 || result.sourcePerformanceMs !== frame.now) return null
    if (pending.requestId !== undefined && pending.requestId !== result.requestId) return null
    pending.requestId = result.requestId
    return pending
  }

  const captureTimings = (result: WorkerHandResult | WorkerPoseResult, observed: NonNullable<typeof pending>) => {
    if (observed.timingsRecorded) return { captureResizeTotalMs: null, transferAndDispatchMs: null }
    observed.timingsRecorded = true
    return {
      captureResizeTotalMs: result.captureResizeTotalMs ?? null,
      transferAndDispatchMs: result.transferAndDispatchMs ?? null,
    }
  }

  try {
    if (config.engine === 'worker') {
      const useHandFirst = config.handFirst !== false
      const targetRes = config.inferenceResolution ?? null
      worker = await createWorkerTracker({
        worker: new Worker('/tracking-worker.js'),
        moduleUrl: new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href,
        handEnabled: config.hands,
        preferGpu: config.gpu,
        handFirst: useHandFirst,
        signal,
        capture: element => captureInferenceBitmapWithTimings(element, targetRes),
        onError: error => { runtimeFailed = true; pending = null; onError(error) },
        onHandResult: useHandFirst ? (result: WorkerHandResult) => {
          const observed = matchingFrame(result)
          if (!observed || observed.handDelivered) return
          observed.handDelivered = true
          onResult({
            frame: observed.frame,
            requestId: result.requestId,
            pose: null,
            hands: result.handFailed ? [] : result.handProcessed ? result.hands : null,
            poseMs: null,
            handMs: result.handProcessed && !result.handFailed ? result.handInferenceMs : null,
            poseWorld: null,
            handWorld: result.handWorldLandmarks ?? null,
            handedness: result.handedness ?? null,
            handFailed: result.handFailed,
            handProcessed: result.handProcessed && !result.handFailed,
            ...captureTimings(result, observed),
          })
          if (result.handFailed) inferenceFailure(result.handError || 'Hand worker inference failed')
        } : undefined,
        onPoseResult: useHandFirst ? (result: WorkerPoseResult) => {
          const observed = matchingFrame(result)
          if (!observed || observed.poseDelivered) return
          observed.poseDelivered = true
          onResult({
            frame: observed.frame,
            requestId: result.requestId,
            pose: result.poseFailed ? [] : result.poseProcessed ? result.pose : null,
            hands: null,
            poseMs: result.poseProcessed && !result.poseFailed ? result.poseInferenceMs : null,
            handMs: null,
            poseWorld: result.poseWorldLandmarks ?? null,
            handWorld: null,
            handedness: null,
            poseFailed: result.poseFailed,
            poseProcessed: result.poseProcessed && !result.poseFailed,
            ...captureTimings(result, observed),
          })
          if (result.poseFailed) inferenceFailure(result.poseError || 'Pose worker inference failed')
        } : undefined,
        onFrameComplete: useHandFirst ? result => {
          const observed = matchingFrame(result)
          if (!observed) return
          pending = null
          onResult({ frame: observed.frame, requestId: result.requestId, frameComplete: true,
            pose: null, hands: null, poseMs: null, handMs: null, poseWorld: null, handWorld: null, handedness: null,
            pipelineMs: performance.now() - observed.frame.inferenceTimestamp })
        } : undefined,
        onResult: !useHandFirst ? (result: WorkerResult) => {
          const observed = matchingFrame(result)
          if (!observed) return
          pending = null
          onResult({
            frame: observed.frame,
            requestId: result.requestId,
            frameComplete: true,
            pipelineMs: performance.now() - observed.frame.inferenceTimestamp,
            pose: result.poseFailed ? [] : result.poseProcessed ? result.pose : null,
            hands: result.handFailed ? [] : result.handProcessed ? result.hands : null,
            poseMs: result.poseProcessed && !result.poseFailed ? result.poseInferenceMs ?? null : null,
            handMs: result.handProcessed && !result.handFailed ? result.handInferenceMs ?? null : null,
            poseWorld: result.poseWorldLandmarks ?? null,
            handWorld: result.handWorldLandmarks ?? null,
            handedness: result.handedness ?? null,
            poseFailed: result.poseFailed,
            handFailed: result.handFailed,
            poseProcessed: result.poseProcessed && !result.poseFailed,
            handProcessed: result.handProcessed && !result.handFailed,
            captureResizeTotalMs: result.captureResizeTotalMs ?? null,
            transferAndDispatchMs: result.transferAndDispatchMs ?? null,
          })
          if (result.handFailed || result.poseFailed) inferenceFailure([result.handFailed ? result.handError || 'Hand worker inference failed' : '', result.poseFailed ? result.poseError || 'Pose worker inference failed' : ''].filter(Boolean).join('; '))
        } : undefined,
      })
      checkCancelled()
      Object.assign(delegates, worker.delegates)
      errors.push(...worker.initializationErrors)
    } else {
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      checkCancelled()
      const poseCanvas = new OffscreenCanvas(1, 1)
      const p = await initializePose(files, config.gpu, poseCanvas)
      pose = p.model
      checkCancelled()
      delegates.pose = p.delegate
      if (p.delegate === 'GPU') inferenceDevices = { ...inferenceDevices, pose: inspectCanvas(poseCanvas) }
      if (p.gpuError) errors.push(`Pose GPU: ${p.gpuError}`)
      if (config.hands) {
        const handCanvas = new OffscreenCanvas(1, 1)
        const h = await initializeHand(files, config.gpu, handCanvas)
        hand = h.model
        checkCancelled()
        delegates.hand = h.delegate
        if (h.delegate === 'GPU') inferenceDevices = { ...inferenceDevices, hand: inspectCanvas(handCanvas) }
        if (h.gpuError) errors.push(`Hand GPU: ${h.gpuError}`)
      }
    }

    if (delegates.pose === null || (config.hands && delegates.hand === null)) throw new Error(`Requested benchmark model unavailable: Pose=${delegates.pose}, Hand=${delegates.hand}. ${errors.join(' ')}`)
    if (config.comparison && (delegates.pose !== 'GPU' || (config.hands && delegates.hand !== 'GPU'))) {
      throw new Error(`GPU comparison rejected CPU fallback: Pose=${delegates.pose}, Hand=${delegates.hand}. ${errors.join(' ')}`)
    }
    checkCancelled()
    signal?.addEventListener('abort', abort, { once: true })

    return {
      delegates,
      runtimeInfo: {
        runtime: config.engine === 'worker' ? 'MediaPipe Tasks Vision Worker' : 'MediaPipe Tasks Vision main thread',
        device: inferenceDevices,
        deviceEvidence: config.engine === 'worker' ? 'Worker reports selected delegates separately; hardware telemetry unavailable' : 'Actual task inference canvases; renderer may be redacted by browser',
        actualDelegates: delegates,
        model: 'Pose Lite + Hand 0.10.35',
      },
      errors,
      close,
      idle: () => pending === null,
      submit(frame, doPose, doHand) {
        if (closed || runtimeFailed || signal?.aborted) return false
        if (worker) {
          if (pending) return false
          pending = { frame, handDelivered: false, poseDelivered: false, timingsRecorded: false }
          const submitted = pending
          if (!worker.submit(video, frame.inferenceTimestamp, doHand, doPose, {
            sourceFrameId: frame.sourceFrameId ?? null,
            sourceMediaTimeMs: frame.mediaTime * 1000,
            sourcePerformanceMs: frame.now,
          })) { pending = null; return false }
          if (pending === submitted && worker.lastRequestId != null) pending = { ...submitted, requestId: worker.lastRequestId }
          return true
        }
        try {
          let poseMs: number | null = null
          let handMs: number | null = null
          const ps = performance.now()
          const p = doPose ? pose?.detectForVideo(video, frame.inferenceTimestamp) : null
          if (p) poseMs = performance.now() - ps
          const hs = performance.now()
          const h = doHand ? hand?.detectForVideo(video, frame.inferenceTimestamp) : null
          if (h) handMs = performance.now() - hs
          onResult({
            frame,
            pose: p ? p.landmarks[0] ?? [] : null,
            hands: h?.landmarks ?? null,
            poseMs,
            handMs,
            poseWorld: p?.worldLandmarks[0] ?? null,
            handWorld: h?.worldLandmarks ?? null,
            handedness: h?.handedness ?? null,
          })
          return true
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)))
          return false
        }
      },
    }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new Error(`${String(error)}; ${String(cleanupError)}`) }
    throw error
  }
}

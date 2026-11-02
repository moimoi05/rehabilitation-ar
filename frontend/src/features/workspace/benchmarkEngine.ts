import { FilesetResolver } from '@mediapipe/tasks-vision'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { initializeHand, initializePose } from './mediaPipeModels'
import { createWorkerTracker } from './workerTracker'
import type { WorkerResult, WorkerTracker } from './workerTracker'
import type { Point } from './drawing'
import type { ScheduledVideoFrame } from './videoFrameScheduler'
import { createRTMPoseEngine, waitForRTMPoseDrain } from './rtmposeEngine'

export type BenchmarkConfig = { name: string; gpu: boolean; engine: 'main' | 'worker' | 'rtmpose'; hands: boolean; poseFps: number; handFps: number; schedule: 'independent' | 'legacy'; repeat: number; filter: 'raw' | 'standard' | 'responsive'; comparison?: boolean; personDetection?: boolean; roi?: { x: number; y: number; width: number; height: number } }
export type Observation = { frame: ScheduledVideoFrame; pose: Point[] | null; hands: Point[][] | null; poseMs: number | null; handMs: number | null; poseWorld: Point[] | null; handWorld: Point[][] | null; handedness: { categoryName: string; score: number }[][] | null; completedAt?: number; rawKeypoints?: unknown; timings?: Record<string, number>; pipelineMs?: number; trackingRegion?: unknown; runtimeTimestamps?: Record<string, number> | null }
export type BenchmarkEngine = { delegates: { pose: string | null; hand: string | null }; runtimeInfo?: unknown; errors: string[]; submit: (frame: ScheduledVideoFrame, doPose: boolean, doHand: boolean) => boolean; close: () => void; idle: () => boolean }

export async function createBenchmarkEngine(config: BenchmarkConfig, video: HTMLVideoElement, onResult: (observation: Observation) => void, onError: (error: Error) => void): Promise<BenchmarkEngine> {
  await waitForRTMPoseDrain()
  if (config.engine === 'rtmpose') {
    let frame: ScheduledVideoFrame | null = null
    const engine = await createRTMPoseEngine({ roi: config.roi, personDetection: config.personDetection, onError, onResult: result => {
      const observed = frame; frame = null
      if (!observed) return
      onResult({ frame: observed, pose: result.pose, hands: result.hands, handedness: result.handedness ?? null,
        poseMs: Number.isFinite(result.timings.inferenceMs) ? result.timings.inferenceMs : null, handMs: null, poseWorld: null, handWorld: null,
        completedAt: result.deliveredAt, rawKeypoints: result.rawKeypoints, timings: result.timings, pipelineMs: result.inferenceMs, runtimeTimestamps: result.stageTimestamps, trackingRegion: result.trackingRegion })
    } })
    return { delegates: { pose: 'GPU', hand: 'GPU' }, get runtimeInfo() { return engine.runtimeInfo }, errors: [], close: () => engine.close(), idle: () => engine.idle(),
      submit(observed) { if (!engine.idle()) return false; frame = observed; if (engine.submit(video, observed.inferenceTimestamp)) return true; frame = null; return false } }
  }
  let pose: PoseLandmarker | null = null, hand: HandLandmarker | null = null, worker: WorkerTracker | null = null
  let inferenceDevices: Record<string, unknown> = {}
  const inspectCanvas = (canvas: OffscreenCanvas) => {
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!context) return { renderer: null, verified: false }
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    return { renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null, evidence: 'Actual canvas passed to this MediaPipe task', verified: !!debug }
  }
  const delegates: BenchmarkEngine['delegates'] = { pose: null, hand: null }, errors: string[] = []
  let pending: ScheduledVideoFrame | null = null
  const close = () => { worker?.close(); worker = null; try { pose?.close() } finally { pose = null; hand?.close(); hand = null } }
  try {
    if (config.engine === 'worker') {
      worker = await createWorkerTracker({ worker: new Worker('/tracking-worker.js'), moduleUrl: new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href,
        handEnabled: config.hands, preferGpu: config.gpu, capture: element => createImageBitmap(element), onError,
        onResult: (result: WorkerResult) => {
          const frame = pending; pending = null
          if (!frame) return
          if (result.handFailed) { onError(new Error(result.handError || 'Hand worker inference failed')); return }
          onResult({ frame, pose: result.poseProcessed ? result.pose : null, hands: result.handProcessed ? result.hands : null,
            poseMs: result.poseInferenceMs ?? null, handMs: result.handInferenceMs ?? null,
            poseWorld: result.poseWorldLandmarks ?? null, handWorld: result.handWorldLandmarks ?? null, handedness: result.handedness ?? null })
        } })
      Object.assign(delegates, worker.delegates); errors.push(...worker.initializationErrors)
    } else {
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const poseCanvas = new OffscreenCanvas(1, 1)
      const p = await initializePose(files, config.gpu, poseCanvas); pose = p.model; delegates.pose = p.delegate
      if (p.delegate === 'GPU') inferenceDevices = { ...inferenceDevices, pose: inspectCanvas(poseCanvas) }
      if (p.gpuError) errors.push(`Pose GPU: ${p.gpuError}`)
      if (config.hands) {
        const handCanvas = new OffscreenCanvas(1, 1)
        const h = await initializeHand(files, config.gpu, handCanvas); hand = h.model; delegates.hand = h.delegate
        if (h.delegate === 'GPU') inferenceDevices = { ...inferenceDevices, hand: inspectCanvas(handCanvas) }
        if (h.gpuError) errors.push(`Hand GPU: ${h.gpuError}`)
      }
    }
    if (config.comparison && (delegates.pose !== 'GPU' || (config.hands && delegates.hand !== 'GPU'))) throw new Error(`GPU comparison rejected CPU fallback: Pose=${delegates.pose}, Hand=${delegates.hand}. ${errors.join(' ')}`)
    return { delegates, runtimeInfo: { runtime: 'MediaPipe WebGL', device: inferenceDevices, deviceEvidence: 'Separate actual task inference canvases; renderer may be redacted by browser', model: 'Pose Lite + Hand 0.10.35' }, errors, close, idle: () => pending === null,
      submit(frame, doPose, doHand) {
        if (worker) {
          if (pending) return false
          if (!worker.submit(video, frame.inferenceTimestamp, doHand, doPose)) return false
          pending = frame; return true
        }
        try {
          let poseMs: number | null = null, handMs: number | null = null
          const ps = performance.now(), p = doPose ? pose?.detectForVideo(video, frame.inferenceTimestamp) : null
          if (p) poseMs = performance.now() - ps
          const hs = performance.now(), h = doHand ? hand?.detectForVideo(video, frame.inferenceTimestamp) : null
          if (h) handMs = performance.now() - hs
          onResult({ frame, pose: p ? p.landmarks[0] ?? [] : null, hands: h?.landmarks ?? null, poseMs, handMs,
            poseWorld: p?.worldLandmarks[0] ?? null, handWorld: h?.worldLandmarks ?? null, handedness: h?.handedness ?? null })
          return true
        } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); return false }
      } }
  } catch (error) { close(); throw error }
}

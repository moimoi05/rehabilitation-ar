import { FilesetResolver } from '@mediapipe/tasks-vision'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { initializeHand, initializePose } from './mediaPipeModels'
import { createWorkerTracker } from './workerTracker'
import type { WorkerResult, WorkerTracker } from './workerTracker'
import type { Point } from './drawing'
import type { ScheduledVideoFrame } from './videoFrameScheduler'

export type BenchmarkConfig = { name: string; gpu: boolean; engine: 'main' | 'worker'; hands: boolean; poseFps: number; handFps: number; schedule: 'independent' | 'legacy'; repeat: number; filter: 'raw' | 'standard' | 'responsive' }
export type Observation = { frame: ScheduledVideoFrame; pose: Point[] | null; hands: Point[][] | null; poseMs: number | null; handMs: number | null; poseWorld: Point[] | null; handWorld: Point[][] | null; handedness: { categoryName: string; score: number }[][] | null }
export type BenchmarkEngine = { delegates: { pose: string | null; hand: string | null }; errors: string[]; submit: (frame: ScheduledVideoFrame, doPose: boolean, doHand: boolean) => boolean; close: () => void; idle: () => boolean }

export async function createBenchmarkEngine(config: BenchmarkConfig, video: HTMLVideoElement, onResult: (observation: Observation) => void, onError: (error: Error) => void): Promise<BenchmarkEngine> {
  let pose: PoseLandmarker | null = null, hand: HandLandmarker | null = null, worker: WorkerTracker | null = null
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
      const p = await initializePose(files, config.gpu); pose = p.model; delegates.pose = p.delegate
      if (p.gpuError) errors.push(`Pose GPU: ${p.gpuError}`)
      if (config.hands) {
        const h = await initializeHand(files, config.gpu); hand = h.model; delegates.hand = h.delegate
        if (h.gpuError) errors.push(`Hand GPU: ${h.gpuError}`)
      }
    }
    return { delegates, errors, close, idle: () => pending === null,
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

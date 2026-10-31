import type { Point } from './drawing'

export type WorkerLandmark = Point & { z?: number; presence?: number }
export type WorkerCategory = { categoryName: string; displayName: string; score: number; index: number }
export type WorkerResult = {
  timestamp: number; pose: WorkerLandmark[]; hands: WorkerLandmark[][] | null; inferenceMs?: number
  handFailed?: boolean; handCleanupFailed?: boolean; handError?: string
  poseProcessed?: boolean; handProcessed?: boolean; poseInferenceMs?: number | null; handInferenceMs?: number | null
  poseWorldLandmarks?: WorkerLandmark[]; handWorldLandmarks?: WorkerLandmark[][] | null; handedness?: WorkerCategory[][] | null
}
type Delegates = { pose: 'GPU' | 'CPU' | null; hand: 'GPU' | 'CPU' | null }
export type WorkerRole = 'both' | 'pose' | 'hand'
type Options = {
  worker: Worker
  moduleUrl: string
  handEnabled: boolean
  role?: WorkerRole
  preferGpu?: boolean
  capture: (video: HTMLVideoElement) => Promise<ImageBitmap>
  onResult: (result: WorkerResult) => void
  onError: (error: Error) => void
  signal?: AbortSignal
}
export type WorkerTracker = {
  submit: (video: HTMLVideoElement, timestamp: number, hand: boolean, pose?: boolean) => boolean
  close: () => void
  readonly delegates: Delegates
  readonly initializationErrors: string[]
}

/** Exactly one bitmap capture or inference can be pending. No frame queue is kept. */
export function createWorkerTracker(options: Options): Promise<WorkerTracker> {
  return new Promise((resolve, reject) => {
    const { worker } = options
    let ready = false, closed = false, busy = false, sequence = 0
    let pendingTimestamp = 0
    let delegates: Delegates = { pose: null, hand: null }
    let initializationErrors: string[] = []
    let frameTimeout: ReturnType<typeof setTimeout> | null = null
    const close = () => {
      if (closed) return
      closed = true; busy = false; clearTimeout(timeout)
      if (frameTimeout !== null) clearTimeout(frameTimeout)
      options.signal?.removeEventListener('abort', abort)
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate()
    }
    const fail = (error: Error) => {
      if (closed) return
      close()
      if (ready) options.onError(error); else reject(error)
    }
    const abort = () => { if (ready) close(); else fail(new Error('Worker initialization cancelled')) }
    const timeout = setTimeout(() => fail(new Error('Worker initialization timed out')), 20000)
    const tracker: WorkerTracker = {
      get delegates() { return { ...delegates } },
      get initializationErrors() { return [...initializationErrors] },
      submit(video, timestamp, hand, pose = true) {
        if (closed || busy) return false
        busy = true; pendingTimestamp = timestamp
        frameTimeout = setTimeout(() => fail(new Error('Worker inference timed out')), 8000)
        const id = ++sequence
        let capture: Promise<ImageBitmap>
        try { capture = options.capture(video) }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return true }
        capture.then(bitmap => {
          if (closed) { bitmap.close(); return }
          try { worker.postMessage({ type: 'frame', id, bitmap, timestamp, hand, ...(pose ? {} : { pose: false }) }, [bitmap]) }
          catch (error) { bitmap.close(); fail(error instanceof Error ? error : new Error(String(error))) }
        }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
        return true
      },
      close,
    }
    worker.onmessage = event => {
      const data = event.data
      if (closed) return
      if (data.type === 'error') { fail(new Error(data.message || 'Worker failed')); return }
      if (data.type === 'ready' && !ready) {
        const actual = (value: unknown) => value === 'GPU' || value === 'CPU' ? value : null
        delegates = { pose: actual(data.delegates?.pose), hand: actual(data.delegates?.hand) }
        initializationErrors = Array.isArray(data.initializationErrors) ? data.initializationErrors.filter((value: unknown) => typeof value === 'string') : []
        ready = true; clearTimeout(timeout); resolve(tracker); return
      }
      if (data.type === 'result' && ready && busy && data.id === sequence) {
        busy = false
        if (frameTimeout !== null) clearTimeout(frameTimeout); frameTimeout = null
        const inferenceMs = typeof data.inferenceMs === 'number' && Number.isFinite(data.inferenceMs) && data.inferenceMs >= 0 ? data.inferenceMs : undefined
        const latency = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
        const observations = typeof data.poseProcessed === 'boolean' && typeof data.handProcessed === 'boolean' ? {
          poseProcessed: data.poseProcessed, handProcessed: data.handProcessed,
          poseInferenceMs: latency(data.poseInferenceMs), handInferenceMs: latency(data.handInferenceMs),
          poseWorldLandmarks: data.poseWorldLandmarks ?? [], handWorldLandmarks: data.handWorldLandmarks ?? null,
          handedness: data.handedness ?? null,
        } : {}
        options.onResult({ timestamp: pendingTimestamp, pose: data.pose || [], hands: data.hands ?? null, inferenceMs, ...observations,
          ...(data.handFailed === true ? { handFailed: true, ...(typeof data.handError === 'string' ? { handError: data.handError } : {}), ...(data.handCleanupFailed === true ? { handCleanupFailed: true } : {}) } : {}) })
      }
    }
    worker.onerror = event => fail(new Error(event.message || 'Worker failed'))
    worker.onmessageerror = () => fail(new Error('Worker message could not be decoded'))
    if (options.signal?.aborted) { abort(); return }
    options.signal?.addEventListener('abort', abort, { once: true })
    try { worker.postMessage({ type: 'init', moduleUrl: options.moduleUrl, handEnabled: options.handEnabled, ...(options.role === undefined ? {} : { role: options.role }), ...(options.preferGpu === undefined ? {} : { preferGpu: options.preferGpu }) }) }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
}

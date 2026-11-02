import type { Point } from './drawing'

export type WorkerLandmark = Point & { z?: number; presence?: number }
export type WorkerCategory = { categoryName: string; displayName: string; score: number; index: number }

export type WorkerResult = {
  timestamp: number
  pose: WorkerLandmark[]
  hands: WorkerLandmark[][] | null
  inferenceMs?: number
  handFailed?: boolean
  handCleanupFailed?: boolean
  handError?: string
  poseProcessed?: boolean
  handProcessed?: boolean
  poseInferenceMs?: number | null
  handInferenceMs?: number | null
  poseWorldLandmarks?: WorkerLandmark[]
  handWorldLandmarks?: WorkerLandmark[][] | null
  handedness?: WorkerCategory[][] | null
}

export type WorkerHandResult = {
  id: number
  timestamp: number
  hands: WorkerLandmark[][]
  handWorldLandmarks: WorkerLandmark[][] | null
  handedness: WorkerCategory[][] | null
  handInferenceMs: number | null
  handProcessed: boolean
  transferMs?: number | null
  captureMs?: number | null
  handFailed?: boolean
  handError?: string
  handCleanupFailed?: boolean
}

export type WorkerPoseResult = {
  id: number
  timestamp: number
  pose: WorkerLandmark[]
  poseWorldLandmarks: WorkerLandmark[] | null
  poseInferenceMs: number | null
  poseProcessed: boolean
  transferMs?: number | null
  captureMs?: number | null
  poseFailed?: boolean
  poseError?: string
  poseCleanupFailed?: boolean
}

export type WorkerFrameComplete = {
  id: number
  timestamp: number
  inferenceMs: number
  poseProcessed: boolean
  handProcessed: boolean
  poseInferenceMs: number | null
  handInferenceMs: number | null
  transferMs?: number | null
  captureMs?: number | null
}

type Delegates = { pose: 'GPU' | 'CPU' | null; hand: 'GPU' | 'CPU' | null }
export type WorkerRole = 'both' | 'pose' | 'hand'

export type CaptureOutput = ImageBitmap | { bitmap: ImageBitmap; captureMs?: number; resizeMs?: number }

type Options = {
  worker: Worker
  moduleUrl: string
  handEnabled: boolean
  role?: WorkerRole
  preferGpu?: boolean
  capture: (video: HTMLVideoElement) => Promise<CaptureOutput>
  onResult?: (result: WorkerResult) => void
  onHandResult?: (result: WorkerHandResult) => void
  onPoseResult?: (result: WorkerPoseResult) => void
  onFrameComplete?: (result: WorkerFrameComplete) => void
  onError: (error: Error) => void
  signal?: AbortSignal
}

export type WorkerTracker = {
  submit: (video: HTMLVideoElement, timestamp: number, hand: boolean, pose?: boolean) => boolean
  close: () => void
  dispose: () => Promise<void>
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
    let completedSequence = 0

    const close = () => {
      if (closed) return
      closed = true
      busy = false
      clearTimeout(timeout)
      if (frameTimeout !== null) {
        clearTimeout(frameTimeout)
        frameTimeout = null
      }
      options.signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }

    const dispose = (): Promise<void> => {
      if (closed) return Promise.resolve()
      closed = true
      busy = false
      clearTimeout(timeout)
      if (frameTimeout !== null) {
        clearTimeout(frameTimeout)
        frameTimeout = null
      }
      options.signal?.removeEventListener('abort', abort)

      return new Promise<void>((resolve) => {
        let cleanupTimeout: ReturnType<typeof setTimeout> | null = null

        const terminateWorker = () => {
          if (cleanupTimeout !== null) {
            clearTimeout(cleanupTimeout)
            cleanupTimeout = null
          }
          worker.onmessage = null
          worker.onerror = null
          worker.onmessageerror = null
          worker.terminate()
          resolve()
        }

        cleanupTimeout = setTimeout(terminateWorker, 1000)

        worker.onmessage = (event) => {
          if (event.data?.type === 'disposed') {
            terminateWorker()
          }
        }
        worker.onerror = terminateWorker
        worker.onmessageerror = terminateWorker

        try {
          worker.postMessage({ type: 'dispose' })
        } catch {
          terminateWorker()
        }
      })
    }

    const fail = (error: Error) => {
      if (closed) return
      close()
      if (ready) options.onError(error)
      else reject(error)
    }

    const abort = () => {
      if (ready) close()
      else fail(new Error('Worker initialization cancelled'))
    }

    const timeout = setTimeout(() => fail(new Error('Worker initialization timed out')), 20000)

    const tracker: WorkerTracker = {
      get delegates() { return { ...delegates } },
      get initializationErrors() { return [...initializationErrors] },
      submit(video, timestamp, hand, pose = true) {
        if (closed || busy) return false
        busy = true
        pendingTimestamp = timestamp
        frameTimeout = setTimeout(() => fail(new Error('Worker inference timed out')), 8000)
        const id = ++sequence
        let capturePromise: Promise<CaptureOutput>
        try {
          capturePromise = options.capture(video)
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return true
        }
        capturePromise.then(output => {
          const isTimingResult = output && typeof output === 'object' && 'bitmap' in output && (output as { bitmap: unknown }).bitmap !== undefined
          const bitmap = isTimingResult ? (output as { bitmap: ImageBitmap }).bitmap : (output as ImageBitmap)
          const captureMs = isTimingResult && typeof (output as { captureMs?: number }).captureMs === 'number'
            ? (output as { captureMs: number }).captureMs : undefined

          if (closed) {
            bitmap.close()
            return
          }
          try {
            const submittedAt = performance.now()
            worker.postMessage({
              type: 'frame',
              id,
              bitmap,
              timestamp,
              submittedAt,
              ...(captureMs !== undefined ? { captureMs } : {}),
              hand,
              ...(pose ? {} : { pose: false }),
            }, [bitmap])
          } catch (error) {
            bitmap.close()
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
        return true
      },
      close,
      dispose,
    }

    worker.onmessage = event => {
      const data = event.data
      if (closed) return
      if (data.type === 'error') {
        fail(new Error(data.message || 'Worker failed'))
        return
      }
      if (data.type === 'ready' && !ready) {
        const actual = (value: unknown) => value === 'GPU' || value === 'CPU' ? value : null
        delegates = { pose: actual(data.delegates?.pose), hand: actual(data.delegates?.hand) }
        initializationErrors = Array.isArray(data.initializationErrors)
          ? data.initializationErrors.filter((value: unknown) => typeof value === 'string')
          : []
        ready = true
        clearTimeout(timeout)
        resolve(tracker)
        return
      }

      // Hand result delivered immediately to the main thread
      if (data.type === 'hand_result' && ready && busy && data.id === sequence) {
        options.onHandResult?.({
          id: data.id,
          timestamp: pendingTimestamp,
          hands: data.hands ?? [],
          handWorldLandmarks: data.handWorldLandmarks ?? null,
          handedness: data.handedness ?? null,
          handInferenceMs: typeof data.handInferenceMs === 'number' && Number.isFinite(data.handInferenceMs) ? data.handInferenceMs : null,
          handProcessed: data.handProcessed === true,
          transferMs: typeof data.transferMs === 'number' && Number.isFinite(data.transferMs) ? data.transferMs : null,
          captureMs: typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null,
          ...(data.handFailed === true ? { handFailed: true, handError: data.handError } : {}),
          ...(data.handCleanupFailed === true ? { handCleanupFailed: true } : {}),
        })
        return
      }

      // Pose result delivered immediately to the main thread
      if (data.type === 'pose_result' && ready && busy && data.id === sequence) {
        options.onPoseResult?.({
          id: data.id,
          timestamp: pendingTimestamp,
          pose: data.pose ?? [],
          poseWorldLandmarks: data.poseWorldLandmarks ?? null,
          poseInferenceMs: typeof data.poseInferenceMs === 'number' && Number.isFinite(data.poseInferenceMs) ? data.poseInferenceMs : null,
          poseProcessed: data.poseProcessed === true,
          transferMs: typeof data.transferMs === 'number' && Number.isFinite(data.transferMs) ? data.transferMs : null,
          captureMs: typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null,
          ...(data.poseFailed === true ? { poseFailed: true, poseError: data.poseError } : {}),
          ...(data.poseCleanupFailed === true ? { poseCleanupFailed: true } : {}),
        })
        return
      }

      // Frame complete or legacy result message
      if ((data.type === 'frame_complete' || data.type === 'result') && ready && busy && data.id === sequence) {
        if (completedSequence === sequence) return // Prevent double-dispatch if both frame_complete and result sent
        completedSequence = sequence
        busy = false
        if (frameTimeout !== null) {
          clearTimeout(frameTimeout)
          frameTimeout = null
        }

        const inferenceMs = typeof data.inferenceMs === 'number' && Number.isFinite(data.inferenceMs) && data.inferenceMs >= 0
          ? data.inferenceMs : undefined
        const latency = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
        const observations = typeof data.poseProcessed === 'boolean' && typeof data.handProcessed === 'boolean' ? {
          poseProcessed: data.poseProcessed,
          handProcessed: data.handProcessed,
          poseInferenceMs: latency(data.poseInferenceMs),
          handInferenceMs: latency(data.handInferenceMs),
          poseWorldLandmarks: data.poseWorldLandmarks ?? [],
          handWorldLandmarks: data.handWorldLandmarks ?? null,
          handedness: data.handedness ?? null,
        } : {}

        options.onFrameComplete?.({
          id: data.id,
          timestamp: pendingTimestamp,
          inferenceMs: inferenceMs ?? 0,
          poseProcessed: data.poseProcessed === true,
          handProcessed: data.handProcessed === true,
          poseInferenceMs: latency(data.poseInferenceMs),
          handInferenceMs: latency(data.handInferenceMs),
          transferMs: latency(data.transferMs),
          captureMs: latency(data.captureMs),
        })

        options.onResult?.({
          timestamp: pendingTimestamp,
          pose: data.pose || [],
          hands: data.hands ?? null,
          inferenceMs,
          ...observations,
          ...(data.handFailed === true ? {
            handFailed: true,
            ...(typeof data.handError === 'string' ? { handError: data.handError } : {}),
            ...(data.handCleanupFailed === true ? { handCleanupFailed: true } : {}),
          } : {}),
        })
      }
    }

    worker.onerror = event => fail(new Error(event.message || 'Worker failed'))
    worker.onmessageerror = () => fail(new Error('Worker message could not be decoded'))

    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      worker.postMessage({
        type: 'init',
        moduleUrl: options.moduleUrl,
        handEnabled: options.handEnabled,
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.preferGpu === undefined ? {} : { preferGpu: options.preferGpu }),
      })
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

import type { Point } from './drawing'

export type WorkerLandmark = Point & { z?: number; presence?: number }
export type WorkerCategory = { categoryName: string; displayName: string; score: number; index: number }

export type SourceFrameIdentity = {
  sourceFrameId?: number | null
  sourceMediaTimeMs?: number | null
  sourcePerformanceMs?: number
}
export type WorkerFrameIdentity = {
  requestId: number
  sourceFrameId: number | null
  sourceMediaTimeMs: number | null
  sourcePerformanceMs: number
}

export type WorkerResult = Partial<WorkerFrameIdentity> & {
  timestamp: number
  pose: WorkerLandmark[]
  hands: WorkerLandmark[][] | null
  inferenceMs?: number
  transferAndDispatchMs?: number | null
  captureResizeTotalMs?: number | null
  handFailed?: boolean
  handCleanupFailed?: boolean
  handError?: string
  poseFailed?: boolean
  poseError?: string
  poseCleanupFailed?: boolean
  poseProcessed?: boolean
  handProcessed?: boolean
  poseInferenceMs?: number | null
  handInferenceMs?: number | null
  poseWorldLandmarks?: WorkerLandmark[]
  handWorldLandmarks?: WorkerLandmark[][] | null
  handedness?: WorkerCategory[][] | null
}

export type WorkerHandResult = WorkerFrameIdentity & {
  id: number
  timestamp: number
  hands: WorkerLandmark[][]
  handWorldLandmarks: WorkerLandmark[][] | null
  handedness: WorkerCategory[][] | null
  handInferenceMs: number | null
  handProcessed: boolean
  transferAndDispatchMs?: number | null
  transferMs?: number | null
  captureResizeTotalMs?: number | null
  captureMs?: number | null
  handFailed?: boolean
  handError?: string
  handCleanupFailed?: boolean
}

export type WorkerPoseResult = WorkerFrameIdentity & {
  id: number
  timestamp: number
  pose: WorkerLandmark[]
  poseWorldLandmarks: WorkerLandmark[] | null
  poseInferenceMs: number | null
  poseProcessed: boolean
  transferAndDispatchMs?: number | null
  transferMs?: number | null
  captureResizeTotalMs?: number | null
  captureMs?: number | null
  poseFailed?: boolean
  poseError?: string
  poseCleanupFailed?: boolean
}

export type WorkerFrameComplete = WorkerFrameIdentity & {
  id: number
  timestamp: number
  inferenceMs: number
  poseProcessed: boolean
  handProcessed: boolean
  poseInferenceMs: number | null
  handInferenceMs: number | null
  transferAndDispatchMs?: number | null
  transferMs?: number | null
  captureResizeTotalMs?: number | null
  captureMs?: number | null
  handFailed?: boolean
  handError?: string
  handCleanupFailed?: boolean
  poseFailed?: boolean
  poseError?: string
  poseCleanupFailed?: boolean
}

type Delegates = { pose: 'GPU' | 'CPU' | null; hand: 'GPU' | 'CPU' | null }
export type WorkerRole = 'both' | 'pose' | 'hand'

export type CaptureOutput = ImageBitmap | { bitmap: ImageBitmap; captureResizeTotalMs?: number; captureMs?: number; resizeMs?: number }

type Options = {
  worker: Worker
  moduleUrl: string
  handEnabled: boolean
  role?: WorkerRole
  preferGpu?: boolean
  handFirst?: boolean
  /** Optional allowance for cold GPU shader compilation on the first frame only. */
  initialFrameTimeoutMs?: number
  capture: (video: HTMLVideoElement) => Promise<CaptureOutput>
  onResult?: (result: WorkerResult) => void
  onHandResult?: (result: WorkerHandResult) => void
  onPoseResult?: (result: WorkerPoseResult) => void
  onFrameComplete?: (result: WorkerFrameComplete) => void
  onError: (error: Error) => void
  signal?: AbortSignal
}

export type WorkerTracker = {
  submit: (video: HTMLVideoElement, timestamp: number, hand: boolean, pose?: boolean, source?: number | SourceFrameIdentity) => boolean
  close: () => void
  dispose: () => Promise<void>
  readonly delegates: Delegates
  readonly initializationErrors: string[]
  readonly lastRequestId: number | null
}

// Shared between pages so a route change cannot initialize a model while an old
// page's Worker is still closing its WebGL resources. The set only holds drains.
const pendingDisposals = new Set<Promise<void>>()
let disposalFailure: Error | null = null
export async function waitForWorkerDisposals(): Promise<void> {
  if (disposalFailure) throw disposalFailure
  while (pendingDisposals.size > 0) await Promise.all([...pendingDisposals])
  if (disposalFailure) throw disposalFailure
}

/** Exactly one bitmap capture or inference can be pending. No frame queue is kept. */
export function createWorkerTracker(options: Options): Promise<WorkerTracker> {
  return new Promise((resolve, reject) => {
    const { worker } = options
    let ready = false, closed = false, busy = false, sequence = 0
    let pendingTimestamp = 0
    let identity: WorkerFrameIdentity | null = null
    let delegates: Delegates = { pose: null, hand: null }
    let initializationErrors: string[] = []
    let frameTimeout: ReturnType<typeof setTimeout> | null = null
    let completedSequence = 0
    let disposal: Promise<void> | null = null
    let initializationPosted = false

    let latestHandForSequence: WorkerHandResult | null = null
    let latestPoseForSequence: WorkerPoseResult | null = null

    const forceCloseBeforeInitialization = () => {
      if (closed) return
      closed = true
      busy = false
      identity = null
      latestHandForSequence = null
      latestPoseForSequence = null
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
      if (disposal) return disposal
      if (closed) return Promise.resolve()
      // A synchronous dispatch failure (or abort before dispatch) cannot have
      // created MediaPipe models, so no acknowledgement is needed in that case.
      if (!initializationPosted) {
        forceCloseBeforeInitialization()
        disposal = Promise.resolve()
        return disposal
      }
      closed = true
      busy = false
      identity = null
      latestHandForSequence = null
      latestPoseForSequence = null
      clearTimeout(timeout)
      if (frameTimeout !== null) {
        clearTimeout(frameTimeout)
        frameTimeout = null
      }
      options.signal?.removeEventListener('abort', abort)

      disposal = new Promise<void>((resolveDisposal, rejectDisposal) => {
        let cleanupTimeout: ReturnType<typeof setTimeout> | null = null
        let finished = false

        const terminateWorker = (error?: Error) => {
          if (finished) return
          finished = true
          if (cleanupTimeout !== null) {
            clearTimeout(cleanupTimeout)
            cleanupTimeout = null
          }
          worker.onmessage = null
          worker.onerror = null
          worker.onmessageerror = null
          worker.terminate()
          if (error) {
            disposalFailure = error
            options.onError(error)
            rejectDisposal(error)
          } else resolveDisposal()
        }

        cleanupTimeout = setTimeout(() => {
          terminateWorker(new Error('Worker disposal timed out; model cleanup was not acknowledged'))
        }, 1500)

        worker.onmessage = (event) => {
          if (event.data?.type === 'disposed') {
            const cleanupErrors = event.data?.cleanupErrors
            if (Array.isArray(cleanupErrors) && cleanupErrors.length > 0) {
              const err = new Error(`Worker cleanup failed: ${cleanupErrors.join('; ')}`)
              terminateWorker(err)
            } else {
              terminateWorker()
            }
          }
        }
        worker.onerror = (e) => terminateWorker(new Error(`Worker disposal error: ${e.message || 'Worker failed'}; model cleanup was not acknowledged`))
        worker.onmessageerror = () => terminateWorker(new Error('Worker disposal decode error; model cleanup was not acknowledged'))

        try {
          worker.postMessage({ type: 'dispose' })
        } catch (error) {
          terminateWorker(error instanceof Error ? error : new Error(String(error)))
        }
      })
      pendingDisposals.add(disposal)
      const removeDisposal = () => { if (disposal) pendingDisposals.delete(disposal) }
      void disposal.then(removeDisposal, removeDisposal)
      return disposal
    }

    const fail = (error: Error) => {
      if (closed) return
      const wasReady = ready
      const drain = dispose()
      if (wasReady) {
        options.onError(error)
        // dispose reports cleanup failures through onError; keep its rejected
        // promise for callers without creating an unhandled rejection here.
        void drain.then(() => {}, () => {})
      } else {
        void drain.then(() => reject(error), cleanupError => reject(new Error(`${error.message}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)))
      }
    }

    const abort = () => {
      const wasReady = ready
      void dispose().then(() => {
        if (!wasReady) reject(new Error('Worker initialization cancelled'))
      }, error => {
        if (!wasReady) reject(new Error(`Worker initialization cancelled; ${error instanceof Error ? error.message : String(error)}`))
      })
    }

    const timeout = setTimeout(() => fail(new Error('Worker initialization timed out')), 20000)

    const tracker: WorkerTracker = {
      get delegates() { return { ...delegates } },
      get initializationErrors() { return [...initializationErrors] },
      get lastRequestId() { return sequence > 0 ? sequence : null },
      submit(video, timestamp, hand, pose = true, source?: number | SourceFrameIdentity) {
        if (closed || busy) return false
        busy = true
        pendingTimestamp = timestamp
        const id = ++sequence
        const initialBudget = typeof options.initialFrameTimeoutMs === 'number' && Number.isFinite(options.initialFrameTimeoutMs)
          ? Math.max(8000, Math.min(30000, options.initialFrameTimeoutMs)) : 8000
        frameTimeout = setTimeout(() => fail(new Error('Worker inference timed out')), id === 1 ? initialBudget : 8000)
        const sourceIdentity = typeof source === 'number' ? { sourceFrameId: source } : source
        const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
        const sourceMediaTimeMs = sourceIdentity?.sourceMediaTimeMs ?? (finite(video.currentTime) ? video.currentTime * 1000 : null)
        const submittedIdentity: WorkerFrameIdentity = {
          requestId: id,
          sourceFrameId: Number.isSafeInteger(sourceIdentity?.sourceFrameId) ? sourceIdentity!.sourceFrameId! : null,
          sourceMediaTimeMs: finite(sourceMediaTimeMs) ? sourceMediaTimeMs : null,
          sourcePerformanceMs: finite(sourceIdentity?.sourcePerformanceMs) ? sourceIdentity.sourcePerformanceMs : timestamp,
        }
        identity = submittedIdentity
        latestHandForSequence = null
        latestPoseForSequence = null
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
          const timingObj = isTimingResult ? (output as Record<string, unknown>) : null
          const captureResizeTotalMs = timingObj && typeof timingObj.captureResizeTotalMs === 'number'
            ? timingObj.captureResizeTotalMs
            : timingObj && typeof timingObj.captureMs === 'number' ? timingObj.captureMs : undefined

          if (closed) {
            bitmap.close()
            return
          }
          try {
            const submittedAt = performance.timeOrigin + performance.now()
            worker.postMessage({
              type: 'frame',
              id,
              ...submittedIdentity,
              bitmap,
              timestamp,
              submittedAt,
              ...(captureResizeTotalMs !== undefined ? { captureResizeTotalMs, captureMs: captureResizeTotalMs } : {}),
              hand,
              ...(pose ? {} : { pose: false }),
              ...(options.handFirst !== undefined ? { handFirst: options.handFirst } : {}),
            }, [bitmap])
          } catch (error) {
            bitmap.close()
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        }).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
        return true
      },
      close: () => {
        // Legacy callers cannot await close(), but their shutdown must still
        // participate in the shared barrier before another engine starts.
        void dispose().catch(error => { console.error('Worker cleanup failed during close', error) })
      },
      dispose,
    }

    worker.onmessage = event => {
      const data = event.data
      if (closed) return
      if (data.type === 'error') {
        fail(new Error(data.message || 'Worker failed'))
        return
      }
      if (data.type === 'ready' && !ready && initializationPosted) {
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

      const requestId = data.requestId ?? data.id
      if (!ready || !busy || !identity || requestId !== sequence || (data.id !== undefined && data.id !== requestId)) return
      if (['sourceFrameId', 'sourceMediaTimeMs', 'sourcePerformanceMs'].some(key => data[key] !== undefined && data[key] !== identity![key as keyof WorkerFrameIdentity])) return

      // Hand result delivered immediately to the main thread
      if (data.type === 'hand_result') {
        if (latestHandForSequence) return
        const transferVal = typeof data.transferAndDispatchMs === 'number' && Number.isFinite(data.transferAndDispatchMs)
          ? data.transferAndDispatchMs
          : typeof data.transferMs === 'number' && Number.isFinite(data.transferMs) ? data.transferMs : null
        const captureVal = typeof data.captureResizeTotalMs === 'number' && Number.isFinite(data.captureResizeTotalMs)
          ? data.captureResizeTotalMs
          : typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null
        const handResult: WorkerHandResult = {
          ...identity,
          id: requestId,
          timestamp: pendingTimestamp,
          hands: data.hands ?? [],
          handWorldLandmarks: data.handWorldLandmarks ?? null,
          handedness: data.handedness ?? null,
          handInferenceMs: typeof data.handInferenceMs === 'number' && Number.isFinite(data.handInferenceMs) ? data.handInferenceMs : null,
          handProcessed: data.handProcessed === true,
          transferAndDispatchMs: transferVal,
          transferMs: transferVal,
          captureResizeTotalMs: captureVal,
          captureMs: captureVal,
          ...(data.handFailed === true ? { handFailed: true, handError: data.handError } : {}),
          ...(data.handCleanupFailed === true ? { handCleanupFailed: true } : {}),
        }
        latestHandForSequence = handResult
        options.onHandResult?.(handResult)
        return
      }

      // Pose result delivered immediately to the main thread
      if (data.type === 'pose_result') {
        if (latestPoseForSequence) return
        const transferVal = typeof data.transferAndDispatchMs === 'number' && Number.isFinite(data.transferAndDispatchMs)
          ? data.transferAndDispatchMs
          : typeof data.transferMs === 'number' && Number.isFinite(data.transferMs) ? data.transferMs : null
        const captureVal = typeof data.captureResizeTotalMs === 'number' && Number.isFinite(data.captureResizeTotalMs)
          ? data.captureResizeTotalMs
          : typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null
        const poseResult: WorkerPoseResult = {
          ...identity,
          id: requestId,
          timestamp: pendingTimestamp,
          pose: data.pose ?? [],
          poseWorldLandmarks: data.poseWorldLandmarks ?? null,
          poseInferenceMs: typeof data.poseInferenceMs === 'number' && Number.isFinite(data.poseInferenceMs) ? data.poseInferenceMs : null,
          poseProcessed: data.poseProcessed === true,
          transferAndDispatchMs: transferVal,
          transferMs: transferVal,
          captureResizeTotalMs: captureVal,
          captureMs: captureVal,
          ...(data.poseFailed === true ? { poseFailed: true, poseError: data.poseError } : {}),
          ...(data.poseCleanupFailed === true ? { poseCleanupFailed: true } : {}),
        }
        latestPoseForSequence = poseResult
        options.onPoseResult?.(poseResult)
        return
      }

      // Frame complete or legacy result message
      if (data.type === 'frame_complete' || data.type === 'result') {
        if (completedSequence === sequence) return // Prevent double-dispatch if both frame_complete and result sent
        completedSequence = sequence
        const completedIdentity = identity
        const timestamp = pendingTimestamp
        const completedHand = latestHandForSequence
        const completedPose = latestPoseForSequence
        identity = null
        latestHandForSequence = null
        latestPoseForSequence = null
        busy = false
        if (frameTimeout !== null) {
          clearTimeout(frameTimeout)
          frameTimeout = null
        }

        const inferenceMs = typeof data.inferenceMs === 'number' && Number.isFinite(data.inferenceMs) && data.inferenceMs >= 0
          ? data.inferenceMs : undefined
        const latency = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

        const transferVal = latency(data.transferAndDispatchMs ?? data.transferMs)
        const captureVal = latency(data.captureResizeTotalMs ?? data.captureMs)

        options.onFrameComplete?.({
          ...completedIdentity,
          id: requestId,
          timestamp,
          inferenceMs: inferenceMs ?? 0,
          poseProcessed: data.poseProcessed === true,
          handProcessed: data.handProcessed === true,
          poseInferenceMs: latency(data.poseInferenceMs),
          handInferenceMs: latency(data.handInferenceMs),
          transferAndDispatchMs: transferVal,
          transferMs: transferVal,
          captureResizeTotalMs: captureVal,
          captureMs: captureVal,
          ...(data.handFailed === true ? { handFailed: true, handError: data.handError } : {}),
          ...(data.handCleanupFailed === true ? { handCleanupFailed: true } : {}),
          ...(data.poseFailed === true ? { poseFailed: true, poseError: data.poseError } : {}),
          ...(data.poseCleanupFailed === true ? { poseCleanupFailed: true } : {}),
        })
        if (closed) return

        // Backward compatibility for consumers expecting aggregated onResult
        const aggregatedPose = data.poseProcessed === false || data.poseFailed === true ? [] : data.pose || completedPose?.pose || []
        const aggregatedHands = data.handProcessed === false || data.handFailed === true ? [] : data.hands !== undefined ? data.hands : (completedHand ? completedHand.hands : null)
        const aggregatedPoseWorld = data.poseProcessed === false || data.poseFailed === true ? [] : data.poseWorldLandmarks ?? completedPose?.poseWorldLandmarks ?? []
        const aggregatedHandWorld = data.handProcessed === false || data.handFailed === true ? [] : data.handWorldLandmarks ?? completedHand?.handWorldLandmarks ?? null
        const aggregatedHandedness = data.handProcessed === false || data.handFailed === true ? [] : data.handedness ?? completedHand?.handedness ?? null

        const hasObservations = (typeof data.poseProcessed === 'boolean' && typeof data.handProcessed === 'boolean')
          || (completedPose !== null || completedHand !== null)

        const observations = hasObservations ? {
          poseProcessed: typeof data.poseProcessed === 'boolean' ? data.poseProcessed : completedPose?.poseProcessed ?? false,
          handProcessed: typeof data.handProcessed === 'boolean' ? data.handProcessed : completedHand?.handProcessed ?? false,
          poseInferenceMs: latency(data.poseInferenceMs ?? completedPose?.poseInferenceMs),
          handInferenceMs: latency(data.handInferenceMs ?? completedHand?.handInferenceMs),
          poseWorldLandmarks: aggregatedPoseWorld,
          handWorldLandmarks: aggregatedHandWorld,
          handedness: aggregatedHandedness,
        } : {}

        options.onResult?.({
          ...completedIdentity,
          timestamp,
          pose: aggregatedPose,
          hands: aggregatedHands,
          inferenceMs,
          transferAndDispatchMs: transferVal,
          captureResizeTotalMs: captureVal,
          ...observations,
          ...(data.handFailed === true || completedHand?.handFailed === true ? {
            handFailed: true,
            ...(typeof data.handError === 'string' ? { handError: data.handError } : typeof completedHand?.handError === 'string' ? { handError: completedHand.handError } : {}),
            ...(data.handCleanupFailed === true || completedHand?.handCleanupFailed === true ? { handCleanupFailed: true } : {}),
          } : {}),
          ...(data.poseFailed === true || completedPose?.poseFailed === true ? {
            poseFailed: true,
            ...(typeof data.poseError === 'string' ? { poseError: data.poseError } : typeof completedPose?.poseError === 'string' ? { poseError: completedPose.poseError } : {}),
            ...(data.poseCleanupFailed === true || completedPose?.poseCleanupFailed === true ? { poseCleanupFailed: true } : {}),
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
    const initialize = () => {
      if (closed) return
      try { worker.postMessage({
        type: 'init',
        moduleUrl: options.moduleUrl,
        handEnabled: options.handEnabled,
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.preferGpu === undefined ? {} : { preferGpu: options.preferGpu }),
      }); initializationPosted = true } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    }
    if (pendingDisposals.size === 0 && !disposalFailure) initialize()
    else void waitForWorkerDisposals().then(initialize, error => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

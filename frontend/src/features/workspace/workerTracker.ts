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
  transferAndDispatchMs?: number | null
  transferMs?: number | null
  captureResizeTotalMs?: number | null
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
  transferAndDispatchMs?: number | null
  transferMs?: number | null
  captureResizeTotalMs?: number | null
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
  capture: (video: HTMLVideoElement) => Promise<CaptureOutput>
  onResult?: (result: WorkerResult) => void
  onHandResult?: (result: WorkerHandResult) => void
  onPoseResult?: (result: WorkerPoseResult) => void
  onFrameComplete?: (result: WorkerFrameComplete) => void
  onError: (error: Error) => void
  signal?: AbortSignal
}

export type WorkerTracker = {
  submit: (video: HTMLVideoElement, timestamp: number, hand: boolean, pose?: boolean, frameId?: number) => boolean
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

    let latestHandForSequence: WorkerHandResult | null = null
    let latestPoseForSequence: WorkerPoseResult | null = null

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

      return new Promise<void>((resolve, reject) => {
        let cleanupTimeout: ReturnType<typeof setTimeout> | null = null

        const terminateWorker = (error?: Error) => {
          if (cleanupTimeout !== null) {
            clearTimeout(cleanupTimeout)
            cleanupTimeout = null
          }
          worker.onmessage = null
          worker.onerror = null
          worker.onmessageerror = null
          worker.terminate()
          if (error) reject(error)
          else resolve()
        }

        cleanupTimeout = setTimeout(() => {
          terminateWorker(new Error('Worker disposal timed out'))
        }, 1500)

        worker.onmessage = (event) => {
          if (event.data?.type === 'disposed') {
            const cleanupErrors = event.data?.cleanupErrors
            if (Array.isArray(cleanupErrors) && cleanupErrors.length > 0) {
              const err = new Error(`Worker cleanup failed: ${cleanupErrors.join('; ')}`)
              options.onError(err)
              terminateWorker(err)
            } else {
              terminateWorker()
            }
          }
        }
        worker.onerror = (e) => terminateWorker(new Error(e.message || 'Worker disposal error'))
        worker.onmessageerror = () => terminateWorker(new Error('Worker disposal decode error'))

        try {
          worker.postMessage({ type: 'dispose' })
        } catch (error) {
          terminateWorker(error instanceof Error ? error : new Error(String(error)))
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
      submit(video, timestamp, hand, pose = true, frameId?: number) {
        if (closed || busy) return false
        busy = true
        pendingTimestamp = timestamp
        frameTimeout = setTimeout(() => fail(new Error('Worker inference timed out')), 8000)
        const id = typeof frameId === 'number' ? frameId : ++sequence
        sequence = id
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
        const transferVal = typeof data.transferAndDispatchMs === 'number' && Number.isFinite(data.transferAndDispatchMs)
          ? data.transferAndDispatchMs
          : typeof data.transferMs === 'number' && Number.isFinite(data.transferMs) ? data.transferMs : null
        const captureVal = typeof data.captureResizeTotalMs === 'number' && Number.isFinite(data.captureResizeTotalMs)
          ? data.captureResizeTotalMs
          : typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null
        const handResult: WorkerHandResult = {
          id: data.id,
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
      if (data.type === 'pose_result' && ready && busy && data.id === sequence) {
        const transferVal = typeof data.transferAndDispatchMs === 'number' && Number.isFinite(data.transferAndDispatchMs)
          ? data.transferAndDispatchMs
          : typeof data.transferMs === 'number' && Number.isFinite(data.transferMs) ? data.transferMs : null
        const captureVal = typeof data.captureResizeTotalMs === 'number' && Number.isFinite(data.captureResizeTotalMs)
          ? data.captureResizeTotalMs
          : typeof data.captureMs === 'number' && Number.isFinite(data.captureMs) ? data.captureMs : null
        const poseResult: WorkerPoseResult = {
          id: data.id,
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

        const transferVal = latency(data.transferAndDispatchMs ?? data.transferMs)
        const captureVal = latency(data.captureResizeTotalMs ?? data.captureMs)

        options.onFrameComplete?.({
          id: data.id,
          timestamp: pendingTimestamp,
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

        // Backward compatibility for consumers expecting aggregated onResult
        const aggregatedPose = data.pose || latestPoseForSequence?.pose || []
        const aggregatedHands = data.hands !== undefined ? data.hands : (latestHandForSequence ? latestHandForSequence.hands : null)
        const aggregatedPoseWorld = data.poseWorldLandmarks ?? latestPoseForSequence?.poseWorldLandmarks ?? []
        const aggregatedHandWorld = data.handWorldLandmarks ?? latestHandForSequence?.handWorldLandmarks ?? null
        const aggregatedHandedness = data.handedness ?? latestHandForSequence?.handedness ?? null

        const hasObservations = (typeof data.poseProcessed === 'boolean' && typeof data.handProcessed === 'boolean')
          || (latestPoseForSequence !== null || latestHandForSequence !== null)

        const observations = hasObservations ? {
          poseProcessed: typeof data.poseProcessed === 'boolean' ? data.poseProcessed : latestPoseForSequence?.poseProcessed ?? false,
          handProcessed: typeof data.handProcessed === 'boolean' ? data.handProcessed : latestHandForSequence?.handProcessed ?? false,
          poseInferenceMs: latency(data.poseInferenceMs ?? latestPoseForSequence?.poseInferenceMs),
          handInferenceMs: latency(data.handInferenceMs ?? latestHandForSequence?.handInferenceMs),
          poseWorldLandmarks: aggregatedPoseWorld,
          handWorldLandmarks: aggregatedHandWorld,
          handedness: aggregatedHandedness,
        } : {}

        options.onResult?.({
          timestamp: pendingTimestamp,
          pose: aggregatedPose,
          hands: aggregatedHands,
          inferenceMs,
          ...observations,
          ...(data.handFailed === true || latestHandForSequence?.handFailed === true ? {
            handFailed: true,
            ...(typeof data.handError === 'string' ? { handError: data.handError } : typeof latestHandForSequence?.handError === 'string' ? { handError: latestHandForSequence.handError } : {}),
            ...(data.handCleanupFailed === true || latestHandForSequence?.handCleanupFailed === true ? { handCleanupFailed: true } : {}),
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

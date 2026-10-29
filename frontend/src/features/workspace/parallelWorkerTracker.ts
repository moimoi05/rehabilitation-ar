import { createWorkerTracker } from './workerTracker'
import type { WorkerResult, WorkerTracker } from './workerTracker'

type Options = {
  poseWorker: Worker
  handWorker: Worker
  moduleUrl: string
  capture: (video: HTMLVideoElement) => Promise<ImageBitmap>
  onPose: (result: WorkerResult) => void
  onHand: (result: WorkerResult) => void
  onPoseError: (error: Error) => void
  onHandError: (error: Error) => void
  signal?: AbortSignal
}

export type ParallelWorkerTracker = {
  submitPose: (video: HTMLVideoElement, timestamp: number) => boolean
  submitHand: (video: HTMLVideoElement, timestamp: number) => boolean
  close: () => void
}

/** Each worker owns at most one pending capture/inference; no frames are queued.
 * Hand initialization failure is reported through onHandError, potentially before
 * this promise resolves. Pose initialization failure rejects the promise.
 */
export async function createParallelWorkerTracker(options: Options): Promise<ParallelWorkerTracker> {
  const controller = new AbortController()
  let closed = false, initialized = false, handAvailable = true
  let poseTracker: WorkerTracker | null = null, handTracker: WorkerTracker | null = null
  let startupFailure: Error | null = null

  const close = () => {
    if (closed) return
    closed = true
    options.signal?.removeEventListener('abort', close)
    controller.abort()
    poseTracker?.close(); handTracker?.close()
    poseTracker = null; handTracker = null
  }
  if (options.signal?.aborted) {
    options.poseWorker.terminate(); options.handWorker.terminate()
    throw new Error('Parallel worker initialization cancelled')
  }
  options.signal?.addEventListener('abort', close, { once: true })

  const handError = (error: Error) => {
    if (closed || !handAvailable) return
    handAvailable = false
    handTracker?.close(); handTracker = null
    options.onHandError(error)
  }
  const poseError = (error: Error) => {
    if (closed) return
    if (!initialized) startupFailure = error
    close()
    if (initialized) options.onPoseError(error)
  }
  const poseInit = createWorkerTracker({
    worker: options.poseWorker, moduleUrl: options.moduleUrl, role: 'pose', handEnabled: false,
    capture: options.capture, signal: controller.signal,
    onResult: result => { if (!closed) options.onPose(result) }, onError: poseError,
  }).then(tracker => { if (closed) tracker.close(); else poseTracker = tracker; return tracker })
  const handInit = createWorkerTracker({
    worker: options.handWorker, moduleUrl: options.moduleUrl, role: 'hand', handEnabled: true,
    capture: options.capture, signal: controller.signal,
    onResult: result => {
      if (closed || !handAvailable) return
      if (result.handFailed) { handAvailable = false; handTracker?.close(); handTracker = null }
      options.onHand(result)
    },
    onError: handError,
  }).then(tracker => {
    if (closed || !handAvailable) tracker.close()
    else handTracker = tracker
    return tracker
  }).catch((error: unknown) => {
    handError(error instanceof Error ? error : new Error(String(error)))
    return null
  })

  try {
    await Promise.all([poseInit, handInit])
    if (closed) throw startupFailure || new Error('Parallel worker initialization cancelled')
    initialized = true
    return {
      submitPose: (video, timestamp) => !closed && !!poseTracker?.submit(video, timestamp, false),
      submitHand: (video, timestamp) => !closed && handAvailable && !!handTracker?.submit(video, timestamp, true),
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}

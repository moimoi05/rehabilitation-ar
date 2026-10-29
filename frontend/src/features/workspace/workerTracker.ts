import type { Point } from './drawing'

export type WorkerResult = { timestamp: number; pose: Point[]; hands: Point[][] | null; inferenceMs?: number; handFailed?: boolean; handCleanupFailed?: boolean }
export type WorkerRole = 'both' | 'pose' | 'hand'
type Options = {
  worker: Worker
  moduleUrl: string
  handEnabled: boolean
  role?: WorkerRole
  capture: (video: HTMLVideoElement) => Promise<ImageBitmap>
  onResult: (result: WorkerResult) => void
  onError: (error: Error) => void
  signal?: AbortSignal
}
export type WorkerTracker = { submit: (video: HTMLVideoElement, timestamp: number, hand: boolean) => boolean; close: () => void }

/** Exactly one bitmap capture or inference can be pending. No frame queue is kept. */
export function createWorkerTracker(options: Options): Promise<WorkerTracker> {
  return new Promise((resolve, reject) => {
    const { worker } = options
    let ready = false, closed = false, busy = false, sequence = 0
    let pendingTimestamp = 0
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
      submit(video, timestamp, hand) {
        if (closed || busy) return false
        busy = true; pendingTimestamp = timestamp
        frameTimeout = setTimeout(() => fail(new Error('Worker inference timed out')), 8000)
        const id = ++sequence
        let capture: Promise<ImageBitmap>
        try { capture = options.capture(video) }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return true }
        capture.then(bitmap => {
          if (closed) { bitmap.close(); return }
          try { worker.postMessage({ type: 'frame', id, bitmap, timestamp, hand }, [bitmap]) }
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
      if (data.type === 'ready' && !ready) { ready = true; clearTimeout(timeout); resolve(tracker); return }
      if (data.type === 'result' && ready && busy && data.id === sequence) {
        busy = false
        if (frameTimeout !== null) clearTimeout(frameTimeout); frameTimeout = null
        const inferenceMs = typeof data.inferenceMs === 'number' && Number.isFinite(data.inferenceMs) && data.inferenceMs >= 0 ? data.inferenceMs : undefined
        options.onResult({ timestamp: pendingTimestamp, pose: data.pose || [], hands: data.hands ?? null, inferenceMs, ...(data.handFailed === true ? { handFailed: true, ...(data.handCleanupFailed === true ? { handCleanupFailed: true } : {}) } : {}) })
      }
    }
    worker.onerror = event => fail(new Error(event.message || 'Worker failed'))
    worker.onmessageerror = () => fail(new Error('Worker message could not be decoded'))
    if (options.signal?.aborted) { abort(); return }
    options.signal?.addEventListener('abort', abort, { once: true })
    try { worker.postMessage({ type: 'init', moduleUrl: options.moduleUrl, handEnabled: options.handEnabled, ...(options.role === undefined ? {} : { role: options.role }) }) }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
}

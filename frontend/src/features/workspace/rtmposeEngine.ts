import { adaptRTMPoseWholeBody, createRtmposeCropTransform } from './rtmposeAdapter'
import type { NormalizedPersonRoi, RtmposeKeypoint } from './rtmposeAdapter'

const endpoint = 'http://127.0.0.1:8766'
let drain: Promise<void> = Promise.resolve()
const drainService = async () => {
  const response = await fetch(`${endpoint}/drain`, { signal: AbortSignal.timeout(20000) })
  if (!response.ok || (await response.json()).idle !== true) throw new Error('RTMPose service has not finished the previous GPU request')
}
export async function waitForRTMPoseDrain() {
  try { await drain } catch { drain = drainService(); await drain }
}
export type TrackingRuntimeInfo = { runtime: string; device: string; model: string; gpuVerified: boolean; serviceVersion?: string; detector?: unknown; roiStrategy?: string }
export type RTMPoseResult = ReturnType<typeof adaptRTMPoseWholeBody> & {
  timestamp: number; inferenceMs: number; runtimeInfo: TrackingRuntimeInfo
  timings: Record<string, number>; deliveredAt: number; roiValid: boolean; stageTimestamps: Record<string, number> | null
  trackingRegion: { roi: number[]; crop: Response['crop']; roiValid: boolean; detector: boolean; detectorInfo?: unknown; validationRoi?: number[] }
}
type Options = { onResult: (result: RTMPoseResult) => void; onError: (error: Error) => void; roi?: NormalizedPersonRoi; signal?: AbortSignal; personDetection?: boolean }
type Response = { keypoints: RtmposeKeypoint[]; imageWidth: number; imageHeight: number; inputWidth: number; inputHeight: number; crop: {x: number; y: number; width: number; height: number}; roi: number[]; validationRoi?: number[]; timings: Record<string, number>; roiValid: boolean; stageTimestamps?: Record<string, number>; detector?: { metadata?: unknown; valid?: boolean; people?: unknown } }

/** One outstanding frame, local-only GPU service. Never falls back to CPU/MediaPipe. */
export async function createRTMPoseEngine(options: Options) {
  const roi = options.personDetection ? { x: 0, y: 0, width: 1, height: 1 } : options.roi ?? { x: 0, y: 0, width: 1, height: 1 }
  createRtmposeCropTransform({ roi, imageWidth: 1, imageHeight: 1, inputWidth: 192, inputHeight: 256 })
  const controller = new AbortController()
  let closed = false, busy = false
  let outstanding: Promise<void> = Promise.resolve()
  let releaseFrame: (() => void) | null = null
  const close = () => {
    if (closed) return
    closed = true; controller.abort(); options.signal?.removeEventListener('abort', close)
    if (busy) {
      drain = outstanding.then(drainService)
      // Retain a rejecting barrier for the next initialization, avoid an unhandled rejection meanwhile.
      void drain.catch(() => undefined)
    }
  }
  options.signal?.addEventListener('abort', close, { once: true })
  if (options.signal?.aborted) close()
  let runtimeInfo: TrackingRuntimeInfo
  try {
    const response = await fetch(`${endpoint}/info`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
    if (!response.ok) throw new Error(`RTMPose initialization HTTP ${response.status}: ${await response.text()}`)
    runtimeInfo = await response.json() as TrackingRuntimeInfo
    if (!runtimeInfo.gpuVerified || !runtimeInfo.device || !runtimeInfo.runtime) throw new Error('RTMPose service has not verified GPU inference')
    if (runtimeInfo.serviceVersion !== 'rtmpose-gpu-v2') throw new Error('RTMPose service is outdated. Stop old service processes and restart service.py (required rtmpose-gpu-v2).')
  } catch (error) { close(); throw new Error(`RTMPose GPU unavailable (${endpoint}): ${error instanceof Error ? error.message : String(error)}`) }
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: false })
  if (!context) { close(); throw new Error('Cannot capture RTMPose source frame') }
  return {
    get runtimeInfo() { return runtimeInfo },
    close,
    idle: () => !busy,
    submit(video: HTMLVideoElement, timestamp: number) {
      if (closed || busy || video.readyState < 2) return false
      busy = true
      outstanding = new Promise<void>(resolve => { releaseFrame = resolve })
      const started = performance.now()
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      const width = canvas.width, height = canvas.height
      try { context.drawImage(video, 0, 0) }
      catch (error) { busy = false; releaseFrame?.(); releaseFrame = null; options.onError(error instanceof Error ? error : new Error(String(error))); return false }
      try { canvas.toBlob(blob => {
        void (async () => {
          try {
            if (closed) return
            if (!blob) throw new Error('RTMPose JPEG encoding failed')
            const response = await fetch(`${endpoint}/detect`, { method: 'POST', signal: AbortSignal.timeout(10000),
              headers: { 'Content-Type': 'image/jpeg', 'X-Person-ROI': JSON.stringify(roi), 'X-ROI-Confirmed': 'true', ...(options.personDetection ? { 'X-Person-Detection': 'true' } : {}) }, body: blob })
            if (!response.ok) throw new Error(`RTMPose inference HTTP ${response.status}: ${await response.text()}`)
            const result = await response.json() as Response
            if (closed) return
            if (result.imageWidth !== width || result.imageHeight !== height || result.inputWidth !== 192 || result.inputHeight !== 256) throw new Error('RTMPose source/model dimensions do not match')
            if (!result.crop || typeof result.roiValid !== 'boolean') throw new Error('RTMPose response missing crop/ROI validation')
            const bounds = result.validationRoi ?? result.roi
            const personRoi = options.personDetection && bounds?.length === 4 ? { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] } : roi
            const adapted = adaptRTMPoseWholeBody(result.keypoints, { roi: personRoi, crop: result.crop, imageWidth: width, imageHeight: height, inputWidth: result.inputWidth, inputHeight: result.inputHeight })
            if (options.personDetection) runtimeInfo = { ...runtimeInfo, detector: result.detector?.metadata ?? null, roiStrategy: 'GPU person detector on every submitted frame' }
            const trackingRegion = { detectorInfo: result.detector, validationRoi: result.validationRoi, roi: result.roi, crop: result.crop, roiValid: result.roiValid, detector: options.personDetection === true }
            if (result.roiValid === false) {
              options.onResult({ ...adapted, pose: [], hands: [], handedness: [], timestamp, inferenceMs: performance.now() - started, deliveredAt: performance.now(), runtimeInfo, timings: result.timings, roiValid: false, stageTimestamps: result.stageTimestamps ?? null, trackingRegion })
              return
            }
            options.onResult({ ...adapted, timestamp, inferenceMs: performance.now() - started, deliveredAt: performance.now(), runtimeInfo, timings: { ...result.timings, client_total_ms: performance.now() - started }, roiValid: true, stageTimestamps: result.stageTimestamps ?? null, trackingRegion })
          } catch (error) { if (!closed) options.onError(error instanceof Error ? error : new Error(String(error))) }
          finally { busy = false; releaseFrame?.(); releaseFrame = null }
        })()
      }, 'image/jpeg', .92) } catch (error) { busy = false; releaseFrame?.(); releaseFrame = null; options.onError(error instanceof Error ? error : new Error(String(error))); return false }
      return true
    },
  }
}
export type RTMPoseEngine = Awaited<ReturnType<typeof createRTMPoseEngine>>

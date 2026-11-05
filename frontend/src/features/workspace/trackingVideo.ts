import { drawLandmarks } from './drawing'
import type { Point } from './drawing'
import { computeInferenceDimensions } from './inferenceResolution'

export type TrackingVideo = { stream: MediaStream; close: () => void }
export const TRACKING_VIDEO_FPS = 15
export const TRACKING_VIDEO_SIZE = Object.freeze({ width: 1280, height: 720 })

/** Record the camera and current displayed skeleton only; never modify raw landmarks. */
export function createTrackingVideo(video: HTMLVideoElement, mirrored: boolean,
    visible: () => { pose: Point[]; hands: Point[][] }, onError: () => void): TrackingVideo {
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) throw new Error('Camera chưa có kích thước để ghi video tracking.')
  const { width, height } = computeInferenceDimensions(sourceWidth, sourceHeight, TRACKING_VIDEO_SIZE) ?? { width: sourceWidth, height: sourceHeight }
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof canvas.captureStream !== 'function') throw new Error('Trình duyệt không hỗ trợ ghi video tracking.')
  const stream = canvas.captureStream(TRACKING_VIDEO_FPS)
  let animation = 0, closed = false, last = 0, frames = 0, failed = false
  const fail = () => { if (!failed) { failed = true; onError() } }
  const visibilityChanged = () => { if (document.visibilityState !== 'visible') fail() }
  document.addEventListener('visibilitychange', visibilityChanged)
  visibilityChanged()
  const close = () => {
    if (closed) return
    if (!frames || performance.now() - last > 1500) fail()
    closed = true; document.removeEventListener('visibilitychange', visibilityChanged); cancelAnimationFrame(animation); stream.getTracks().forEach(track => track.stop())
  }
  const draw = (now: number) => {
    if (closed) return
    try {
      if (now - last >= 1000 / TRACKING_VIDEO_FPS && video.readyState >= 2) {
        if (frames && now - last > 1500) fail()
        last = now
        ctx.save()
        if (mirrored) { ctx.translate(width, 0); ctx.scale(-1, 1) }
        ctx.drawImage(video, 0, 0, width, height)
        ctx.restore()
        const points = visible()
        drawLandmarks(ctx, width, height, points.pose, mirrored)
        points.hands.forEach(hand => drawLandmarks(ctx, width, height, hand, mirrored, true))
        frames++
      }
      animation = requestAnimationFrame(draw)
    } catch { fail(); close() }
  }
  animation = requestAnimationFrame(draw)
  return { stream, close }
}

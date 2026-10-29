/** The source media time is separate from the monotonic inference timestamp.
 * Times are in milliseconds except mediaTime, in seconds. A presented-frame count,
 * when available, identifies frames even when mediaTime stays constant. */
export type ScheduledVideoFrame = { now: number; mediaTime: number; inferenceTimestamp: number }
export type VideoFrameSchedulerOptions = {
  maxFps: number
  onReset?: () => void
  onSkip?: (reason: 'duplicate' | 'throttled') => void
}

/** Synchronous inference only. A new callback is requested after the current callback
 * returns, so frames never accumulate in a queue while the model is busy. */
export function startVideoFrameScheduler(
  video: HTMLVideoElement,
  onFrame: (frame: ScheduledVideoFrame) => void,
  options: VideoFrameSchedulerOptions,
): () => void {
  let stopped = false
  let request: number | null = null
  let lastMediaTime: number | null = null
  let lastRun = -Infinity
  let lastTimestamp = -Infinity
  let inferenceCost = 0
  let lastFrameId: number | null = null
  const hasVideoCallback = typeof video.requestVideoFrameCallback === 'function'
  const resetSource = () => {
    lastMediaTime = null
    lastRun = -Infinity
    inferenceCost = 0
    lastFrameId = null
    options.onReset?.()
  }
  video.addEventListener('seeking', resetSource)
  video.addEventListener('emptied', resetSource)

  const accept = (now: number, mediaTime: number, frameId: number | null) => {
    if (stopped || video.paused || video.seeking || video.readyState < 2 || !Number.isFinite(mediaTime)) return
    // A backward jump can occur on a loop even when no seeking event is dispatched.
    if ((lastMediaTime !== null && mediaTime < lastMediaTime) || (frameId !== null && lastFrameId !== null && frameId < lastFrameId)) {
      resetSource()
      // onReset may stop and dispose this scheduler synchronously.
      if (stopped) return
    }
    if (frameId !== null ? frameId === lastFrameId : lastMediaTime === mediaTime) { options.onSkip?.('duplicate'); return }
    lastMediaTime = mediaTime
    lastFrameId = frameId
    // Reserve a small amount of time for UI work when inference itself is expensive.
    // This is a frequency cap, not a queue; the newest available frame is selected.
    const interval = Math.max(1000 / Math.max(1, options.maxFps), inferenceCost + Math.min(50, inferenceCost * 0.2))
    if (now - lastRun < interval) { options.onSkip?.('throttled'); return }
    lastRun = now
    lastTimestamp = Math.max(now, lastTimestamp + 0.001)
    const started = performance.now()
    onFrame({ now, mediaTime, inferenceTimestamp: lastTimestamp })
    const cost = Math.max(0, performance.now() - started)
    inferenceCost = inferenceCost ? inferenceCost * 0.75 + cost * 0.25 : cost
  }
  const schedule = () => {
    if (stopped) return
    if (hasVideoCallback) {
      request = video.requestVideoFrameCallback((now, metadata) => {
        request = null
        const presented = metadata.presentedFrames
        accept(now, metadata.mediaTime, Number.isSafeInteger(presented) && presented > 0 ? presented : null)
        schedule()
      })
    } else {
      request = requestAnimationFrame(now => {
        request = null
        // totalVideoFrames includes dropped frames. Subtract them to estimate
        // presented frames; this browser counter is still only a best-effort proxy.
        let frameId: number | null = null
        try {
          const quality = video.getVideoPlaybackQuality?.()
          if (quality && Number.isSafeInteger(quality.totalVideoFrames) && Number.isSafeInteger(quality.droppedVideoFrames)) {
            const displayed = quality.totalVideoFrames - quality.droppedVideoFrames
            if (displayed > 0) frameId = displayed
          }
        } catch { /* unavailable: use mediaTime */ }
        accept(now, video.currentTime, frameId)
        schedule()
      })
    }
  }
  schedule()
  return () => {
    stopped = true
    video.removeEventListener('seeking', resetSource)
    video.removeEventListener('emptied', resetSource)
    if (request !== null) {
      if (hasVideoCallback) video.cancelVideoFrameCallback(request)
      else cancelAnimationFrame(request)
      request = null
    }
  }
}

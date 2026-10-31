import { afterEach, describe, expect, it, vi } from 'vitest'
import { startVideoFrameScheduler } from './videoFrameScheduler'

function videoHarness() {
  const video = document.createElement('video')
  let callback: VideoFrameRequestCallback | undefined
  let nextId = 0
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 })
  Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false })
  video.requestVideoFrameCallback = vi.fn(cb => { callback = cb; return ++nextId })
  video.cancelVideoFrameCallback = vi.fn()
  const frame = (now: number, mediaTime: number, presentedFrames?: number) => {
    const current = callback; callback = undefined
    current?.(now, { mediaTime, presentedFrames } as VideoFrameCallbackMetadata)
  }
  return { video, frame, pending: () => Boolean(callback) }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('video frame scheduler', () => {
  it('uses the presented frame counter when a live source has a constant media time', () => {
    const { video, frame } = videoHarness(), infer = vi.fn(), onSkip = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30, onSkip })
    frame(100, 0, 1); frame(150, 0, 2); frame(200, 0, 2); frame(250, 0, 3)
    expect(infer).toHaveBeenCalledTimes(3)
    expect(onSkip).toHaveBeenCalledWith('duplicate')
    expect(infer.mock.calls.map(call => call[0].inferenceTimestamp)).toEqual([100, 150, 250])
    stop()
  })

  it('does not process a repeated presented frame even if mediaTime changes', () => {
    const { video, frame } = videoHarness(), infer = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30 })
    frame(100, 1, 4); frame(150, 1.02, 4); frame(200, 1.04, 5)
    expect(infer).toHaveBeenCalledTimes(2)
    stop()
  })

  it('resets source when the frame counter goes backwards, keeping timestamps monotonic', () => {
    const { video, frame } = videoHarness(), infer = vi.fn(), reset = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30, onReset: reset })
    frame(100, 0, 10); frame(150, 0, 11); frame(150, 0, 1)
    expect(reset).toHaveBeenCalledOnce()
    expect(infer).toHaveBeenCalledTimes(3)
    expect(infer.mock.calls[2][0].inferenceTimestamp).toBeGreaterThan(infer.mock.calls[1][0].inferenceTimestamp)
    stop()
  })

  it('does not infer or schedule again if source reset stops the scheduler', () => {
    const { video, frame, pending } = videoHarness(), infer = vi.fn()
    let stop = () => {}
    stop = startVideoFrameScheduler(video, infer, { maxFps: 30, onReset: () => stop() })
    frame(100, 1, 2); frame(150, .5, 3)
    expect(infer).toHaveBeenCalledOnce()
    expect(pending()).toBe(false)
  })
  it('handles each source frame at most once, without queueing and cancels on stop', () => {
    const { video, frame, pending } = videoHarness()
    const infer = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30 })
    frame(100, 1); frame(120, 1); frame(140, 1.04); frame(150, 1.08); frame(180, 1.12)
    expect(infer).toHaveBeenCalledTimes(3)
    expect(infer.mock.calls.map(call => call[0].mediaTime)).toEqual([1, 1.04, 1.12])
    expect(pending()).toBe(true)
    stop(); expect(video.cancelVideoFrameCallback).toHaveBeenCalledOnce()
    frame(300, 2); expect(infer).toHaveBeenCalledTimes(3)
  })

  it('allows the same media time after seek while timestamps stay strictly increasing', () => {
    const { video, frame } = videoHarness()
    const infer = vi.fn(), reset = vi.fn()
    startVideoFrameScheduler(video, infer, { maxFps: 30, onReset: reset })
    frame(100, 1); frame(150, 2)
    video.dispatchEvent(new Event('seeking'))
    frame(150, 1)
    expect(reset).toHaveBeenCalledOnce()
    expect(infer).toHaveBeenCalledTimes(3)
    const times = infer.mock.calls.map(call => call[0].inferenceTimestamp)
    expect(times[1]).toBeGreaterThan(times[0]); expect(times[2]).toBeGreaterThan(times[1])
  })

  it('does not infer while paused and resumes when a new frame arrives', () => {
    const { video, frame } = videoHarness()
    const infer = vi.fn()
    startVideoFrameScheduler(video, infer, { maxFps: 30 })
    frame(100, 1)
    Object.defineProperty(video, 'paused', { configurable: true, value: true })
    frame(200, 2)
    Object.defineProperty(video, 'paused', { configurable: true, value: false })
    frame(250, 2)
    expect(infer).toHaveBeenCalledTimes(2)
  })

  it('uses requestAnimationFrame fallback and skips unchanged currentTime', () => {
    let callback: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { callback = cb; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 4 })
    Object.defineProperty(video, 'paused', { value: false })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 1 })
    const infer = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30 })
    callback?.(100); callback?.(200)
    expect(infer).toHaveBeenCalledOnce()
    stop(); expect(cancelAnimationFrame).toHaveBeenCalledOnce()
  })

  it('reduces the rate when inference exceeds the frame budget', () => {
    const { video, frame } = videoHarness()
    const clock = vi.spyOn(performance, 'now')
    clock.mockReturnValueOnce(0).mockReturnValueOnce(80)
    const infer = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30 })
    frame(100, 1); frame(150, 1.05); frame(200, 1.1)
    expect(infer).toHaveBeenCalledTimes(2)
    stop(); clock.mockRestore()
  })

  it('keeps UI slack even when inference takes more than 200 ms', () => {
    const { video, frame } = videoHarness()
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(400)
    const infer = vi.fn()
    const stop = startVideoFrameScheduler(video, infer, { maxFps: 30 })
    frame(100, 1); frame(510, 1.1)
    expect(infer).toHaveBeenCalledTimes(1)
    frame(560, 1.2)
    expect(infer).toHaveBeenCalledTimes(2)
    stop(); clock.mockRestore()
  })

  it('uses displayed-frame count rather than total including dropped frames in the fallback', () => {
    let callback: FrameRequestCallback | undefined, total = 2, dropped = 1
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { callback = cb; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { value: 4 })
    Object.defineProperty(video, 'paused', { value: false })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 1 })
    video.getVideoPlaybackQuality = vi.fn(() => ({ totalVideoFrames: total, droppedVideoFrames: dropped }) as VideoPlaybackQuality)
    const infer = vi.fn(), stop = startVideoFrameScheduler(video, infer, { maxFps: 30 })
    callback?.(100); video.currentTime = 1.05; callback?.(150)
    expect(infer).toHaveBeenCalledTimes(1)
    total = 3; dropped = 2; callback?.(200)
    expect(infer).toHaveBeenCalledTimes(1)
    total = 4; callback?.(250)
    expect(infer).toHaveBeenCalledTimes(2)
    stop()
  })
})

it('exposes timestamps for throttled source frames without mistaking duplicates for skipped frames', () => {
  const { video, frame } = videoHarness(), skipped = vi.fn()
  const stop = startVideoFrameScheduler(video, vi.fn(), { maxFps: 10, onSkippedFrame: skipped })
  frame(100, 1, 4); frame(120, 1.04, 7); frame(140, 1.04, 7); frame(250, 1.16, 8)
  expect(skipped).toHaveBeenCalledOnce()
  expect(skipped).toHaveBeenCalledWith({ now: 120, mediaTime: 1.04, sourceFrameId: 7, skippedSourceFrames: 2 })
  stop()
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latencyBenchmarkSuite, runBenchmark } from './benchmarkRunner'
import type { BenchmarkConfig, Observation } from './benchmarkEngine'
import type { ScheduledVideoFrame } from './videoFrameScheduler'

const mock = vi.hoisted(() => ({ create: vi.fn(), scheduler: vi.fn(), request: vi.fn(), close: vi.fn(), files: new Map<string, string>() }))
vi.mock('./benchmarkEngine', () => ({ createBenchmarkEngine: mock.create }))
vi.mock('./videoFrameScheduler', () => ({ startVideoFrameScheduler: mock.scheduler }))
vi.mock('./drawing', () => ({ drawLandmarks: vi.fn() }))
vi.mock('./benchmarkArtifacts', async importOriginal => {
  const original = await importOriginal<typeof import('./benchmarkArtifacts')>()
  return { ...original, benchmarkRequest: mock.request, BenchmarkArtifacts: class {
    append(name: string, content: string) { mock.files.set(name, (mock.files.get(name) ?? '') + content) }
    async flush() {}
  } }
})

const config: BenchmarkConfig = { name: 'Hand-first', engine: 'worker', gpu: true, handFirst: true, hands: true, poseFps: 15, handFps: 30, schedule: 'independent', repeat: 1, filter: 'raw' }
const points = (count: number) => Array.from({ length: count }, () => ({ x: .5, y: .5, visibility: .9 }))

describe('benchmark metric integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.files.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    mock.request.mockImplementation(async path => path === '/runs' ? { run_id: 'test', directory: 'test' } : { run_id: 'test', status: 'COMPLETE', errors: [], summary: JSON.parse(mock.files.get('summary.json')!) })
    vi.stubGlobal('PerformanceObserver', class { static supportedEntryTypes = [] })
    vi.stubGlobal('MediaRecorder', class extends EventTarget {
      static isTypeSupported() { return true }
      state = 'inactive'; mimeType = 'video/mp4'
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.dispatchEvent(new Event('stop')) }
    })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('keeps stream samples independent, deduplicates callbacks, and awaits cleanup', async () => {
    let measure = false, ended = false
    let callback!: (frame: ScheduledVideoFrame) => void
    let finishClose!: () => void
    mock.close.mockImplementation(() => new Promise<void>(resolve => { finishClose = resolve }))
    mock.create.mockImplementation(async (_config, _video, observe: (value: Observation) => void) => ({
      delegates: { hand: 'GPU', pose: 'CPU' }, errors: [], close: mock.close, idle: () => true,
      submit(frame: ScheduledVideoFrame, doPose: boolean, doHand: boolean) {
        if (!measure) return true
        if (frame.sourceFrameId === 2) return false
        if (doHand) {
          const observation = { frame, requestId: frame.sourceFrameId!, pose: null, hands: frame.sourceFrameId === 3 ? [] : [points(21)], poseMs: null, handMs: 7, poseWorld: null, handWorld: null, handedness: frame.sourceFrameId === 3 ? [] : [[{ categoryName: 'Right', score: .9 }]], captureResizeTotalMs: 2, transferAndDispatchMs: 1 }
          observe(observation); observe(observation)
        }
        if (doPose) observe({ frame, requestId: frame.sourceFrameId!, pose: points(33), hands: null, poseMs: 11, handMs: null, poseWorld: null, handWorld: null, handedness: null })
        return true
      },
    }))
    mock.scheduler.mockImplementation((_video, onFrame) => { callback = onFrame; measure = true; return vi.fn() })
    const video = document.createElement('video')
    Object.defineProperties(video, {
      videoWidth: { value: 1280 }, videoHeight: { value: 720 }, duration: { value: .2 }, readyState: { value: 2 }, ended: { get: () => ended },
      load: { value: () => queueMicrotask(() => video.dispatchEvent(new Event('loadeddata'))) }, pause: { value: vi.fn() },
      play: { value: async () => {
        for (let index = 0; index < 4; index++) setTimeout(() => {
          const now = performance.now()
          callback({ now, inferenceTimestamp: now, mediaTime: index / 30, sourceFrameId: index + 1, skippedSourceFrames: index === 2 ? 2 : 0 })
        }, index * 40)
        setTimeout(() => { ended = true }, 160)
      } },
    })
    const canvas = document.createElement('canvas')
    Object.defineProperties(canvas, {
      getContext: { value: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn() }) },
      captureStream: { value: () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
    })
    let finished = false
    const running = runBenchmark(config, video, canvas, { source_path: 'test.mp4', width: 1280, height: 720, duration: .2, fps: 30, hardware: {} }, new AbortController().signal, vi.fn()).then(result => { finished = true; return result })
    await vi.advanceTimersByTimeAsync(3400)
    expect(mock.close).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    finishClose(); const result = await running
    const summary = result.summary as Record<string, any>
    expect(summary.processed_frames.hand).toBe(3)
    expect(summary.processed_frames.pose).toBe(2)
    expect(summary.tracking_loss_events).toEqual({ losses: 1, recoveries: 1 })
    expect(summary.skipped_frames.source_unpresented).toBe(2)
    expect(summary.skipped_frames.worker_busy).toBe(1)
    expect(summary.requested_fps).toEqual({ pose: 15, hand: 30 })
    expect(summary.actual_fps.hand).toBeGreaterThan(summary.actual_fps.pose)
    expect(summary.hand_latency).toMatchObject({ p50_ms: 7, p95_ms: 7 })
    expect(summary.pose_latency).toMatchObject({ p50_ms: 11, p95_ms: 11 })
    expect(summary.captureResizeTotalMs.samples).toBe(3)
    expect(summary.transferAndDispatchMs.samples).toBe(3)
    expect(summary.hand_source_to_overlay_age.samples).toBe(2)
    expect(summary.worker_utilization_percent_deprecated).toContain('not GPU')
    const rows = mock.files.get('landmarks.jsonl')!.trim().split('\n').map(row => JSON.parse(row))
    expect(rows.filter(row => row.hand_valid !== null)).toHaveLength(3)
    expect(rows.find(row => row.raw_pose_landmarks !== null).hand_valid).toBeNull()
    expect(rows.every(row => row.worker_request_id === row.source_frame_id)).toBe(true)
  })

  it('exposes both 720p and 540p Hand-first GPU configurations', () => {
    expect(latencyBenchmarkSuite().filter(run => run.handFirst && run.inferenceResolution).map(run => run.inferenceResolution)).toEqual([{ width: 1280, height: 720 }, { width: 960, height: 540 }])
  })
})

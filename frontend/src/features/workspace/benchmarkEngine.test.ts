import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBenchmarkEngine } from './benchmarkEngine'
import type { BenchmarkConfig } from './benchmarkEngine'
import type { WorkerHandResult, WorkerPoseResult } from './workerTracker'

const mock = vi.hoisted(() => ({ create: vi.fn(), submit: vi.fn(), dispose: vi.fn(), drain: vi.fn(), files: vi.fn(), pose: vi.fn(), options: null as Record<string, unknown> | null }))
vi.mock('./workerTracker', () => ({ createWorkerTracker: mock.create, waitForWorkerDisposals: mock.drain }))
vi.mock('./rtmposeEngine', () => ({ waitForRTMPoseDrain: vi.fn().mockResolvedValue(undefined), createRTMPoseEngine: vi.fn() }))
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: { forVisionTasks: mock.files } }))
vi.mock('./mediaPipeModels', () => ({ initializePose: mock.pose, initializeHand: vi.fn() }))

const config: BenchmarkConfig = { name: 'Hand first', engine: 'worker', gpu: true, hands: true, poseFps: 15, handFps: 30, handFirst: true, schedule: 'independent', repeat: 1, filter: 'raw' }
const frame = { now: 1000, inferenceTimestamp: 1000, mediaTime: 2.5, sourceFrameId: 75 }
const hand = (extra = {}) => ({ id: 1, requestId: 1, timestamp: 1000, sourceFrameId: 75, sourceMediaTimeMs: 2500, sourcePerformanceMs: 1000, hands: [], handWorldLandmarks: null, handedness: null, handInferenceMs: 7, handProcessed: true, captureResizeTotalMs: 2, transferAndDispatchMs: 1, ...extra }) as WorkerHandResult
const pose = (extra = {}) => ({ id: 1, requestId: 1, timestamp: 1000, sourceFrameId: 75, sourceMediaTimeMs: 2500, sourcePerformanceMs: 1000, pose: [], poseWorldLandmarks: null, poseInferenceMs: 11, poseProcessed: true, captureResizeTotalMs: 2, transferAndDispatchMs: 1, ...extra }) as WorkerPoseResult
const callback = <T,>(key: string, value: T) => (mock.options![key] as (result: T) => void)(value)

describe('benchmark worker observations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('Worker', class {})
    mock.submit.mockReturnValue(true)
    mock.drain.mockResolvedValue(undefined)
    mock.dispose.mockResolvedValue(undefined)
    mock.create.mockImplementation(async options => {
      mock.options = options
      return { submit: mock.submit, dispose: mock.dispose, delegates: { pose: 'GPU', hand: 'CPU' }, initializationErrors: ['Hand GPU failed; CPU fallback'] }
    })
  })

  it('submits original frame identity and rejects results from another source frame', async () => {
    const observed = vi.fn()
    const engine = await createBenchmarkEngine(config, {} as HTMLVideoElement, observed, vi.fn())
    engine.submit(frame, true, true)
    expect(mock.submit).toHaveBeenCalledWith(expect.anything(), 1000, true, true, { sourceFrameId: 75, sourceMediaTimeMs: 2500, sourcePerformanceMs: 1000 })
    callback('onHandResult', hand({ sourceFrameId: 76 }))
    expect(observed).not.toHaveBeenCalled()
    callback('onHandResult', hand())
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ frame, hands: [], pose: null, handMs: 7 }))
    callback('onPoseResult', pose({ requestId: 2, id: 2 }))
    expect(observed).toHaveBeenCalledOnce()
  })

  it('delivers Hand before Pose and records each stream and capture timing only once', async () => {
    const observed = vi.fn()
    const engine = await createBenchmarkEngine(config, {} as HTMLVideoElement, observed, vi.fn())
    engine.submit(frame, true, true)
    callback('onHandResult', hand())
    callback('onHandResult', hand())
    callback('onPoseResult', pose())
    expect(observed).toHaveBeenCalledTimes(2)
    expect(observed.mock.calls[0][0]).toMatchObject({ pose: null, handMs: 7, captureResizeTotalMs: 2, transferAndDispatchMs: 1 })
    expect(observed.mock.calls[1][0]).toMatchObject({ hands: null, poseMs: 11, captureResizeTotalMs: null, transferAndDispatchMs: null })
    expect(engine.delegates).toEqual({ pose: 'GPU', hand: 'CPU' })
    expect(engine.errors).toEqual(['Hand GPU failed; CPU fallback'])
  })

  it('awaits disposal and exposes cleanup failure to its caller', async () => {
    let reject!: (error: Error) => void
    mock.dispose.mockReturnValue(new Promise<void>((_, fail) => { reject = fail }))
    const engine = await createBenchmarkEngine(config, {} as HTMLVideoElement, vi.fn(), vi.fn())
    const closing = engine.close()
    expect(closing).toBeInstanceOf(Promise)
    const checked = expect(closing).rejects.toThrow('GPU cleanup failed')
    reject(new Error('GPU cleanup failed'))
    await checked
  })

  it('reports whole-frame completion separately from immediate Hand delivery', async () => {
    const observed = vi.fn()
    const engine = await createBenchmarkEngine(config, {} as HTMLVideoElement, observed, vi.fn())
    engine.submit(frame, true, true)
    callback('onHandResult', hand())
    expect(engine.idle()).toBe(false)
    callback('onFrameComplete', { ...pose(), inferenceMs: 18, handProcessed: true, handInferenceMs: 7 })
    expect(engine.idle()).toBe(true)
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ frameComplete: true, requestId: 1, pose: null, hands: null, poseMs: null, handMs: null }))
  })

  it('waits for previous Worker disposal before starting main-thread models and cancels during that wait', async () => {
    let release!: () => void
    mock.drain.mockReturnValue(new Promise<void>(resolve => { release = resolve }))
    const abort = new AbortController()
    const creating = createBenchmarkEngine({ ...config, engine: 'main' }, {} as HTMLVideoElement, vi.fn(), vi.fn(), abort.signal)
    const rejected = expect(creating).rejects.toThrow(/cancel/i)
    await Promise.resolve()
    expect(mock.files).not.toHaveBeenCalled()
    abort.abort(); release(); await rejected
    expect(mock.pose).not.toHaveBeenCalled()
  })

  it('forwards cancellation to pending Worker initialization', async () => {
    const abort = new AbortController()
    const engine = await createBenchmarkEngine(config, {} as HTMLVideoElement, vi.fn(), vi.fn(), abort.signal)
    expect(mock.options!.signal).toBe(abort.signal)
    abort.abort()
    await Promise.resolve()
    expect(mock.dispose).toHaveBeenCalledOnce()
    expect(engine.submit(frame, true, true)).toBe(false)
  })

  it('reports inference failure without creating a zero-latency inference sample', async () => {
    const observed = vi.fn(), failed = vi.fn()
    const engine = await createBenchmarkEngine(config, {} as HTMLVideoElement, observed, failed)
    engine.submit(frame, true, true)
    callback('onHandResult', hand({ handFailed: true, handProcessed: false, handInferenceMs: 0, handError: 'Hand model unavailable' }))
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ hands: [], handFailed: true, handProcessed: false, handMs: null }))
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Hand model unavailable' }))
  })
})

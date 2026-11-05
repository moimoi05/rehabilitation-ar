import { describe, expect, it, vi } from 'vitest'
import { createParallelWorkerTracker } from './parallelWorkerTracker'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn((data: { type: string }) => {
    if (data.type === 'dispose') this.send({ type: 'disposed', cleanupErrors: [] })
  })
  terminate = vi.fn()
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}

function setup(capture = vi.fn(async () => ({ close: vi.fn() } as unknown as ImageBitmap)), signal?: AbortSignal) {
  const poseWorker = new FakeWorker(), handWorker = new FakeWorker()
  const onPose = vi.fn(), onHand = vi.fn(), onPoseError = vi.fn(), onHandError = vi.fn()
  const pending = createParallelWorkerTracker({ poseWorker: poseWorker as unknown as Worker, handWorker: handWorker as unknown as Worker, moduleUrl: '/vision.mjs', capture, onPose, onHand, onPoseError, onHandError, signal })
  return { poseWorker, handWorker, onPose, onHand, onPoseError, onHandError, capture, pending }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const video = {} as HTMLVideoElement

describe('parallel worker tracking', () => {
  it('preserves shared main-thread observation identity through independently returning models', async () => {
    const s = setup(); s.poseWorker.send({ type: 'ready' }); s.handWorker.send({ type: 'ready' })
    const tracker = await s.pending
    const source = { sourceFrameId: 42, sourceObservationId: 9, sourcePerformanceMs: 120, sourceMediaTimeMs: 450, captureScope: 'capture-a' }
    tracker.submitPose(video, 120, source); tracker.submitHand(video, 120, source); await flush()
    expect(s.poseWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining(source), expect.any(Array))
    s.handWorker.send({ type: 'result', id: 1, pose: [], hands: [], handProcessed: true, poseProcessed: false })
    s.poseWorker.send({ type: 'result', id: 1, pose: [], hands: null, poseProcessed: true, handProcessed: false })
    expect(s.onHand).toHaveBeenCalledWith(expect.objectContaining(source))
    expect(s.onPose).toHaveBeenCalledWith(expect.objectContaining(source))
    tracker.close()
  })

  it('initializes independent roles and bounds capture separately for each worker', async () => {
    const s = setup(); s.poseWorker.send({ type: 'ready' }); s.handWorker.send({ type: 'ready' })
    const tracker = await s.pending
    expect(s.poseWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', role: 'pose' }))
    expect(s.handWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', role: 'hand' }))
    expect(tracker.submitPose(video, 10)).toBe(true); expect(tracker.submitPose(video, 11)).toBe(false)
    expect(tracker.submitHand(video, 12)).toBe(true); expect(tracker.submitHand(video, 13)).toBe(false)
    await flush(); expect(s.capture).toHaveBeenCalledTimes(2)
    s.handWorker.send({ type: 'result', id: 1, pose: [], hands: [[{ x: .2, y: .3 }]], inferenceMs: 8 })
    s.poseWorker.send({ type: 'result', id: 1, pose: [{ x: .4, y: .5 }], hands: null, inferenceMs: 5 })
    expect(s.onHand).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 12, hands: [[{ x: .2, y: .3 }]] }))
    expect(s.onPose).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 10, pose: [{ x: .4, y: .5 }] }))
    tracker.close(); expect(s.poseWorker.terminate).toHaveBeenCalledOnce(); expect(s.handWorker.terminate).toHaveBeenCalledOnce()
  })

  it('continues Pose after Hand initialization fails', async () => {
    const s = setup(); s.handWorker.send({ type: 'error', message: 'hand init failed' }); s.poseWorker.send({ type: 'ready' })
    const tracker = await s.pending
    expect(s.onHandError).toHaveBeenCalledOnce(); expect(s.onPoseError).not.toHaveBeenCalled()
    expect(tracker.submitHand(video, 10)).toBe(false); expect(tracker.submitPose(video, 10)).toBe(true)
    tracker.close(); expect(s.handWorker.terminate).toHaveBeenCalledOnce(); expect(s.poseWorker.terminate).toHaveBeenCalledOnce()
  })

  it('continues with Pose after a stalled Hand initialization times out', async () => {
    vi.useFakeTimers()
    try {
      const s = setup(); s.poseWorker.send({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(20_001)
      const tracker = await s.pending
      expect(s.onHandError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Worker initialization timed out' }))
      expect(tracker.submitHand(video, 10)).toBe(false); expect(tracker.submitPose(video, 10)).toBe(true)
      tracker.close()
    } finally { vi.useRealTimers() }
  })

  it('isolates Hand runtime failure and leaves Pose usable', async () => {
    const s = setup(); s.poseWorker.send({ type: 'ready' }); s.handWorker.send({ type: 'ready' }); const tracker = await s.pending
    s.handWorker.send({ type: 'error', message: 'hand runtime failed' })
    expect(s.onHandError).toHaveBeenCalledOnce(); expect(s.onPoseError).not.toHaveBeenCalled()
    expect(tracker.submitHand(video, 1)).toBe(false); expect(tracker.submitPose(video, 2)).toBe(true)
    tracker.close()
  })

  it('forwards an explicit Hand failure including uncertain cleanup and disables that branch', async () => {
    const s = setup(); s.poseWorker.send({ type: 'ready' }); s.handWorker.send({ type: 'ready' }); const tracker = await s.pending
    tracker.submitHand(video, 1); await flush()
    s.handWorker.send({ type: 'result', id: 1, pose: [], hands: [], handFailed: true, handCleanupFailed: true })
    expect(s.onHand).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 1, handFailed: true, handCleanupFailed: true }))
    expect(s.onHandError).not.toHaveBeenCalled(); expect(tracker.submitHand(video, 2)).toBe(false)
    expect(s.handWorker.terminate).toHaveBeenCalledOnce(); expect(tracker.submitPose(video, 3)).toBe(true)
    tracker.close()
  })

  it('closes both workers on Pose failure and suppresses late callbacks', async () => {
    const s = setup(); s.poseWorker.send({ type: 'ready' }); s.handWorker.send({ type: 'ready' }); const tracker = await s.pending
    const oldHandler = s.handWorker.onmessage
    s.poseWorker.send({ type: 'error', message: 'pose runtime failed' })
    expect(s.onPoseError).toHaveBeenCalledOnce(); expect(s.poseWorker.terminate).toHaveBeenCalledOnce(); expect(s.handWorker.terminate).toHaveBeenCalledOnce()
    oldHandler?.({ data: { type: 'result', id: 1, hands: [[{ x: .1, y: .2 }]] } } as MessageEvent)
    expect(s.onHand).not.toHaveBeenCalled(); expect(tracker.submitPose(video, 2)).toBe(false)
    tracker.close()
  })

  it('rejects a Pose initialization error and aborts pending Hand initialization', async () => {
    const s = setup(); void s.pending.catch(() => {})
    s.poseWorker.send({ type: 'error', message: 'pose init failed' })
    await expect(s.pending).rejects.toThrow('pose init failed')
    expect(s.poseWorker.terminate).toHaveBeenCalledOnce(); expect(s.handWorker.terminate).toHaveBeenCalledOnce()
    expect(s.onPoseError).not.toHaveBeenCalled(); expect(s.onHandError).not.toHaveBeenCalled()
  })

  it('aborts both initializations without fallback callbacks', async () => {
    const abort = new AbortController(), s = setup(undefined, abort.signal); void s.pending.catch(() => {})
    s.poseWorker.send({ type: 'ready' }); abort.abort()
    await expect(s.pending).rejects.toThrow(/cancelled/i)
    expect(s.poseWorker.terminate).toHaveBeenCalledOnce(); expect(s.handWorker.terminate).toHaveBeenCalledOnce()
    expect(s.onPoseError).not.toHaveBeenCalled(); expect(s.onHandError).not.toHaveBeenCalled()
  })

  it('rejects if Pose fails after it becomes ready but before Hand initialization completes', async () => {
    const s = setup(); void s.pending.catch(() => {})
    s.poseWorker.send({ type: 'ready' }); await flush()
    s.poseWorker.send({ type: 'error', message: 'pose failed during startup' })
    await expect(s.pending).rejects.toThrow('pose failed during startup')
    expect(s.poseWorker.terminate).toHaveBeenCalledOnce(); expect(s.handWorker.terminate).toHaveBeenCalledOnce()
    expect(s.onPoseError).not.toHaveBeenCalled(); expect(s.onHandError).not.toHaveBeenCalled()
  })

  it('terminates both pre-created workers when already aborted', async () => {
    const abort = new AbortController(); abort.abort()
    const s = setup(undefined, abort.signal)
    await expect(s.pending).rejects.toThrow(/cancelled/i)
    expect(s.poseWorker.terminate).toHaveBeenCalledOnce(); expect(s.handWorker.terminate).toHaveBeenCalledOnce()
    expect(s.poseWorker.postMessage).not.toHaveBeenCalled(); expect(s.handWorker.postMessage).not.toHaveBeenCalled()
  })

  it('closes a bitmap captured after shutdown without queuing a frame', async () => {
    let finish!: (bitmap: ImageBitmap) => void
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const s = setup(vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve })))
    s.poseWorker.send({ type: 'ready' }); s.handWorker.send({ type: 'ready' }); const tracker = await s.pending
    tracker.submitHand(video, 3); tracker.close(); finish(bitmap); await flush()
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(s.handWorker.postMessage).toHaveBeenCalledTimes(2)
  })
})

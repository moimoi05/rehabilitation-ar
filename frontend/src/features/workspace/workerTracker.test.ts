import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerTracker, waitForWorkerDisposals } from './workerTracker'

class FakeWorker {
  static instances = new Set<FakeWorker>()
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.add(this) }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}

describe('worker tracker', () => {
  it('allows an explicit cold GPU first-frame budget without relaxing later inference deadlines', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker(), onError = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onError, handEnabled: true, moduleUrl: '/vision.mjs', initialFrameTimeoutMs: 30000 })
    worker.send({ type: 'ready' }); const tracker = await pending
    try {
      tracker.submit({} as HTMLVideoElement, 100, true)
      await Promise.resolve(); await Promise.resolve()
      vi.advanceTimersByTime(8001)
      expect(onError).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3000)
      worker.send({ type: 'frame_complete', id: 1, handProcessed: true, poseProcessed: true })
      tracker.submit({} as HTMLVideoElement, 200, true)
      await Promise.resolve(); await Promise.resolve()
      vi.advanceTimersByTime(8001)
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Worker inference timed out' }))
    } finally {
      tracker.close(); worker.send({ type: 'disposed', cleanupErrors: [] })
      await waitForWorkerDisposals(); vi.useRealTimers()
    }
  })
  afterEach(async () => {
    // A real Worker acknowledges deliberate close. Do not leave an outstanding
    // drain from one fixture blocking initialization in the next test.
    for (const worker of FakeWorker.instances) {
      if (worker.postMessage.mock.lastCall?.[0]?.type === 'dispose') worker.send({ type: 'disposed', cleanupErrors: [] })
    }
    FakeWorker.instances.clear()
    await waitForWorkerDisposals()
  })
  it('registers legacy close in the shared disposal barrier before another engine initializes', async () => {
    const worker = new FakeWorker()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onError: vi.fn(), handEnabled: true, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.close()
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'dispose' })
    expect(worker.terminate).not.toHaveBeenCalled()
    const next = new FakeWorker()
    const replacement = createWorkerTracker({ worker: next as unknown as Worker, capture: vi.fn(), onError: vi.fn(), handEnabled: true, moduleUrl: '/vision.mjs' })
    expect(next.postMessage).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    await waitForWorkerDisposals(); await Promise.resolve()
    expect(next.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }))
    next.send({ type: 'ready' }); const nextTracker = await replacement
    const disposal = nextTracker.dispose(); next.send({ type: 'disposed', cleanupErrors: [] }); await disposal
  })
  it('terminates safely when init dispatch throws before a model request was delivered', async () => {
    const worker = new FakeWorker(), onError = vi.fn()
    worker.postMessage.mockImplementationOnce(() => { throw new Error('Worker dispatch unavailable') })
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onError, handEnabled: true, moduleUrl: '/vision.mjs' })
    await expect(pending).rejects.toThrow('Worker dispatch unavailable')
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    // No model was created, so this safe failure does not poison the next init.
    const next = new FakeWorker()
    const replacement = createWorkerTracker({ worker: next as unknown as Worker, capture: vi.fn(), onError, handEnabled: true, moduleUrl: '/vision.mjs' })
    expect(next.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }))
    next.send({ type: 'ready' }); (await replacement).close()
  })
  it('keeps request identity unique when a replay reuses source frame IDs and timestamps', async () => {
    const worker = new FakeWorker(), handResult = vi.fn(), result = vi.fn()
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onHandResult: handResult, onResult: result, onError: vi.fn(), handEnabled: true, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    const source = { sourceFrameId: 7, sourceMediaTimeMs: 250, sourcePerformanceMs: 100 }
    tracker.submit({} as HTMLVideoElement, 100, true, false, source)
    await Promise.resolve(); await Promise.resolve()
    expect(tracker.lastRequestId).toBe(1)
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, requestId: 1, ...source }), [bitmap])
    worker.send({ type: 'hand_result', id: 1, requestId: 1, ...source, hands: [[{ x: .1, y: .2 }]], handProcessed: true })
    worker.send({ type: 'frame_complete', id: 1, requestId: 1, ...source, handProcessed: true, poseProcessed: false })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ requestId: 1, ...source }))
    tracker.submit({} as HTMLVideoElement, 100, true, false, source)
    await Promise.resolve(); await Promise.resolve()
    expect(tracker.lastRequestId).toBe(2)
    // Late callbacks from the previous request and mismatched source identity are ignored.
    worker.send({ type: 'hand_result', id: 1, requestId: 1, ...source, hands: [], handProcessed: true })
    worker.send({ type: 'hand_result', id: 2, requestId: 2, ...source, sourceFrameId: 8, hands: [], handProcessed: true })
    expect(handResult).toHaveBeenCalledOnce()
    worker.send({ type: 'frame_complete', id: 2, requestId: 2, ...source, handProcessed: false, poseProcessed: false })
    expect(result).toHaveBeenCalledTimes(2)
    tracker.close()
  })

  it('shares the pending disposal promise and initializes replacements only after acknowledgement', async () => {
    const worker = new FakeWorker()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onError: vi.fn(), handEnabled: true, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    const disposal = tracker.dispose()
    expect(tracker.dispose()).toBe(disposal)
    const next = new FakeWorker()
    const replacement = createWorkerTracker({ worker: next as unknown as Worker, capture: vi.fn(), onError: vi.fn(), handEnabled: true, moduleUrl: '/vision.mjs' })
    expect(next.postMessage).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    await disposal; await Promise.resolve(); await Promise.resolve()
    expect(next.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }))
    next.send({ type: 'ready' }); (await replacement).close()
  })

  it('reports a disposal timeout and never claims acknowledged model cleanup', async () => {
    vi.resetModules()
    const isolated = await import('./workerTracker')
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker(), onError = vi.fn()
      const pending = isolated.createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onError, handEnabled: true, moduleUrl: '/vision.mjs' })
      worker.send({ type: 'ready' }); const tracker = await pending
      const disposal = tracker.dispose()
      const rejected = expect(disposal).rejects.toThrow('cleanup was not acknowledged')
      vi.advanceTimersByTime(1500)
      await rejected
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cleanup was not acknowledged') }))
      expect(worker.terminate).toHaveBeenCalledOnce()
      await expect(isolated.waitForWorkerDisposals()).rejects.toThrow('cleanup was not acknowledged')
    } finally { vi.useRealTimers() }
  })
  it('reports actual mixed delegates and preserves independent observation metadata', async () => {
    const worker = new FakeWorker(), result = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: result, onError: vi.fn(), handEnabled: true, preferGpu: true, moduleUrl: '/vision.mjs' })
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ preferGpu: true }))
    worker.send({ type: 'ready', delegates: { pose: 'GPU', hand: 'CPU' }, initializationErrors: ['Hand GPU: unavailable'] })
    const tracker = await pending
    expect(tracker.delegates).toEqual({ pose: 'GPU', hand: 'CPU' })
    expect(tracker.initializationErrors).toEqual(['Hand GPU: unavailable'])
    tracker.submit({} as HTMLVideoElement, 10, true, false); await Promise.resolve(); await Promise.resolve()
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ pose: false, hand: true }), [bitmap])
    const hands = [[{ x: .2, y: .3, z: -.1 }]], handedness = [[{ categoryName: 'Left', score: .9, index: 0, displayName: 'Left' }]]
    worker.send({ type: 'result', id: 1, pose: [], hands, poseProcessed: false, handProcessed: true, poseInferenceMs: null, handInferenceMs: 12, poseWorldLandmarks: [], handWorldLandmarks: hands, handedness })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ poseProcessed: false, handProcessed: true, poseInferenceMs: null, handInferenceMs: 12, handedness, handWorldLandmarks: hands }))
    tracker.close()
  })
  it.each(['pose', 'hand'] as const)('forwards the %s role during initialization and its independent result', async role => {
    const worker = new FakeWorker(), result = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: result, onError: vi.fn(), role, handEnabled: false, moduleUrl: '/vision.mjs' })
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'init', moduleUrl: '/vision.mjs', handEnabled: false, role })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 10, true); await Promise.resolve(); await Promise.resolve()
    const pose = role === 'pose' ? [{ x: .2, y: .3 }] : []
    const hands = role === 'hand' ? [[{ x: .4, y: .5 }]] : null
    worker.send({ type: 'result', id: 1, pose, hands, inferenceMs: 8 })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 10, pose, hands, inferenceMs: 8 }))
    tracker.close()
  })

  it('keeps the legacy initialization message when role is omitted', async () => {
    const worker = new FakeWorker()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: vi.fn(), handEnabled: false, moduleUrl: '/vision.mjs' })
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'init', moduleUrl: '/vision.mjs', handEnabled: false })
    worker.send({ type: 'ready' }); (await pending).close()
  })
  it('propagates a Hand failure with its Pose result and remains ready for another frame', async () => {
    const worker = new FakeWorker(), result = vi.fn(), failure = vi.fn()
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: result, onError: failure, handEnabled: true, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 10, true); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 1, pose: [{ x: .4, y: .5 }], hands: [], handFailed: true, inferenceMs: 10 })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 10, pose: [{ x: .4, y: .5 }], hands: [], handFailed: true, inferenceMs: 10 }))
    expect(failure).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled()
    expect(tracker.submit({} as HTMLVideoElement, 20, false)).toBe(true)
    tracker.close()
  })
  it('propagates uncertain Hand cleanup only alongside a Hand failure', async () => {
    const worker = new FakeWorker(), result = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: result, onError: vi.fn(), handEnabled: true, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 10, true); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 1, pose: [], hands: [], handFailed: true, handCleanupFailed: true })
    expect(result).toHaveBeenLastCalledWith(expect.objectContaining({ timestamp: 10, pose: [], hands: [], inferenceMs: undefined, handFailed: true, handCleanupFailed: true }))
    tracker.submit({} as HTMLVideoElement, 20, false); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 2, pose: [], hands: null, handCleanupFailed: true })
    expect(result).toHaveBeenLastCalledWith(expect.objectContaining({ timestamp: 20, pose: [], hands: null, inferenceMs: undefined }))
    tracker.close()
  })
  it('permits only one capture or inference and transfers the bitmap', async () => {
    const worker = new FakeWorker()
    let finishCapture!: (value: ImageBitmap) => void
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const capture = vi.fn(() => new Promise<ImageBitmap>(resolve => { finishCapture = resolve }))
    const result = vi.fn(), failure = vi.fn()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture, onResult: result, onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' })
    const tracker = await pending
    expect(tracker.submit({} as HTMLVideoElement, 10, false)).toBe(true)
    expect(tracker.submit({} as HTMLVideoElement, 20, false)).toBe(false)
    finishCapture(bitmap); await Promise.resolve(); await Promise.resolve()
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'frame', bitmap, timestamp: 10 }), [bitmap])
    expect(tracker.submit({} as HTMLVideoElement, 30, false)).toBe(false)
    worker.send({ type: 'result', id: 1, pose: [{ x: 1, y: 2 }], hands: null, inferenceMs: 42.5 })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 10, pose: [{ x: 1, y: 2 }], hands: null, inferenceMs: 42.5 }))
    expect(tracker.submit({} as HTMLVideoElement, 40, false)).toBe(true)
    tracker.close(); expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('closes an image captured after shutdown and ignores late results', async () => {
    const worker = new FakeWorker()
    let finishCapture!: (value: ImageBitmap) => void
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const result = vi.fn()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: () => new Promise(resolve => { finishCapture = resolve }), onResult: result, onError: vi.fn(), handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 1, false); tracker.close()
    finishCapture(bitmap); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 1, pose: [], hands: null })
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(result).not.toHaveBeenCalled()
    expect(worker.postMessage).toHaveBeenCalledTimes(2)
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'dispose' })
  })

  it('rejects initialization and reports runtime failure for fallback', async () => {
    const worker = new FakeWorker()
    const init = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: vi.fn(), handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'error', message: 'init failed' })
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    await expect(init).rejects.toThrow('init failed')
    expect(worker.terminate).toHaveBeenCalledOnce()
    const next = new FakeWorker(), failure = vi.fn()
    const ready = createWorkerTracker({ worker: next as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    next.send({ type: 'ready' }); await ready
    next.send({ type: 'error', message: 'inference failed' })
    expect(next.terminate).not.toHaveBeenCalled()
    next.send({ type: 'disposed', cleanupErrors: [] })
    expect(failure).toHaveBeenCalledOnce(); expect(next.terminate).toHaveBeenCalledOnce()
  })

  it('rejects after acknowledged cleanup if initialization receives an unreadable message', async () => {
    const worker = new FakeWorker(), failure = vi.fn()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    void pending.catch(() => {})
    expect(worker.onmessageerror).not.toBeNull()
    worker.onmessageerror?.({} as MessageEvent)
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    expect(worker.terminate).toHaveBeenCalledOnce()
    await expect(pending).rejects.toThrow('Worker message could not be decoded')
    expect(failure).not.toHaveBeenCalled()
    expect(worker.onmessageerror).toBeNull()
  })

  it('falls back once for an unreadable runtime message and closes a late capture', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), result = vi.fn()
    let finishCapture!: (value: ImageBitmap) => void
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: () => new Promise(resolve => { finishCapture = resolve }), onResult: result, onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 10, false)
    expect(worker.onmessageerror).not.toBeNull()
    const handler = worker.onmessageerror!
    handler({} as MessageEvent); handler({} as MessageEvent)
    expect(failure).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'Worker message could not be decoded' }))
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.onmessageerror).toBeNull()
    expect(tracker.submit({} as HTMLVideoElement, 20, false)).toBe(false)
    finishCapture(bitmap); await Promise.resolve(); await Promise.resolve()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(result).not.toHaveBeenCalled()
    expect(worker.postMessage).toHaveBeenCalledTimes(2)
  })

  it('times out a stuck capture and disposes its late bitmap', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker(), failure = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    let finishCapture!: (value: ImageBitmap) => void
    const ready = createWorkerTracker({ worker: worker as unknown as Worker, capture: () => new Promise(resolve => { finishCapture = resolve }), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await ready
    tracker.submit({} as HTMLVideoElement, 1, false)
    vi.advanceTimersByTime(8001)
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    expect(failure).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce()
    finishCapture(bitmap); await Promise.resolve(); await Promise.resolve()
    expect(bitmap.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cancels pending initialization and terminates without invoking runtime fallback', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), controller = new AbortController()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs', signal: controller.signal })
    controller.abort()
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    await expect(pending).rejects.toThrow('cancelled')
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled()
  })

  it('treats a synchronous capture failure as a runtime failure', async () => {
    const worker = new FakeWorker(), failure = vi.fn()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: () => { throw new Error('capture unavailable') }, onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 1, false)
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'capture unavailable' }))
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(tracker.submit({} as HTMLVideoElement, 2, false)).toBe(false)
  })

  it('closes an untransferred bitmap if sending it to the worker fails', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    worker.postMessage.mockImplementationOnce(() => { throw new Error('transfer blocked') })
    tracker.submit({} as HTMLVideoElement, 1, false); await Promise.resolve(); await Promise.resolve()
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'transfer blocked' }))
  })

  it('cancels an initialized worker without triggering fallback on deliberate shutdown', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), controller = new AbortController()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs', signal: controller.signal })
    worker.send({ type: 'ready' }); const tracker = await pending
    controller.abort(); tracker.close()
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.send({ type: 'disposed', cleanupErrors: [] })
    await tracker.dispose()
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled()
    expect(tracker.submit({} as HTMLVideoElement, 1, false)).toBe(false)
  })

  it('does not report invalid or missing model timings as measured latency', async () => {
    const worker = new FakeWorker(), result = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: result, onError: vi.fn(), handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 100, false); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 1, pose: [], hands: null, inferenceMs: -1 })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 100, pose: [], hands: null, inferenceMs: undefined }))
    tracker.close()
  })
})

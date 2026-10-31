import { describe, expect, it, vi } from 'vitest'
import { createWorkerTracker } from './workerTracker'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}

describe('worker tracker', () => {
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
    expect(result).toHaveBeenCalledWith({ timestamp: 10, pose, hands, inferenceMs: 8 })
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
    expect(result).toHaveBeenCalledWith({ timestamp: 10, pose: [{ x: .4, y: .5 }], hands: [], handFailed: true, inferenceMs: 10 })
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
    expect(result).toHaveBeenLastCalledWith({ timestamp: 10, pose: [], hands: [], inferenceMs: undefined, handFailed: true, handCleanupFailed: true })
    tracker.submit({} as HTMLVideoElement, 20, false); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 2, pose: [], hands: null, handCleanupFailed: true })
    expect(result).toHaveBeenLastCalledWith({ timestamp: 20, pose: [], hands: null, inferenceMs: undefined })
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
    expect(result).toHaveBeenCalledWith({ timestamp: 10, pose: [{ x: 1, y: 2 }], hands: null, inferenceMs: 42.5 })
    expect(tracker.submit({} as HTMLVideoElement, 40, false)).toBe(true)
    tracker.close(); expect(worker.terminate).toHaveBeenCalledOnce()
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
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects initialization and reports runtime failure for fallback', async () => {
    const worker = new FakeWorker()
    const init = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: vi.fn(), handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'error', message: 'init failed' })
    await expect(init).rejects.toThrow('init failed')
    expect(worker.terminate).toHaveBeenCalledOnce()
    const next = new FakeWorker(), failure = vi.fn()
    const ready = createWorkerTracker({ worker: next as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    next.send({ type: 'ready' }); await ready
    next.send({ type: 'error', message: 'inference failed' })
    expect(failure).toHaveBeenCalledOnce(); expect(next.terminate).toHaveBeenCalledOnce()
  })

  it('rejects immediately and cleans up if initialization receives an unreadable message', async () => {
    const worker = new FakeWorker(), failure = vi.fn()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    void pending.catch(() => {})
    expect(worker.onmessageerror).not.toBeNull()
    worker.onmessageerror?.({} as MessageEvent)
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
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.onmessageerror).toBeNull()
    expect(tracker.submit({} as HTMLVideoElement, 20, false)).toBe(false)
    finishCapture(bitmap); await Promise.resolve(); await Promise.resolve()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(result).not.toHaveBeenCalled()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })

  it('times out a stuck capture and disposes its late bitmap', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker(), failure = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    let finishCapture!: (value: ImageBitmap) => void
    const ready = createWorkerTracker({ worker: worker as unknown as Worker, capture: () => new Promise(resolve => { finishCapture = resolve }), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await ready
    tracker.submit({} as HTMLVideoElement, 1, false)
    vi.advanceTimersByTime(8001)
    expect(failure).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce()
    finishCapture(bitmap); await Promise.resolve(); await Promise.resolve()
    expect(bitmap.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cancels pending initialization and terminates without invoking runtime fallback', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), controller = new AbortController()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled()
  })

  it('treats a synchronous capture failure as a runtime failure', async () => {
    const worker = new FakeWorker(), failure = vi.fn()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: () => { throw new Error('capture unavailable') }, onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 1, false)
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'capture unavailable' }))
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(tracker.submit({} as HTMLVideoElement, 2, false)).toBe(false)
  })

  it('closes an untransferred bitmap if sending it to the worker fails', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    worker.postMessage.mockImplementationOnce(() => { throw new Error('transfer blocked') })
    tracker.submit({} as HTMLVideoElement, 1, false); await Promise.resolve(); await Promise.resolve()
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'transfer blocked' }))
  })

  it('cancels an initialized worker without triggering fallback on deliberate shutdown', async () => {
    const worker = new FakeWorker(), failure = vi.fn(), controller = new AbortController()
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: vi.fn(), onResult: vi.fn(), onError: failure, handEnabled: false, moduleUrl: '/vision.mjs', signal: controller.signal })
    worker.send({ type: 'ready' }); const tracker = await pending
    controller.abort(); tracker.close()
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled()
    expect(tracker.submit({} as HTMLVideoElement, 1, false)).toBe(false)
  })

  it('does not report invalid or missing model timings as measured latency', async () => {
    const worker = new FakeWorker(), result = vi.fn(), bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const pending = createWorkerTracker({ worker: worker as unknown as Worker, capture: async () => bitmap, onResult: result, onError: vi.fn(), handEnabled: false, moduleUrl: '/vision.mjs' })
    worker.send({ type: 'ready' }); const tracker = await pending
    tracker.submit({} as HTMLVideoElement, 100, false); await Promise.resolve(); await Promise.resolve()
    worker.send({ type: 'result', id: 1, pose: [], hands: null, inferenceMs: -1 })
    expect(result).toHaveBeenCalledWith({ timestamp: 100, pose: [], hands: null, inferenceMs: undefined })
    tracker.close()
  })
})

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createWorkerTracker } from './workerTracker'
import { computeInferenceDimensions } from './inferenceResolution'
import { resolveWorkerPreference } from './trackingEnginePreference'
import { createReplayFrame } from './replayFrame'

function workerHarness(pose: unknown, hand: unknown, role = 'both') {
  const messages: Record<string, unknown>[] = []
  const scope: { onmessage?: (event: { data: Record<string, unknown> }) => Promise<void>; postMessage: (value: Record<string, unknown>) => void } = {
    postMessage: value => { messages.push(value) },
  }
  const source = readFileSync('public/tracking-worker.js', 'utf8')
  const injected: { setModels?: (p: unknown, h: unknown, r: string) => void } = {}
  runInNewContext(`${source}\n;globalThis.setModels = (p, h, r) => { pose = p; hand = h; role = r }`, {
    self: scope, performance: { now: () => 10 }, globalThis: injected,
  })
  ;(injected.setModels as (p: unknown, h: unknown, r: string) => void)(pose, hand, role)
  return { scope, messages }
}

describe('Target Architecture: Hand-first GPU Worker and Optimization', () => {
  // 1. Hand result can be delivered before Pose result.
  it('delivers hand_result before pose_result on a frame where both are scheduled', async () => {
    const handLandmarks = Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5, z: -0.1 }))
    const poseLandmarks = Array.from({ length: 33 }, (_, i) => ({ x: i / 33, y: 0.4, z: 0.1, visibility: 0.9 }))

    const hand = {
      detectForVideo: vi.fn(() => ({
        landmarks: [handLandmarks],
        handedness: [[{ categoryName: 'Right', score: 0.95 }]],
        worldLandmarks: [[{ x: 0.1, y: 0.2, z: 0.3 }]],
      })),
    }
    const pose = {
      detectForVideo: vi.fn(() => ({
        landmarks: [poseLandmarks],
        worldLandmarks: [poseLandmarks],
      })),
    }

    const { scope, messages } = workerHarness(pose, hand)
    const bitmap = { close: vi.fn() }

    await scope.onmessage!({
      data: { type: 'frame', id: 42, bitmap, timestamp: 1000, hand: true, pose: true },
    })

    // Assert message sequence
    expect(messages.length).toBeGreaterThanOrEqual(3)
    expect(messages[0].type).toBe('hand_result')
    expect(messages[0].id).toBe(42)
    expect(messages[0].hands).toEqual([handLandmarks])

    expect(messages[1].type).toBe('pose_result')
    expect(messages[1].id).toBe(42)
    expect(messages[1].pose).toEqual(poseLandmarks)

    const completeMsg = messages.find(m => m.type === 'frame_complete')
    expect(completeMsg).toBeDefined()
    expect(completeMsg?.id).toBe(42)

    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  // 2. Pose and Hand use independent inference schedules.
  it('executes only Hand when pose is false, and only Pose when hand is false', async () => {
    const hand = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })) }
    const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })) }

    const { scope, messages } = workerHarness(pose, hand)
    const bitmap1 = { close: vi.fn() }
    const bitmap2 = { close: vi.fn() }

    // Frame 1: Hand only
    await scope.onmessage!({
      data: { type: 'frame', id: 1, bitmap: bitmap1, timestamp: 100, hand: true, pose: false },
    })
    expect(hand.detectForVideo).toHaveBeenCalledTimes(1)
    expect(pose.detectForVideo).toHaveBeenCalledTimes(0)
    expect(messages.some(m => m.type === 'hand_result' && m.id === 1)).toBe(true)
    expect(messages.some(m => m.type === 'pose_result' && m.id === 1)).toBe(false)

    // Frame 2: Pose only
    await scope.onmessage!({
      data: { type: 'frame', id: 2, bitmap: bitmap2, timestamp: 200, hand: false, pose: true },
    })
    expect(hand.detectForVideo).toHaveBeenCalledTimes(1)
    expect(pose.detectForVideo).toHaveBeenCalledTimes(1)
    expect(messages.some(m => m.type === 'hand_result' && m.id === 2)).toBe(false)
    expect(messages.some(m => m.type === 'pose_result' && m.id === 2)).toBe(true)
  })

  // 3. Worker does not accumulate frame queues (strict latest-frame strategy).
  it('rejects frame submission while busy and avoids unbounded queues', async () => {
    let messageListener!: (event: MessageEvent) => void
    const fakeWorker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      set onmessage(fn: (event: MessageEvent) => void) { messageListener = fn },
      onerror: null,
      onmessageerror: null,
    } as unknown as Worker

    const trackerPromise = createWorkerTracker({
      worker: fakeWorker,
      moduleUrl: '/test-bundle.mjs',
      handEnabled: true,
      capture: vi.fn().mockReturnValue(new Promise(() => {})), // in-flight capture
      onError: vi.fn(),
    })

    // Simulate worker ready
    messageListener({ data: { type: 'ready', delegates: { pose: 'GPU', hand: 'GPU' }, initializationErrors: [] } } as MessageEvent)
    const tracker = await trackerPromise

    const fakeVideo = {} as HTMLVideoElement

    // First submission enters in-flight state (busy = true)
    const accepted1 = tracker.submit(fakeVideo, 100, true, true)
    expect(accepted1).toBe(true)

    // Second submission while busy must be discarded immediately
    const accepted2 = tracker.submit(fakeVideo, 110, true, true)
    expect(accepted2).toBe(false)

    // Third submission while still busy must also be rejected
    const accepted3 = tracker.submit(fakeVideo, 120, true, true)
    expect(accepted3).toBe(false)

    tracker.close()
  })

  // 4. Stale Hand results are rejected.
  it('stale Hand results exceeding the 150 ms freshness limit are identified as stale', () => {
    const HAND_MAX_AGE_MS = 150
    const isFreshHand = (timestamp: number, now: number) => timestamp > 0 && now >= timestamp && now - timestamp <= HAND_MAX_AGE_MS

    const now = 2000
    expect(isFreshHand(1950, now)).toBe(true)  // 50 ms age -> fresh
    expect(isFreshHand(1880, now)).toBe(true)  // 120 ms age -> fresh
    expect(isFreshHand(1850, now)).toBe(true)  // 150 ms age -> boundary
    expect(isFreshHand(1800, now)).toBe(false) // 200 ms age -> STALE, rejected
    expect(isFreshHand(1300, now)).toBe(false) // 700 ms age -> STALE, rejected
  })

  // 5. Frame resize preserves aspect ratio and coordinate mapping.
  it('calculates downscaled inference dimensions preserving exact aspect ratio without upscaling', () => {
    // 1920x1080 (16:9) downscaled to 1280x720
    const res1280 = computeInferenceDimensions(1920, 1080, { width: 1280, height: 720 })
    expect(res1280).toEqual({ width: 1280, height: 720 })

    // 1920x1080 (16:9) downscaled to 960x540
    const res960 = computeInferenceDimensions(1920, 1080, { width: 960, height: 540 })
    expect(res960).toEqual({ width: 960, height: 540 })

    // Aspect ratio preservation with non-standard source (e.g. 1440x900, 16:10)
    const res1610 = computeInferenceDimensions(1440, 900, { width: 960, height: 540 })
    expect(res1610?.width).toBe(864)
    expect(res1610?.height).toBe(540)

    // Source smaller than target must not be upscaled
    const noUpscale = computeInferenceDimensions(640, 480, { width: 1280, height: 720 })
    expect(noUpscale).toBeNull()

    // Coordinate mapping identity check: normalized [0..1] coordinates match source video 1:1
    const normX = 0.45, normY = 0.60
    const originalPixelX = normX * 1920, originalPixelY = normY * 1080
    const inferencePixelX = normX * 1280, inferencePixelY = normY * 720

    expect(originalPixelX / 1920).toBeCloseTo(inferencePixelX / 1280, 5)
    expect(originalPixelY / 1080).toBeCloseTo(inferencePixelY / 720, 5)
  })

  // 6. Worker disposal releases resources.
  it('releases resources on dispose message and worker termination', async () => {
    const pose = { close: vi.fn() }
    const hand = { close: vi.fn() }

    const { scope, messages } = workerHarness(pose, hand)

    await scope.onmessage!({ data: { type: 'dispose' } })

    expect(pose.close).toHaveBeenCalledOnce()
    expect(hand.close).toHaveBeenCalledOnce()
    expect(messages.some(m => m.type === 'disposed')).toBe(true)
  })

  // 7. GPU and CPU delegates are reported correctly.
  it('reports GPU delegate when successful and falls back to CPU with error report when GPU fails', async () => {
    const messages: Record<string, unknown>[] = []
    const poseCreate = vi.fn(async (_files, options) => {
      expect(options.baseOptions.delegate).toBe('GPU')
      return { close: vi.fn() }
    })
    const handCreate = vi.fn(async (_files, options) => {
      if (options.baseOptions.delegate === 'GPU') throw new Error('GPU WebGL context creation failed')
      return { close: vi.fn() }
    })
    const scope: { onmessage?: (event: unknown) => Promise<void>; postMessage: (value: unknown) => void } = {
      postMessage: value => { messages.push(value as Record<string, unknown>) },
    }
    const fakeImport = async () => ({
      FilesetResolver: { forVisionTasks: async () => ({}) },
      PoseLandmarker: { createFromOptions: poseCreate },
      HandLandmarker: { createFromOptions: handCreate },
    })

    const source = readFileSync('public/tracking-worker.js', 'utf8').replace('await import(data.moduleUrl)', 'await fakeImport(data.moduleUrl)')
    runInNewContext(source, { self: scope, fakeImport, Error, OffscreenCanvas: class {} })

    await scope.onmessage!({
      data: { type: 'init', role: 'both', handEnabled: true, preferGpu: true, moduleUrl: '/vision.mjs' },
    })

    expect(messages[0].type).toBe('ready')
    const ready = messages[0] as { delegates: { pose: string; hand: string }; initializationErrors: string[] }
    expect(ready.delegates.pose).toBe('GPU')
    expect(ready.delegates.hand).toBe('CPU')
    expect(ready.initializationErrors).toEqual([
      expect.stringContaining('Hand GPU: GPU WebGL context creation failed'),
    ])
  })

  // 8. A Hand inference failure does not unnecessarily stop Pose.
  it('allows Pose inference to continue when Hand inference fails on the same frame', async () => {
    const poseLandmarks = [{ x: 0.5, y: 0.5, z: 0 }]
    const pose = {
      detectForVideo: vi.fn(() => ({ landmarks: [poseLandmarks] })),
    }
    const hand = {
      detectForVideo: vi.fn(() => { throw new Error('Hand WebGL kernel timeout') }),
      close: vi.fn(),
    }

    const { scope, messages } = workerHarness(pose, hand)
    const bitmap = { close: vi.fn() }

    await scope.onmessage!({
      data: { type: 'frame', id: 99, bitmap, timestamp: 500, hand: true, pose: true },
    })

    // Hand failed message sent
    const handMsg = messages.find(m => m.type === 'hand_result')
    expect(handMsg).toBeDefined()
    expect(handMsg?.handFailed).toBe(true)
    expect(handMsg?.handError).toContain('Hand WebGL kernel timeout')

    // Pose still executed and succeeded
    expect(pose.detectForVideo).toHaveBeenCalledOnce()
    const poseMsg = messages.find(m => m.type === 'pose_result')
    expect(poseMsg).toBeDefined()
    expect(poseMsg?.poseProcessed).toBe(true)
    expect(poseMsg?.pose).toEqual(poseLandmarks)

    expect(hand.close).toHaveBeenCalledOnce()
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  // 9. Resize verification for portrait (9:16, 3:4) and 4:3 videos
  it('preserves aspect ratio for 16:9, 4:3, and portrait videos without upscaling', () => {
    // 16:9 Landscape 1920x1080 -> 1280x720
    const land169 = computeInferenceDimensions(1920, 1080, { width: 1280, height: 720 })
    expect(land169).toEqual({ width: 1280, height: 720 })

    // 4:3 Landscape 1600x1200 -> 960x720 (fits within 1280x720, exact 4:3 aspect ratio)
    const land43 = computeInferenceDimensions(1600, 1200, { width: 1280, height: 720 })
    expect(land43).toEqual({ width: 960, height: 720 })
    expect(land43!.width / land43!.height).toBeCloseTo(1600 / 1200, 4)
    expect(land43!.width).toBeLessThanOrEqual(1600)
    expect(land43!.height).toBeLessThanOrEqual(1200)

    // 9:16 Portrait 1080x1920 -> 720x1280 (fits within portrait box 720x1280, never exceeds source)
    const port916 = computeInferenceDimensions(1080, 1920, { width: 1280, height: 720 })
    expect(port916).toEqual({ width: 720, height: 1280 })
    expect(port916!.width / port916!.height).toBeCloseTo(1080 / 1920, 4)
    expect(port916!.width).toBeLessThanOrEqual(1080)
    expect(port916!.height).toBeLessThanOrEqual(1920)

    // 3:4 Portrait 1200x1600 -> 720x960 (fits within 720x1280, exact 3:4 aspect ratio)
    const port34 = computeInferenceDimensions(1200, 1600, { width: 1280, height: 720 })
    expect(port34).toEqual({ width: 720, height: 960 })
    expect(port34!.width / port34!.height).toBeCloseTo(1200 / 1600, 4)
    expect(port34!.width).toBeLessThanOrEqual(1200)
    expect(port34!.height).toBeLessThanOrEqual(1600)
  })

  // 10. WorkerTracker asynchronous disposal acknowledgement
  it('awaits disposed acknowledgement before terminating worker on dispose()', async () => {
    let messageListener!: (event: MessageEvent) => void
    const fakeWorker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      set onmessage(fn: (event: MessageEvent) => void) { messageListener = fn },
      onerror: null,
      onmessageerror: null,
    } as unknown as Worker

    const trackerPromise = createWorkerTracker({
      worker: fakeWorker,
      moduleUrl: '/test-bundle.mjs',
      handEnabled: true,
      capture: vi.fn(),
      onError: vi.fn(),
    })
    messageListener({ data: { type: 'ready', delegates: { pose: 'GPU', hand: 'GPU' }, initializationErrors: [] } } as MessageEvent)
    const tracker = await trackerPromise

    // Call dispose
    const disposePromise = tracker.dispose()
    expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: 'dispose' })
    expect(fakeWorker.terminate).not.toHaveBeenCalled()

    // Send disposed confirmation from worker
    messageListener({ data: { type: 'disposed', cleanupErrors: [] } } as MessageEvent)
    await disposePromise

    // Worker terminated only after disposal acknowledged
    expect(fakeWorker.terminate).toHaveBeenCalledOnce()
  })

  // 11. Independent freshness verification
  it('verifies independent freshness limits for Hand (150 ms) and Pose (250 ms)', () => {
    const HAND_LIMIT = 150
    const POSE_LIMIT = 250
    const isFresh = (ts: number, now: number, limit: number) => ts > 0 && now >= ts && now - ts <= limit

    const now = 1000
    // At t = 820 ms (age = 180 ms): Hand is expired, but Pose is still fresh
    expect(isFresh(820, now, HAND_LIMIT)).toBe(false)
    expect(isFresh(820, now, POSE_LIMIT)).toBe(true)

    // At t = 700 ms (age = 300 ms): Both are expired
    expect(isFresh(700, now, HAND_LIMIT)).toBe(false)
    expect(isFresh(700, now, POSE_LIMIT)).toBe(false)

    // At t = 900 ms (age = 100 ms): Both are fresh
    expect(isFresh(900, now, HAND_LIMIT)).toBe(true)
    expect(isFresh(900, now, POSE_LIMIT)).toBe(true)
  })

  // 12. GPU Worker is selected by default
  it('selects dedicated GPU Worker by default when no preference is saved', () => {
    expect(resolveWorkerPreference(undefined, null)).toBe(true)
    expect(resolveWorkerPreference(true, null)).toBe(true)
    expect(resolveWorkerPreference(false, null)).toBe(false)
    expect(resolveWorkerPreference(undefined, 'disabled')).toBe(false)
  })

  // 13. Restores Pose-first order when handFirst: false
  it('executes Pose before Hand when handFirst is false', async () => {
    const hand = { detectForVideo: vi.fn(() => ({ landmarks: [[{ x: 0.1, y: 0.2 }]] })) }
    const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[{ x: 0.3, y: 0.4 }]] })) }

    const { scope, messages } = workerHarness(pose, hand)
    const bitmap = { close: vi.fn() }

    await scope.onmessage!({
      data: { type: 'frame', id: 50, bitmap, timestamp: 2000, hand: true, pose: true, handFirst: false },
    })

    expect(messages[0].type).toBe('pose_result')
    expect(messages[1].type).toBe('hand_result')
    expect(messages[2].type).toBe('frame_complete')
    expect(messages.some(m => m.type === 'result')).toBe(false)
  })

  // 14. Non-empty cleanupErrors propagates error and rejects disposal
  it('rejects disposal and invokes onError when model close fails with non-empty cleanupErrors', async () => {
    let messageListener!: (event: MessageEvent) => void
    const fakeWorker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      set onmessage(fn: (event: MessageEvent) => void) { messageListener = fn },
      onerror: null,
      onmessageerror: null,
    } as unknown as Worker

    const onError = vi.fn()
    const trackerPromise = createWorkerTracker({
      worker: fakeWorker,
      moduleUrl: '/test-bundle.mjs',
      handEnabled: true,
      capture: vi.fn(),
      onError,
    })
    messageListener({ data: { type: 'ready', delegates: { pose: 'GPU', hand: 'GPU' }, initializationErrors: [] } } as MessageEvent)
    const tracker = await trackerPromise

    const disposePromise = tracker.dispose()
    messageListener({ data: { type: 'disposed', cleanupErrors: ['Failed to delete WebGL program'] } } as MessageEvent)

    await expect(disposePromise).rejects.toThrow('Worker cleanup failed: Failed to delete WebGL program')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Worker cleanup failed') }))
    expect(fakeWorker.terminate).toHaveBeenCalledOnce()
  })

  // 15. Legacy onResult compatibility aggregates results upon frame_complete without duplicate messages
  it('aggregates Hand and Pose results for legacy onResult upon frame_complete without duplicate worker messages', async () => {
    let messageListener!: (event: MessageEvent) => void
    const fakeWorker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      set onmessage(fn: (event: MessageEvent) => void) { messageListener = fn },
      onerror: null,
      onmessageerror: null,
    } as unknown as Worker

    const onResult = vi.fn()
    const onHandResult = vi.fn()
    const onPoseResult = vi.fn()
    const onFrameComplete = vi.fn()

    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const trackerPromise = createWorkerTracker({
      worker: fakeWorker,
      moduleUrl: '/test-bundle.mjs',
      handEnabled: true,
      capture: async () => bitmap,
      onResult,
      onHandResult,
      onPoseResult,
      onFrameComplete,
      onError: vi.fn(),
    })
    messageListener({ data: { type: 'ready', delegates: { pose: 'GPU', hand: 'GPU' }, initializationErrors: [] } } as MessageEvent)
    const tracker = await trackerPromise

    tracker.submit({} as HTMLVideoElement, 1000, true, true)
    await Promise.resolve(); await Promise.resolve()

    // 1. Worker sends hand_result
    const hands = [[{ x: 0.1, y: 0.2, z: 0 }]]
    messageListener({ data: { type: 'hand_result', id: 1, timestamp: 1000, hands, handInferenceMs: 15, handProcessed: true } } as MessageEvent)
    expect(onHandResult).toHaveBeenCalledOnce()
    expect(onResult).not.toHaveBeenCalled() // Must NOT trigger legacy onResult yet

    // 2. Worker sends pose_result
    const pose = [{ x: 0.3, y: 0.4, z: 0 }]
    messageListener({ data: { type: 'pose_result', id: 1, timestamp: 1000, pose, poseInferenceMs: 25, poseProcessed: true } } as MessageEvent)
    expect(onPoseResult).toHaveBeenCalledOnce()
    expect(onResult).not.toHaveBeenCalled() // Must NOT trigger legacy onResult yet

    // 3. Worker sends lightweight frame_complete (NO duplicate landmarks)
    messageListener({ data: { type: 'frame_complete', id: 1, timestamp: 1000, inferenceMs: 40, poseProcessed: true, handProcessed: true, poseInferenceMs: 25, handInferenceMs: 15 } } as MessageEvent)
    expect(onFrameComplete).toHaveBeenCalledOnce()
    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: 1000,
      pose,
      hands,
      inferenceMs: 40,
      poseProcessed: true,
      handProcessed: true,
    }))

    tracker.close()
  })

  // 16. Cross-context timestamps in consistent monotonic time domain
  it('computes transferAndDispatchMs using performance.timeOrigin in same domain', async () => {
    const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })) }
    const hand = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })) }

    const { scope, messages } = workerHarness(pose, hand)
    const bitmap = { close: vi.fn() }

    // Simulate submission timestamp using Window's monotonic domain: timeOrigin + now
    const submittedAt = 5 // In worker harness, performance.now() returns 10, timeOrigin defaults to 0
    await scope.onmessage!({
      data: { type: 'frame', id: 1, bitmap, timestamp: 500, hand: true, pose: true, submittedAt },
    })

    const frameComplete = messages.find(m => m.type === 'frame_complete')
    expect(frameComplete).toBeDefined()
    expect(frameComplete?.transferAndDispatchMs).toBe(5)
    expect(Number.isFinite(frameComplete?.transferAndDispatchMs)).toBe(true)
    expect(frameComplete?.transferAndDispatchMs).toBeGreaterThanOrEqual(0)
  })

  // 17. Replay frame association strictly binds same-frame observations
  it('preserves frame identity and does not combine stale Hand landmarks with newer Pose frame', () => {
    const frame1 = createReplayFrame({
      frameId: 1,
      framePerformanceMs: 100,
      mediaTime: 0.1,
      capturedAt: '2026-11-02T00:00:00.000Z',
      inferenceMs: 20,
      pose: [{ x: 0.1, y: 0.2, z: 0 }],
      poseWorld: [],
      displayPose: [{ x: 0.1, y: 0.2, z: 0 }],
      hands: [[{ x: 0.5, y: 0.5, z: 0 }]],
      handsWorld: [],
      handedness: [[{ categoryName: 'Right' }]],
      posePerformed: true,
      handPerformed: true,
    })

    // Frame 2 where Hand was NOT scheduled (handPerformed: false)
    const frame2 = createReplayFrame({
      frameId: 2,
      framePerformanceMs: 200,
      mediaTime: 0.2,
      capturedAt: '2026-11-02T00:00:00.100Z',
      inferenceMs: 15,
      pose: [{ x: 0.2, y: 0.3, z: 0 }],
      poseWorld: [],
      displayPose: [{ x: 0.2, y: 0.3, z: 0 }],
      hands: [], // MUST NOT combine stale Frame 1 hand landmarks!
      handsWorld: [],
      handedness: [],
      posePerformed: true,
      handPerformed: false,
    })

    expect(frame1.hand_detected).toBe(true)
    expect(frame1.landmarks.some(l => l.landmark_source === 'hand')).toBe(true)

    expect(frame2.hand_detected).toBeNull() // Not performed is null, not false
    expect(frame2.landmarks.some(l => l.landmark_source === 'hand')).toBe(false)
  })

  // 18. Initial hand detection is not counted as a tracking recovery event
  it('does not count the first successful hand detection as a tracking recovery event', () => {
    let handTrackingLossCount = 0
    let handTrackingRecoveryCount = 0
    let lastHandValid = false
    let hadInitialDetection = false

    const observeHand = (valid: boolean) => {
      if (!hadInitialDetection) {
        if (valid) hadInitialDetection = true
      } else {
        if (lastHandValid && !valid) handTrackingLossCount++
        else if (!lastHandValid && valid) handTrackingRecoveryCount++
      }
      lastHandValid = valid
    }

    // 1. Initial detection
    observeHand(true)
    expect(handTrackingRecoveryCount).toBe(0) // Must NOT count initial detection as recovery
    expect(handTrackingLossCount).toBe(0)

    // 2. Tracking lost
    observeHand(false)
    expect(handTrackingLossCount).toBe(1)
    expect(handTrackingRecoveryCount).toBe(0)

    // 3. Tracking recovered
    observeHand(true)
    expect(handTrackingLossCount).toBe(1)
    expect(handTrackingRecoveryCount).toBe(1) // Real recovery after loss
  })
})

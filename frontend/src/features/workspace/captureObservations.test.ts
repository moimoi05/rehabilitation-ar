import { describe, expect, it, vi } from 'vitest'
import { CaptureObservationCollector } from './captureObservations'

const point = { x: 0.2, y: 0.3, z: -0.1 }
const observed = (now: number) => ({ now, mediaTime: now / 1000, sourceFrameId: now, skippedSourceFrames: 0 })

describe('capture source observations', () => {
  it('joins out-of-order results by source identity and preserves raw/world arrays', () => {
    const emit = vi.fn(), collector = new CaptureObservationCollector(emit)
    const a = collector.observe(observed(100), 'capture-a'), b = collector.observe(observed(110), 'capture-a')
    collector.submitted(a, { pose: true, hand: true }); collector.submitted(b, { pose: true, hand: true })
    collector.workerResult({ ...b, timestamp: 110, pose: [], hands: [[point]], handProcessed: true, handWorldLandmarks: [[point]], handedness: [[{ categoryName: 'Left', score: 0.9, index: 0, displayName: '' }]] }, 'hand')
    collector.workerResult({ ...a, timestamp: 100, pose: [point], hands: null, poseProcessed: true }, 'pose')
    expect(emit).not.toHaveBeenCalled()
    collector.workerResult({ ...a, timestamp: 100, pose: [], hands: [], handProcessed: true }, 'hand')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ timestamp: 100, source_observation_id: a.sourceObservationId, pose_inference_status: 'detected', hand_inference_status: 'not_detected' })
    collector.workerResult({ ...b, timestamp: 110, pose: [], hands: null, poseProcessed: true }, 'pose')
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1][0].landmarks).toEqual(expect.arrayContaining([expect.objectContaining({ landmark_source: 'hand', coordinate_space: 'world', handedness_score: 0.9, hand_observation_index: 0 })]))
  })

  it('distinguishes unscheduled, failed and missing model outputs and bounds waiting memory', () => {
    const emit = vi.fn(), collector = new CaptureObservationCollector(emit, { maxPending: 2, maxWaitMs: 20 })
    const a = collector.observe(observed(100), 'capture-a')
    collector.submitted(a, { pose: true, hand: false })
    collector.workerResult({ ...a, timestamp: 100, pose: [], hands: null, poseProcessed: false, poseFailed: true, poseError: 'inference failed' }, 'pose')
    expect(emit.mock.calls[0][0]).toMatchObject({ pose_inference_status: 'error', pose_detected: null, hand_inference_status: 'not_run', hand_detected: null })
    const b = collector.observe(observed(110), 'capture-a'); collector.submitted(b, { pose: false, hand: true })
    collector.observe(observed(140), 'capture-a')
    expect(emit.mock.calls[1][0]).toMatchObject({ hand_inference_status: 'missing_result', hand_detected: null })
    for (let index = 0; index < 10; index++) collector.observe(observed(140 + index), 'capture-a')
    expect(collector.pendingCount).toBeLessThanOrEqual(2)
  })

  it('preserves source-time ordering when a newer parallel observation finishes first', () => {
    const emit = vi.fn(), collector = new CaptureObservationCollector(emit)
    const a = collector.observe(observed(100), 'capture-a'), b = collector.observe(observed(110), 'capture-a')
    collector.submitted(a, { pose: true, hand: false }); collector.submitted(b, { pose: false, hand: true })
    collector.workerResult({ ...b, timestamp: 110, pose: [], hands: [], handProcessed: true }, 'hand')
    expect(emit).not.toHaveBeenCalled()
    collector.workerResult({ ...a, timestamp: 100, pose: [], hands: null, poseProcessed: true }, 'pose')
    expect(emit.mock.calls.map(call => call[0].timestamp)).toEqual([100, 110])
  })

  it('rejects stale or mismatched trial callbacks and emits observed frames with no inference', () => {
    const emit = vi.fn(), collector = new CaptureObservationCollector(emit)
    const old = collector.observe(observed(100), 'capture-a'); collector.submitted(old, { pose: true, hand: true })
    const current = collector.observe(observed(110), 'capture-b'); collector.submitted(current, { pose: true, hand: false })
    collector.workerResult({ ...old, captureScope: 'capture-b', timestamp: 100, pose: [point], hands: null, poseProcessed: true }, 'pose')
    collector.workerResult({ ...current, sourcePerformanceMs: 999, timestamp: 110, pose: [point], hands: null, poseProcessed: true }, 'pose')
    expect(emit).not.toHaveBeenCalled()
    collector.workerResult({ ...current, timestamp: 110, pose: [point], hands: null, poseProcessed: true }, 'pose')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 110 }), 'capture-b')
    const idle = collector.observe(observed(120), 'capture-b'); collector.submitted(idle, { pose: false, hand: false })
    expect(emit.mock.calls[1][0]).toMatchObject({ inference_performed: false, pose_inference_status: 'not_run', hand_inference_status: 'not_run', landmarks: [] })
    collector.flush()
    expect(collector.pendingCount).toBe(0)
  })

  it('settles delayed results within a bounded stop window without flushing another trial', async () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn(), collector = new CaptureObservationCollector(emit)
      const a = collector.observe(observed(100), 'capture-a'), b = collector.observe(observed(110), 'capture-b')
      collector.submitted(a, { pose: true, hand: false }); collector.submitted(b, { pose: false, hand: true })
      const done = vi.fn(), waiting = collector.settle('capture-a', 100).then(done)
      await vi.advanceTimersByTimeAsync(50)
      expect(done).not.toHaveBeenCalled()
      collector.workerResult({ ...a, timestamp: 100, pose: [point], hands: null, poseProcessed: true }, 'pose')
      await waiting
      expect(done).toHaveBeenCalledOnce(); expect(collector.pendingCount).toBe(1)
      const timeout = collector.settle('capture-b', 100)
      await vi.advanceTimersByTimeAsync(101); await timeout
      expect(collector.pendingCount).toBe(0)
      expect(emit.mock.calls[1][0]).toMatchObject({ hand_inference_status: 'missing_result', hand_inference_performed: null })
    } finally { vi.useRealTimers() }
  })

  it('keeps a successful inference summary with a missing payload distinct from no detection', () => {
    const emit = vi.fn(), collector = new CaptureObservationCollector(emit)
    const source = collector.observe(observed(100), 'capture-a'); collector.submitted(source, { pose: false, hand: true })
    collector.workerResult({ ...source, timestamp: 100, pose: [], hands: null, poseProcessed: false, handProcessed: true, handResultReceived: false })
    expect(emit.mock.calls[0][0]).toMatchObject({ hand_inference_status: 'missing_result', hand_inference_performed: true, hand_detected: null, landmarks: [] })
  })
})

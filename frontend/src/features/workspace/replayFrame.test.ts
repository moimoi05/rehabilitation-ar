import { describe, expect, it } from 'vitest'
import { createReplayFrame } from './replayFrame'

describe('replay frame mapping', () => {
  it('keeps source media time, raw and display coordinates and hand identity', () => {
    const frame = createReplayFrame({ frameId: 7, framePerformanceMs: 4932.25, mediaTime: 1.25, capturedAt: '2026-01-01T00:00:00.000Z', inferenceMs: 8, pose: [{ x: 0.1, y: 0.2, z: -0.3, visibility: 0.9 }], poseWorld: [{ x: 2, y: 3, z: 4 }], displayPose: [{ x: 0.15, y: 0.2, z: -0.3 }], hands: [[{ x: 0.4, y: 0.5, z: 0.6 }]], handsWorld: [[{ x: 1, y: 2, z: 3 }]], handedness: [[{ categoryName: 'Left' }]] })
    expect(frame).toMatchObject({ frame_id: 7, frame_performance_ms: 4932.25, video_media_time_ms: 1250, inference_performed: true, pose_detected: true, hand_detected: true, inference_ms: 8 })
    expect(frame).not.toHaveProperty('timestamp_ms')
    expect(frame.landmarks).toEqual(expect.arrayContaining([
      expect.objectContaining({ landmark_source: 'pose', landmark_index: 0, coordinate_space: 'normalized_image', representation: 'raw', x: 0.1, z: -0.3, visibility: 0.9 }),
      expect.objectContaining({ landmark_source: 'pose', coordinate_space: 'world', representation: 'raw', x: 2 }),
      expect.objectContaining({ landmark_source: 'pose', coordinate_space: 'normalized_image', representation: 'display', x: 0.15 }),
      expect.objectContaining({ landmark_source: 'hand', coordinate_space: 'world', handedness: 'Left', z: 3 }),
    ]))
  })
  it('preserves detected out-of-image landmarks as invalid', () => {
    const frame = createReplayFrame({ frameId: 1, framePerformanceMs: 4000, mediaTime: 0, capturedAt: '2026-01-01T00:00:00.000Z', inferenceMs: 0, pose: [{ x: 1.2, y: 0.2, z: 0 }], poseWorld: [], displayPose: [], hands: [], handsWorld: [], handedness: [] })
    expect(frame.landmarks[0]).toMatchObject({ x: 1.2, is_valid: false, invalid_reason: 'outside_image' })
  })
  it('distinguishes a disabled pose model from a model that ran without a detection', () => {
    const input = { frameId: 1, framePerformanceMs: 4000, mediaTime: 0, capturedAt: '2026-01-01T00:00:00.000Z', inferenceMs: 0, pose: [], poseWorld: [], displayPose: [], hands: [], handsWorld: [], handedness: [] }
    expect(createReplayFrame({ ...input, posePerformed: false }).pose_detected).toBeNull()
    expect(createReplayFrame({ ...input, posePerformed: true }).pose_detected).toBe(false)
  })
  it('never copies coordinates from a model that was not observed for this source frame', () => {
    const frame = createReplayFrame({ frameId: 8, sourceFrameId: 71, framePerformanceMs: 1200, mediaTime: 2.5, capturedAt: '2026-01-01T00:00:00.000Z', inferenceMs: 3,
      pose: [{ x: .2, y: .3, z: .1 }], poseWorld: [], displayPose: [{ x: .25, y: .3, z: .1 }], posePerformed: false,
      hands: [[{ x: .4, y: .5, z: .1 }]], handsWorld: [], handedness: [[{ categoryName: 'Right' }]], handPerformed: true })
    expect(frame).toMatchObject({ source_frame_id: 71, video_media_time_ms: 2500, pose_detected: null, hand_detected: true })
    expect(frame.landmarks.every(point => point.landmark_source === 'hand')).toBe(true)
  })
  it('marks failed inference as observed without a detection and discards its invalid coordinates', () => {
    const frame = createReplayFrame({ frameId: 9, sourceFrameId: 72, framePerformanceMs: 1233, mediaTime: 2.533, capturedAt: '2026-01-01T00:00:00.000Z', inferenceMs: 4,
      pose: [], poseWorld: [], displayPose: [], posePerformed: false, hands: [[{ x: .4, y: .5, z: .1 }]], handsWorld: [], handedness: [], handPerformed: true, handFailed: true })
    expect(frame).toMatchObject({ source_frame_id: 72, inference_performed: true, pose_detected: null, hand_detected: false })
    expect(frame.landmarks).toEqual([])
  })
})

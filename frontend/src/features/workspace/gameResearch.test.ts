import { expect, it, vi } from 'vitest'
import { createGameResearchSink } from './gameResearch'

it('uses the capture monotonic origin and stable ordered identities without inventing frame mappings', () => {
  const event = vi.fn(), sample = vi.fn()
  const sink = createGameResearchSink({ captureId: 'capture', trialId: 42, gameKey: 'glowing_flower', start: 1000, event, sample })
  sink.event('TARGET_TOUCHED', { target_id: 't1' }, { timestamp: 1450.25, sourceTimestamp: 1430, sourceObservationId: 135 })
  sink.event('TARGET_SPAWNED', { target_id: 't2' }, { timestamp: 1450.25 })
  sink.sample('flower_cursor', { x: 0.5, y: 0.6 }, { timestamp: 1430, sourceObservationId: 135 })
  expect(event.mock.calls[0][0]).toMatchObject({ capture_id: 'capture', trial_id: 42, game_key: 'glowing_flower', sequence: 0, timestamp_ms: 450.25, source_timestamp_ms: 430, source_observation_id: 135, frame_id: null })
  expect(event.mock.calls[1][0]).toMatchObject({ sequence: 1, source_observation_id: null })
  expect(event.mock.calls[0][0].event_id).not.toBe(event.mock.calls[1][0].event_id)
  expect(sample.mock.calls[0][0]).toMatchObject({ timestamp_ms: 430, frame_id: null })
})

it('rejects observations before capture and isolates research writer errors from gameplay', () => {
  const gap = vi.fn(), sample = vi.fn()
  const sink = createGameResearchSink({ captureId: 'capture', trialId: 42, gameKey: 'free_drawing', start: 1000, sample, event: () => { throw new Error('disk full') }, gap })
  sink.sample('drawing_stroke_point', { x: 1, y: 2 }, { timestamp: 999 })
  expect(sample).not.toHaveBeenCalled()
  expect(() => sink.event('GAME_STARTED', {}, { timestamp: 1001 })).not.toThrow()
  expect(gap).toHaveBeenCalledWith(expect.stringContaining('disk full'))
})

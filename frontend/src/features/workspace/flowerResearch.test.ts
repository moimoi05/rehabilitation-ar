import { describe, expect, it, vi } from 'vitest'
import { initialRound, stepRound } from './flowerGame'
import { FlowerResearchRecorder } from './flowerResearch'

const display = { width: 1000, height: 1000 }
const geometry = { box: display, rect: { x: 0, y: 0, width: 1000, height: 1000 } }
const owner = () => ({ prepare: vi.fn(), started: vi.fn(), stopped: vi.fn(), event: vi.fn(), sample: vi.fn() })

describe('flower research transitions', () => {
  it('emits one touch for one score and gives the next target its own timestamp and ID', () => {
    const sink = owner(), recorder = new FlowerResearchRecorder(sink, 'left', false)
    const first = initialRound()
    recorder.start(first, 100, display, geometry, true)
    const next = stepRound(first, first.target, 10, 1000, 1000)
    recorder.tick(first, next, { timestamp: 110, sourceTimestamp: 105, sourceObservationId: 3, pointer: first.target, display, geometry, geometryPaused: false, freshnessMs: 5 })
    recorder.tick(next, stepRound(next, first.target, 10, 1000, 1000), { timestamp: 120, sourceTimestamp: 105, sourceObservationId: 3, pointer: first.target, display, geometry, geometryPaused: false, freshnessMs: 15 })
    const touches = sink.event.mock.calls.filter(([type]) => type === 'TARGET_TOUCHED')
    expect(touches).toHaveLength(1)
    expect(touches[0]).toEqual(['TARGET_TOUCHED', expect.objectContaining({ target_id: 'target-1', cursor_x: .35, cursor_y: .5 }), { timestamp: 110, sourceTimestamp: 105, sourceObservationId: 3 }])
    const spawned = sink.event.mock.calls.filter(([type]) => type === 'TARGET_SPAWNED')
    expect(spawned.map(([, payload]) => payload.target_id)).toEqual(['target-1', 'target-2'])
    expect(spawned[1][2].timestamp).toBe(110)
    expect(spawned[1][1]).toMatchObject({ target_sequence: 2, target_x: .6, target_y: .43, width: 1000, height: 1000, target_radius: 70 })
    expect(sink.sample).toHaveBeenCalledOnce()
    expect(sink.sample).toHaveBeenCalledWith('flower_cursor', expect.objectContaining({ target_id: 'target-1', usable: true, side: 'left' }), { timestamp: 105, sourceTimestamp: 105, sourceObservationId: 3 })
  })

  it('records loss/recovery as transitions without inventing a failed touch', () => {
    const sink = owner(), recorder = new FlowerResearchRecorder(sink, 'right', false), round = initialRound()
    recorder.start(round, 100, display, geometry, true)
    recorder.tick(round, round, { timestamp: 400, sourceTimestamp: 100, sourceObservationId: 1, pointer: null, display, geometry, geometryPaused: false, freshnessMs: 300 })
    recorder.tick(round, round, { timestamp: 410, sourceTimestamp: 100, sourceObservationId: 1, pointer: null, display, geometry, geometryPaused: false, freshnessMs: 310 })
    recorder.tick(round, round, { timestamp: 420, sourceTimestamp: 420, sourceObservationId: 2, pointer: { x: .1, y: .1 }, display, geometry, geometryPaused: false, freshnessMs: 0 })
    expect(sink.event.mock.calls.map(([type]) => type)).toEqual(['GAME_STARTED', 'TARGET_SPAWNED', 'TRACKING_LOST', 'TRACKING_RECOVERED'])
    expect(sink.event.mock.calls[0][1]).toMatchObject({ tracking_usable: true })
    expect(sink.sample.mock.calls[0][1]).toMatchObject({ usable: false, freshness: 'stale', x: null, y: null })
  })

  it('captures geometry changes, release gates, and terminal gameplay time only once', () => {
    const sink = owner(), recorder = new FlowerResearchRecorder(sink, 'left', true), round = initialRound()
    recorder.start(round, 100, display, geometry, true)
    const touched = stepRound(round, round.target, 10, 1000, 1000)
    recorder.tick(round, touched, { timestamp: 110, sourceTimestamp: 110, pointer: round.target, display, geometry, geometryPaused: false, freshnessMs: 0 })
    recorder.tick(touched, touched, { timestamp: 120, sourceTimestamp: 120, pointer: touched.target, display, geometry, geometryPaused: true, freshnessMs: 0 })
    const released = stepRound(touched, touched.target, 10, 1000, 1000)
    recorder.tick(touched, released, { timestamp: 130, sourceTimestamp: 130, pointer: touched.target, display, geometry, geometryPaused: false, freshnessMs: 0 })
    recorder.stop('stopped', released, 140)
    recorder.stop('unmounted', released, 150)
    expect(sink.event.mock.calls.filter(([type]) => type === 'TARGET_RELEASE_GATE_CLEARED')).toHaveLength(1)
    expect(sink.event.mock.calls.find(([type]) => type === 'GEOMETRY_PAUSED')?.[1]).toMatchObject({ mapping: { mirrored: true }, target_id: 'target-2' })
    expect(sink.event.mock.calls.filter(([type]) => type === 'GEOMETRY_RESUMED')).toHaveLength(1)
    expect(sink.event.mock.calls.at(-1)).toEqual(['GAME_STOPPED', expect.objectContaining({ gameplay_elapsed_ms: 20, score: 2 }), { timestamp: 140 }])
  })

  it('never lets recording failures interrupt gameplay instrumentation', () => {
    const sink = owner(), warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    sink.event.mockImplementation(() => { throw new Error('queue full') })
    const recorder = new FlowerResearchRecorder(sink, 'left', false), round = initialRound()
    expect(() => recorder.start(round, 100, display, geometry, false)).not.toThrow()
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })
})

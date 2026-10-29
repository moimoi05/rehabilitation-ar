import { describe, expect, it } from 'vitest'
import { AdaptiveWorkerBudget, AUTO_WORKER_MAX_FPS } from './adaptiveWorkerBudget'

const create = () => new AdaptiveWorkerBudget({ poseMaxFps: 30, handMaxFps: 20 })
const windowSamples = (budget: AdaptiveWorkerBudget, start: number, delay: number, roundTrip = 100) => {
  budget.recordResult('pose', { timestamp: start + 1, receivedAt: start + 1 + roundTrip, inferenceMs: 65 })
  budget.recordUiDelay(start + 500, delay)
  budget.recordUiDelay(start + 1500, delay)
  budget.recordUiDelay(start + 2000, delay)
}

describe('adaptive worker budget', () => {
  it('shares immutable maximum frame budgets for auto mode', () => {
    expect(AUTO_WORKER_MAX_FPS).toEqual({ poseMaxFps: 30, handMaxFps: 20 })
    expect(Object.isFrozen(AUTO_WORKER_MAX_FPS)).toBe(true)
  })
  it('limits accepted submissions per stream without creating a queue', () => {
    const budget = create()
    expect(budget.canSubmit('pose', 100)).toBe(true)
    budget.submitted('pose', 100)
    expect(budget.canSubmit('pose', 120)).toBe(false)
    expect(budget.canSubmit('hand', 120)).toBe(true)
    expect(budget.canSubmit('pose', 134)).toBe(true)
    expect(budget.canSubmit('pose', 134)).toBe(true) // rejected worker submit does not consume the budget
  })

  it('requires sustained UI pressure, reducing Hand before Pose and recovering more slowly', () => {
    const budget = create()
    windowSamples(budget, 0, 120)
    expect(budget.snapshot().handFps).toBe(20)
    windowSamples(budget, 2000, 120)
    const degraded = budget.snapshot()
    expect(degraded.handFps).toBeLessThan(20)
    expect(degraded.poseFps).toBe(30)
    windowSamples(budget, 4000, 0)
    windowSamples(budget, 6000, 0)
    expect(budget.snapshot().handFps).toBe(degraded.handFps)
    windowSamples(budget, 8000, 0)
    windowSamples(budget, 10000, 0)
    expect(budget.snapshot().handFps).toBeGreaterThan(degraded.handFps)
  })

  it('does not treat a naturally slow but stable model as system overload', () => {
    const budget = create()
    for (let t = 0; t < 14000; t += 2000) windowSamples(budget, t, 0, 550)
    expect(budget.snapshot()).toMatchObject({ poseFps: 30, handFps: 20 })
    expect(budget.snapshot().poseRoundTripMs).toBeCloseTo(550)
  })

  it('bounds throttling and eventually protects Pose under continuing UI pressure', () => {
    const budget = create()
    for (let t = 0; t < 90000; t += 2000) windowSamples(budget, t, 120)
    const snapshot = budget.snapshot()
    expect(snapshot.handFps).toBeGreaterThanOrEqual(3)
    expect(snapshot.poseFps).toBeGreaterThanOrEqual(8)
    expect(snapshot.poseFps).toBeLessThan(30)
  })

  it('rejects invalid, out-of-order, and prior-epoch observations; reset restores budgets', () => {
    const budget = create()
    windowSamples(budget, 0, 120); windowSamples(budget, 2000, 120)
    budget.reset(5000)
    budget.submitted('pose', 5100)
    budget.recordResult('pose', { timestamp: 100, receivedAt: 5200, inferenceMs: 20 })
    budget.recordResult('pose', { timestamp: 5150, receivedAt: 5140, inferenceMs: 20 })
    budget.recordUiDelay(4900, 300)
    budget.recordUiDelay(5200, NaN)
    expect(budget.snapshot()).toMatchObject({ poseFps: 30, handFps: 20, poseInferenceMs: null, poseRoundTripMs: null })
    expect(budget.canSubmit('pose', 5110)).toBe(false)
    expect(budget.canSubmit('pose', 5200)).toBe(true)
  })

  it('does not infer recovery while UI or Pose telemetry is absent', () => {
    const budget = create()
    windowSamples(budget, 0, 120); windowSamples(budget, 2000, 120)
    const fps = budget.snapshot().handFps
    for (let t = 5000; t <= 20000; t += 1000) budget.recordUiDelay(t, 0)
    expect(budget.snapshot().handFps).toBe(fps)
  })

  it('uses relative Pose slowdown with moderate UI delay, but not slowdown alone', () => {
    const budget = create()
    for (let i = 0; i < 5; i++) budget.recordResult('pose', { timestamp: 100 + i * 100, receivedAt: 180 + i * 100, inferenceMs: 50 })
    for (let t = 0; t < 30000; t += 2000) windowSamples(budget, t + 1000, 0, 400)
    expect(budget.snapshot().handFps).toBe(20)
    windowSamples(budget, 31000, 55, 400)
    windowSamples(budget, 33000, 55, 400)
    expect(budget.snapshot().handFps).toBeLessThan(20)
    expect(budget.snapshot().poseFps).toBe(30)
  })

  it('records timings independently without allowing bad values to poison metrics', () => {
    const budget = create()
    budget.recordResult('pose', { timestamp: 10, receivedAt: 110, inferenceMs: 80 })
    budget.recordResult('hand', { timestamp: 20, receivedAt: 220, inferenceMs: 150 })
    budget.recordResult('pose', { timestamp: 9, receivedAt: 900, inferenceMs: 500 })
    budget.recordResult('pose', { timestamp: 15, receivedAt: 900, inferenceMs: 600 }) // older than the display freshness limit
    budget.recordResult('hand', { timestamp: 21, receivedAt: 221, inferenceMs: NaN })
    expect(budget.snapshot()).toMatchObject({ poseInferenceMs: 80, poseRoundTripMs: 100, handInferenceMs: 150, handRoundTripMs: 200 })
    expect(() => new AdaptiveWorkerBudget({ poseMaxFps: NaN, handMaxFps: 10 })).toThrow(RangeError)
  })

  it('reduces Pose rather than an unavailable Hand and preserves availability on reset', () => {
    const budget = create()
    budget.setHandAvailable(false)
    windowSamples(budget, 0, 120); windowSamples(budget, 2000, 120)
    expect(budget.snapshot()).toMatchObject({ handAvailable: false, handFps: 20, poseFps: 24 })
    budget.reset(5000)
    expect(budget.snapshot()).toMatchObject({ handAvailable: false, handFps: 20, poseFps: 30 })
    windowSamples(budget, 5000, 120); windowSamples(budget, 7000, 120)
    expect(budget.snapshot().poseFps).toBe(24)
    budget.setHandAvailable(true)
    windowSamples(budget, 9000, 120); windowSamples(budget, 11000, 120)
    expect(budget.snapshot()).toMatchObject({ handAvailable: true, handFps: 16, poseFps: 24 })
  })

  it('responds to repeated severe UI delays even when all Pose results are stale', () => {
    const budget = create()
    for (let start = 0; start < 4000; start += 2000) {
      budget.recordResult('pose', { timestamp: start + 1, receivedAt: start + 1000, inferenceMs: 800 })
      budget.recordUiDelay(start + 500, 120)
      budget.recordUiDelay(start + 1500, 120)
      budget.recordUiDelay(start + 2000, 120)
    }
    expect(budget.snapshot()).toMatchObject({ handFps: 16, poseFps: 30, poseInferenceMs: null })
    budget.reset(5000)
    expect(budget.snapshot()).toMatchObject({ handFps: 20, poseFps: 30 })
  })

  it('ignores isolated or sparse severe UI delays without worker results', () => {
    const budget = create()
    budget.recordUiDelay(2000, 200)
    budget.recordUiDelay(4000, 200)
    budget.recordUiDelay(6000, 200)
    expect(budget.snapshot()).toMatchObject({ handFps: 20, poseFps: 30 })
  })
})

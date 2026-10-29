import { describe, expect, it } from 'vitest'
import { LandmarkSmoother } from './landmarkSmoothing'

describe('LandmarkSmoother', () => {
  it('preserves out-of-frame observations and resets their filter state', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    const outside = { x: 0.5, y: 1.1, visibility: 1 }
    smoother.filter('pose', [{ x: .5, y: .9, visibility: 1 }], 0)
    expect(smoother.filter('pose', [outside], 40)).toEqual([outside])
    expect(smoother.filter('pose', [{ x: .5, y: .8, visibility: 1 }], 80)[0].y).toBe(.8)
  })

  it.each([
    { x: -.1, y: .5 }, { x: 1.1, y: .5 },
    { x: .5, y: -.1 }, { x: .5, y: 1.1 },
    { x: NaN, y: .5 }, { x: .5, y: Infinity },
  ])('does not retain filter history across invalid coordinates: %o', (invalid) => {
    const smoother = new LandmarkSmoother({ beta: 0 })
    smoother.filter('pose', [{ x: .2, y: .2 }], 0)
    expect(smoother.filter('pose', [invalid], 40)).toEqual([invalid])
    expect(smoother.filter('pose', [{ x: .8, y: .8 }], 80)).toEqual([{ x: .8, y: .8 }])
  })

  it('does not carry smoothing state across a landmark with invalid visibility', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    smoother.filter('pose', [{ x: 0, y: 0, visibility: 1 }], 0)
    smoother.filter('pose', [{ x: 1, y: 1, visibility: NaN }], 40)
    expect(smoother.filter('pose', [{ x: .5, y: .5, visibility: 1 }], 80)[0].x).toBe(.5)
  })
  it('resets only the Pose point with missing visibility and preserves the raw observation', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    const policy = { requireVisibility: true }
    smoother.filter('pose', [{ x: .2, y: .2, visibility: 1 }, { x: .2, y: .2, visibility: 1 }], 0, policy)
    const raw = [{ x: .8, y: .8 }, { x: .8, y: .8, visibility: 1 }]
    const display = smoother.filter('pose', raw, 40, policy)
    expect(raw[0]).toEqual({ x: .8, y: .8 })
    expect(display[0]).toEqual(raw[0])
    expect(display[1].x).toBeLessThan(.8)
    const next = smoother.filter('pose', [{ x: .5, y: .5, visibility: 1 }, { x: .9, y: .9, visibility: 1 }], 80, policy)
    expect(next[0].x).toBe(.5)
    expect(next[1].x).toBeLessThan(.9)
  })

  it('continues smoothing Hand or generic landmarks without visibility when permitted', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    smoother.filter('hand', [{ x: .2, y: .2 }], 0)
    expect(smoother.filter('hand', [{ x: .8, y: .8 }], 40)[0].x).toBeLessThan(.8)
  })
  it('smooths irregularly timed observations without changing raw landmarks', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    const first = [{ x: 0, y: 0, z: 0, visibility: 1 }]
    const second = [{ x: 1, y: 1, z: 1, visibility: 1 }]
    expect(smoother.filter('pose', first, 0)).toEqual(first)
    const result = smoother.filter('pose', second, 40)
    expect(result[0].x).toBeGreaterThan(0)
    expect(result[0].x).toBeLessThan(1)
    expect(result[0].z).toBeLessThan(1)
    expect(second).toEqual([{ x: 1, y: 1, z: 1, visibility: 1 }])
    expect(smoother.filter('pose', second, 150)[0].x).toBeGreaterThan(result[0].x)
  })

  it('tracks each identity and coordinate independently', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    smoother.filter('left', [{ x: 0, y: 1 }], 0)
    smoother.filter('right', [{ x: 1, y: 0 }], 0)
    const left = smoother.filter('left', [{ x: 1, y: 1 }], 30)[0]
    const right = smoother.filter('right', [{ x: 1, y: 0 }], 30)[0]
    expect(left.x).toBeLessThan(1)
    expect(left.y).toBe(1)
    expect(right).toEqual({ x: 1, y: 0 })
  })

  it('responds faster to rapid motion when beta is positive', () => {
    const slow = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    const adaptive = new LandmarkSmoother({ minCutoff: 1, beta: 3, dCutoff: 1 })
    slow.filter('pose', [{ x: 0, y: 0 }], 0)
    adaptive.filter('pose', [{ x: 0, y: 0 }], 0)
    expect(adaptive.filter('pose', [{ x: 1, y: 0 }], 50)[0].x)
      .toBeGreaterThan(slow.filter('pose', [{ x: 1, y: 0 }], 50)[0].x)
  })

  it('attenuates synthetic stationary jitter while following a controlled ramp', () => {
    // Synthetic signal only: this checks filter behavior, not clinical accuracy or video latency.
    const stationary = new LandmarkSmoother()
    let rawSquaredError = 0, filteredSquaredError = 0, count = 0
    for (let i = 0; i < 150; i++) {
      const x = .5 + .015 * Math.sin(i * Math.PI / 2)
      const filtered = stationary.filter('pose', [{ x, y: .5, visibility: 1 }], i * 1000 / 30)[0].x
      if (i > 30) {
        rawSquaredError += (x - .5) ** 2
        filteredSquaredError += (filtered - .5) ** 2
        count++
      }
    }
    expect(Math.sqrt(filteredSquaredError / count)).toBeLessThan(Math.sqrt(rawSquaredError / count) * .5)

    const movement = new LandmarkSmoother()
    let filtered = 0
    for (let i = 0; i <= 60; i++) {
      const x = i < 30 ? .2 : .2 + .6 * (i - 30) / 30
      filtered = movement.filter('pose', [{ x, y: .5, visibility: 1 }], i * 1000 / 30)[0].x
    }
    expect(.8 - filtered).toBeLessThan(.12)
    expect(filtered).toBeLessThan(.8)
  })

  it('does not synthesize a missing observation and resets after prolonged loss', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1, resetAfterMs: 500 })
    smoother.filter('pose', [{ x: 0, y: 0 }], 0)
    expect(smoother.filter('pose', [], 100)).toEqual([])
    expect(smoother.filter('pose', [{ x: 1, y: 1 }], 700)[0].x).toBe(1)
  })

  it('resets on seek, explicit reset and unreliable individual landmarks', () => {
    const smoother = new LandmarkSmoother({ minCutoff: 1, beta: 0, dCutoff: 1 })
    smoother.filter('pose', [{ x: 0, y: 0, visibility: 1 }], 100)
    expect(smoother.filter('pose', [{ x: 1, y: 1, visibility: 1 }], 50)[0].x).toBe(1)
    smoother.filter('pose', [{ x: 0, y: 0, visibility: 0 }], 60)
    expect(smoother.filter('pose', [{ x: 0.5, y: 0.5, visibility: 1 }], 70)[0].x).toBe(0.5)
    smoother.reset()
    expect(smoother.filter('pose', [{ x: 0, y: 0 }], 80)[0].x).toBe(0)
  })

  it('rejects invalid configuration and non-finite timestamps', () => {
    expect(() => new LandmarkSmoother({ minCutoff: Infinity })).toThrow(RangeError)
    expect(() => new LandmarkSmoother({ beta: -1 })).toThrow(RangeError)
    expect(() => new LandmarkSmoother().filter('pose', [{ x: 0, y: 0 }], NaN)).toThrow(RangeError)
  })
})

import { describe, expect, it } from 'vitest'
import { videoContentRect, mapVideoPoint } from './videoGeometry'

describe('video to overlay coordinates', () => {
  const source = { width: 1600, height: 900 }
  const square = { width: 1000, height: 1000 }

  it('maps a contained wide video inside the letterboxed box', () => {
    const rect = videoContentRect(source, square, 'contain')!
    expect(rect).toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 })
    expect(mapVideoPoint({ x: .2, y: .4 }, rect, square, false)).toEqual({ x: .2, y: .44375 })
    expect(mapVideoPoint({ x: .2, y: .4 }, rect, square, true)).toEqual({ x: .8, y: .44375 })
  })

  it('maps a covered wide video, including cropping and mirroring', () => {
    const rect = videoContentRect(source, square, 'cover')!
    expect(rect.x).toBeCloseTo(-388.888889)
    expect(rect.width).toBeCloseTo(1777.777778)
    expect(mapVideoPoint({ x: .25, y: .5 }, rect, square, false).x).toBeCloseTo(1 / 18)
    expect(mapVideoPoint({ x: .25, y: .5 }, rect, square, true).x).toBeCloseTo(17 / 18)
  })

  it('preserves normalized coordinates for fill, and recomputes on fullscreen resize', () => {
    const filled = videoContentRect(source, square, 'fill')!
    expect(mapVideoPoint({ x: .25, y: .75 }, filled, square, false)).toEqual({ x: .25, y: .75 })
    const screen = { width: 1600, height: 900 }
    const resized = videoContentRect(source, screen, 'contain')!
    expect(mapVideoPoint({ x: .25, y: .75 }, resized, screen, false)).toEqual({ x: .25, y: .75 })
  })

  it('withholds the mapping before metadata or layout is available', () => {
    expect(videoContentRect({ width: 0, height: 0 }, square, 'contain')).toBeNull()
    expect(videoContentRect(source, { width: 0, height: 0 }, 'contain')).toBeNull()
  })
})

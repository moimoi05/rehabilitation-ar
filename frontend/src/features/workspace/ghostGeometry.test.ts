import { describe, expect, it } from 'vitest'
import { anchorGhost, mapGhostAnchor, ghostFitsCalibration, toPersistedGhostAnchor, fromPersistedGhostAnchor } from './ghostGeometry'
import { videoContentRect } from './videoGeometry'

describe('Ghost registration against the visible video', () => {
  const source = { width: 1600, height: 900 }
  const box = { width: 800, height: 800 }
  const contain = { box, rect: videoContentRect(source, box, 'contain')! }
  const cover = { box, rect: videoContentRect(source, box, 'cover')! }
  const ghost = { x: .5, y: .3, scale: 1 }

  it('preserves the visible anchor and relative size when fit changes', () => {
    const anchor = anchorGhost(ghost, contain)
    const same = mapGhostAnchor(anchor, contain)
    expect(same.x).toBeCloseTo(ghost.x); expect(same.y).toBeCloseTo(ghost.y); expect(same.scale).toBeCloseTo(ghost.scale)
    const result = mapGhostAnchor(anchor, cover)
    expect(result.x).toBeCloseTo(.5)
    expect(result.y).toBeCloseTo(115.5555555556 / 800)
    expect(result.scale).toBeCloseTo(800 / 450)
  })

  it('round trips edits from the current display through a new source geometry', () => {
    const edited = { x: .65, y: .55, scale: .7 }
    const anchor = anchorGhost(edited, cover)
    const resizedBox = { width: 1600, height: 900 }
    const resized = { box: resizedBox, rect: videoContentRect(source, resizedBox, 'contain')! }
    const actual = mapGhostAnchor(anchor, resized)
    expect(anchorGhost(actual, resized).x).toBeCloseTo(anchor.x)
    expect(anchorGhost(actual, resized).y).toBeCloseTo(anchor.y)
    expect(anchorGhost(actual, resized).scale).toBeCloseTo(anchor.scale)
  })

  it('does not silently clamp values outside API calibration constraints', () => {
    const offscreen = mapGhostAnchor(anchorGhost({ x: .5, y: .1, scale: 2 }, contain), cover)
    expect(offscreen.y).toBeLessThan(0)
    expect(ghostFitsCalibration(offscreen)).toBe(false)
    expect(ghostFitsCalibration({ x: .5, y: .5, scale: 1 })).toBe(true)
    expect(ghostFitsCalibration({ x: .5, y: .5, scale: Number.NaN })).toBe(false)
  })

  it('persists image coordinates in the unmirrored source space and restores for either display orientation', () => {
    const anchor = { x: .2, y: .4, scale: 1.5 }
    expect(toPersistedGhostAnchor(anchor, true)).toEqual({ version: 1, x: .8, y: .4, scale: 1.5 })
    expect(fromPersistedGhostAnchor({ version: 1, x: .8, y: .4, scale: 1.5 }, true)?.x).toBeCloseTo(anchor.x)
    expect(fromPersistedGhostAnchor({ version: 1, x: .8, y: .4, scale: 1.5 }, false)).toEqual({ x: .8, y: .4, scale: 1.5 })
  })

  it('rejects unknown versions, invalid or cropped anchors without silently clamping', () => {
    expect(toPersistedGhostAnchor({ x: -.1, y: .5, scale: 1 }, false)).toBeNull()
    expect(toPersistedGhostAnchor({ x: .5, y: .5, scale: 16 }, false)).toBeNull()
    expect(fromPersistedGhostAnchor({ version: 2, x: .5, y: .5, scale: 1 }, false)).toBeNull()
    expect(fromPersistedGhostAnchor({ version: 1, x: Number.NaN, y: .5, scale: 1 }, false)).toBeNull()
  })
})

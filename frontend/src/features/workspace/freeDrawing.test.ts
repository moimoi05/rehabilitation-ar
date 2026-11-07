import { describe, expect, it } from 'vitest'
import type { Point } from './drawing'
import { DrawingController, hitTestStroke, type DrawingObservation } from './freeDrawing'
import { drawingViewport, mapDrawingPoint, redrawDrawing } from './freeDrawingRenderer'
import { indexThumbPinched } from './freeDrawingHand'

const mapping = { box: { width: 1000, height: 562.5 }, rect: { x: 0, y: 0, width: 1000, height: 562.5 } }
function hand(x = .35, pointing = false): Point[] {
  const points = Array.from({ length: 21 }, () => ({ x, y: .6, z: 0 }))
  points[0] = { x, y: .8, z: 0 }
  for (const base of [5, 9, 13, 17]) {
    const fingerX = x + (base - 9) * .004
    points[base] = { x: fingerX, y: .65, z: 0 }
    points[base + 1] = { x: fingerX, y: .55, z: 0 }
    points[base + 2] = { x: fingerX, y: .59, z: 0 }
    points[base + 3] = { x: fingerX, y: .66, z: 0 }
  }
  if (pointing) { points[7] = { x: points[5].x, y: .45, z: 0 }; points[8] = { x: points[5].x, y: .35, z: 0 } }
  return points
}
const observation = (timestamp: number, hands = [hand()], names = ['Left']): DrawingObservation => ({
  timestamp, frameId: timestamp, hands, handedness: names.map(categoryName => [{ categoryName, score: .98 }]),
})
const controller = (mode: 'assisted' | 'gesture' = 'assisted') => new DrawingController({ side: 'left', mode, cursorSource: 'index' })
function acquire(game: DrawingController, start = 100, hands = [hand()], names = ['Left']) {
  for (const t of [start, start + 33, start + 66]) game.update(observation(t, hands, names), t + 1, mapping, false)
}

describe('Free Drawing affected-hand input', () => {
  it('hides stale input and resumes a short gap only with a fresh pointing hand', () => {
    const game = controller('gesture')
    acquire(game, 100, [hand(.35, true)])
    game.update(observation(199, [hand(.36, true)]), 254, mapping, false)
    expect(game.phase).toBe('drawing')
    game.checkFreshness(350)
    expect(game.hand).toBeNull()
    expect(game.cursor).toBeNull()
    expect(game.strokes[0].endedAt).toBeNull()
    expect(game.strokes[0].points).toHaveLength(1)
    // No point is invented while waiting for a fresh observation.
    game.update(observation(309, [hand(.37, true)]), 364, mapping, false)
    expect(game.hand).not.toBeNull()
    expect(game.phase).toBe('drawing')
    expect(game.strokes).toHaveLength(1)
    expect(game.strokes[0].points).toHaveLength(2)
    // A long gap must still require acquisition and never transfer to another hand.
    game.update(observation(600, [hand(.37, true)]), 655, mapping, false)
    expect(game.hand).toBeNull()
    game.update(observation(710, [hand(.37, true)], ['Right']), 765, mapping, false)
    expect(game.hand).toBeNull()
  })
  it('bridges a brief missed detection only when the same hand remains pointing', () => {
    const game = controller('gesture')
    acquire(game, 100, [hand(.35, true)])
    game.update(observation(199, [hand(.36, true)]), 200, mapping, false)
    game.update(observation(260, [], []), 261, mapping, false)
    expect(game.cursor).toBeNull()
    expect(game.strokes[0].points).toHaveLength(1)
    game.update(observation(320, [hand(.37, true)]), 321, mapping, false)
    expect(game.strokes).toHaveLength(1)
    expect(game.strokes[0].points).toHaveLength(2)
  })
  it('ends the pending stroke on long absence, wrong hand or released gesture', () => {
    for (const input of [observation(300, [hand(.36, true)], ['Right']), observation(300, [hand(.36)]),
      observation(300, [hand(.7, true)]), observation(300, [hand(.36, true), hand(.7, true)], ['Left', 'Right'])]) {
      const game = controller('gesture')
      acquire(game, 100, [hand(.35, true)])
      game.update(observation(199, [hand(.36, true)]), 200, mapping, false)
      game.update(observation(250, [], []), 251, mapping, false)
      game.update(input, 301, mapping, false)
      expect(game.completedStrokeCount).toBe(1)
      expect(game.strokes[0].points).toHaveLength(1)
    }
    const game = controller('gesture')
    acquire(game, 100, [hand(.35, true)])
    game.update(observation(199, [hand(.36, true)]), 200, mapping, false)
    game.update(observation(250, [], []), 251, mapping, false)
    game.checkFreshness(500)
    expect(game.completedStrokeCount).toBe(1)
    expect(game.strokes[0].points).toHaveLength(1)
  })
  it('chooses the affected hand regardless of array order and CSS mirroring', () => {
    for (const side of ['left', 'right'] as const) for (const mirrored of [true, false]) {
      const game = new DrawingController({ side, mode: 'assisted', cursorSource: 'wrist' })
      const hands = [hand(.7), hand(.3)], names = ['Right', 'Left']
      for (const t of [100, 133, 166]) game.update(observation(t, hands, names), t + 1, mapping, mirrored)
      expect(game.phase).toBe('ready')
      expect(game.cursor?.x).toBeCloseTo((mirrored ? 1 - (side === 'left' ? .3 : .7) : side === 'left' ? .3 : .7) * 1000)
    }
  })
  it('does not draw with the healthy hand or duplicate/low-confidence handedness', () => {
    const game = controller()
    acquire(game, 100, [hand(.7)], ['Right'])
    game.setPenDown(true)
    expect(game.strokes).toHaveLength(0)
    acquire(game, 300, [hand(.3), hand(.7)], ['Left', 'Left'])
    expect(game.cursor).toBeNull()
    const weak = observation(500); weak.handedness[0][0].score = .4
    game.update(weak, 501, mapping, false)
    expect(game.phase).toBe('tracking_lost')
  })
  it('rejects a second affected-side label even when it has lower confidence', () => {
    const game = controller()
    const hands = [hand(.3), hand(.7)]
    for (const t of [100, 133, 166]) {
      const input = observation(t, hands, ['Left', 'Left'])
      input.handedness[1][0].score = .6
      game.update(input, t + 1, mapping, false)
    }
    expect(game.cursor).toBeNull()
  })
  it('rejects non-finite handedness confidence', () => {
    const game = controller()
    for (const t of [100, 133, 166]) {
      const input = observation(t)
      input.handedness[0][0].score = Number.NaN
      game.update(input, t + 1, mapping, false)
    }
    expect(game.cursor).toBeNull()
  })
  it('rejects crossing hands and a label swap onto the other hand', () => {
    const game = controller()
    acquire(game, 100, [hand(.3), hand(.7)], ['Left', 'Right'])
    game.setPenDown(true)
    game.update(observation(199, [hand(.31), hand(.7)], ['Left', 'Right']), 200, mapping, false)
    game.update(observation(232, [hand(.7), hand(.31)], ['Left', 'Right']), 233, mapping, false)
    expect(game.phase).toBe('tracking_lost')
    expect(game.penDown).toBe(false)
    acquire(game, 300, [hand(.5), hand(.51)], ['Left', 'Right'])
    expect(game.cursor).toBeNull()
  })
  it('forgets the old competing wrist only after a sustained absence and reacquires with pen up', () => {
    const game = controller()
    acquire(game, 100, [hand(.3), hand(.7)], ['Left', 'Right'])
    game.setPenDown(true)
    game.update(observation(199, [hand(.31), hand(.7)], ['Left', 'Right']), 200, mapping, false)
    game.update(observation(232, [], []), 233, mapping, false)
    acquire(game, 265, [hand(.7)])
    expect(game.hand).toBeNull()

    for (const t of [364, 464, 564, 664, 764]) game.update(observation(t, [], []), t + 1, mapping, false)
    for (const t of [797, 830]) {
      game.update(observation(t, [hand(.7)]), t + 1, mapping, false)
      expect(game.hand).toBeNull()
    }
    game.update(observation(863, [hand(.7)]), 864, mapping, false)
    expect(game.phase).toBe('ready')
    expect(game.penDown).toBe(false)
    expect(game.strokes).toHaveLength(1)
  })
  it('keeps a freshly acquired single hand through a nearby same-label confidence dip', () => {
    const game = controller()
    acquire(game); game.setPenDown(true)
    const input = observation(199, [hand(.36)])
    input.handedness[0][0].score = .6
    game.update(input, 200, mapping, false)
    expect(game.hand).toBe(input.hands[0])
    expect(game.phase).toBe('drawing')
    expect(game.strokes).toHaveLength(1)
  })
  it('never uses confidence continuity for an opposite label or a competing hand', () => {
    const game = controller()
    acquire(game)
    game.update(observation(199, [hand(.36)], ['Right']), 200, mapping, false)
    expect(game.hand).toBeNull()
    acquire(game, 300)
    const input = observation(399, [hand(.36), hand(.7)], ['Left', 'Right'])
    input.handedness[0][0].score = .6
    game.update(input, 400, mapping, false)
    expect(game.hand).toBeNull()
  })
  it('does not acquire with weak labels or extend confidence continuity indefinitely', () => {
    const game = controller()
    for (const t of [100, 133, 166]) {
      const input = observation(t); input.handedness[0][0].score = .6
      game.update(input, t + 1, mapping, false)
    }
    expect(game.hand).toBeNull()
    acquire(game, 200)
    for (const t of [299, 332, 365, 398]) {
      const input = observation(t); input.handedness[0][0].score = .6
      game.update(input, t + 1, mapping, false)
      expect(game.hand).not.toBeNull()
    }
    const expired = observation(431); expired.handedness[0][0].score = .6
    game.update(expired, 432, mapping, false)
    expect(game.hand).toBeNull()
    expect(game.diagnostics.reason).toBe('SIDE_AMBIGUOUS')
  })
})

describe('Free Drawing controller', () => {
  it('activates a held index gesture on initial acquisition without an open-hand transition', () => {
    const game = controller('gesture')
    acquire(game, 100, [hand(.35, true)])
    expect(game.phase).toBe('ready')
    game.update(observation(199, [hand(.35, true)]), 200, mapping, false)
    expect(game.phase).toBe('drawing')
    expect(game.strokes).toHaveLength(1)
    game.update(observation(232), 233, mapping, false)
    expect(game.phase).toBe('ready')
    expect(game.completedStrokeCount).toBe(1)
  })
  it('starts a separate stroke after prolonged hand loss while the index gesture remains held', () => {
    const game = controller('gesture')
    acquire(game, 100, [hand(.35, true)])
    game.update(observation(199, [hand(.35, true)]), 200, mapping, false)
    game.update(observation(232, [], []), 233, mapping, false)
    game.checkFreshness(500)
    expect(game.completedStrokeCount).toBe(1)
    expect(game.hand).toBeNull()
    acquire(game, 550, [hand(.4, true)])
    expect(game.strokes).toHaveLength(1)
    game.update(observation(649, [hand(.4, true)]), 650, mapping, false)
    expect(game.phase).toBe('drawing')
    expect(game.strokes).toHaveLength(2)
    expect(game.strokes[1].points).toHaveLength(1)
    expect(game.strokes[1].startedAt).toBe(649)
  })
  it('requires distinct fresh source frames to confirm the index gesture', () => {
    const game = controller('gesture')
    acquire(game, 100, [hand(.35, true)])
    const duplicate = { ...observation(199, [hand(.35, true)]), frameId: 166 }
    game.update(duplicate, 200, mapping, false)
    expect(game.strokes).toHaveLength(0)
    game.update(observation(232, [hand(.35, true)]), 233, mapping, false)
    expect(game.strokes).toHaveLength(1)
    expect(game.strokes[0].startedAt).toBe(232)
  })
  it('draws in assisted mode without finger posture and ignores repeated observations', () => {
    const game = controller()
    acquire(game)
    game.setPenDown(true)
    game.update(observation(199), 200, mapping, false)
    game.update(observation(232, [hand(.36)]), 233, mapping, false)
    game.update(observation(232, [hand(.9)]), 234, mapping, false)
    expect(game.strokes).toHaveLength(1)
    expect(game.strokes[0].points).toHaveLength(2)
    expect(game.phase).toBe('drawing')
  })
  it('ends on tracking loss and requires deliberate activation after stable reacquisition', () => {
    const game = controller()
    acquire(game)
    game.setPenDown(true)
    game.update(observation(199), 200, mapping, false)
    game.update(observation(232, [], []), 233, mapping, false)
    expect(game.completedStrokeCount).toBe(1)
    expect(game.penDown).toBe(false)
    acquire(game, 300)
    game.update(observation(399), 400, mapping, false)
    expect(game.strokes).toHaveLength(1)
    game.setPenDown(true)
    game.update(observation(432), 433, mapping, false)
    expect(game.strokes).toHaveLength(2)
  })
  it('lifts the pen when stale even without another callback', () => {
    const game = controller()
    acquire(game); game.setPenDown(true)
    game.update(observation(199), 200, mapping, false)
    game.checkFreshness(350)
    expect(game.phase).toBe('tracking_lost')
    expect(game.completedStrokeCount).toBe(1)
  })
  it('keeps a valid selected skeleton outside the artwork while lifting the pen', () => {
    const game = controller()
    const covered = { ...mapping, rect: { x: -250, y: 0, width: 1500, height: 562.5 } }
    for (const t of [100, 133, 166]) game.update(observation(t), t + 1, covered, false)
    game.setPenDown(true)
    game.update(observation(199), 200, covered, false)
    const outside = observation(232, [hand(.1)])
    const update = game.update(outside, 233, covered, false)
    expect(update.hand).toBe(outside.hands[0])
    expect(update.cursor).toBeNull()
    expect(game.penDown).toBe(false)
    expect(game.completedStrokeCount).toBe(1)
    expect(game.diagnostics.reason).toBe('CURSOR_OUTSIDE_BOARD')
    game.update(observation(265), 266, covered, false)
    expect(game.hand).not.toBeNull()
    expect(game.strokes).toHaveLength(1)
  })
  it('splits a cursor jump without hiding the current valid skeleton or bridging the jump', () => {
    const game = controller()
    acquire(game); game.setPenDown(true)
    game.update(observation(199), 200, mapping, false)
    const moved = hand(); moved[8] = { ...moved[8], x: .85 }
    const update = game.update(observation(232, [moved]), 233, mapping, false)
    expect(update.hand).toBe(moved)
    expect(update.cursor).not.toBeNull()
    expect(update.segment).toBeNull()
    expect(game.phase).toBe('ready')
    expect(game.penDown).toBe(false)
    expect(game.completedStrokeCount).toBe(1)
    expect(game.diagnostics.reason).toBe('CURSOR_JUMP')
    game.update(observation(265, [moved]), 266, mapping, false)
    expect(game.strokes).toHaveLength(1)
  })
  it('distinguishes tracking rejection, acquisition, gesture inactivity and suspension', () => {
    const game = controller('gesture')
    game.update(observation(100, [], []), 101, mapping, false)
    expect(game.diagnostics.reason).toBe('RAW_HAND_MISSING')
    game.update(observation(133, [[{ x: .3, y: .5 }]]), 134, mapping, false)
    expect(game.diagnostics.reason).toBe('HAND_INVALID')
    game.update(observation(166, [hand()], ['Right']), 167, mapping, false)
    expect(game.diagnostics.reason).toBe('SIDE_AMBIGUOUS')
    game.update(observation(199), 200, mapping, false)
    expect(game.diagnostics.reason).toBe('ACQUIRING')
    game.update(observation(232), 233, mapping, false)
    game.update(observation(265), 266, mapping, false)
    expect(game.diagnostics).toMatchObject({ selected: true, reason: 'GESTURE_INACTIVE', gestureActive: false, penDown: false })
    game.checkFreshness(416)
    expect(game.diagnostics.reason).toBe('STALE_HAND')
    game.suspend()
    expect(game.diagnostics.reason).toBe('DRAWING_PAUSED')
  })
  it('reacquires a relocated affected hand stably without resuming the previous pen state', () => {
    const game = controller()
    acquire(game, 100, [hand(.25)])
    game.setPenDown(true); game.update(observation(199, [hand(.25)]), 200, mapping, false)
    game.update(observation(232, [], []), 233, mapping, false)
    acquire(game, 300, [hand(.65)])
    expect(game.phase).toBe('ready')
    expect(game.penDown).toBe(false)
    expect(game.strokes).toHaveLength(1)
    game.setPenDown(true); game.update(observation(399, [hand(.65)]), 400, mapping, false)
    expect(game.strokes).toHaveLength(2)
    expect(game.strokes[1].points).toHaveLength(1)
  })
  it('starts a fresh stable pointing gesture without opening the hand after a gap', () => {
    const game = controller('gesture')
    acquire(game)
    game.update(observation(199, [hand(.35, true)]), 200, mapping, false)
    expect(game.strokes).toHaveLength(0)
    game.update(observation(232, [hand(.36, true)]), 233, mapping, false)
    expect(game.phase).toBe('drawing')
    game.update(observation(265), 266, mapping, false)
    expect(game.phase).toBe('ready')
    game.update(observation(298, [hand(.35, true)]), 299, mapping, false)
    game.update(observation(331, [hand(.36, true)]), 332, mapping, false)
    expect(game.strokes).toHaveLength(2)
    game.checkFreshness(650)
    acquire(game, 700, [hand(.36, true)])
    expect(game.phase).toBe('ready')
    expect(game.strokes).toHaveLength(2)
    game.update(observation(799, [hand(.36, true)]), 800, mapping, false)
    expect(game.strokes).toHaveLength(3)
    expect(game.strokes[2].points).toHaveLength(1)
  })
  it('splits on timestamp gaps, jumps and geometry changes without phantom segments', () => {
    const game = controller()
    acquire(game); game.setPenDown(true)
    game.update(observation(199), 200, mapping, false)
    game.update(observation(399, [hand(.36)]), 400, mapping, false)
    expect(game.phase).toBe('tracking_lost')
    acquire(game, 450); game.setPenDown(true)
    game.update(observation(549), 550, mapping, false)
    game.update(observation(582, [hand(.9)]), 583, mapping, false)
    expect(game.phase).toBe('tracking_lost')
    acquire(game, 650); game.setPenDown(true)
    game.update(observation(749), 750, mapping, false)
    game.update(observation(782), 783, { ...mapping, box: { width: 900, height: 600 } }, false)
    expect(game.penDown).toBe(false)
  })
  it('undoes strokes, clears, resets and refuses input after finish', () => {
    const game = controller()
    acquire(game); game.setPenDown(true)
    game.update(observation(199), 200, mapping, false)
    game.setPenDown(false)
    expect(game.completedStrokeCount).toBe(1)
    game.undo()
    expect(game.strokes).toHaveLength(0)
    game.setPenDown(true); game.update(observation(232), 233, mapping, false)
    game.clear()
    expect(game.strokes).toHaveLength(0)
    game.finish()
    game.setPenDown(true); game.update(observation(265), 266, mapping, false)
    expect(game.phase).toBe('finished')
    expect(game.strokes).toHaveLength(0)
    game.reset()
    expect(game.phase).toBe('tracking_lost')
  })
  it('confirms pointing again after undo or clear without an open-hand reset', () => {
    const game = controller('gesture')
    acquire(game)
    for (const t of [199, 232]) game.update(observation(t, [hand(.35, true)]), t + 1, mapping, false)
    game.undo()
    game.update(observation(265, [hand(.35, true)]), 266, mapping, false)
    expect(game.strokes).toHaveLength(0)
    game.update(observation(298, [hand(.35, true)]), 299, mapping, false)
    expect(game.strokes).toHaveLength(1)
    game.clear()
    game.update(observation(364, [hand(.35, true)]), 365, mapping, false)
    expect(game.strokes).toHaveLength(0)
    game.update(observation(397, [hand(.35, true)]), 398, mapping, false)
    expect(game.strokes).toHaveLength(1)
  })
})

function pinchHand(x = .35, y = .35): Point[] {
  const points = hand(x + .016, true).map(point => ({ ...point, y: point.y + y - .35 }))
  return points.map((point, index) => index === 4 ? { ...points[8], x: points[8].x + .006 } : point)
}

describe('Free Drawing selection and assisted move', () => {
  function seeded() {
    const game = controller()
    game.updatePointer({ x: 300, y: 200 }, 10, true)
    game.updatePointer({ x: 350, y: 200 }, 30, true)
    game.updatePointer({ x: 350, y: 200 }, 50, false)
    game.updatePointer({ x: 600, y: 300 }, 70, true)
    game.updatePointer({ x: 650, y: 300 }, 90, true)
    game.updatePointer({ x: 650, y: 300 }, 110, false)
    game.configure({ interactionMode: 'move' })
    return game
  }
  function point(game: DrawingController, x: number, y: number, at: number) {
    return game.updatePointer({ x, y }, at, false)
  }

  it('allows a stationary demo pointer to grab with a button and move after a human-sized delay', () => {
    const game = seeded()
    point(game, 320, 200, 140)
    expect(game.grabStroke(2000)).toBe(true)
    point(game, 380, 230, 2400)
    expect(game.phase).toBe('dragging')
    expect(game.strokes[0].offset).toEqual({ x: 60, y: 30 })
    game.releaseStroke()
    expect(game.completedStrokeCount).toBe(2)
    game.undo()
    expect(game.strokes[0].offset).toEqual({ x: 0, y: 0 })
  })

  it('uses the closest polyline and touch tolerance in display pixels', () => {
    const game = seeded(), first = game.strokes[0], second = { ...first, id: 9, offset: { x: 0, y: 12 } }
    expect(hitTestStroke([first, second], { x: 320, y: 209 }, 18, 1)?.id).toBe(9)
    expect(hitTestStroke([first], { x: 320, y: 225 }, 18, 1)).toBeNull()
    expect(hitTestStroke([first], { x: 320, y: 225 }, 18, .5)?.id).toBe(first.id)
  })

  it('selects, grabs and releases one stroke without adding ink, then undoes the move', () => {
    const game = seeded(), before = structuredClone(game.strokes)
    point(game, 320, 200, 140)
    expect(game.selectedStrokeId).toBe(before[0].id)
    expect(game.grabStroke(141)).toBe(true)
    expect(game.phase).toBe('dragging')
    const update = point(game, 420, 250, 170)
    expect(update.artworkChanged).toBe(true)
    expect(update.segment).toBeNull()
    expect(game.strokes[0].offset).toEqual({ x: 100, y: 50 })
    expect(game.strokes[0].points).toEqual(before[0].points)
    expect(game.strokes[1]).toEqual(before[1])
    expect(game.completedStrokeCount).toBe(2)
    game.releaseStroke()
    expect(game.grabbedStrokeIds).toEqual([])
    expect(game.strokes[0].offset).toEqual({ x: 100, y: 50 })
    game.undo()
    expect(game.strokes).toEqual(before)
    game.undo()
    expect(game.completedStrokeCount).toBe(1)
  })

  it('keeps the last safe offset on tracking loss and requires a new fresh grab', () => {
    const game = seeded()
    point(game, 320, 200, 140); game.grabStroke(141)
    point(game, 420, 250, 170)
    game.checkFreshness(321)
    expect(game.phase).toBe('tracking_lost')
    expect(game.draggingInterrupted).toBe(true)
    expect(game.grabbedStrokeIds).toEqual([])
    expect(game.grabStroke(322)).toBe(false)
    const safe = structuredClone(game.strokes)
    point(game, 900, 500, 350)
    expect(game.strokes).toEqual(safe)
    expect(game.grabbedStrokeIds).toEqual([])
    game.undo()
    expect(game.strokes[0].offset).toEqual({ x: 0, y: 0 })
  })

  it('moves with fresh affected-hand observations and interrupts before wrong-hand input can move ink', () => {
    const game = seeded()
    const cursorHand = (x: number, y = 200 / 562.5) => hand(.35).map((point, index) => index === 8 ? { ...point, x, y } : point)
    acquire(game, 200, [cursorHand(.32)])
    expect(game.selectedStrokeId).toBe(game.strokes[0].id)
    expect(game.grabStroke(267)).toBe(true)
    game.update(observation(299, [cursorHand(.42)]), 300, mapping, false)
    expect(game.strokes[0].offset?.x).toBeCloseTo(100)
    const safe = structuredClone(game.strokes)
    game.update(observation(332, [cursorHand(.5)], ['Right']), 333, mapping, false)
    expect(game.draggingInterrupted).toBe(true)
    expect(game.strokes).toEqual(safe)
    expect(game.hand).toBeNull()
    acquire(game, 400, [cursorHand(.42)])
    expect(game.grabbedStrokeIds).toEqual([])
    expect(game.strokes).toEqual(safe)
    expect(game.grabStroke(467)).toBe(true)
    game.update(observation(499, [cursorHand(.47)]), 500, mapping, false)
    game.releaseStroke()
    expect(game.strokes[0].offset?.x).toBeCloseTo(150)
    game.undo()
    expect(game.strokes[0].offset?.x).toBeCloseTo(100)
  })

  it('moves in the mirrored visual direction exactly once', () => {
    const game = seeded()
    const cursorHand = (x: number) => hand(.35).map((point, index) => index === 8 ? { ...point, x, y: 200 / 562.5 } : point)
    for (const t of [200, 233, 266]) game.update(observation(t, [cursorHand(.68)]), t + 1, mapping, true)
    expect(game.cursor?.x).toBeCloseTo(320)
    expect(game.grabStroke(267)).toBe(true)
    game.update(observation(299, [cursorHand(.58)]), 300, mapping, true)
    expect(game.cursor?.x).toBeCloseTo(420)
    expect(game.strokes[0].offset?.x).toBeCloseTo(100)
    game.releaseStroke()
    expect(game.completedStrokeCount).toBe(2)
  })

  it('stops a sudden drag jump and never silently switches to another hand', () => {
    const game = seeded()
    point(game, 320, 200, 140); game.grabStroke(141)
    const safe = structuredClone(game.strokes)
    point(game, 900, 500, 170)
    expect(game.draggingInterrupted).toBe(true)
    expect(game.strokes).toEqual(safe)
    game.update(observation(200, [hand(.7)], ['Right']), 201, mapping, false)
    expect(game.hand).toBeNull()
    expect(game.grabbedStrokeIds).toEqual([])
  })

  it('does not grab or draw after finish and can draw again only after reset', () => {
    const game = seeded()
    point(game, 320, 200, 140)
    game.finish()
    expect(game.grabStroke(141)).toBe(false)
    point(game, 420, 250, 170)
    expect(game.diagnostics.reason).toBe('EXERCISE_FINISHED')
    expect(game.completedStrokeCount).toBe(2)
    game.reset(); game.configure({ interactionMode: 'draw' })
    acquire(game, 300, [hand(.35, true)])
    game.setPenDown(true)
    game.update(observation(399, [hand(.35, true)]), 400, mapping, false)
    expect(game.strokes).toHaveLength(1)
  })

  it('never intercepts ordinary drawing with a pinch', () => {
    const game = controller('gesture')
    acquire(game, 100, [pinchHand()])
    for (const timestamp of [199, 232]) game.update(observation(timestamp, [pinchHand()]), timestamp + 1, mapping, false)
    expect(indexThumbPinched(pinchHand())).toBe(true)
    expect(game.phase).toBe('drawing')
    expect(game.grabbedStrokeIds).toEqual([])
  })

  it('renders transformed geometry through the same path used for PNG export', () => {
    const game = seeded()
    point(game, 320, 200, 140); game.grabStroke(141)
    point(game, 420, 250, 170); game.releaseStroke()
    const positions: number[][] = []
    const ctx = { clearRect() {}, save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, stroke() {}, fill() {},
      moveTo(x: number, y: number) { positions.push([x, y]) }, lineTo(x: number, y: number) { positions.push([x, y]) },
      arc(x: number, y: number) { positions.push([x, y]) } } as unknown as CanvasRenderingContext2D
    redrawDrawing(ctx, game.strokes, game.logicalSize, mapping.box)
    expect(positions).toContainEqual([400, 250])
    expect(positions).toContainEqual([600, 300])
  })
})

describe('Free Drawing geometry', () => {
  it('reuses contain/cover mapping and mirrors exactly once', () => {
    const contain = { box: { width: 1000, height: 800 }, rect: { x: 0, y: 118.75, width: 1000, height: 562.5 } }
    expect(mapDrawingPoint({ x: .2, y: .5 }, contain, true, { width: 1000, height: 562.5 })).toEqual({ x: 800, y: 281.25 })
    const cover = { box: { width: 1000, height: 562.5 }, rect: { x: -250, y: 0, width: 1500, height: 562.5 } }
    expect(mapDrawingPoint({ x: .5, y: .5 }, cover, false, { width: 1000, height: 562.5 })).toEqual({ x: 500, y: 281.25 })
    expect(mapDrawingPoint({ x: 0, y: .5 }, cover, false, { width: 1000, height: 562.5 })).toBeNull()
  })
  it('preserves the logical board aspect ratio through resizing', () => {
    expect(drawingViewport({ width: 1000, height: 562.5 }, { width: 800, height: 800 })).toEqual({ x: 0, y: 175, width: 800, height: 450 })
  })
})

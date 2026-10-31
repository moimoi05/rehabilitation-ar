import { describe, expect, it } from 'vitest'
import { initialRound, stepRound, wristForSide, displayPoint } from './flowerGame'

describe('Chạm hoa phát sáng', () => {
  it('honors the prescribed Flower variant duration without changing the default round', () => {
    const round = { ...initialRound(), elapsedMs: 29900 }
    const ongoing = stepRound(round, { x: .5, y: .9 }, 100, 1280, 720, undefined, 45000)
    expect(ongoing.finished).toBe(false)
    expect(ongoing.elapsedMs).toBe(30000)
    const finished = stepRound({ ...ongoing, elapsedMs: 44900 }, { x: .5, y: .9 }, 100, 1280, 720, undefined, 45000)
    expect(finished.finished).toBe(true)
    expect(finished.elapsedMs).toBe(45000)
  })
  it('maps the affected wrist and mirrors its displayed coordinate', () => {
    const pose = Array.from({ length: 17 }, () => ({ x: .1, y: .2, visibility: 0 }))
    pose[15] = { x: .2, y: .5, visibility: .9 }
    pose[16] = { x: .7, y: .4, visibility: .2 }
    expect(displayPoint(wristForSide(pose, 'left'), true)).toEqual({ x: .8, y: .5 })
    expect(wristForSide(pose, 'right')).toBeNull()
  })
  it('does not use a wrist with non-finite visibility for game scoring', () => {
    const pose = Array.from({ length: 17 }, () => ({ x: .5, y: .5, visibility: 1 }))
    pose[15] = { x: .35, y: .5, visibility: NaN }
    expect(wristForSide(pose, 'left')).toBeNull()
  })
  it('does not use a wrist whose visibility is missing', () => {
    const pose = Array.from({ length: 17 }, () => ({ x: .35, y: .5 }))
    expect(wristForSide(pose, 'left')).toBeNull()
  })
  it('maps game input through the same cropped image and rejects offscreen wrists', () => {
    const mapping = { box: { width: 1000, height: 1000 }, rect: { x: -388.8888888889, y: 0, width: 1777.7777777778, height: 1000 } }
    expect(displayPoint({ x: .5, y: .5 }, true, mapping)?.x).toBeCloseTo(.5)
    expect(displayPoint({ x: 0, y: .5 }, false, mapping)).toBeNull()
  })
  it('places game targets inside a narrow visible video region', () => {
    const region = { x: 0, y: .45, width: 1, height: .1 }
    const round = initialRound(region)
    expect(round.target.y).toBeGreaterThanOrEqual(.45)
    expect(round.target.y).toBeLessThanOrEqual(.55)
    const hit = stepRound(round, round.target, 100, 1000, 1000, region)
    expect(hit.score).toBe(1)
    expect(hit.target.y).toBeGreaterThanOrEqual(.45)
    expect(hit.target.y).toBeLessThanOrEqual(.55)
  })
  it('counts hits in pixel space and requires release', () => {
    const round = initialRound()
    const hit = stepRound(round, round.target, 100, 1280, 720)
    expect(hit.score).toBe(1)
    expect(hit.targetCount).toBe(2)
    const stationary = stepRound(hit, round.target, 100, 1280, 720)
    expect(stationary.score).toBe(1)
    const released = stepRound(stationary, { x: .5, y: .9 }, 100, 1280, 720)
    const second = stepRound(released, released.target, 100, 1280, 720)
    expect(second.score).toBe(2)
  })
  it('pauses when the wrist is unavailable and ends after 30 active seconds', () => {
    const round = initialRound()
    const lost = stepRound(round, null, 2000, 1280, 720)
    expect(lost.elapsedMs).toBe(0)
    expect(lost.score).toBe(0)
    const finished = stepRound({ ...round, elapsedMs: 29900 }, { x: .5, y: .9 }, 100, 1280, 720)
    expect(finished.finished).toBe(true)
    expect(finished.elapsedMs).toBe(30000)
  })
  it('does not present or count a new flower after time has expired', () => {
    const round = { ...initialRound(), elapsedMs: 29900 }
    const finished = stepRound(round, round.target, 100, 1280, 720)
    expect(finished.finished).toBe(true)
    expect(finished.score).toBe(0)
    expect(finished.targetCount).toBe(1)
  })
})

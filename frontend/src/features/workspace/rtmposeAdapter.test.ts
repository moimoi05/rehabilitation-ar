import { describe, expect, it } from 'vitest'
import { adaptRTMPoseWholeBody, createRtmposeCropTransform } from './rtmposeAdapter'
import { wristForSide } from './flowerGame'
import { validHand } from './handObservation'
import { BenchmarkQuality, validPose, validHand as benchmarkValidHand } from './benchmarkQuality'
const raw = () => Array.from({ length: 133 }, () => ({ x: 96, y: 128, score: .9 }))
const options = { imageWidth: 1000, imageHeight: 1000, inputWidth: 192, inputHeight: 256, roi: { x: .2, y: .1, width: .6, height: .8 } }
describe('RTMPose adapter', () => {
  it('maps verified ordering, confidence and sparse body without fabricated depth', () => {
    const points = raw(); points[5] = { x: 48, y: 64, score: .8 }; points[112] = { x: 144, y: 128, score: .7 }
    const result = adaptRTMPoseWholeBody(points, options)
    expect(result.pose[11]).toMatchObject({ x: .3125, y: .25, confidence: .8, valid: true })
    expect(result.pose[11]).not.toHaveProperty('z'); expect(result.pose[11]).not.toHaveProperty('visibility')
    expect(result.pose[1]).toBeUndefined(); expect(result.poseWorld).toBeNull()
    expect(result.hands.map(hand => hand.length)).toEqual([21, 21])
    expect(result.hands[1][0].x).toBeCloseTo(.6875)
    expect(result.handedness.map(side => side[0].categoryName)).toEqual(['Left', 'Right'])
    expect(wristForSide(result.pose, 'left')).toEqual({ x: .5, y: .5 })
    expect(adaptRTMPoseWholeBody(points, { ...options, mirrored: true })).toEqual(result)
  })
  it('inverts aspect padding and rejects points beyond confirmed ROI', () => {
    const roi = { x: .25, y: .25, width: .5, height: .5 }
    expect(createRtmposeCropTransform({ ...options, roi }).height).toBeCloseTo(500 * 256 / 192 * 1.25)
    const points = raw(); points[9] = { x: 96, y: 0, score: .9 }
    const result = adaptRTMPoseWholeBody(points, { ...options, roi })
    expect(result.pose[15].invalidReason).toBe('outside_roi')
    expect(wristForSide(result.pose, 'left')).toBeNull()
  })
  it('preserves invalid raw observations but excludes them from game input', () => {
    const points = raw(); points[9].score = .1; points[91].x = NaN
    const result = adaptRTMPoseWholeBody(points, options)
    expect(result.pose[15].confidence).toBe(.1); expect(wristForSide(result.pose, 'left')).toBeNull()
    expect(result.hands[0][0].valid).toBe(false); expect(validHand(result.hands[0])).toBe(false); expect(result.rawKeypoints[91].x).toBeNaN()
  })
  it('uses actual padded affine and supports unbounded SimCC confidence', () => {
    const points = raw(); points[5] = { x: 48, y: 128, score: 2.5 }
    const result = adaptRTMPoseWholeBody(points, { ...options, crop: { x: 125, y: 0, width: 750, height: 1000 } })
    expect(result.pose[11]).toMatchObject({ x: .3125, y: .5, confidence: 2.5, valid: true })
    points[5].x = -1
    expect(adaptRTMPoseWholeBody(points, { ...options, crop: { x: 400, y: 400, width: 100, height: 100 } }).pose[11].invalidReason).toBe('outside_model_input')
  })
  it('rejects invalid ROI, dimensions and keypoint count', () => {
    expect(() => adaptRTMPoseWholeBody(raw(), { ...options, roi: { x: .8, y: 0, width: .5, height: 1 } })).toThrow()
    expect(() => adaptRTMPoseWholeBody(raw(), { ...options, imageWidth: 0 })).toThrow()
    expect(() => adaptRTMPoseWholeBody(raw().slice(1), options)).toThrow()
  })
  it('benchmarks sparse 2D poses and rejects invalid hand confidence without smoothing them', () => {
    const points = raw(), quality = new BenchmarkQuality()
    const result = adaptRTMPoseWholeBody(points, options)
    expect(validPose(result.pose)).toBe(true)
    expect(quality.filter('pose', result.pose, 100, 'standard')).toEqual(result.pose)
    expect(quality.summary().filters.raw.samples).toBe(9)
    expect(quality.summary().filters.standard.samples).toBe(0)
    points[91].score = .1
    expect(benchmarkValidHand(adaptRTMPoseWholeBody(points, options).hands[0])).toBe(false)
  })
})

import type { Category, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { describe, expect, it } from 'vitest'
import { landmarkRows } from './captureLandmarks'

const point = (x: number, y: number, z: number, visibility = 0.8): NormalizedLandmark => ({ x, y, z, visibility })
const handCategory = (categoryName: string): Category => ({ index: 0, score: 0.93, categoryName, displayName: '' })

describe('capture landmark serialization', () => {
  it('keeps raw and display pose coordinates separate with anatomical names and supplied visibility', () => {
    const raw = Array.from({ length: 33 }, (_, index) => point(index / 100, 0.25, -0.1, 0.7))
    const display = raw.map((value, index) => index === 15 ? { ...value, x: 0.2 } : value)
    const original = raw.map(value => ({ ...value }))
    const rawRows = landmarkRows(raw, 'pose', 'normalized_image')
    const displayRows = landmarkRows(display, 'pose', 'normalized_image', 'display')

    expect(rawRows).toHaveLength(33)
    expect(rawRows[11]).toMatchObject({ landmark_name: 'left_shoulder', landmark_index: 11, representation: 'raw', visibility: 0.7 })
    expect(rawRows[13].landmark_name).toBe('left_elbow')
    expect(rawRows[15]).toMatchObject({ landmark_name: 'left_wrist', x: 0.15, y: 0.25, z: -0.1, is_valid: true })
    expect(displayRows[15]).toMatchObject({ landmark_name: 'left_wrist', x: 0.2, representation: 'display' })
    expect(raw).toEqual(original)
    expect(rawRows[15]).not.toHaveProperty('presence')
    expect(rawRows[15]).not.toHaveProperty('confidence')
  })

  it('preserves hand landmark indexes, coordinates, and model-supplied handedness in both spaces', () => {
    const points = Array.from({ length: 21 }, (_, index) => point(index / 100, 0.5, -0.01))
    const image = landmarkRows(points, 'hand', 'normalized_image', 'raw', [handCategory('Left')])
    const world = landmarkRows([point(-2, 4, 0.3)], 'hand', 'world', 'raw', [handCategory('Right')])

    expect(image).toHaveLength(21)
    expect(image[0]).toMatchObject({ landmark_name: 'wrist', handedness: 'Left', coordinate_space: 'normalized_image' })
    expect(image[20]).toMatchObject({ landmark_index: 20, landmark_name: 'pinky_tip', handedness: 'Left' })
    expect(world[0]).toMatchObject({ x: -2, y: 4, z: 0.3, coordinate_space: 'world', handedness: 'Right', is_valid: true })
    expect(landmarkRows([points[0]], 'hand', 'normalized_image')[0]).not.toHaveProperty('handedness')
    expect(landmarkRows([points[0]], 'hand', 'normalized_image', 'raw', [handCategory('')])[0]).not.toHaveProperty('handedness')
  })

  it('retains out-of-image and missing or non-finite coordinates with explicit validity reasons', () => {
    const missingZ = { x: 0.1, y: 0.2, visibility: 0.5 } as NormalizedLandmark
    const rows = landmarkRows([point(1.2, -0.1, -0.2), point(Number.NaN, 0.3, Number.POSITIVE_INFINITY), missingZ], 'pose', 'normalized_image')

    expect(rows[0]).toMatchObject({ x: 1.2, y: -0.1, z: -0.2, is_valid: false, invalid_reason: 'outside_image' })
    expect(rows[1]).toMatchObject({ x: null, y: 0.3, z: null, is_valid: false, invalid_reason: 'non_finite' })
    expect(rows[2]).toMatchObject({ x: 0.1, y: 0.2, z: null, is_valid: false, invalid_reason: 'non_finite' })
  })

  it('includes presence only when supplied and finite, and handles extra landmark indexes', () => {
    const withPresence = { ...point(0, 1, 0, Number.NaN), presence: 0.6 }
    const withoutFinitePresence = { ...point(0, 0, 0), presence: Number.NaN }
    const extended = Array.from({ length: 34 }, () => point(0.5, 0.5, 0))

    const [first, second] = landmarkRows([withPresence, withoutFinitePresence], 'pose', 'normalized_image')
    expect(first).toMatchObject({ presence: 0.6, is_valid: true })
    expect(first).not.toHaveProperty('visibility')
    expect(second).not.toHaveProperty('presence')
    expect(landmarkRows(extended, 'pose', 'world')[33].landmark_name).toBe('landmark_33')
    expect(landmarkRows([], 'hand', 'world')).toEqual([])
  })

  it('preserves handedness probability and an observation-local hand index without inventing tracking identity', () => {
    const rows = landmarkRows([point(0.2, 0.3, -0.1)], 'hand', 'normalized_image', 'raw', [handCategory('Left')], 1)
    expect(rows[0]).toMatchObject({ handedness: 'Left', handedness_score: 0.93, hand_observation_index: 1 })
    expect(rows[0]).not.toHaveProperty('hand_tracking_id')
  })
})

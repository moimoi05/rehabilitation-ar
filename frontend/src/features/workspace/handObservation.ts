import type { Point } from './drawing'
import { usableTrackingPoint } from './trackingLandmark'

export type HandFreshness = { left: number; right: number }
export const validHand = (points: Point[]) => points.length === 21 && Array.from(points).every(point => usableTrackingPoint(point, true))

/** Only this observation establishes freshness. A missing side is cleared rather
 * than inheriting the other hand's timestamp. Coordinates and categories stay raw.
 */
export function handFreshness(hands: Point[][], handedness: { categoryName: string }[][], timestamp: number): HandFreshness {
  return hands.reduce<HandFreshness>((state, points, index) => {
    if (!validHand(points)) return state
    const name = handedness[index]?.[0]?.categoryName
    return name === 'Left' ? { ...state, left: timestamp } : name === 'Right' ? { ...state, right: timestamp } : state
  }, { left: 0, right: 0 })
}

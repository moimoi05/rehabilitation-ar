import type { Point, Side } from './drawing'
import { validHand } from './handObservation'

export type DrawingObservation = {
  timestamp: number
  frameId?: number
  hands: Point[][]
  handedness: { categoryName: string; score: number }[][]
}
export type HandSelectionReason = 'RAW_HAND_MISSING' | 'HAND_INVALID' | 'SIDE_AMBIGUOUS' | 'ACQUIRING'
export const DRAWING_POLICY = Object.freeze({
  maxAgeMs: 150, continuityGraceMs: 300, handednessScore: .75, acquisitionFrames: 3, acquisitionMs: 50,
  handJump: .25, cursorJump: .23, gestureFrames: 2, maxStrokes: 500, maxPoints: 60000,
  pinchCloseRatio: .28, pinchReleaseRatio: .45,
})
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Tasks Vision labels describe the subject's hand on our unmirrored input.
 * CSS mirroring changes only coordinates, never anatomical handedness.
 */
export class AffectedHandSelector {
  rejectionReason: HandSelectionReason | null = 'ACQUIRING'
  private wrist: Point | null = null
  private others: Point[] = []
  private stableFrames = 0
  private stableSince = 0
  private relocation: { wrist: Point; since: number; frames: number } | null = null
  private lastSelectedAt = 0
  private lastConfidentAt = 0
  constructor(private readonly side: Side) {}

  lose(reason: HandSelectionReason = 'ACQUIRING') {
    this.stableFrames = 0; this.stableSince = 0; this.relocation = null
    this.lastSelectedAt = 0; this.lastConfidentAt = 0; this.rejectionReason = reason
  }
  reset() { this.lose(); this.wrist = null; this.others = [] }

  /** Resume only a previously selected, nearby single hand with a confident matching label. */
  matchesPrevious(observation: DrawingObservation): boolean {
    if (!this.wrist || observation.hands.length !== 1 || !validHand(observation.hands[0])) return false
    const label = observation.handedness[0]?.[0]
    return label?.categoryName === (this.side === 'left' ? 'Left' : 'Right') &&
      Number.isFinite(label.score) && label.score >= DRAWING_POLICY.handednessScore &&
      distance(observation.hands[0][0], this.wrist) <= .08
  }

  select(observation: DrawingObservation): Point[] | null {
    this.rejectionReason = 'ACQUIRING'
    if (!observation.hands.length) { this.lose('RAW_HAND_MISSING'); return null }
    const expected = this.side === 'left' ? 'Left' : 'Right'
    const candidates = observation.hands.map((points, index) => ({ points, label: observation.handedness[index]?.[0] }))
    const selected = candidates.filter(({ points, label }) => validHand(points) && label?.categoryName === expected)
    const score = selected[0]?.label?.score
    if (!candidates.some(candidate => validHand(candidate.points))) { this.lose('HAND_INVALID'); return null }
    if (selected.length !== 1 || !Number.isFinite(score)) { this.lose('SIDE_AMBIGUOUS'); return null }
    const hand = selected[0].points, wrist = hand[0]
    // Only bridge a short classification-confidence dip for the same label and
    // nearby identity. Weak labels cannot acquire a hand or renew this window.
    const continuing = this.wrist !== null && candidates.length === 1 && this.others.length === 0 &&
      score! >= .5 && observation.timestamp > this.lastSelectedAt &&
      observation.timestamp - this.lastSelectedAt <= DRAWING_POLICY.maxAgeMs &&
      this.lastConfidentAt > 0 && observation.timestamp - this.lastConfidentAt <= DRAWING_POLICY.maxAgeMs &&
      distance(wrist, this.wrist) <= .08
    if (score! < DRAWING_POLICY.handednessScore && !continuing) { this.lose('SIDE_AMBIGUOUS'); return null }
    const otherWrists = candidates.filter(candidate => candidate !== selected[0] && validHand(candidate.points)).map(candidate => candidate.points[0])
    const palm = distance(wrist, hand[9])
    const crossing = otherWrists.some(other => distance(wrist, other) < Math.max(.08, palm * .65))
    const jumped = this.wrist !== null && distance(wrist, this.wrist) > DRAWING_POLICY.handJump
    const switched = this.wrist !== null && this.others.some(other => distance(wrist, other) + .025 < distance(wrist, this.wrist!))
    if (crossing || switched) { this.lose('SIDE_AMBIGUOUS'); return null }
    if (jumped) {
      this.stableFrames = 0
      const prior = this.relocation
      this.relocation = prior && distance(wrist, prior.wrist) < .08
        ? { wrist: { ...wrist }, since: prior.since, frames: prior.frames + 1 }
        : { wrist: { ...wrist }, since: observation.timestamp, frames: 1 }
      if (this.relocation.frames < DRAWING_POLICY.acquisitionFrames || observation.timestamp - this.relocation.since < DRAWING_POLICY.acquisitionMs) return null
      this.stableFrames = this.relocation.frames - 1
      this.stableSince = this.relocation.since
    }
    this.relocation = null
    this.wrist = { ...wrist }; this.others = otherWrists.map(point => ({ ...point }))
    if (this.stableFrames === 0) this.stableSince = observation.timestamp
    this.stableFrames += 1
    if (this.stableFrames < DRAWING_POLICY.acquisitionFrames || observation.timestamp - this.stableSince < DRAWING_POLICY.acquisitionMs) return null
    this.lastSelectedAt = observation.timestamp
    if (score! >= DRAWING_POLICY.handednessScore) this.lastConfidentAt = observation.timestamp
    this.rejectionReason = null
    return hand
  }
}

function jointAngle(a: Point, b: Point, c: Point): number {
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y
  const denominator = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  return denominator > 1e-8 ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator))) * 180 / Math.PI : 0
}

/** Rotation-independent, deliberately conservative pointing; no pinch required. */
export function indexPointing(hand: Point[]): boolean | null {
  if (!validHand(hand)) return null
  const extended = (base: number) => jointAngle(hand[base], hand[base + 1], hand[base + 3]) > 155 &&
    distance(hand[0], hand[base + 3]) > distance(hand[0], hand[base + 1]) * 1.12
  const curled = (base: number) => distance(hand[0], hand[base + 3]) < distance(hand[0], hand[base + 1]) * .94 ||
    jointAngle(hand[base], hand[base + 1], hand[base + 3]) < 115
  if (extended(5) && [9, 13, 17].every(curled)) return true
  if (!extended(5) || [9, 13, 17].some(extended)) return false
  return null
}

/** Palm-relative thresholds keep a held pinch stable as the hand moves. */
export function indexThumbPinched(hand: Point[], held = false): boolean | null {
  if (!validHand(hand)) return null
  const palm = distance(hand[0], hand[9])
  if (palm < 1e-4) return null
  return distance(hand[4], hand[8]) / palm < (held ? DRAWING_POLICY.pinchReleaseRatio : DRAWING_POLICY.pinchCloseRatio)
}

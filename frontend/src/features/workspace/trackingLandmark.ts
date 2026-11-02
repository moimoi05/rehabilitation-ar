/** Confidence is model-specific; RTMPose scores are never MediaPipe visibility. */
export type TrackingPoint = { x: number; y: number; visibility?: number; confidence?: number; valid?: boolean; source?: 'rtmpose'; invalidReason?: string }
export function usableTrackingPoint(point: TrackingPoint | undefined, hand = false): point is TrackingPoint {
  if (!point || point.valid === false || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false
  if (point.source === 'rtmpose') return point.valid === true && point.confidence !== undefined && Number.isFinite(point.confidence)
  return hand || (point.visibility !== undefined && Number.isFinite(point.visibility) && point.visibility >= .4)
}

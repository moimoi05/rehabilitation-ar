/** Explicit serialization contract for a frame presented by a local replay video. */
export type ReplayPoint = { x: number; y: number; z?: number; visibility?: number; presence?: number }
export type ReplayLandmark = {
  landmark_source: 'pose' | 'hand'; landmark_index: number; landmark_name: string
  x: number | null; y: number | null; z: number | null; coordinate_space: 'normalized_image' | 'world'
  is_valid: boolean; invalid_reason?: string; visibility?: number; presence?: number
  handedness?: string; representation: 'raw' | 'display'
}
export type ReplayFrame = {
  frame_id: number; source_frame_id: number | null; frame_performance_ms: number; video_media_time_ms: number; utc_time: string
  inference_performed: boolean; pose_detected: boolean | null; hand_detected: boolean | null
  inference_ms: number | null; skipped_frames: number; landmarks: ReplayLandmark[]
}
type Inputs = {
  frameId: number; sourceFrameId?: number | null; skippedSourceFrames?: number; framePerformanceMs: number; mediaTime: number; capturedAt: string; inferenceMs: number
  pose: readonly ReplayPoint[]; poseWorld: readonly ReplayPoint[]; displayPose: readonly ReplayPoint[]
  hands: readonly (readonly ReplayPoint[])[]; handsWorld: readonly (readonly ReplayPoint[])[]
  handedness: readonly (readonly { categoryName: string }[])[]; posePerformed?: boolean; handPerformed?: boolean
}
const poseNames = ['nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index']
const handNames = ['wrist', 'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip', 'index_finger_mcp', 'index_finger_pip', 'index_finger_dip', 'index_finger_tip', 'middle_finger_mcp', 'middle_finger_pip', 'middle_finger_dip', 'middle_finger_tip', 'ring_finger_mcp', 'ring_finger_pip', 'ring_finger_dip', 'ring_finger_tip', 'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip']
function rows(points: readonly ReplayPoint[], source: 'pose' | 'hand', space: 'normalized_image' | 'world', representation: 'raw' | 'display', handedness?: string): ReplayLandmark[] {
  return points.map((point, index) => {
    const missing = point.z === undefined
    const finite = Number.isFinite(point.x) && Number.isFinite(point.y) && !missing && Number.isFinite(point.z)
    const outside = space === 'normalized_image' && (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
    return {
      landmark_source: source, landmark_index: index, landmark_name: (source === 'pose' ? poseNames[index] : handNames[index]) ?? `${source}_${index}`,
      x: Number.isFinite(point.x) ? point.x : null, y: Number.isFinite(point.y) ? point.y : null, z: point.z !== undefined && Number.isFinite(point.z) ? point.z : null, coordinate_space: space,
      is_valid: finite && !outside, ...(!finite ? { invalid_reason: missing ? 'missing_coordinate' : 'non_finite' } : outside ? { invalid_reason: 'outside_image' } : {}),
      ...(point.visibility !== undefined ? { visibility: point.visibility } : {}), ...(point.presence !== undefined ? { presence: point.presence } : {}),
      ...(handedness ? { handedness } : {}), representation,
    }
  })
}
export function createReplayFrame(input: Inputs): ReplayFrame {
  const hands = input.hands.flatMap((points, index) => rows(points, 'hand', 'normalized_image', 'raw', input.handedness[index]?.[0]?.categoryName))
  const handsWorld = input.handsWorld.flatMap((points, index) => rows(points, 'hand', 'world', 'raw', input.handedness[index]?.[0]?.categoryName))
  return {
    frame_id: input.frameId, source_frame_id: input.sourceFrameId ?? null, frame_performance_ms: input.framePerformanceMs, video_media_time_ms: input.mediaTime * 1000,
    utc_time: input.capturedAt, inference_performed: true, pose_detected: input.posePerformed === false ? null : input.pose.length > 0,
    hand_detected: input.handPerformed === false ? null : input.hands.length > 0, inference_ms: input.inferenceMs, skipped_frames: input.skippedSourceFrames ?? 0,
    landmarks: [...rows(input.pose, 'pose', 'normalized_image', 'raw'), ...rows(input.poseWorld, 'pose', 'world', 'raw'), ...rows(input.displayPose, 'pose', 'normalized_image', 'display'), ...hands, ...handsWorld],
  }
}

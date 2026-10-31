import type { NormalizedLandmark, Landmark, Category } from '@mediapipe/tasks-vision'
import type { CaptureLandmark } from './captureUploader'
const poseNames = ['nose','left_eye_inner','left_eye','left_eye_outer','right_eye_inner','right_eye','right_eye_outer','left_ear','right_ear','mouth_left','mouth_right','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_pinky','right_pinky','left_index','right_index','left_thumb','right_thumb','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle','left_heel','right_heel','left_foot_index','right_foot_index']
const handNames = ['wrist','thumb_cmc','thumb_mcp','thumb_ip','thumb_tip','index_finger_mcp','index_finger_pip','index_finger_dip','index_finger_tip','middle_finger_mcp','middle_finger_pip','middle_finger_dip','middle_finger_tip','ring_finger_mcp','ring_finger_pip','ring_finger_dip','ring_finger_tip','pinky_mcp','pinky_pip','pinky_dip','pinky_tip']
type Point = NormalizedLandmark | Landmark
export function landmarkRows(points: Point[], source: 'pose' | 'hand', space: 'normalized_image' | 'world', representation: 'raw' | 'display' = 'raw', handedness?: Category[]): CaptureLandmark[] {
  return points.map((point, index) => {
    const finite = Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
    const inside = space === 'world' || (point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
    const valid = finite && inside
    return { landmark_source: source, landmark_index: index, landmark_name: (source === 'pose' ? poseNames : handNames)[index] || `landmark_${index}`, x: Number.isFinite(point.x) ? point.x : null, y: Number.isFinite(point.y) ? point.y : null, z: Number.isFinite(point.z) ? point.z : null, coordinate_space: space, representation, is_valid: valid, ...(valid ? {} : { invalid_reason: finite ? 'outside_image' : 'non_finite' }), ...('visibility' in point && Number.isFinite(point.visibility) ? { visibility: point.visibility } : {}), ...('presence' in point && typeof point.presence === 'number' && Number.isFinite(point.presence) ? { presence: point.presence } : {}), ...(handedness?.[0]?.categoryName ? { handedness: handedness[0].categoryName } : {}) }
  })
}

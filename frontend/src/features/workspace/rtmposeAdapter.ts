import type { TrackingPoint } from './trackingLandmark'

export type RtmposeKeypoint = { x: number; y: number; score: number }
export type NormalizedPersonRoi = { x: number; y: number; width: number; height: number }
export type RtmposeAdapterOptions = {
  imageWidth: number; imageHeight: number; inputWidth: number; inputHeight: number
  roi: NormalizedPersonRoi; scoreThreshold?: number; mirrored?: boolean
  /** Use the actual preprocessing affine, including model-specific bbox padding. */
  crop?: { x: number; y: number; width: number; height: number }
}
// Verified against MMPose configs/_base_/datasets/coco_wholebody.py:
// https://github.com/open-mmlab/mmpose/blob/main/configs/_base_/datasets/coco_wholebody.py
export const RTMPOSE_BODY_MAPPING = [[0, 0], [5, 11], [6, 12], [7, 13], [8, 14], [9, 15], [10, 16], [11, 23], [12, 24]] as const
export const RTMPOSE_HAND_START = { Left: 91, Right: 112 } as const

/** Pixel crop before resizing to model input. Aspect expansion is NOT clipped:
 * preprocessing must pad off-image areas, rather than stretching/clamping it. */
export function createRtmposeCropTransform(options: RtmposeAdapterOptions) {
  const { imageWidth, imageHeight, inputWidth, inputHeight, roi } = options
  if (![imageWidth, imageHeight, inputWidth, inputHeight].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid image/model dimensions')
  if (![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite) || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 || roi.x + roi.width > 1 || roi.y + roi.height > 1) throw new RangeError('Person ROI must lie within normalized image')
  const aspect = inputWidth / inputHeight
  // Official TopdownAffine input uses GetBBoxCenterScale padding=1.25.
  const width = Math.max(roi.width * imageWidth, roi.height * imageHeight * aspect) * 1.25
  const height = width / aspect
  return { x: (roi.x + roi.width / 2) * imageWidth - width / 2, y: (roi.y + roi.height / 2) * imageHeight - height / 2, width, height }
}

/** Decoded keypoints are MODEL INPUT pixels. Canonical points remain unmirrored
 * image coordinates; drawing applies mirroring once without swapping anatomy.
 * Missing body indices remain sparse (JSON serializes holes as null). */
export function adaptRTMPoseWholeBody(keypoints: readonly RtmposeKeypoint[], options: RtmposeAdapterOptions) {
  if (keypoints.length !== 133) throw new RangeError('Expected exactly 133 COCO-WholeBody keypoints')
  const defaultCrop = createRtmposeCropTransform(options), crop = options.crop ?? defaultCrop, threshold = options.scoreThreshold ?? .3
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) throw new RangeError('Invalid crop affine')
  if (!Number.isFinite(threshold) || threshold < 0) throw new RangeError('Invalid confidence threshold')
  const { roi } = options
  const convert = (point: RtmposeKeypoint): TrackingPoint => {
    const x = (crop.x + point.x / options.inputWidth * crop.width) / options.imageWidth
    const y = (crop.y + point.y / options.inputHeight * crop.height) / options.imageHeight
    const finite = [point.x, point.y, point.score, x, y].every(Number.isFinite)
    const outsideInput = point.x < 0 || point.y < 0 || point.x >= options.inputWidth || point.y >= options.inputHeight
    const outside = x < roi.x || x > roi.x + roi.width || y < roi.y || y > roi.y + roi.height
    const invalidReason = !finite ? 'non_finite' : outsideInput ? 'outside_model_input' : outside ? 'outside_roi' : point.score < threshold ? 'low_confidence' : undefined
    return { x, y, confidence: point.score, source: 'rtmpose', valid: invalidReason === undefined, ...(invalidReason ? { invalidReason } : {}) }
  }
  const pose: TrackingPoint[] = new Array(33)
  for (const [source, target] of RTMPOSE_BODY_MAPPING) pose[target] = convert(keypoints[source])
  const sides = ['Left', 'Right'] as const
  const hands = sides.map(side => keypoints.slice(RTMPOSE_HAND_START[side], RTMPOSE_HAND_START[side] + 21).map(convert))
  // Category score summarizes actual keypoint confidence, not a handedness classifier.
  const handedness = sides.map((categoryName, index) => [{ categoryName, score: hands[index].every(point => Number.isFinite(point.confidence)) ? Math.min(...hands[index].map(point => point.confidence!)) : 0 }])
  return { pose, hands, handedness, poseWorld: null, handsWorld: null, rawKeypoints: keypoints.map(point => ({ ...point })), coordinateSpace: 'normalized_image_2d' as const }
}

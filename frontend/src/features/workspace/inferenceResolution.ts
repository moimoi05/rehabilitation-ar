export type InferenceResolutionName = 'native' | '1280x720' | '960x540' | '640x360'

export type ResolutionDimensions = { width: number; height: number }

export const INFERENCE_RESOLUTIONS: Record<InferenceResolutionName, { label: string; dimensions: ResolutionDimensions | null }> = {
  'native': { label: 'Gốc (Native)', dimensions: null },
  '1280x720': { label: '1280 × 720 (Khuyên dùng)', dimensions: { width: 1280, height: 720 } },
  '960x540': { label: '960 × 540 (Nhanh)', dimensions: { width: 960, height: 540 } },
  '640x360': { label: '640 × 360 (Tiết kiệm)', dimensions: { width: 640, height: 360 } },
}

/**
 * Calculates inference frame dimensions preserving the source video aspect ratio.
 * Supports landscape (16:9, 4:3), square (1:1), and portrait (9:16, 3:4) video sources.
 * Strictly avoids upscaling: dimensions never exceed source dimensions under any rounding.
 * Always produces integer even dimensions suitable for video/texture processing.
 *
 * Normalized coordinates [0.0, 1.0] returned by MediaPipe on the uniformly scaled
 * frame map 1:1 to normalized coordinates of the source video without distortion.
 */
export function computeInferenceDimensions(
  sourceWidth: number,
  sourceHeight: number,
  target: ResolutionDimensions | null | undefined,
): ResolutionDimensions | null {
  if (!target || !target.width || !target.height) return null
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return null

  // Orient target bounding box to match source orientation (portrait vs landscape/square)
  const isSourcePortrait = sourceHeight > sourceWidth
  const targetMax = Math.max(target.width, target.height)
  const targetMin = Math.min(target.width, target.height)

  const boxWidth = isSourcePortrait ? targetMin : targetMax
  const boxHeight = isSourcePortrait ? targetMax : targetMin

  // Never upscale: scale factor must be strictly <= 1.0
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight, 1.0)

  // If source already fits within target box without downscaling, use native source frame
  if (scale >= 1.0) {
    return null
  }

  let width = Math.round(sourceWidth * scale)
  let height = Math.round(sourceHeight * scale)

  // Ensure even dimensions for video and GPU texture compatibility
  if (width % 2 !== 0) width -= 1
  if (height % 2 !== 0) height -= 1

  // Guarantee dimensions never exceed source dimensions under any rounding edge case
  width = Math.min(width, sourceWidth)
  height = Math.min(height, sourceHeight)

  return { width: Math.max(16, width), height: Math.max(16, height) }
}

export type CaptureTimingResult = {
  bitmap: ImageBitmap
  /**
   * Unified duration of bitmap capture and optional browser-managed resampling.
   * Note on browser limitation:
   * The browser's createImageBitmap(video, { resizeWidth, resizeHeight }) executes frame
   * capture and resampling in a single asynchronous call. Browser APIs do not expose
   * separate execution timers for the capture step versus the resize step without
   * allocating intermediate manual canvases. Thus, captureResizeTotalMs truthfully
   * represents the combined duration. Resizing is browser-managed and not guaranteed zero-copy.
   */
  captureResizeTotalMs: number
  /** Backward compatibility alias for captureResizeTotalMs */
  captureMs: number
  /** Backward compatibility alias; separate resize time is bundled in captureResizeTotalMs */
  resizeMs: number
  scaled: ResolutionDimensions | null
}

/**
 * Captures an inference frame from HTMLVideoElement with optional browser-managed resize.
 * createImageBitmap with resizeWidth/resizeHeight delegates to the browser's image decode/resampling
 * pipeline (GPU or CPU SIMD depending on the browser/compositor surface).
 * This avoids manual full-resolution canvas allocation in JavaScript heap.
 * Note: Resizing is browser-managed and not guaranteed zero-copy.
 */
export async function captureInferenceBitmap(
  video: HTMLVideoElement,
  target?: ResolutionDimensions | null,
): Promise<ImageBitmap> {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  const scaled = computeInferenceDimensions(sourceWidth, sourceHeight, target)

  if (scaled && typeof createImageBitmap === 'function') {
    return createImageBitmap(video, {
      resizeWidth: scaled.width,
      resizeHeight: scaled.height,
      resizeQuality: 'medium',
    })
  }

  return createImageBitmap(video)
}

/**
 * Captures an inference frame and measures truthful unified capture/resize execution time.
 */
export async function captureInferenceBitmapWithTimings(
  video: HTMLVideoElement,
  target?: ResolutionDimensions | null,
): Promise<CaptureTimingResult> {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  const scaled = computeInferenceDimensions(sourceWidth, sourceHeight, target)

  const started = performance.now()
  if (scaled && typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(video, {
      resizeWidth: scaled.width,
      resizeHeight: scaled.height,
      resizeQuality: 'medium',
    })
    const totalMs = Math.max(0, performance.now() - started)
    return { bitmap, captureResizeTotalMs: totalMs, captureMs: totalMs, resizeMs: totalMs, scaled }
  }

  const bitmap = await createImageBitmap(video)
  const totalMs = Math.max(0, performance.now() - started)
  return { bitmap, captureResizeTotalMs: totalMs, captureMs: totalMs, resizeMs: 0, scaled: null }
}

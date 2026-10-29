export type Size = { width: number; height: number }
export type VideoRect = Size & { x: number; y: number }
export type VideoMapping = { box: Size; rect: VideoRect }
export type VideoFit = 'fill' | 'contain' | 'cover'

/** CSS object-fit geometry for a centered video, expressed in box pixels. */
export function videoContentRect(source: Size, box: Size, fit: VideoFit): VideoRect | null {
  if (![source.width, source.height, box.width, box.height].every(value => Number.isFinite(value) && value > 0)) return null
  if (fit === 'fill') return { x: 0, y: 0, width: box.width, height: box.height }
  const scales = [box.width / source.width, box.height / source.height]
  const scale = fit === 'contain' ? Math.min(...scales) : Math.max(...scales)
  const width = source.width * scale, height = source.height * scale
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}

/** Map normalized raw coordinates to normalized box coordinates; mirror the box once. */
export function mapVideoPoint(point: { x: number; y: number }, rect: VideoRect, box: Size, mirrored: boolean) {
  const x = (rect.x + point.x * rect.width) / box.width
  return { x: mirrored ? 1 - x : x, y: (rect.y + point.y * rect.height) / box.height }
}

/** Normalized intersection of the displayed image and the overlay box. */
export function visibleVideoRegion(mapping: VideoMapping): VideoRect {
  const { box, rect } = mapping
  const left = Math.max(0, rect.x), top = Math.max(0, rect.y)
  const right = Math.min(box.width, rect.x + rect.width), bottom = Math.min(box.height, rect.y + rect.height)
  return { x: left / box.width, y: top / box.height, width: Math.max(0, right - left) / box.width, height: Math.max(0, bottom - top) / box.height }
}

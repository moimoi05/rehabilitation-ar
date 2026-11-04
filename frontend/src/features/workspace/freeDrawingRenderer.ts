import type { Point } from './drawing'
import type { DrawingSegment, DrawingStroke } from './freeDrawing'
import { mapVideoPoint, videoContentRect } from './videoGeometry'
import type { Size, VideoMapping, VideoRect } from './videoGeometry'

export function drawingViewport(logicalSize: Size, display: Size): VideoRect {
  return videoContentRect(logicalSize, display, 'contain') ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** Inverse of the artwork's contain transform; drawing coordinates never stretch. */
export function mapDrawingPoint(point: { x: number; y: number }, mapping: VideoMapping, mirrored: boolean, logicalSize: Size): { x: number; y: number } | null {
  if (![point.x, point.y].every(Number.isFinite)) return null
  const mapped = mapVideoPoint(point, mapping.rect, mapping.box, mirrored)
  const viewport = drawingViewport(logicalSize, mapping.box)
  const x = (mapped.x * mapping.box.width - viewport.x) / viewport.width * logicalSize.width
  const y = (mapped.y * mapping.box.height - viewport.y) / viewport.height * logicalSize.height
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= logicalSize.width && y >= 0 && y <= logicalSize.height ? { x, y } : null
}

function artworkTransform(ctx: CanvasRenderingContext2D, logicalSize: Size, display: Size) {
  const viewport = drawingViewport(logicalSize, display)
  ctx.translate(viewport.x, viewport.y)
  ctx.scale(viewport.width / logicalSize.width, viewport.height / logicalSize.height)
}

/** Appends one short segment. It deliberately never clears the persistent canvas. */
export function renderDrawingSegment(ctx: CanvasRenderingContext2D, segment: DrawingSegment, logicalSize: Size, display: Size) {
  ctx.save(); artworkTransform(ctx, logicalSize, display)
  ctx.strokeStyle = segment.stroke.color; ctx.fillStyle = segment.stroke.color
  ctx.lineWidth = segment.stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  const offset = segment.stroke.offset ?? { x: 0, y: 0 }
  if (segment.from) {
    ctx.moveTo(segment.from.x + offset.x, segment.from.y + offset.y); ctx.lineTo(segment.to.x + offset.x, segment.to.y + offset.y); ctx.stroke()
  } else { ctx.arc(segment.to.x + offset.x, segment.to.y + offset.y, segment.stroke.width / 2, 0, Math.PI * 2); ctx.fill() }
  ctx.restore()
}

/** Rebuild a saved path once, keeping drag previews independent of point count's Canvas state overhead. */
function renderSavedStroke(ctx: CanvasRenderingContext2D, stroke: DrawingStroke, logicalSize: Size, display: Size) {
  const first = stroke.points[0]
  if (!first) return
  const offset = stroke.offset ?? { x: 0, y: 0 }
  ctx.save(); artworkTransform(ctx, logicalSize, display)
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color
  ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  if (stroke.points.length === 1) {
    ctx.arc(first.x + offset.x, first.y + offset.y, stroke.width / 2, 0, Math.PI * 2); ctx.fill()
  } else {
    ctx.moveTo(first.x + offset.x, first.y + offset.y)
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index]
      ctx.lineTo(point.x + offset.x, point.y + offset.y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** Full rebuild handles moved shapes, undo, clear, context recovery and resize. */
export function redrawDrawing(ctx: CanvasRenderingContext2D, strokes: readonly DrawingStroke[], logicalSize: Size, display: Size) {
  ctx.clearRect(0, 0, display.width, display.height)
  for (const stroke of strokes) renderSavedStroke(ctx, stroke, logicalSize, display)
}

const handLinks = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]]
export function drawDrawingOverlay(ctx: CanvasRenderingContext2D, input: { cursor: { x: number; y: number } | null; hand: Point[] | null; drawing: boolean; dragging?: boolean; grabbedStrokes?: readonly DrawingStroke[]; highlightedStrokes?: readonly DrawingStroke[] }, mapping: VideoMapping, mirrored: boolean, logicalSize: Size, display: Size) {
  ctx.clearRect(0, 0, display.width, display.height)
  for (const source of input.highlightedStrokes ?? (input.dragging ? input.grabbedStrokes ?? [] : [])) {
    const stroke = { ...source, color: '#facc15', width: source.width + 2 }
    renderSavedStroke(ctx, stroke, logicalSize, display)
  }
  ctx.save(); ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.lineCap = 'round'
  if (input.hand) for (const [a, b] of handLinks) {
    const left = mapVideoPoint(input.hand[a], mapping.rect, mapping.box, mirrored)
    const right = mapVideoPoint(input.hand[b], mapping.rect, mapping.box, mirrored)
    ctx.beginPath(); ctx.moveTo(left.x * display.width, left.y * display.height); ctx.lineTo(right.x * display.width, right.y * display.height); ctx.stroke()
  }
  if (input.cursor) {
    const viewport = drawingViewport(logicalSize, display)
    const x = viewport.x + input.cursor.x / logicalSize.width * viewport.width
    const y = viewport.y + input.cursor.y / logicalSize.height * viewport.height
    ctx.strokeStyle = input.dragging ? '#facc15' : input.drawing ? '#f472b6' : '#f4f8ff'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(x, y, input.dragging ? 14 : input.drawing ? 7 : 10, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.restore()
}

import { mapVideoPoint } from './videoGeometry'
import type { VideoMapping } from './videoGeometry'
import type { Size } from './videoGeometry'

export type Side = 'left' | 'right'
export type Point = { x: number; y: number; visibility?: number }
export type Ghost = { ghost_visible: boolean; opacity: number; x: number; y: number; scale: number; affected_side: Side; confirmed: boolean }

export const initialGhost: Ghost = { ghost_visible: true, opacity: 0.45, x: 0.5, y: 0.5, scale: 1, affected_side: 'left', confirmed: false }

/** Clear the backing store, then draw in CSS pixels to preserve shape under resizing. */
export function prepareOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, box: Size | null): Size {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const display = box && box.width > 0 && box.height > 0 ? box : { width, height }
  ctx.setTransform(width / display.width, 0, 0, height / display.height, 0, 0)
  return display
}

/** Coordinates are normalized to the image, not to CSS pixels. */
export function drawGhost(ctx: CanvasRenderingContext2D, width: number, height: number, ghost: Ghost, mirrored = true) {
  if (!ghost.ghost_visible) return
  const unit = Math.min(width, height) * ghost.scale
  ctx.save()
  ctx.translate(ghost.x * width, ghost.y * height)
  ctx.globalAlpha = ghost.opacity
  ctx.fillStyle = '#7dd3fc'
  ctx.strokeStyle = '#d9f5ff'
  ctx.lineWidth = Math.max(2, unit * 0.007)
  ctx.beginPath()
  ctx.ellipse(0, -unit * 0.26, unit * 0.075, unit * 0.095, 0, 0, 2 * Math.PI)
  ctx.fill(); ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(-unit * 0.16, -unit * 0.12); ctx.quadraticCurveTo(0, -unit * 0.16, unit * 0.16, -unit * 0.12)
  ctx.lineTo(unit * 0.13, unit * 0.29); ctx.quadraticCurveTo(0, unit * 0.32, -unit * 0.13, unit * 0.29); ctx.closePath()
  ctx.fill(); ctx.stroke()
  ctx.lineCap = 'round'; ctx.lineWidth = unit * 0.055
  const affectedDirection = ghost.affected_side === 'left' ? (mirrored ? -1 : 1) : (mirrored ? 1 : -1)
  for (const direction of [-1, 1]) {
    ctx.strokeStyle = direction === affectedDirection ? '#fcd34d' : '#b4ecff'
    ctx.beginPath(); ctx.moveTo(direction * unit * 0.16, -unit * 0.1)
    ctx.lineTo(direction * unit * 0.22, unit * 0.09); ctx.lineTo(direction * unit * 0.25, unit * 0.26); ctx.stroke()
  }
  ctx.globalAlpha = Math.min(1, ghost.opacity + 0.3)
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, unit * 0.004); ctx.setLineDash([unit * 0.018, unit * 0.013])
  ctx.beginPath(); ctx.moveTo(0, -unit * 0.39); ctx.lineTo(0, unit * 0.34); ctx.moveTo(-unit * 0.25, -unit * 0.1); ctx.lineTo(unit * 0.25, -unit * 0.1); ctx.stroke()
  ctx.restore()
}

const poseLinks = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [0, 11], [0, 12]]
const handLinks = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]]
// Hand Landmarker does not provide meaningful visibility; MediaPipe may emit 0.
const drawable = (point: Point | undefined, hand: boolean): point is Point => !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && (hand || (point.visibility !== undefined && Number.isFinite(point.visibility) && point.visibility >= 0.4))

export function drawLandmarks(ctx: CanvasRenderingContext2D, width: number, height: number, points: Point[], mirrored: boolean, hand = false, mapping?: VideoMapping) {
  const position = (p: Point) => {
    const mapped = mapping ? mapVideoPoint(p, mapping.rect, mapping.box, mirrored) : { x: mirrored ? 1 - p.x : p.x, y: p.y }
    return [mapped.x * width, mapped.y * height]
  }
  ctx.save(); ctx.strokeStyle = hand ? '#fbbf24' : '#48e2c2'; ctx.fillStyle = '#fff'; ctx.lineWidth = Math.max(2, width / 500)
  for (const [a, b] of hand ? handLinks : poseLinks) {
    const p = points[a], q = points[b]
    if (!drawable(p, hand) || !drawable(q, hand)) continue
    const [x1, y1] = position(p), [x2, y2] = position(q)
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  }
  const indexes = hand ? points.map((_, i) => i) : [0, 11, 12, 13, 14, 15, 16, 23, 24]
  for (const index of indexes) {
    const p = points[index]
    if (!drawable(p, hand)) continue
    const [x, y] = position(p); ctx.beginPath(); ctx.arc(x, y, Math.max(3, width / 250), 0, 2 * Math.PI); ctx.fill()
  }
  ctx.restore()
}

export function demoPose(time: number): Point[] {
  const pts: Point[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
  const sway = Math.sin(time / 850) * 0.035
  const visible = (x: number, y: number): Point => ({ x, y, visibility: 1 })
  pts[0] = visible(.5, .2); pts[11] = visible(.39, .36); pts[12] = visible(.61, .36)
  pts[13] = visible(.33, .51 + sway); pts[14] = visible(.67, .51 - sway)
  pts[15] = visible(.29, .66 + sway); pts[16] = visible(.71, .66 - sway)
  pts[23] = visible(.43, .73); pts[24] = visible(.57, .73)
  return pts
}

import { prepareOverlay } from './drawing'
import type { Point, Side } from './drawing'
import { usableTrackingPoint } from './trackingLandmark'
import { mapVideoPoint } from './videoGeometry'
import type { Size, VideoMapping, VideoRect } from './videoGeometry'

export type Position = { x: number; y: number }
export type Round = { score: number; targetCount: number; target: Position; elapsedMs: number; finished: boolean; releaseFrom: Position | null }
const targets: Position[] = [
  { x: .35, y: .50 }, { x: .60, y: .43 }, { x: .45, y: .62 },
  { x: .66, y: .58 }, { x: .30, y: .62 }, { x: .53, y: .35 },
]
export const ROUND_MS = 30000
export const targetRadius = (height: number) => height * .07
export function targetForScore(score: number, region?: VideoRect): Position {
  const target = targets[score % targets.length]
  return region ? { x: region.x + target.x * region.width, y: region.y + target.y * region.height } : target
}
export function initialRound(region?: VideoRect): Round {
  return { score: 0, targetCount: 1, target: targetForScore(0, region), elapsedMs: 0, finished: false, releaseFrom: null }
}
export function wristForSide(pose: Point[], side: Side): Position | null {
  const p = pose[side === 'left' ? 15 : 16]
  if (!usableTrackingPoint(p)) return null
  return { x: p.x, y: p.y }
}
export function displayPoint(point: Position | null, mirrored: boolean, mapping?: VideoMapping): Position | null {
  if (!point) return null
  const result = mapping ? mapVideoPoint(point, mapping.rect, mapping.box, mirrored) : { x: mirrored ? 1 - point.x : point.x, y: point.y }
  return result.x >= 0 && result.x <= 1 && result.y >= 0 && result.y <= 1 ? result : null
}
const distance = (a: Position, b: Position, width: number, height: number) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height)
export function stepRound(round: Round, pointer: Position | null, delta: number, width: number, height: number, region?: VideoRect, roundDurationMs = ROUND_MS): Round {
  if (round.finished || !pointer || !Number.isFinite(delta) || delta <= 0 || width <= 0 || height <= 0) return round
  const elapsedMs = Math.min(roundDurationMs, round.elapsedMs + Math.min(delta, 250))
  if (elapsedMs >= roundDurationMs) return { ...round, elapsedMs, finished: true }
  const released = round.releaseFrom && distance(pointer, round.releaseFrom, width, height) > targetRadius(height) * 1.3 ? null : round.releaseFrom
  if (!released && distance(pointer, round.target, width, height) <= targetRadius(height)) {
    const score = round.score + 1
    return { ...round, score, targetCount: round.targetCount + 1, target: targetForScore(score, region), releaseFrom: round.target, elapsedMs, finished: elapsedMs >= roundDurationMs }
  }
  return { ...round, releaseFrom: released, elapsedMs, finished: elapsedMs >= roundDurationMs }
}

function drawFlowerArtwork(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save(); ctx.shadowColor = '#fff49b'; ctx.shadowBlur = r * .45
  ctx.fillStyle = '#ffd66c'
  for (let i = 0; i < 6; i += 1) {
    const angle = i * Math.PI / 3
    ctx.beginPath(); ctx.arc(x + Math.cos(angle) * r * .57, y + Math.sin(angle) * r * .57, r * .40, 0, Math.PI * 2); ctx.fill()
  }
  ctx.shadowBlur = 0; ctx.fillStyle = '#ef8d38'; ctx.beginPath(); ctx.arc(x, y, r * .38, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

function drawWristCursor(ctx: CanvasRenderingContext2D, width: number, height: number, pointer: Position | null) {
  if (pointer) {
    ctx.save()
    const r = targetRadius(height)
    ctx.shadowBlur = 0; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(3, height * .005)
    ctx.beginPath(); ctx.arc(pointer.x * width, pointer.y * height, r * .32, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }
}

export function drawFlower(ctx: CanvasRenderingContext2D, width: number, height: number, target: Position, pointer: Position | null) {
  drawFlowerArtwork(ctx, target.x * width, target.y * height, targetRadius(height))
  drawWristCursor(ctx, width, height, pointer)
}

/** One small sprite per game loop; no shadow work or full-canvas clear on unchanged ticks. */
export function createFlowerRenderer(ctx: CanvasRenderingContext2D) {
  let sprite: HTMLCanvasElement | null = null
  let spriteKey = ''
  let previous = ''
  return (width: number, height: number, box: Size, target: Position, pointer: Position | null) => {
    const display = box.width > 0 && box.height > 0 ? box : { width, height }
    const key = `${width}|${height}|${display.width}|${display.height}`
    const frameKey = `${key}|${target.x}|${target.y}|${pointer?.x ?? ''}|${pointer?.y ?? ''}`
    if (frameKey === previous) return
    const scaleX = width / display.width, scaleY = height / display.height
    if (key !== spriteKey) {
      const r = targetRadius(display.height), blur = r * .45
      sprite = document.createElement('canvas')
      // shadowBlur is measured in backing pixels, independently of the current transform.
      sprite.width = Math.ceil(2 * r * scaleX + 6 * blur)
      sprite.height = Math.ceil(2 * r * scaleY + 6 * blur)
      const artwork = sprite.getContext('2d')
      if (artwork) {
        artwork.setTransform(scaleX, 0, 0, scaleY, sprite.width / 2, sprite.height / 2)
        drawFlowerArtwork(artwork, 0, 0, r)
      } else sprite = null
      spriteKey = key
    }
    prepareOverlay(ctx, width, height, display)
    if (sprite) {
      const w = sprite.width / scaleX, h = sprite.height / scaleY
      ctx.drawImage(sprite, target.x * display.width - w / 2, target.y * display.height - h / 2, w, h)
      drawWristCursor(ctx, display.width, display.height, pointer)
    } else drawFlower(ctx, display.width, display.height, target, pointer)
    previous = frameKey
  }
}

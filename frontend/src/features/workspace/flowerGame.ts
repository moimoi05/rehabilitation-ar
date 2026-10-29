import type { Point, Side } from './drawing'
import { mapVideoPoint } from './videoGeometry'
import type { VideoMapping, VideoRect } from './videoGeometry'

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
  if (!p || p.visibility === undefined || !Number.isFinite(p.visibility) || p.visibility < .4 || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null
  return { x: p.x, y: p.y }
}
export function displayPoint(point: Position | null, mirrored: boolean, mapping?: VideoMapping): Position | null {
  if (!point) return null
  const result = mapping ? mapVideoPoint(point, mapping.rect, mapping.box, mirrored) : { x: mirrored ? 1 - point.x : point.x, y: point.y }
  return result.x >= 0 && result.x <= 1 && result.y >= 0 && result.y <= 1 ? result : null
}
const distance = (a: Position, b: Position, width: number, height: number) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height)
export function stepRound(round: Round, pointer: Position | null, delta: number, width: number, height: number, region?: VideoRect): Round {
  if (round.finished || !pointer || !Number.isFinite(delta) || delta <= 0 || width <= 0 || height <= 0) return round
  const elapsedMs = Math.min(ROUND_MS, round.elapsedMs + Math.min(delta, 250))
  if (elapsedMs >= ROUND_MS) return { ...round, elapsedMs, finished: true }
  const released = round.releaseFrom && distance(pointer, round.releaseFrom, width, height) > targetRadius(height) * 1.3 ? null : round.releaseFrom
  if (!released && distance(pointer, round.target, width, height) <= targetRadius(height)) {
    const score = round.score + 1
    return { ...round, score, targetCount: round.targetCount + 1, target: targetForScore(score, region), releaseFrom: round.target, elapsedMs, finished: elapsedMs >= ROUND_MS }
  }
  return { ...round, releaseFrom: released, elapsedMs, finished: elapsedMs >= ROUND_MS }
}

export function drawFlower(ctx: CanvasRenderingContext2D, width: number, height: number, target: Position, pointer: Position | null) {
  const x = target.x * width, y = target.y * height, r = targetRadius(height)
  ctx.save(); ctx.shadowColor = '#fff49b'; ctx.shadowBlur = r * .45
  ctx.fillStyle = '#ffd66c'
  for (let i = 0; i < 6; i += 1) {
    const angle = i * Math.PI / 3
    ctx.beginPath(); ctx.arc(x + Math.cos(angle) * r * .57, y + Math.sin(angle) * r * .57, r * .40, 0, Math.PI * 2); ctx.fill()
  }
  ctx.shadowBlur = 0; ctx.fillStyle = '#ef8d38'; ctx.beginPath(); ctx.arc(x, y, r * .38, 0, Math.PI * 2); ctx.fill()
  if (pointer) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(3, height * .005)
    ctx.beginPath(); ctx.arc(pointer.x * width, pointer.y * height, r * .32, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.restore()
}

import type { VideoMapping } from './videoGeometry'

type GhostPosition = { x: number; y: number; scale: number }
export type GhostAnchor = GhostPosition
export type PersistedGhostAnchor = GhostAnchor & { version: 1 }

/** Version 1 uses source-image coordinates before the video mirror transform. */
export function toPersistedGhostAnchor(anchor: GhostAnchor, mirrored: boolean): PersistedGhostAnchor | null {
  if (![anchor.x, anchor.y, anchor.scale].every(Number.isFinite) || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1 || anchor.scale <= 0 || anchor.scale > 15) return null
  return { version: 1, x: mirrored ? 1 - anchor.x : anchor.x, y: anchor.y, scale: anchor.scale }
}

export function fromPersistedGhostAnchor(value: unknown, mirrored: boolean): GhostAnchor | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (data.version !== 1 || typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.scale !== 'number') return null
  const raw = { x: data.x, y: data.y, scale: data.scale }
  if (!toPersistedGhostAnchor(raw, false)) return null
  return { ...raw, x: mirrored ? 1 - raw.x : raw.x }
}

/** Convert the existing box-relative calibration to an in-memory image anchor. */
export function anchorGhost(ghost: GhostPosition, { box, rect }: VideoMapping): GhostAnchor {
  return {
    x: (ghost.x * box.width - rect.x) / rect.width,
    y: (ghost.y * box.height - rect.y) / rect.height,
    scale: ghost.scale * Math.min(box.width, box.height) / Math.min(rect.width, rect.height),
  }
}

/** Preserve the displayed image point and image-relative size across layout changes. */
export function mapGhostAnchor(anchor: GhostAnchor, { box, rect }: VideoMapping): GhostPosition {
  return {
    x: (rect.x + anchor.x * rect.width) / box.width,
    y: (rect.y + anchor.y * rect.height) / box.height,
    scale: anchor.scale * Math.min(rect.width, rect.height) / Math.min(box.width, box.height),
  }
}

/** API and slider limits apply to the legacy box-relative representation. */
export function ghostFitsCalibration({ x, y, scale }: GhostPosition): boolean {
  return [x, y, scale].every(Number.isFinite) && x >= 0 && x <= 1 && y >= 0 && y <= 1 && scale >= .2 && scale <= 3
}

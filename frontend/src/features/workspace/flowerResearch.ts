import { targetRadius } from './flowerGame'
import type { Position, Round } from './flowerGame'
import type { ResearchTrialCapture } from './gameWorkflow'
import type { Side } from './drawing'
import type { Size, VideoMapping } from './videoGeometry'

type Context = { timestamp: number; sourceTimestamp?: number; sourceObservationId?: number | null }
type Tick = Context & {
  pointer: Position | null; display: Size; geometry: VideoMapping | null | undefined
  geometryPaused: boolean; geometryChanged?: boolean; freshnessMs: number
}

/** Observes the game's accepted state transitions; never participates in hit testing. */
export class FlowerResearchRecorder {
  private active = false
  private tracking = false
  private paused = false
  private lastObservation: string | null = null
  private geometryKey = ''
  private warned = false

  constructor(private readonly owner: ResearchTrialCapture, private readonly side: Side, private readonly mirrored: boolean) {}

  private emit(type: string, payload: Record<string, unknown>, context: Context, sample = false) {
    try {
      if (sample) this.owner.sample?.(type, payload, context)
      else this.owner.event?.(type, payload, context)
    } catch (error) {
      if (!this.warned) { this.warned = true; console.warn('Không ghi được dữ liệu tương tác Hái hoa.', error) }
    }
  }

  private snapshot(round: Round, display: Size, geometry: VideoMapping | null | undefined) {
    return {
      target_id: `target-${round.targetCount}`, target_sequence: round.targetCount,
      target_x: round.target.x, target_y: round.target.y, target_radius: targetRadius(display.height), radius_unit: 'px',
      coordinate_space: 'display_normalized', width: display.width, height: display.height,
      mapping_version: 'video-mapping-v1',
      mapping: { rect: geometry ? { ...geometry.rect } : null, box: geometry ? { ...geometry.box } : null, mirrored: this.mirrored },
    }
  }

  private key(display: Size, geometry: VideoMapping | null | undefined) {
    return [display.width, display.height, geometry?.box.width, geometry?.box.height, geometry?.rect.x, geometry?.rect.y, geometry?.rect.width, geometry?.rect.height].join('|')
  }

  start(round: Round, timestamp: number, display: Size, geometry: VideoMapping | null | undefined, trackingUsable: boolean) {
    this.active = true; this.tracking = trackingUsable
    this.geometryKey = this.key(display, geometry)
    this.emit('GAME_STARTED', { score: round.score, gameplay_elapsed_ms: round.elapsedMs, tracking_usable: trackingUsable, side: this.side }, { timestamp })
    this.emit('TARGET_SPAWNED', this.snapshot(round, display, geometry), { timestamp })
  }

  tick(before: Round, after: Round, input: Tick) {
    if (!this.active) return
    const { timestamp, sourceTimestamp, sourceObservationId, pointer, display, geometry, geometryPaused, geometryChanged, freshnessMs } = input
    const context: Context = { timestamp, sourceTimestamp, sourceObservationId }
    const target = this.snapshot(before, display, geometry)
    const tracking = pointer !== null
    if (tracking !== this.tracking) {
      this.emit(tracking ? 'TRACKING_RECOVERED' : 'TRACKING_LOST', { target_id: target.target_id, freshness_ms: freshnessMs }, tracking ? context : { timestamp })
      this.tracking = tracking
    }
    const geometryKey = this.key(display, geometry)
    if (geometryPaused !== this.paused || geometryChanged || geometryKey !== this.geometryKey) {
      this.emit(geometryPaused ? 'GEOMETRY_PAUSED' : this.paused ? 'GEOMETRY_RESUMED' : 'GEOMETRY_CHANGED', target, { timestamp })
      this.paused = geometryPaused; this.geometryKey = geometryKey
    }
    const observation = sourceObservationId != null ? `id:${sourceObservationId}` : sourceTimestamp ? `time:${sourceTimestamp}` : null
    if (observation && observation !== this.lastObservation && sourceTimestamp != null && sourceTimestamp > 0) {
      this.lastObservation = observation
      this.emit('flower_cursor', {
        x: pointer?.x ?? null, y: pointer?.y ?? null, coordinate_space: target.coordinate_space, width: display.width, height: display.height,
        usable: tracking && !geometryPaused, freshness: freshnessMs > 250 ? 'stale' : tracking ? 'fresh' : 'missing', freshness_ms: freshnessMs,
        target_id: target.target_id, side: this.side, mapping_version: target.mapping_version,
        geometry_paused: geometryPaused, representation: 'game_processed',
      }, { timestamp: sourceTimestamp, sourceTimestamp, sourceObservationId }, true)
    }
    if (before.releaseFrom && (!after.releaseFrom || after.score > before.score)) {
      this.emit('TARGET_RELEASE_GATE_CLEARED', { target_id: target.target_id, cursor_x: pointer?.x ?? null, cursor_y: pointer?.y ?? null }, context)
    }
    if (after.score > before.score) {
      this.emit('TARGET_TOUCHED', { target_id: target.target_id, cursor_x: pointer?.x ?? null, cursor_y: pointer?.y ?? null, score: after.score }, context)
      this.emit('TARGET_SPAWNED', this.snapshot(after, display, geometry), { timestamp })
    }
  }

  stop(reason: string, round: Round, timestamp: number) {
    if (!this.active) return
    this.active = false
    const type = reason === 'completed' ? 'GAME_COMPLETED' : reason === 'stopped' ? 'GAME_STOPPED' : 'GAME_CANCELLED'
    this.emit(type, { reason, score: round.score, target_count: round.targetCount, gameplay_elapsed_ms: round.elapsedMs }, { timestamp })
  }
}

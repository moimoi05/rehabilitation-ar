/** All input times are performance.now() timestamps, never upload time or nominal FPS. */
export type ResearchContext = { timestamp: number; sourceObservationId?: number | null; sourceTimestamp?: number }
export type GameResearchSink = {
  event: (eventType: string, payload: Record<string, unknown>, context: ResearchContext) => void
  sample: (sampleType: string, payload: Record<string, unknown>, context: ResearchContext) => void
}
type GameRow = {
  capture_id: string; trial_id: number; game_key: 'glowing_flower' | 'free_drawing'; sequence: number
  timestamp_ms: number; source_timestamp_ms: number | null; source_observation_id: number | null; frame_id: null
  payload: Record<string, unknown>
}
export type GameEvent = GameRow & { event_id: string; event_schema_version: 1; event_type: string }
export type InteractionSample = GameRow & { sample_id: string; sample_schema_version: 1; sample_type: string }

export function createGameResearchSink(options: {
  captureId: string; trialId: number; gameKey: GameRow['game_key']; start: number
  event: (row: GameEvent) => void; sample: (row: InteractionSample) => void; gap?: (reason: string) => void
}): GameResearchSink {
  let eventSequence = 0, sampleSequence = 0
  const row = (sequence: number, payload: Record<string, unknown>, context: ResearchContext): GameRow => ({
    capture_id: options.captureId, trial_id: options.trialId, game_key: options.gameKey, sequence,
    timestamp_ms: context.timestamp - options.start,
    source_timestamp_ms: context.sourceTimestamp !== undefined && context.sourceTimestamp >= options.start ? context.sourceTimestamp - options.start : null,
    source_observation_id: context.sourceObservationId ?? null, frame_id: null, payload,
  })
  const safe = (write: () => void, context: ResearchContext) => {
    if (!Number.isFinite(context.timestamp) || context.timestamp < options.start) return
    try { write() }
    catch (error) { options.gap?.(`Game research: ${error instanceof Error ? error.message : 'cannot buffer data'}`) }
  }
  return {
    event: (type, payload, context) => safe(() => {
      const sequence = eventSequence++
      options.event({ ...row(sequence, payload, context), event_id: `${options.captureId}:event:${sequence}`, event_schema_version: 1, event_type: type })
    }, context),
    sample: (type, payload, context) => safe(() => {
      const sequence = sampleSequence++
      options.sample({ ...row(sequence, payload, context), sample_id: `${options.captureId}:sample:${sequence}`, sample_schema_version: 1, sample_type: type })
    }, context),
  }
}

import type { ResearchTrialCapture } from './gameWorkflow'
import type { GameResearchSink, ResearchContext } from './gameResearch'

type CapturePort = {
  getScope: () => string | null
  gameStarted: (timestamp: number) => void
  stop: (reason: string, timestamp: number, settle?: () => Promise<void>) => Promise<void>
  event?: (scope: string, ...args: Parameters<GameResearchSink['event']>) => void
  sample?: (scope: string, ...args: Parameters<GameResearchSink['sample']>) => void
}
type Options = {
  prepare: (trialId: number, gameKey: 'glowing_flower' | 'free_drawing', taskSnapshot?: Record<string, unknown>) => Promise<string | null>
  beforeStop: (scope: string) => void | Promise<void>
  unavailable: (message: string) => void
}

/** Each round retains this owner, so a late callback cannot stop its successor. */
export function createTrialResearchCapture(capture: CapturePort, options: Options): ResearchTrialCapture {
  let scope: string | null = null
  let ended: { reason: string; timestamp: number } | null = null
  let stopRequested = false
  const stopOwned = () => {
    if (!ended || !scope || stopRequested || capture.getScope() !== scope) return
    stopRequested = true
    const ownedScope = scope
    void capture.stop(ended.reason, ended.timestamp, async () => { await options.beforeStop(ownedScope) }).catch(error => options.unavailable(error instanceof Error ? error.message : 'Không xác nhận được lưu dữ liệu.'))
  }
  return {
    prepare: async (trialId, gameKey, taskSnapshot) => {
      try { scope = await options.prepare(trialId, gameKey, taskSnapshot); stopOwned() }
      catch (error) { options.unavailable(error instanceof Error ? error.message : 'Chưa sẵn sàng thu dữ liệu.') }
    },
    started: timestamp => { if (!ended && scope && capture.getScope() === scope) capture.gameStarted(timestamp) },
    stopped: (reason, timestamp) => { if (!ended) ended = { reason, timestamp }; stopOwned() },
    event: (type: string, payload: Record<string, unknown>, context: ResearchContext) => {
      if (!ended && scope && capture.getScope() === scope) capture.event?.(scope, type, payload, context)
    },
    sample: (type: string, payload: Record<string, unknown>, context: ResearchContext) => {
      if (!ended && scope && capture.getScope() === scope) capture.sample?.(scope, type, payload, context)
    },
  }
}

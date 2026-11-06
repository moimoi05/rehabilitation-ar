import type { GameResearchSink } from './gameResearch'

interface SavedGameResultBase {
  id: number
  trial_id: number
  session_id: number
  exercise_id?: number | null
  exercise_code?: string | null
  duration_seconds: number
  round_id: string
  created_at: string
  data_valid?: boolean
}

export type SavedGameResult = SavedGameResultBase & (
  | { game_key: 'glowing_flower'; score: number; target_count: number }
  | { game_key: 'free_drawing'; completed_strokes: number; active_drawing_seconds?: number }
)

/** Per-round adapter; capture failures are reported independently of gameplay. */
export interface ResearchTrialCapture extends Partial<GameResearchSink> {
  prepare: (trialId: number, gameKey: 'glowing_flower' | 'free_drawing', taskSnapshot?: Record<string, unknown>) => Promise<void>
  started: (timestamp: number) => void
  stopped: (reason: string, timestamp: number) => void
}

/** Optional domain adapter; standalone tracking and demo retain their original behavior. */
export interface FlowerWorkflow {
  renderer?: 'flower' | 'free_drawing'
  enabled: boolean
  setupReady: boolean
  exerciseId: number | null
  exerciseName?: string
  durationSeconds?: number
  attempt: number
  createTrial: (roundId: string) => Promise<number>
  cancelTrial?: (trialId: number) => Promise<void>
  onResultSaved: (result: SavedGameResult) => void
  onRoundAbandoned?: () => void
}

export interface WorkspaceWorkflow {
  view: 'setup' | 'game' | 'monitor'
  game: FlowerWorkflow
  beforeCalibrationSave: () => Promise<number>
  onSetupSaved: (calibrationId: number) => void
  onSetupInvalidated: () => void
}

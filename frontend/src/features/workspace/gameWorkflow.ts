export interface SavedGameResult {
  id: number
  trial_id: number
  session_id: number
  game_key: string
  exercise_id?: number | null
  exercise_code?: string | null
  duration_seconds: number
  score: number
  target_count: number
  round_id: string
  created_at: string
  data_valid?: boolean
}

/** Optional domain adapter; standalone tracking and demo retain their original behavior. */
export interface FlowerWorkflow {
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

import { useEffect, useRef, useState } from 'react'
import WorkspacePage from '../workspace/WorkspacePage'
import type { SavedGameResult, WorkspaceWorkflow } from '../workspace/gameWorkflow'
import type { Exercise, RehabSession } from '../../types/rehab'
import { rehabApi } from '../../services/rehab'
import { ErrorState } from '../../components/States'

export type { SavedGameResult } from '../workspace/gameWorkflow'
export interface ClinicalWorkspaceProps {
  session: RehabSession
  exercise: Exercise | null
  view: 'setup' | 'game' | 'monitor'
  onSetupSaved: (calibrationId: number) => void
  onSetupInvalidated: () => void
  onResultSaved: (result: SavedGameResult) => void
}

/** One mounted camera owner for the whole visit; a new game changes only the round. */
export default function ClinicalWorkspace(props: ClinicalWorkspaceProps) {
  const { session, exercise, view } = props
  const callbacks = useRef(props)
  callbacks.current = props
  const revision = useRef(session.setup_revision ?? 0)
  const invalidationQueue = useRef<Promise<void>>(Promise.resolve())
  const invalidationFailed = useRef(false)
  const invalidationScheduled = useRef(false)
  const live = useRef(true)
  const [setupReady, setSetupReady] = useState(false)
  const [error, setError] = useState('')
  const [attemptState, setAttemptState] = useState({ view, attempt: view === 'game' ? 1 : 0 })
  // Derive the round token before rendering the child, so returning to the same
  // catalog item cannot render the previous finished round for one frame.
  if (attemptState.view !== view) setAttemptState({ view, attempt: attemptState.attempt + (view === 'game' ? 1 : 0) })
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { revision.current = Math.max(revision.current, session.setup_revision ?? 0) }, [session.setup_revision])

  const invalidate = () => {
    setSetupReady(false)
    callbacks.current.onSetupInvalidated()
    if (invalidationScheduled.current) return
    invalidationScheduled.current = true
    invalidationQueue.current = invalidationQueue.current.then(async () => {
      try {
        const updated = await rehabApi.invalidateSetup(session.id)
        revision.current = updated.setup_revision
        invalidationFailed.current = false
        if (live.current) setError('')
      } catch (cause) {
        invalidationFailed.current = true
        if (live.current) setError(cause instanceof Error ? cause.message : 'Chưa đồng bộ được trạng thái hiệu chuẩn. Hãy thử lại.')
      } finally { invalidationScheduled.current = false }
    })
  }

  const workflow: WorkspaceWorkflow = {
    view,
    game: {
      enabled: view === 'game', setupReady, exerciseId: exercise?.id ?? null,
      renderer: exercise?.renderer === 'free_drawing' ? 'free_drawing' : 'flower',
      exerciseName: exercise?.name, attempt: attemptState.attempt,
      durationSeconds: exercise?.default_duration_seconds,
      createTrial: async roundId => {
        await invalidationQueue.current
        if (invalidationFailed.current) throw new Error('Chưa đồng bộ hiệu chuẩn. Hãy kiểm tra và lưu lại.')
        if (!exercise || (exercise.renderer !== 'flower' && !(exercise.renderer === 'free_drawing' && exercise.usage_mode === 'training' && session.session_type === 'training'))) throw new Error('Bài tập này chưa có giao diện thực hiện trong phân hệ hiện tại.')
        return (await rehabApi.createTrial(session.id, exercise.id, roundId)).id
      },
      cancelTrial: async trialId => { await rehabApi.cancelTrial(trialId) },
      onResultSaved: result => callbacks.current.onResultSaved(result),
      onRoundAbandoned: invalidate,
    },
    beforeCalibrationSave: async () => {
      await invalidationQueue.current
      if (invalidationFailed.current) {
        invalidate()
        await invalidationQueue.current
      }
      if (invalidationFailed.current) throw new Error('Chưa đồng bộ được hiệu chuẩn. Hãy kiểm tra kết nối và lưu lại.')
      return revision.current
    },
    onSetupSaved: id => { setSetupReady(true); callbacks.current.onSetupSaved(id) },
    onSetupInvalidated: invalidate,
  }

  return <div className="clinical-camera-shell">
    {error && <ErrorState message={error} retry={invalidate}/>}
    <WorkspacePage session={session} workflow={workflow}/>
  </div>
}

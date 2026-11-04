import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ClinicalWorkspace from './ClinicalWorkspace'
import type { Exercise, RehabSession } from '../../types/rehab'
import type { WorkspacePageProps } from '../workspace/WorkspacePage'
import { rehabApi } from '../../services/rehab'

const observed: WorkspacePageProps[] = []
let mounts = 0
vi.mock('../workspace/WorkspacePage', async () => {
  const { useEffect } = await import('react')
  function WorkspaceMock(props: WorkspacePageProps) {
    observed.push(props)
    useEffect(() => { mounts += 1 }, [])
    return <><button onClick={() => props.workflow?.onSetupSaved(8)}>save setup</button><button onClick={() => props.workflow?.onSetupInvalidated()}>invalidate setup</button><button onClick={() => void props.workflow?.beforeCalibrationSave()}>revision</button></>
  }
  return { default: WorkspaceMock }
})
vi.mock('../../services/rehab', () => ({ rehabApi: { invalidateSetup: vi.fn(), createTrial: vi.fn() } }))
const session: RehabSession = { id: 7, patient_id: 3, affected_side: 'left', session_type: 'training', status: 'draft', started_at: null, ended_at: null, notes: null, created_at: '', managed_workflow: true, setup_confirmed: false, setup_revision: 0 }
const callbacks = { onSetupSaved: vi.fn(), onSetupInvalidated: vi.fn(), onResultSaved: vi.fn() }
const drawing: Exercise = { id: 2, code: 'free_drawing', renderer: 'free_drawing', name: 'Vẽ tự do', description: '', instructions: '', exercise_type: 'game', usage_mode: 'training', active: true, is_default: false, default_duration_seconds: 60 }
afterEach(() => { cleanup(); observed.length = 0; mounts = 0; vi.clearAllMocks() })

it('keeps a single workspace mounted and resets only the game attempt between games', () => {
  const view = render(<ClinicalWorkspace session={session} exercise={null} view="setup" {...callbacks}/>)
  fireEvent.click(screen.getByText('save setup'))
  view.rerender(<ClinicalWorkspace session={{ ...session, status: 'in_progress', setup_confirmed: true }} exercise={null} view="game" {...callbacks}/>)
  const first = observed.at(-1)!.workflow!.game.attempt
  view.rerender(<ClinicalWorkspace session={{ ...session, status: 'in_progress', setup_confirmed: true }} exercise={null} view="monitor" {...callbacks}/>)
  view.rerender(<ClinicalWorkspace session={{ ...session, status: 'in_progress', setup_confirmed: true }} exercise={null} view="game" {...callbacks}/>)
  expect(mounts).toBe(1)
  expect(observed.at(-1)!.workflow!.game.attempt).toBeGreaterThan(first)
  expect(observed.at(-1)!.workflow!.game.setupReady).toBe(true)
})

it('serializes invalidation before the next calibration obtains its revision', async () => {
  let finish!: (value: RehabSession) => void
  vi.mocked(rehabApi.invalidateSetup).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<ClinicalWorkspace session={session} exercise={null} view="setup" {...callbacks}/>)
  fireEvent.click(screen.getByText('save setup'))
  fireEvent.click(screen.getByText('invalidate setup'))
  await waitFor(() => expect(rehabApi.invalidateSetup).toHaveBeenCalledOnce())
  let revision = -1
  const requested = observed.at(-1)!.workflow!.beforeCalibrationSave().then(value => { revision = value })
  expect(revision).toBe(-1)
  await act(async () => { finish({ ...session, setup_revision: 1 }); await requested })
  expect(revision).toBe(1)
  expect(observed.at(-1)!.workflow!.game.setupReady).toBe(false)
  expect(callbacks.onSetupInvalidated).toHaveBeenCalledOnce()
})

it('passes the drawing renderer through the same clinical trial lifecycle in training', async () => {
  vi.mocked(rehabApi.createTrial).mockResolvedValue({ id: 18 } as Awaited<ReturnType<typeof rehabApi.createTrial>>)
  render(<ClinicalWorkspace session={{ ...session, status: 'in_progress' }} exercise={drawing} view="game" {...callbacks}/>)
  const game = observed.at(-1)!.workflow!.game
  expect(game.renderer).toBe('free_drawing')
  await expect(game.createTrial('same-round')).resolves.toBe(18)
  expect(rehabApi.createTrial).toHaveBeenCalledWith(7, 2, 'same-round')
})

it('does not start drawing as an assessment even with a mismatched catalog item', async () => {
  render(<ClinicalWorkspace session={{ ...session, session_type: 'assessment' }} exercise={drawing} view="game" {...callbacks}/>)
  await expect(observed.at(-1)!.workflow!.game.createTrial('assessment-round')).rejects.toThrow()
  expect(rehabApi.createTrial).not.toHaveBeenCalled()
})

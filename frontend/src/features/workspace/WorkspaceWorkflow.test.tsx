import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WorkspacePage from './WorkspacePage'
import { api } from '../../services/api'
import type { WorkspaceWorkflow } from './gameWorkflow'
import type { Session } from '../../types'

vi.mock('../../services/api', () => ({ api: { sessions: vi.fn().mockResolvedValue([]) } }))
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: {}, PoseLandmarker: {}, HandLandmarker: {} }))
const session: Session = { id: 77, patient_id: 9, affected_side: 'left', session_type: 'training', status: 'draft', started_at: null, ended_at: null, notes: null, created_at: '' }
const stop = vi.fn()
const config = (): WorkspaceWorkflow => ({ view: 'setup', game: { enabled: false, setupReady: false, exerciseId: null, attempt: 0, createTrial: vi.fn(), onResultSaved: vi.fn() }, beforeCalibrationSave: vi.fn().mockResolvedValue(7), onSetupSaved: vi.fn(), onSetupInvalidated: vi.fn() })
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const track = { label: 'Test camera', getSettings: () => ({ width: 1280, height: 720, deviceId: 'camera-1' }), addEventListener: vi.fn(), stop }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }), enumerateDevices: vi.fn().mockResolvedValue([]) } })
  vi.mocked(api.sessions).mockClear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); stop.mockClear() })
async function openCamera() {
  fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
  await screen.findByRole('button', { name: 'Tắt camera' })
  fireEvent.click(screen.getByLabelText('Nhân viên đã kiểm tra camera và tư thế người tập'))
}

it('keeps the same camera and confirmation across workflow views and session status updates', async () => {
  const workflow = config()
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 21, confirmed: true }) })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<WorkspacePage session={session} workflow={workflow}/>)
  expect(api.sessions).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Phiên tập')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Chạy demo' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Bắt đầu thu dữ liệu' })).not.toBeInTheDocument()
  await openCamera()
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp theo' }))
  await waitFor(() => expect(workflow.onSetupSaved).toHaveBeenCalledWith(21))
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ session_id: 77, confirmed: true, setup_revision: 7 })
  view.rerender(<WorkspacePage session={{ ...session, status: 'in_progress' }} workflow={{ ...workflow, view: 'game' }}/>)
  view.rerender(<WorkspacePage session={{ ...session, status: 'in_progress' }} workflow={{ ...workflow, view: 'monitor' }}/>)
  expect(screen.getByLabelText('Nhân viên đã kiểm tra camera và tư thế người tập')).toBeChecked()
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  view.unmount()
  expect(stop).toHaveBeenCalledOnce()
})

it('invalidates a saved setup when the chair or patient position must be checked again', async () => {
  const workflow = config()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 21, confirmed: true }) }))
  render(<WorkspacePage session={session} workflow={workflow}/>)
  await openCamera()
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp theo' }))
  await waitFor(() => expect(workflow.onSetupSaved).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByLabelText('Nhân viên đã kiểm tra camera và tư thế người tập'))
  await waitFor(() => expect(workflow.onSetupInvalidated).toHaveBeenCalled())
  expect(screen.getByLabelText('Nhân viên đã kiểm tra camera và tư thế người tập')).not.toBeChecked()
})

it('requires explicit research permissions in clinical setup and does not start capture on view changes', async () => {
  const workflow = config()
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<WorkspacePage session={session} workflow={workflow}/>)
  expect(screen.getByLabelText('Cho phép thu landmark cho các lượt chơi')).not.toBeChecked()
  expect(screen.getByLabelText('Cho phép ghi video nguồn cho các lượt chơi')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('Cho phép thu landmark cho các lượt chơi'))
  view.rerender(<WorkspacePage session={session} workflow={{ ...workflow, view: 'game' }}/>)
  expect(screen.getByText(/Không thu do chưa đủ quyền video và landmark/)).toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not approve a calibration response received after the camera was stopped', async () => {
  const workflow = config()
  let finish!: (response: unknown) => void
  const fetchMock = vi.fn(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetchMock)
  render(<WorkspacePage session={session} workflow={workflow}/>)
  await openCamera()
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp theo' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' }))
  await act(async () => finish({ ok: true, json: async () => ({ id: 21, confirmed: true }) }))
  expect(workflow.onSetupSaved).not.toHaveBeenCalled()
  expect(workflow.onSetupInvalidated).toHaveBeenCalled()
})

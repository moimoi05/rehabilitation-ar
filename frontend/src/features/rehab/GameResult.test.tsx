import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GameResult from './GameResult'
import ExerciseCatalog from './ExerciseCatalog'
import type { Exercise } from '../../types/rehab'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const drawing: Exercise = { id: 2, code: 'free_drawing', renderer: 'free_drawing', name: 'Vẽ tự do', description: '', instructions: '', exercise_type: 'game', usage_mode: 'training', active: true, is_default: false, default_duration_seconds: 60 }
const common = { id: 3, trial_id: 8, session_id: 7, round_id: 'drawing-round', duration_seconds: 12.5, created_at: '' }
const actions = { onContinue: vi.fn(), onReturn: vi.fn() }

it('shows drawing activity without inventing game scores or targets', () => {
  render(<GameResult result={{ ...common, game_key: 'free_drawing', completed_strokes: 4, active_drawing_seconds: 8 }} exercise={drawing} {...actions}/> )
  expect(screen.getByText('Số nét đã hoàn tất')).toBeInTheDocument()
  expect(screen.getByText('4')).toBeInTheDocument()
  expect(screen.getByText('8.0 giây')).toBeInTheDocument()
  expect(screen.queryByText('Điểm trò chơi')).not.toBeInTheDocument()
  expect(screen.queryByText('Số mục tiêu')).not.toBeInTheDocument()
})

it('keeps Flower results readable with their existing score and targets', () => {
  render(<GameResult result={{ ...common, game_key: 'glowing_flower', score: 2, target_count: 3 }} exercise={null} {...actions}/> )
  expect(screen.getByText('Điểm trò chơi')).toBeInTheDocument()
  expect(screen.getByText('2')).toBeInTheDocument()
  expect(screen.getByText('Số mục tiêu')).toBeInTheDocument()
})

it('makes the implemented drawing renderer playable for both managed workflows', () => {
  render(<ExerciseCatalog exercises={[drawing, { ...drawing, id: 3, name: 'Không hỗ trợ', renderer: 'unknown' }, { ...drawing, id: 4, name: 'Sai phân hệ', usage_mode: 'assessment' }]} onPlay={vi.fn()}/> )
  expect(screen.getByRole('button', { name: 'Thực hiện Vẽ tự do' })).toBeEnabled()
  expect(screen.queryByText('Không hỗ trợ')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Thực hiện Sai phân hệ' })).toBeEnabled()
})

it('refreshes this trial capture after the saved gameplay result appears', async () => {
  const capture = { id: 'trial-capture', trial_id: 8, status: 'recording', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: null }
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [capture] }).mockResolvedValueOnce({ ok: true, json: async () => [{ ...capture, status: 'complete', artifact_summary: { video_status: 'complete', frames_status: 'complete', landmarks_status: 'complete', manifest_status: 'complete' } }] })
  vi.stubGlobal('fetch', fetchMock)
  render(<GameResult result={{ ...common, game_key: 'glowing_flower', score: 2, target_count: 3 }} exercise={null} {...actions}/> )
  expect(await screen.findByText(/Capture trial-capture/)).toBeInTheDocument()
  expect(fetchMock.mock.calls[0][0]).toContain('/api/trials/8/captures')
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật trạng thái dữ liệu' }))
  expect(await screen.findByRole('link', { name: 'Tải manifest' })).toBeInTheDocument()
  expect(screen.getByText(/frames complete.*landmarks complete.*video complete.*manifest complete/)).toBeInTheDocument()
})

it('ignores an old capture response when a different trial result is rendered', async () => {
  let finishOld!: (response: unknown) => void
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockResolvedValue({ ok: true, json: async () => [] })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<GameResult result={{ ...common, game_key: 'glowing_flower', score: 2, target_count: 3 }} exercise={null} {...actions}/> )
  view.rerender(<GameResult result={{ ...common, trial_id: 9, game_key: 'glowing_flower', score: 2, target_count: 3 }} exercise={null} {...actions}/> )
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  await act(async () => finishOld({ ok: true, json: async () => [{ id: 'old-capture', trial_id: 8, status: 'complete', source_type: 'webcam', record_video: false, record_landmarks: false, artifact_summary: null }] }))
  expect(screen.queryByText(/old-capture/)).not.toBeInTheDocument()
})

it('keeps result success separate from a failed artifact status request', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
  render(<GameResult result={{ ...common, game_key: 'glowing_flower', score: 2, target_count: 3 }} exercise={null} {...actions}/> )
  expect(await screen.findByText(/Chưa kiểm tra được dữ liệu nghiên cứu/)).toBeInTheDocument()
  expect(screen.getByText('Đã lưu')).toBeInTheDocument()
})

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFlowerGame } from './useFlowerGame'
import type { FlowerWorkflow } from './gameWorkflow'
import type { Session } from '../../types'

const session: Session = { id: 7, patient_id: 3, affected_side: 'left', session_type: 'training', status: 'in_progress', started_at: null, ended_at: null, notes: null, created_at: '' }
const pose = { current: { pose: Array.from({ length: 17 }, () => ({ x: .35, y: .5, visibility: 1 })), hands: [] } }
const poseTime = { current: 100 }
let frame: FrameRequestCallback
function Harness({ workflow, tracking = true }: { workflow: FlowerWorkflow; tracking?: boolean }) {
  const game = useFlowerGame({ demo: false, streamActive: true, tracking, mirrored: false, side: 'left', confirmed: true, session, size: { width: 1280, height: 720 }, pose, poseTime, workflow })
  return <>{game.panel}{game.hud}{game.overlay}</>
}
function tick(time: number) {
  act(() => { const clock = vi.spyOn(performance, 'now').mockReturnValue(time); try { frame(time) } finally { clock.mockRestore() } })
}
const workflow = (changes: Partial<FlowerWorkflow> = {}): FlowerWorkflow => ({ enabled: true, setupReady: true, exerciseId: 2, exerciseName: 'Hái hoa · Luyện tầm với', attempt: 1, createTrial: vi.fn().mockResolvedValue(19), onResultSaved: vi.fn(), ...changes })
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('waits for a persisted trial and saves the same trial on an uncertain retry', async () => {
  let finishTrial!: (id: number) => void
  const config = workflow({ createTrial: vi.fn(() => new Promise(resolve => { finishTrial = resolve })) })
  const saved = { id: 11, trial_id: 19, session_id: 7, round_id: '00000000-0000-4000-8000-000000000001', game_key: 'glowing_flower', duration_seconds: .15, score: 1, target_count: 2, created_at: '' }
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, json: async () => saved })
  vi.stubGlobal('fetch', fetchMock)
  render(<Harness workflow={config}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  expect(config.createTrial).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Dừng' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Đang chuẩn bị…' })).toBeDisabled()
  await act(async () => finishTrial(19))
  tick(100); tick(250)
  fireEvent.click(screen.getByRole('button', { name: 'Dừng' }))
  expect(screen.queryByRole('button', { name: 'Lượt mới' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu kết quả' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Thử lưu lại' }))
  await waitFor(() => expect(config.onResultSaved).toHaveBeenCalledWith(saved))
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ session_id: 7, trial_id: 19 })
  expect(fetchMock.mock.calls[0][1].body).toEqual(fetchMock.mock.calls[1][1].body)
  expect(config.createTrial).toHaveBeenCalledOnce()
})

it('requires saved setup and an explicitly selected available game', () => {
  const view = render(<Harness workflow={workflow({ setupReady: false })}/>)
  expect(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })).toBeDisabled()
  view.rerender(<Harness workflow={workflow({ exerciseId: null })}/>)
  expect(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })).toBeDisabled()
  view.rerender(<Harness workflow={workflow({ enabled: false })}/>)
  expect(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })).toBeDisabled()
})

it('keeps failed trial creation out of the game and reports a clear error', async () => {
  render(<Harness workflow={workflow({ createTrial: vi.fn().mockRejectedValue(new Error('Bài tập chưa được chỉ định.')) })}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  expect(await screen.findByText('Bài tập chưa được chỉ định.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Dừng' })).not.toBeInTheDocument()
})

it('ignores a trial created after setup was invalidated', async () => {
  let finishTrial!: (id: number) => void
  const config = workflow({ createTrial: vi.fn(() => new Promise(resolve => { finishTrial = resolve })), onRoundAbandoned: vi.fn() })
  const view = render(<Harness workflow={config}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  view.rerender(<Harness workflow={{ ...config, setupReady: false }}/>)
  await act(async () => finishTrial(19))
  expect(screen.queryByRole('button', { name: 'Dừng' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })).toBeDisabled()
  expect(config.onRoundAbandoned).toHaveBeenCalledOnce()
})

it('cancels the managed trial when tracking is stopped during a round', async () => {
  const config = workflow({ onRoundAbandoned: vi.fn() })
  const view = render(<Harness workflow={config}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await screen.findByRole('button', { name: 'Dừng' })
  view.rerender(<Harness workflow={config} tracking={false}/>)
  await waitFor(() => expect(config.onRoundAbandoned).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'Xác nhận lưu kết quả' })).not.toBeInTheDocument()
})

it('lets staff cancel a round with no observed data without making a result or repeating setup', async () => {
  const config = workflow({ cancelTrial: vi.fn().mockResolvedValue(undefined) })
  render(<Harness workflow={config}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Dừng' }))
  expect(screen.getByRole('button', { name: 'Xác nhận lưu kết quả' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Hủy lượt chưa có dữ liệu' }))
  await waitFor(() => expect(config.cancelTrial).toHaveBeenCalledWith(19))
  expect(config.onResultSaved).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })).toBeEnabled()
})

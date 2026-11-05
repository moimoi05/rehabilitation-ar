import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFlowerGame } from './useFlowerGame'
import type { FlowerWorkflow, ResearchTrialCapture } from './gameWorkflow'
import type { Session } from '../../types'

const session: Session = { id: 7, patient_id: 3, affected_side: 'left', session_type: 'training', status: 'in_progress', started_at: null, ended_at: null, notes: null, created_at: '' }
const pose = { current: { pose: Array.from({ length: 17 }, () => ({ x: .35, y: .5, visibility: 1 })), hands: [] } }
const poseTime = { current: 100 }
let frame: FrameRequestCallback
function Harness({ workflow, tracking = true, researchCapture }: { workflow: FlowerWorkflow; tracking?: boolean; researchCapture?: ResearchTrialCapture }) {
  const game = useFlowerGame({ demo: false, streamActive: true, tracking, mirrored: false, side: 'left', confirmed: true, session, size: { width: 1280, height: 720 }, pose, poseTime, workflow, researchCapture })
  return <>{game.panel}{game.hud}{game.overlay}</>
}
function tick(time: number) {
  act(() => { const clock = vi.spyOn(performance, 'now').mockReturnValue(time); try { frame(time) } finally { clock.mockRestore() } })
}
const workflow = (changes: Partial<FlowerWorkflow> = {}): FlowerWorkflow => ({ enabled: true, setupReady: true, exerciseId: 2, exerciseName: 'Hái hoa · Luyện tầm với', attempt: 1, createTrial: vi.fn().mockResolvedValue(19), onResultSaved: vi.fn(), ...changes })
beforeEach(() => {
  poseTime.current = 100
  pose.current.pose = Array.from({ length: 17 }, () => ({ x: .35, y: .5, visibility: 1 }))
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

it('waits for per-trial research preparation and closes its retained owner once at gameplay end', async () => {
  let ready!: () => void
  const researchCapture = { prepare: vi.fn(() => new Promise<void>(resolve => { ready = resolve })), started: vi.fn(), stopped: vi.fn() }
  const nextOwner = { prepare: vi.fn(), started: vi.fn(), stopped: vi.fn() }
  const config = workflow()
  const view = render(<Harness workflow={config} researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await waitFor(() => expect(researchCapture.prepare).toHaveBeenCalledWith(19, 'glowing_flower'))
  expect(screen.queryByRole('button', { name: 'Dừng' })).not.toBeInTheDocument()
  expect(researchCapture.started).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Đang chuẩn bị…' }))
  expect(config.createTrial).toHaveBeenCalledOnce()
  await act(async () => ready())
  expect(researchCapture.started).toHaveBeenCalledWith(expect.any(Number))
  view.rerender(<Harness workflow={config} researchCapture={nextOwner}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Dừng' }))
  expect(researchCapture.stopped).toHaveBeenCalledWith('stopped', expect.any(Number))
  view.unmount()
  expect(researchCapture.stopped).toHaveBeenCalledOnce()
  expect(nextOwner.stopped).not.toHaveBeenCalled()
})

it('closes research preparation invalidated before gameplay and never starts that stale round', async () => {
  let ready!: () => void
  const researchCapture = { prepare: vi.fn(() => new Promise<void>(resolve => { ready = resolve })), started: vi.fn(), stopped: vi.fn() }
  const config = workflow({ onRoundAbandoned: vi.fn() })
  const view = render(<Harness workflow={config} researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await waitFor(() => expect(researchCapture.prepare).toHaveBeenCalledOnce())
  view.rerender(<Harness workflow={config} researchCapture={researchCapture} tracking={false}/>)
  expect(researchCapture.stopped).toHaveBeenCalledWith('context_changed', expect.any(Number))
  await act(async () => ready())
  expect(researchCapture.started).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Dừng' })).not.toBeInTheDocument()
  expect(researchCapture.stopped).toHaveBeenCalledOnce()
})

it.each([
  ['resolve', false], ['reject', false], ['resolve', true], ['reject', true],
] as const)('isolates old preparation %s and cancellation failure=%s from the next flower trial', async (outcome, cleanupFails) => {
  let oldReady!: () => void
  const first = { prepare: vi.fn(() => new Promise<void>((resolve, reject) => { oldReady = () => outcome === 'resolve' ? resolve() : reject(new Error('Capture unavailable')) })), started: vi.fn(), stopped: vi.fn() }
  const second = { prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped: vi.fn() }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const config = workflow({
    createTrial: vi.fn().mockResolvedValueOnce(19).mockResolvedValueOnce(20),
    cancelTrial: cleanupFails ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue(undefined),
    onRoundAbandoned: vi.fn(),
  })
  const view = render(<Harness workflow={config} researchCapture={first}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await waitFor(() => expect(first.prepare).toHaveBeenCalledOnce())
  view.rerender(<Harness workflow={{ ...config, attempt: 2 }} researchCapture={second}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await screen.findByRole('button', { name: 'Dừng' })
  await act(async () => oldReady())
  expect(first.stopped).toHaveBeenCalledOnce()
  expect(second.stopped).not.toHaveBeenCalled()
  expect(second.started).toHaveBeenCalledOnce()
  expect(config.cancelTrial).toHaveBeenCalledWith(19)
  expect(config.cancelTrial).not.toHaveBeenCalledWith(20)
  expect(config.onRoundAbandoned).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Dừng' })).toBeInTheDocument()
  expect(screen.queryByText(/Chưa xác nhận hủy lượt trước/)).not.toBeInTheDocument()
  if (cleanupFails) expect(warning).toHaveBeenCalledWith('Chưa xác nhận hủy lượt trước. Hãy kiểm tra trạng thái lượt trong Báo cáo.')
})

it('marks capture end when the prescribed flower duration completes', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100)
  const researchCapture = { prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped: vi.fn() }
  const config = workflow({ durationSeconds: .1 })
  const saved = { id: 11, trial_id: 19, session_id: 7, round_id: '00000000-0000-4000-8000-000000000001', game_key: 'glowing_flower', duration_seconds: .1, score: 1, target_count: 2, created_at: '' }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => saved })
  vi.stubGlobal('fetch', fetchMock)
  render(<Harness workflow={config} researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await screen.findByRole('button', { name: 'Dừng' })
  await act(async () => {})
  tick(100); tick(250)
  expect(researchCapture.stopped).toHaveBeenCalledWith('completed', 250)
  await waitFor(() => expect(config.onResultSaved).toHaveBeenCalledWith(saved))
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ trial_id: 19, round_id: saved.round_id })
})

it('records only accepted touches and observations on its original owner, including tracking loss', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100)
  const first = { prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped: vi.fn(), event: vi.fn(), sample: vi.fn() }
  const next = { ...first, event: vi.fn(), sample: vi.fn() }
  const config = workflow()
  const view = render(<Harness workflow={config} researchCapture={first}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
  await screen.findByRole('button', { name: 'Dừng' })
  view.rerender(<Harness workflow={config} researchCapture={next}/>)
  tick(100); tick(200); tick(250)
  expect(first.event.mock.calls.filter(([type]) => type === 'TARGET_TOUCHED')).toHaveLength(1)
  expect(first.sample).toHaveBeenCalledOnce()
  expect(first.sample.mock.calls[0][2]).toMatchObject({ timestamp: 100, sourceTimestamp: 100 })
  tick(400); tick(450)
  expect(first.event.mock.calls.filter(([type]) => type === 'TRACKING_LOST')).toHaveLength(1)
  expect(first.event.mock.calls.filter(([type]) => type === 'TARGET_TOUCHED')).toHaveLength(1)
  poseTime.current = 500; pose.current.pose[15] = { x: .6, y: .43, visibility: 1 }
  tick(500)
  expect(first.event.mock.calls.filter(([type]) => type === 'TRACKING_RECOVERED')).toHaveLength(1)
  expect(first.event.mock.calls.filter(([type]) => type === 'TARGET_TOUCHED')).toHaveLength(2)
  expect(first.event.mock.calls.filter(([type]) => type === 'TARGET_RELEASE_GATE_CLEARED')).toHaveLength(1)
  expect(next.event).not.toHaveBeenCalled()
  expect(next.sample).not.toHaveBeenCalled()
  const staleFrame = frame
  view.rerender(<Harness workflow={{ ...config, attempt: 2 }} researchCapture={next}/>)
  const count = first.event.mock.calls.length
  act(() => staleFrame(600))
  expect(first.event).toHaveBeenCalledTimes(count)
  expect(next.event).not.toHaveBeenCalled()
})

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFreeDrawingGame } from './useFreeDrawingGame'
import * as drawingRenderer from './freeDrawingRenderer'
import { DrawingController } from './freeDrawing'
import type { FlowerWorkflow, ResearchTrialCapture } from './gameWorkflow'
import type { Session } from '../../types'

const session: Session = { id: 7, patient_id: 3, affected_side: 'left', session_type: 'training', status: 'in_progress', started_at: null, ended_at: null, notes: null, created_at: '' }
const mapping = { current: { box: { width: 1280, height: 720 }, rect: { x: 0, y: 0, width: 1280, height: 720 } } }
const displayBox = { current: { width: 1280, height: 720 } }
let clockNow = 100
const workflow = (changes: Partial<FlowerWorkflow> = {}): FlowerWorkflow => ({ enabled: true, setupReady: true, exerciseId: 2, attempt: 1, createTrial: vi.fn().mockResolvedValue(19), cancelTrial: vi.fn().mockResolvedValue(undefined), onResultSaved: vi.fn(), ...changes })
function Harness({ config, tracking = true, demo = false, developmentReplay = false, noSession = false, cursorX = .3, researchCapture, sessionType = 'training' }: { config?: FlowerWorkflow; tracking?: boolean; demo?: boolean; developmentReplay?: boolean; noSession?: boolean; cursorX?: number; researchCapture?: ResearchTrialCapture; sessionType?: Session['session_type'] }) {
  const game = useFreeDrawingGame({ enabled: true, demo, streamActive: !demo, tracking, mirrored: false, side: 'left', confirmed: true, session: noSession ? undefined : { ...session, session_type: sessionType }, size: { width: 1280, height: 720 }, mapping, displayBox, workflow: config, developmentReplay, researchCapture })
  return <>{game.overlay}{game.hud}{game.panel}<button onClick={() => {
    const hand = Array.from({ length: 21 }, () => ({ x: cursorX, y: .5, z: 0 }))
    hand[9] = { x: cursorX, y: .4, z: 0 }
    game.onHandObservation({ timestamp: clockNow, frameId: clockNow, hands: [hand], handedness: [[{ categoryName: 'Left', score: .98 }]] })
  }}>Observation</button><button onClick={game.resetReplay}>Reset replay</button><button onClick={() => game.cancelResearch('source_reset')}>Reset source</button></>
}
beforeEach(() => {
  clockNow = 100
  vi.spyOn(performance, 'now').mockImplementation(() => clockNow)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('waits for research readiness and stops its original capture at the actual game end', async () => {
  let ready!: () => void
  const researchCapture = { prepare: vi.fn(() => new Promise<void>(resolve => { ready = resolve })), started: vi.fn(), stopped: vi.fn() }
  const nextOwner = { prepare: vi.fn(), started: vi.fn(), stopped: vi.fn() }
  const config = workflow()
  const view = render(<Harness config={config} researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await waitFor(() => expect(researchCapture.prepare).toHaveBeenCalledWith(19, 'free_drawing', expect.objectContaining({ mode: 'gesture', interaction_mode: 'draw', cursor_source: 'index', pen_width: 5, logical_canvas: { width: 1000, height: 562.5 } })))
  expect(screen.queryByRole('button', { name: 'Kết thúc bài vẽ' })).not.toBeInTheDocument()
  expect(researchCapture.started).not.toHaveBeenCalled()
  clockNow = 1000
  await act(async () => ready())
  expect(researchCapture.started).toHaveBeenCalledWith(1000)
  view.rerender(<Harness config={config} researchCapture={nextOwner}/>)
  clockNow = 1250
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(researchCapture.stopped).toHaveBeenCalledWith('stopped', 1250)
  view.unmount()
  expect(researchCapture.stopped).toHaveBeenCalledOnce()
  expect(nextOwner.stopped).not.toHaveBeenCalled()
})

it('keeps telemetry on its captured round and rejects observations from before the next trial', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
  const owner = () => ({ prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped: vi.fn(), event: vi.fn(), sample: vi.fn() })
  const first = owner(), next = owner(), config = workflow()
  const view = render(<Harness config={config} researchCapture={first}/>)
  fireEvent.change(screen.getByRole('combobox', { name: 'Chế độ vẽ' }), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  clockNow = 180; fireEvent.click(screen.getByRole('button', { name: 'Hạ bút', exact: true }))
  clockNow = 199; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  view.rerender(<Harness config={config} researchCapture={next}/>)
  clockNow = 232; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  clockNow = 250; fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(first.event.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['GAME_STARTED', 'PEN_DOWN', 'STROKE_STARTED', 'STROKE_COMPLETED', 'PEN_UP', 'GAME_COMPLETED']))
  expect(first.sample).toHaveBeenCalledTimes(2)
  expect(next.event).not.toHaveBeenCalled(); expect(next.sample).not.toHaveBeenCalled()
  await screen.findByRole('button', { name: 'Thử lưu lại' })
  clockNow = 1000
  view.rerender(<Harness config={{ ...config, attempt: 2 }} researchCapture={next}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  const update = vi.spyOn(DrawingController.prototype, 'update')
  clockNow = 232; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  expect(update).not.toHaveBeenCalled()
  expect(next.sample).not.toHaveBeenCalled()
})

it('closes the active stroke as source-reset interruption before cancelling its capture', async () => {
  const event = vi.fn(), stopped = vi.fn()
  const researchCapture = { prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped, event, sample: vi.fn() }
  render(<Harness config={workflow()} researchCapture={researchCapture}/>)
  fireEvent.change(screen.getByRole('combobox', { name: 'Chế độ vẽ' }), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  clockNow = 180; fireEvent.click(screen.getByRole('button', { name: 'Hạ bút', exact: true }))
  clockNow = 199; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  clockNow = 210; fireEvent.click(screen.getByRole('button', { name: 'Reset source' }))
  expect(event).toHaveBeenCalledWith('STROKE_COMPLETED', expect.objectContaining({ reason: 'source_reset', interrupted: true }), { timestamp: 210 })
  expect(event).toHaveBeenCalledWith('PEN_UP', expect.objectContaining({ reason: 'source_reset' }), { timestamp: 210 })
  expect(event.mock.calls.at(-1)?.[0]).toBe('GAME_CANCELLED')
  expect(stopped).toHaveBeenCalledWith('source_reset', 210)
})

it('never starts research for standalone or demo drawing', () => {
  const researchCapture = { prepare: vi.fn(), started: vi.fn(), stopped: vi.fn() }
  const view = render(<Harness demo researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  view.unmount()
  render(<Harness noSession researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  expect(researchCapture.prepare).not.toHaveBeenCalled()
  expect(researchCapture.started).not.toHaveBeenCalled()
  expect(researchCapture.stopped).not.toHaveBeenCalled()
})

it('closes pending drawing capture on unmount without starting gameplay later', async () => {
  let ready!: () => void
  const researchCapture = { prepare: vi.fn(() => new Promise<void>(resolve => { ready = resolve })), started: vi.fn(), stopped: vi.fn() }
  const view = render(<Harness config={workflow()} researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await waitFor(() => expect(researchCapture.prepare).toHaveBeenCalledOnce())
  clockNow = 200; view.unmount()
  expect(researchCapture.stopped).toHaveBeenCalledWith('unmounted', 200)
  await act(async () => ready())
  expect(researchCapture.started).not.toHaveBeenCalled()
  expect(researchCapture.stopped).toHaveBeenCalledOnce()
})

it.each([
  ['resolve', false], ['reject', false], ['resolve', true], ['reject', true],
] as const)('isolates old preparation %s and cancellation failure=%s from the next drawing trial', async (outcome, cleanupFails) => {
  let oldReady!: () => void
  const first = { prepare: vi.fn(() => new Promise<void>((resolve, reject) => { oldReady = () => outcome === 'resolve' ? resolve() : reject(new Error('Capture unavailable')) })), started: vi.fn(), stopped: vi.fn() }
  const second = { prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped: vi.fn() }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const config = workflow({
    createTrial: vi.fn().mockResolvedValueOnce(19).mockResolvedValueOnce(20),
    cancelTrial: cleanupFails ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue(undefined),
    onRoundAbandoned: vi.fn(),
  })
  const view = render(<Harness config={config} researchCapture={first}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await waitFor(() => expect(first.prepare).toHaveBeenCalledOnce())
  view.rerender(<Harness config={{ ...config, attempt: 2 }} researchCapture={second}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  await act(async () => oldReady())
  expect(first.stopped).toHaveBeenCalledOnce()
  expect(second.stopped).not.toHaveBeenCalled()
  expect(second.started).toHaveBeenCalledOnce()
  expect(config.cancelTrial).toHaveBeenCalledWith(19)
  expect(config.cancelTrial).not.toHaveBeenCalledWith(20)
  expect(config.onRoundAbandoned).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Kết thúc bài vẽ' })).toBeInTheDocument()
  expect(screen.queryByText(/Chưa xác nhận hủy lượt trước/)).not.toBeInTheDocument()
  if (cleanupFails) expect(warning).toHaveBeenCalledWith('Chưa xác nhận hủy lượt trước. Hãy kiểm tra trạng thái lượt trong Báo cáo.')
})

it('keeps research capture open past the former deadline until the user stops', async () => {
  let frame!: FrameRequestCallback
  vi.mocked(requestAnimationFrame).mockImplementation(callback => { frame = callback; return 1 })
  const researchCapture = { prepare: vi.fn().mockResolvedValue(undefined), started: vi.fn(), stopped: vi.fn() }
  render(<Harness config={workflow({ durationSeconds: 60 })} researchCapture={researchCapture}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  clockNow = 60100; act(() => frame(clockNow))
  expect(researchCapture.stopped).not.toHaveBeenCalled()
  clockNow = 700100; act(() => frame(clockNow))
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(researchCapture.stopped).toHaveBeenCalledWith('stopped', 700100)
})

it('waits for a persisted clinical trial before drawing and allows cancelling an empty round', async () => {
  let resolveTrial!: (id: number) => void
  const config = workflow({ createTrial: vi.fn(() => new Promise(resolve => { resolveTrial = resolve })) })
  render(<Harness config={config} />)
  expect(screen.getByLabelText('Chế độ vẽ')).toHaveValue('gesture')
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  expect(config.createTrial).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Kết thúc bài vẽ' })).not.toBeInTheDocument()
  await act(async () => resolveTrial(19))
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(config.onResultSaved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Hủy lượt chưa có dữ liệu' }))
  await waitFor(() => expect(config.cancelTrial).toHaveBeenCalledWith(19))
  expect(config.onResultSaved).not.toHaveBeenCalled()
})

it('offers cancellation retry, not result retry, when cancelling an empty round fails', async () => {
  const config = workflow({ cancelTrial: vi.fn().mockRejectedValueOnce(new Error('Không hủy được')).mockResolvedValueOnce(undefined) })
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  render(<Harness config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Kết thúc bài vẽ' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hủy lượt chưa có dữ liệu' }))
  await screen.findByText('Không hủy được')
  expect(screen.queryByRole('button', { name: 'Thử lưu lại' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Hủy lượt chưa có dữ liệu' }))
  await waitFor(() => expect(config.cancelTrial).toHaveBeenCalledTimes(2))
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not start a trial returned after setup changes', async () => {
  let resolveTrial!: (id: number) => void
  const config = workflow({ createTrial: vi.fn(() => new Promise(resolve => { resolveTrial = resolve })), onRoundAbandoned: vi.fn() })
  const view = render(<Harness config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  view.rerender(<Harness config={{ ...config, setupReady: false }} />)
  await act(async () => resolveTrial(19))
  expect(config.onRoundAbandoned).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Kết thúc bài vẽ' })).not.toBeInTheDocument()
})

it('counts elapsed time after authorization and blocks drawing after the user finishes', async () => {
  let frame!: FrameRequestCallback
  let resolveTrial!: (id: number) => void
  vi.mocked(requestAnimationFrame).mockImplementation(callback => { frame = callback; return 1 })
  const update = vi.spyOn(DrawingController.prototype, 'update')
  const config = workflow({ durationSeconds: 60, createTrial: vi.fn(() => new Promise(resolve => { resolveTrial = resolve })) })
  render(<Harness config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  clockNow = 10100
  act(() => frame(clockNow))
  await act(async () => resolveTrial(19))
  const hud = within(screen.getByRole('group', { name: 'Điều khiển bài vẽ' }))
  expect(hud.getByText('0s · 0 nét')).toBeInTheDocument()
  clockNow = 70100
  act(() => frame(clockNow))
  expect(hud.getByText('60s · 0 nét')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(hud.getByText('Bài vẽ đã kết thúc')).toBeInTheDocument()
  expect(screen.getByLabelText('Bài vẽ đã kết thúc')).toHaveTextContent('Không thể vẽ hoặc di chuyển nét')
  fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  expect(update).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Vẽ lượt mới' })).not.toBeInTheDocument()
  expect(config.createTrial).toHaveBeenCalledOnce()
})

it('offers an explicit standalone new round and mutually exclusive draw and move controls', () => {
  render(<Harness demo />)
  const draw = screen.getByRole('button', { name: 'Vẽ', exact: true })
  const move = screen.getByRole('button', { name: 'Chọn / Di chuyển', exact: true })
  expect(draw).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(move)
  expect(draw).toHaveAttribute('aria-pressed', 'false')
  expect(move).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('Đưa con trỏ đến nét vẽ, chọn Cầm nét, di chuyển tay rồi chọn Thả nét.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  fireEvent.click(screen.getByRole('button', { name: 'Vẽ lượt mới' }))
  expect(screen.getByRole('button', { name: 'Bắt đầu vẽ' })).toBeEnabled()
  fireEvent.click(draw)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  expect(screen.getByRole('button', { name: 'Kết thúc bài vẽ' })).toBeInTheDocument()
})

it('allows calibrated live standalone practice without creating or saving a clinical trial', () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  const view = render(<Harness noSession />)
  const start = screen.getByRole('button', { name: 'Bắt đầu vẽ' })
  expect(start).toBeEnabled()
  fireEvent.click(start)
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(screen.queryByRole('button', { name: 'Xác nhận lưu kết quả' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
  const config = workflow()
  view.rerender(<Harness config={config} noSession />)
  expect(screen.getByRole('button', { name: 'Bắt đầu vẽ' })).toBeDisabled()
  expect(config.createTrial).not.toHaveBeenCalled()
})

it('accepts a demo pointer past the former deadline when animation frames are delayed', () => {
  class DemoPointerEvent extends MouseEvent { pointerId = 1 }
  vi.stubGlobal('PointerEvent', DemoPointerEvent)
  const updatePointer = vi.spyOn(DrawingController.prototype, 'updatePointer')
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 720 } as DOMRect)
  render(<Harness demo />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  clockNow = 120100
  fireEvent.pointerMove(screen.getByLabelText('Vùng vẽ demo bằng chuột hoặc chạm'), { clientX: 400, clientY: 300 })
  expect(updatePointer).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Kết thúc bài vẽ' })).toBeInTheDocument()
})

it('does not end the exercise before lowering the assisted pen when frames are delayed', async () => {
  const lowerPen = vi.spyOn(DrawingController.prototype, 'setPenDown')
  render(<Harness config={workflow({ durationSeconds: 60 })} />)
  fireEvent.change(screen.getByLabelText('Chế độ vẽ'), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  clockNow = 60100
  fireEvent.click(screen.getByRole('button', { name: 'Hạ bút', exact: true }))
  expect(lowerPen).toHaveBeenCalledWith(true)
  expect(screen.getByRole('status')).toHaveTextContent('Mất tracking')
  expect(screen.getByRole('button', { name: 'Kết thúc bài vẽ' })).toBeInTheDocument()
})

it('uses the full video lifecycle only for development replay without a clinical session', async () => {
  let frame!: FrameRequestCallback
  vi.mocked(requestAnimationFrame).mockImplementation(callback => { frame = callback; return 1 })
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  const view = render(<Harness developmentReplay noSession />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  clockNow = 180100
  act(() => frame(clockNow))
  expect(screen.getByText('Replay · Không giới hạn giờ')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Kết thúc bài vẽ' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(screen.queryByRole('button', { name: 'Xác nhận lưu kết quả' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
  const config = workflow({ durationSeconds: 60 })
  view.rerender(<Harness developmentReplay config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  expect(screen.queryByText('Replay · Không giới hạn giờ')).not.toBeInTheDocument()
  clockNow += 60000
  act(() => frame(clockNow))
  expect(screen.getByRole('button', { name: 'Kết thúc bài vẽ' })).toBeInTheDocument()
  expect(config.createTrial).toHaveBeenCalledOnce()
})

it('resets a finished replay to empty idle state and draws a second replay in the same mounted hook', () => {
  render(<Harness developmentReplay noSession />)
  fireEvent.change(screen.getByLabelText('Chế độ vẽ'), { target: { value: 'assisted' } })
  const drawRound = (startTime: number) => {
    clockNow = startTime
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
    for (const time of [startTime, startTime + 33, startTime + 66]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
    fireEvent.click(screen.getByRole('button', { name: 'Hạ bút', exact: true }))
    clockNow = startTime + 99; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Nhấc bút', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
    expect(screen.getByText('0s · 1 nét')).toBeInTheDocument()
  }
  drawRound(100)
  fireEvent.click(screen.getByRole('button', { name: 'Reset replay' }))
  expect(screen.queryByLabelText('Bài vẽ đã kết thúc')).not.toBeInTheDocument()
  expect(screen.getByText('0s · 0 nét')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Bắt đầu vẽ' })).toBeEnabled()
  drawRound(300)
})

it('ignores resetReplay for a completed clinical exercise and cannot silently authorize another trial', async () => {
  const config = workflow()
  render(<Harness config={config} developmentReplay />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Kết thúc bài vẽ' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset replay' }))
  expect(screen.getByLabelText('Bài vẽ đã kết thúc')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Bắt đầu vẽ' })).not.toBeInTheDocument()
  expect(config.createTrial).toHaveBeenCalledOnce()
})

it('accepts input in a newly authorized clinical attempt after completion', async () => {
  const update = vi.spyOn(DrawingController.prototype, 'update')
  const config = workflow()
  const view = render(<Harness config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Kết thúc bài vẽ' }))
  clockNow = 200
  fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  expect(update).not.toHaveBeenCalled()
  view.rerender(<Harness config={{ ...config, attempt: 2 }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  clockNow = 233
  fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  expect(update).toHaveBeenCalledOnce()
  expect(config.createTrial).toHaveBeenCalledTimes(2)
})

it('invalidates a running trial when tracking stops without creating a result', async () => {
  const config = workflow({ onRoundAbandoned: vi.fn() })
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  const view = render(<Harness config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  view.rerender(<Harness config={config} tracking={false} />)
  await waitFor(() => expect(config.onRoundAbandoned).toHaveBeenCalledOnce())
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Xác nhận lưu kết quả' })).not.toBeInTheDocument()
})

it('uses gesture mode in standalone demo and never exposes patient result saving', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  render(<Harness demo />)
  expect(screen.getByLabelText('Chế độ vẽ')).toHaveValue('gesture')
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Kết thúc bài vẽ' }))
  expect(screen.queryByRole('button', { name: 'Xác nhận lưu kết quả' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rebuilds artwork after the controller moves a stroke and shows the dragging state', async () => {
  const redraw = vi.spyOn(drawingRenderer, 'redrawDrawing').mockImplementation(() => undefined)
  const ctx = { setTransform: vi.fn() }
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(DrawingController.prototype, 'update').mockImplementation(function (this: DrawingController) {
    this.phase = 'dragging'
    return { phase: 'dragging', cursor: { x: 300, y: 250 }, hand: null, segment: null, artworkChanged: true }
  })
  render(<Harness config={workflow()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  redraw.mockClear()
  clockNow = 133; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  expect(redraw).toHaveBeenCalledOnce()
  expect(screen.getByRole('status')).toHaveTextContent('Đang kéo nét')
  expect(screen.queryByRole('button', { name: 'Hạ bút' })).not.toBeInTheDocument()
})

it('selects a real stroke with the hand cursor and wires assisted grab, release and undo without pinch', async () => {
  const redraw = vi.spyOn(drawingRenderer, 'redrawDrawing').mockImplementation(() => undefined)
  vi.spyOn(drawingRenderer, 'renderDrawingSegment').mockImplementation(() => undefined)
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ setTransform: vi.fn() } as unknown as CanvasRenderingContext2D)
  const config = workflow(), view = render(<Harness config={config} />)
  fireEvent.change(screen.getByLabelText('Chế độ vẽ'), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  fireEvent.click(screen.getByRole('button', { name: 'Hạ bút', exact: true }))
  clockNow = 199; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  fireEvent.click(screen.getByRole('button', { name: 'Nhấc bút', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Chọn / Di chuyển', exact: true }))
  clockNow = 232; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  const grab = screen.getByRole('button', { name: 'Cầm nét', exact: true })
  expect(grab).toBeEnabled(); fireEvent.click(grab)
  view.rerender(<Harness config={config} cursorX={.34} />)
  clockNow = 265; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  expect(redraw.mock.lastCall?.[1][0].offset?.x).toBeCloseTo(40)
  fireEvent.click(screen.getByRole('button', { name: 'Thả nét', exact: true }))
  expect(screen.getByText('0s · 1 nét')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác nét' }))
  expect(redraw.mock.lastCall?.[1][0].offset).toEqual({ x: 0, y: 0 })
  expect(redraw.mock.lastCall?.[1]).toHaveLength(1)
})

it('enables assisted grab immediately when the demo cursor selects a stroke', () => {
  class DemoPointerEvent extends MouseEvent {
    pointerId = 1
  }
  vi.stubGlobal('PointerEvent', DemoPointerEvent)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 720 } as DOMRect)
  render(<Harness demo />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  const input = screen.getByLabelText('Vùng vẽ demo bằng chuột hoặc chạm')
  clockNow = 133; fireEvent.pointerDown(input, { clientX: 400, clientY: 300 })
  clockNow = 166; fireEvent.pointerMove(input, { clientX: 450, clientY: 320 })
  clockNow = 199; fireEvent.pointerUp(input, { clientX: 450, clientY: 320 })
  fireEvent.click(screen.getByRole('button', { name: 'Chọn / Di chuyển', exact: true }))
  clockNow = 232; fireEvent.pointerMove(input, { clientX: 420, clientY: 308 })
  const grab = screen.getByRole('button', { name: 'Cầm nét', exact: true })
  expect(grab).toBeEnabled()
  fireEvent.click(grab)
  expect(screen.getByRole('button', { name: 'Thả nét', exact: true })).toBeEnabled()
})

it.each(['training', 'assessment'] as const)('retries the same %s drawing payload without inventing Flower scores', async sessionType => {
  const config = workflow()
  const result = { id: 11, trial_id: 19, session_id: 7, game_key: 'free_drawing', duration_seconds: .15, completed_strokes: 1, round_id: '00000000-0000-4000-8000-000000000001', created_at: '' }
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, json: async () => result })
  vi.stubGlobal('fetch', fetchMock)
  render(<Harness config={config} sessionType={sessionType} />)
  fireEvent.change(screen.getByLabelText('Chế độ vẽ'), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  fireEvent.click(screen.getByRole('button', { name: 'Hạ bút' }))
  clockNow = 199; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  clockNow = 250; fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  expect(config.onResultSaved).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'Thử lưu lại' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Xem kết quả' }))
  expect(config.onResultSaved).toHaveBeenCalledWith(result)
  const payload = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(payload).toMatchObject({ session_id: 7, trial_id: 19, game_key: 'free_drawing', completed_strokes: 1 })
  expect(payload).not.toHaveProperty('score')
  expect(payload).not.toHaveProperty('target_count')
  expect(fetchMock.mock.calls[0][1].body).toEqual(fetchMock.mock.calls[1][1].body)
  expect(config.createTrial).toHaveBeenCalledOnce()
})

it('automatically saves a completed clinical drawing once without requiring confirmation', async () => {
  const config = workflow()
  const result = { id: 11, trial_id: 19, session_id: 7, game_key: 'free_drawing', duration_seconds: .15, completed_strokes: 0, round_id: '00000000-0000-4000-8000-000000000001', created_at: '' }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => result })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<Harness config={config} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  clockNow = 250; fireEvent.click(screen.getByRole('button', { name: 'Kết thúc bài vẽ' }))
  const showResult = await screen.findByRole('button', { name: 'Xem kết quả' })
  expect(config.onResultSaved).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Bài vẽ đã kết thúc')).toBeInTheDocument()
  view.rerender(<Harness config={config} tracking={false} />)
  expect(screen.queryByText(/Lượt chưa được xác nhận lưu/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Xem kết quả' })).toBeEnabled()
  fireEvent.click(showResult)
  expect(config.onResultSaved).toHaveBeenCalledWith(result)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ trial_id: 19, round_id: result.round_id, game_key: 'free_drawing' })
})

it('resumes fresh affected-hand acquisition after staff confirms the physical hand', async () => {
  render(<Harness config={workflow()} />)
  fireEvent.change(screen.getByLabelText('Chế độ vẽ'), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Xác nhận lại tay bên tập' }))
  clockNow = 200
  fireEvent.click(screen.getByRole('button', { name: 'Đã kiểm tra đúng tay trái' }))
  for (const time of [233, 266, 299]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  fireEvent.click(screen.getByRole('button', { name: 'Hạ bút' }))
  expect(screen.getByRole('button', { name: 'Nhấc bút' })).toHaveAttribute('aria-pressed', 'true')
})

it('provides an explicit assisted pen control inside the fullscreen drawing HUD', async () => {
  let frame!: FrameRequestCallback
  vi.mocked(requestAnimationFrame).mockImplementation(callback => { frame = callback; return 1 })
  render(<Harness config={workflow()} />)
  fireEvent.change(screen.getByLabelText('Chế độ vẽ'), { target: { value: 'assisted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  const hud = within(screen.getByRole('group', { name: 'Điều khiển bài vẽ' }))
  expect(hud.getByRole('button', { name: 'Hạ bút trên bảng vẽ' })).toBeDisabled()
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  clockNow = 266; act(() => frame(clockNow))
  const lowerPen = hud.getByRole('button', { name: 'Hạ bút trên bảng vẽ' })
  expect(lowerPen).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Lưu PNG' })).toBeDisabled()
  fireEvent.click(lowerPen)
  expect(screen.getByRole('button', { name: 'Lưu PNG' })).toBeDisabled()
  clockNow = 299; fireEvent.click(screen.getByRole('button', { name: 'Observation' }))
  fireEvent.click(hud.getByRole('button', { name: 'Nhấc bút trên bảng vẽ' }))
  expect(hud.getByText('0s · 1 nét')).toBeInTheDocument()
  clockNow = 500; act(() => frame(clockNow))
  expect(hud.getByRole('button', { name: 'Hạ bút trên bảng vẽ' })).toBeDisabled()
})

it('retries the pending hand overlay when its canvas context becomes available', async () => {
  let frame!: FrameRequestCallback
  vi.mocked(requestAnimationFrame).mockImplementation(callback => { frame = callback; return 1 })
  const drawOverlay = vi.spyOn(drawingRenderer, 'drawDrawingOverlay').mockImplementation(() => undefined)
  render(<Harness config={workflow()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  await screen.findByRole('button', { name: 'Kết thúc bài vẽ' })
  for (const time of [100, 133, 166]) { clockNow = time; fireEvent.click(screen.getByRole('button', { name: 'Observation' })) }
  act(() => frame(clockNow))
  expect(drawOverlay).not.toHaveBeenCalled()
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn() }
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  clockNow = 183; act(() => frame(clockNow))
  expect(drawOverlay).toHaveBeenCalledWith(ctx, expect.objectContaining({ hand: expect.any(Array), cursor: expect.any(Object) }), mapping.current, false, expect.anything(), displayBox.current)
})

it('draws demo pointer strokes, exports artwork only, and applies undo and confirmed clear', () => {
  vi.useFakeTimers()
  class DemoPointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  }
  vi.stubGlobal('PointerEvent', DemoPointerEvent)
  let frame!: FrameRequestCallback
  vi.mocked(requestAnimationFrame).mockImplementation(callback => { frame = callback; return 1 })
  const ctx = Object.fromEntries(['setTransform', 'clearRect', 'save', 'translate', 'scale', 'beginPath', 'arc', 'fill', 'restore', 'moveTo', 'lineTo', 'stroke', 'fillRect', 'drawImage'].map(name => [name, vi.fn()]))
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) })
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['artwork'], { type: 'image/png' })))
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  const createObjectURL = vi.fn(() => 'blob:local-artwork'), revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  render(<Harness demo />)
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu vẽ' }))
  const input = screen.getByLabelText('Vùng vẽ demo bằng chuột hoặc chạm')
  const draw = (time: number) => {
    clockNow = time; fireEvent.pointerDown(input, { pointerId: 1, clientX: 400, clientY: 300 })
    clockNow += 33; fireEvent.pointerMove(input, { pointerId: 1, clientX: 450, clientY: 320 })
    clockNow += 33; fireEvent.pointerUp(input, { pointerId: 1, clientX: 450, clientY: 320 })
    clockNow += 250; act(() => frame(clockNow))
  }
  draw(133)
  expect(screen.getByRole('button', { name: 'Lưu PNG' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Lưu PNG' }))
  expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
  expect(download).toHaveBeenCalledOnce()
  expect(download.mock.instances[0]).toHaveAttribute('download', 've-tu-do.png')
  expect(ctx.drawImage).not.toHaveBeenCalled()
  expect(ctx.lineTo).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác nét' }))
  expect(screen.getByRole('button', { name: 'Lưu PNG' })).toBeDisabled()
  draw(600)
  fireEvent.click(screen.getByRole('button', { name: 'Xóa tranh' }))
  expect(screen.getByRole('group', { name: 'Xác nhận xóa tranh' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận xóa' }))
  expect(screen.getByRole('button', { name: 'Lưu PNG' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Hoàn tác nét' })).toBeDisabled()
  expect(fetchMock).not.toHaveBeenCalled()
  vi.runOnlyPendingTimers()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-artwork')
  vi.useRealTimers()
})

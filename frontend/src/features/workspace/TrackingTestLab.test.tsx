import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import TrackingTestLab from './TrackingTestLab'
import { createWorkerTracker } from './workerTracker'
import { createParallelWorkerTracker } from './parallelWorkerTracker'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import * as drawing from './drawing'
import { AdaptiveWorkerBudget } from './adaptiveWorkerBudget'

vi.mock('./workerTracker', () => ({ createWorkerTracker: vi.fn(), waitForWorkerDisposals: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./parallelWorkerTracker', () => ({ createParallelWorkerTracker: vi.fn() }))
vi.mock('./videoFrameScheduler', () => ({ startVideoFrameScheduler: vi.fn() }))
vi.mock('./useVideoMapping', () => ({ useVideoMapping: () => [{ current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }, { current: { width: 1000, height: 1000 } }] }))
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn().mockResolvedValue({ wasmLoaderPath: '/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm' }) },
  PoseLandmarker: { createFromOptions: vi.fn().mockResolvedValue({ detectForVideo: vi.fn(() => ({ landmarks: [[]] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }) },
  HandLandmarker: { createFromOptions: vi.fn().mockResolvedValue({ detectForVideo: vi.fn(() => ({ landmarks: [] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }) },
}))

class FakeWorker { terminate = vi.fn(); postMessage = vi.fn() }
const enableHand = () => { const control = screen.getByLabelText('Hand (21 mốc)') as HTMLInputElement; if (!control.checked) fireEvent.click(control) }
const renderLab = (element: Parameters<typeof render>[0]) => {
  const result = render(element)
  const gpu = screen.getByLabelText('Thử GPU (fallback CPU)') as HTMLInputElement
  if (gpu.checked) fireEvent.click(gpu)
  const hand = screen.getByLabelText('Hand (21 mốc)') as HTMLInputElement
  if (hand.checked) fireEvent.click(hand)
  return result
}

type TestWorkerOptions = Parameters<typeof createWorkerTracker>[0]
type TestSubmission = { id: number; requestId: number; timestamp: number; sourceFrameId: number | null; sourceMediaTimeMs: number; sourcePerformanceMs: number }
const workerRequests = new WeakMap<TestWorkerOptions, Map<number, TestSubmission>>()
function prepareWorkerMock<T extends { submit: ReturnType<typeof vi.fn> }>(tracker: T, options: TestWorkerOptions): T {
  let sequence = 0
  const requests = new Map<number, TestSubmission>()
  workerRequests.set(options, requests)
  const originalSubmit = tracker.submit
  tracker.submit = vi.fn((...args: unknown[]) => {
    const accepted = originalSubmit(...args)
    if (accepted) {
      const source = args[4] as { sourceFrameId: number | null; sourceMediaTimeMs: number; sourcePerformanceMs: number }
      requests.set(args[1] as number, { id: ++sequence, requestId: sequence, timestamp: args[1] as number, ...source })
    }
    return accepted
  })
  Object.defineProperty(tracker, 'lastRequestId', { get: () => sequence, configurable: true })
  return tracker
}
function deliverWorkerResult(options: TestWorkerOptions, result: { timestamp: number; pose: { x: number; y: number; z?: number; visibility?: number }[]; hands: { x: number; y: number }[][] | null; inferenceMs?: number; handFailed?: boolean; handCleanupFailed?: boolean }) {
  let identity = workerRequests.get(options)?.get(result.timestamp)
  if (!identity) {
    const callback = vi.mocked(startVideoFrameScheduler).mock.calls.at(-1)?.[1]
    callback?.({ now: result.timestamp, mediaTime: result.timestamp / 1000, inferenceTimestamp: result.timestamp })
    identity = workerRequests.get(options)?.get(result.timestamp)
  }
  if (!identity) return
  if (result.hands !== null) options.onHandResult?.({ ...identity, hands: result.hands, handWorldLandmarks: [], handedness: [], handInferenceMs: result.inferenceMs ?? null, handProcessed: true, handFailed: result.handFailed, handCleanupFailed: result.handCleanupFailed })
  options.onPoseResult?.({ ...identity, pose: result.pose, poseWorldLandmarks: [], poseInferenceMs: result.inferenceMs ?? null, poseProcessed: true })
  options.onFrameComplete?.({ ...identity, inferenceMs: result.inferenceMs ?? 0, handProcessed: result.hands !== null, poseProcessed: true, handInferenceMs: result.inferenceMs ?? null, poseInferenceMs: result.inferenceMs ?? null, handFailed: result.handFailed, handCleanupFailed: result.handCleanupFailed })
}

describe('tracking test lab', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('rehab.settings', JSON.stringify({ workerTracking: false }))
    vi.clearAllMocks()
    vi.mocked(createWorkerTracker).mockReset()
    vi.mocked(createParallelWorkerTracker).mockReset()
    vi.mocked(startVideoFrameScheduler).mockReset()
    vi.mocked(PoseLandmarker.createFromOptions).mockReset().mockResolvedValue({ detectForVideo: vi.fn(() => ({ landmarks: [[]], worldLandmarks: [] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockReset().mockResolvedValue({ detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [], handedness: [] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.mocked(FilesetResolver.forVisionTasks).mockResolvedValue({ wasmLoaderPath: '/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm' })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    URL.createObjectURL = vi.fn(() => 'blob:local-test')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('createImageBitmap', vi.fn())
  })
  afterEach(() => { cleanup(); document.querySelectorAll('[data-loader-probe]').forEach(script => script.remove()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('does not associate an older display landmark with a replay frame whose inference result is stale', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, callback) => { onFrame = callback; return vi.fn() })
    const pose = vi.fn().mockReturnValueOnce({ landmarks: [[{ x: .2, y: .3, z: .1, visibility: 1 }]] }).mockReturnValueOnce({ landmarks: [[{ x: .8, y: .7, z: .2, visibility: 1 }]] })
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: pose, close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] } as never)
    const replayFrame = vi.fn()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    renderLab(<TrackingTestLab onReplayFrame={replayFrame} />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    clock.mockReturnValue(1010)
    act(() => onFrame({ now: 1000, mediaTime: .1, inferenceTimestamp: 1000 }))
    expect(replayFrame.mock.calls[0][0].landmarks).toEqual(expect.arrayContaining([expect.objectContaining({ representation: 'display', x: .2 })]))
    clock.mockReturnValue(2000)
    act(() => onFrame({ now: 1100, mediaTime: .2, inferenceTimestamp: 1100 }))
    expect(replayFrame.mock.calls[1][0]).toMatchObject({ frame_performance_ms: 1100, video_media_time_ms: 200, utc_time: new Date(performance.timeOrigin + 1100).toISOString() })
    expect(replayFrame.mock.calls[1][0].landmarks).toEqual(expect.arrayContaining([expect.objectContaining({ representation: 'raw', x: .8 })]))
    expect(replayFrame.mock.calls[1][0].landmarks.filter((point: { representation: string }) => point.representation === 'display')).toEqual([])
  })
  it('preserves the observed input callback clock and media time for throttled frames', async () => {
    let opts!: Parameters<typeof startVideoFrameScheduler>[2]
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, _callback, options) => { opts = options; return vi.fn() })
    const replayFrame = vi.fn()
    renderLab(<TrackingTestLab onReplayFrame={replayFrame} />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    act(() => opts.onSkippedFrame?.({ now: 5333, mediaTime: 1.25, sourceFrameId: 40, skippedSourceFrames: 2 }))
    expect(replayFrame).toHaveBeenCalledWith(expect.objectContaining({ frame_performance_ms: 5333, video_media_time_ms: 1250, utc_time: new Date(performance.timeOrigin + 5333).toISOString(), inference_performed: false, skipped_frames: 2 }))
  })
  it('applies independent adaptive budgets only to accepted parallel submissions and exports a frozen budget snapshot', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async value => { options = value; return tracker })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    enableHand()
    fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByLabelText('Tự điều chỉnh nhịp Worker'))
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1010, mediaTime: 1, inferenceTimestamp: 1010 }))
    clock.mockReturnValue(1020); act(() => options.onPose({ timestamp: 1010, pose: [{ x: .5, y: .5, visibility: 1 }], hands: null, inferenceMs: 8 }))
    act(() => onFrame({ now: 1020, mediaTime: 1.01, inferenceTimestamp: 1020 }))
    expect(tracker.submitPose).toHaveBeenCalledTimes(1)
    expect(tracker.submitHand).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1050); fireEvent.click(screen.getByRole('button', { name: 'Dừng đo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ engine: 'parallel', adaptiveWorkerBudget: { enabled: true, poseFps: 30, handFps: 20, phase: 'normal', poseInferenceMs: 8 } })
    clock.mockRestore()
  })
  it('resets adaptive telemetry on visibility return and removes its timer and listener on stop', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0], tick!: () => void
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async value => { options = value; return tracker })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    const realInterval = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 250) { tick = callback as () => void; return 9876 }
      return realInterval(callback, delay, ...args)
    }) as typeof window.setInterval)
    const clear = vi.spyOn(window, 'clearInterval')
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    renderLab(<TrackingTestLab />)
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)')); fireEvent.click(screen.getByLabelText('Tự điều chỉnh nhịp Worker'))
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(tick).toBeTypeOf('function')
    clock.mockReturnValue(1100); act(() => options.onPose({ timestamp: 1050, pose: [], hands: null, inferenceMs: 10 }))
    hidden = true; clock.mockReturnValue(4000); act(() => tick())
    hidden = false; clock.mockReturnValue(4100); act(() => document.dispatchEvent(new Event('visibilitychange')))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    clock.mockReturnValue(4150); act(() => options.onPose({ timestamp: 1050, pose: [], hands: null, inferenceMs: 999 }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Dừng đo' })); fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text).adaptiveWorkerBudget.poseInferenceMs).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    expect(clear).toHaveBeenCalledWith(9876)
    expect(tracker.close).toHaveBeenCalledOnce()
    clock.mockRestore()
  })
  it('does not submit hidden frames or feed idle video delays into the adaptive controller', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1], tick!: () => void
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockResolvedValue(tracker)
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    const realInterval = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 250) { tick = callback as () => void; return 9876 }
      return realInterval(callback, delay, ...args)
    }) as typeof window.setInterval)
    const observeDelay = vi.spyOn(AdaptiveWorkerBudget.prototype, 'recordUiDelay')
    let hidden = false, paused = false, ended = false, seeking = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused)
    vi.spyOn(HTMLMediaElement.prototype, 'ended', 'get').mockImplementation(() => ended)
    vi.spyOn(HTMLMediaElement.prototype, 'seeking', 'get').mockImplementation(() => seeking)
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    renderLab(<TrackingTestLab />)
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)')); fireEvent.click(screen.getByLabelText('Tự điều chỉnh nhịp Worker'))
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    act(() => onFrame({ now: 1010, mediaTime: 1, inferenceTimestamp: 1010 }))
    hidden = true; clock.mockReturnValue(1350); act(() => { tick(); onFrame({ now: 1350, mediaTime: 1.1, inferenceTimestamp: 1350 }) })
    expect(tracker.submitPose).toHaveBeenCalledTimes(1); expect(tracker.submitHand).toHaveBeenCalledTimes(1)
    hidden = false; clock.mockReturnValue(1400); act(() => document.dispatchEvent(new Event('visibilitychange')))
    paused = true; clock.mockReturnValue(1800); act(() => tick())
    paused = false; ended = true; clock.mockReturnValue(2200); act(() => tick())
    ended = false; seeking = true; clock.mockReturnValue(2600); act(() => tick())
    expect(observeDelay).not.toHaveBeenCalled()
    seeking = false; clock.mockReturnValue(2850); act(() => tick())
    expect(observeDelay).toHaveBeenCalledOnce()
    clock.mockRestore()
  })
  it('records the selected smoothing configuration and freezes it during a measurement', async () => {
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    const selector = screen.getByLabelText('Cấu hình làm mượt') as HTMLSelectElement
    expect(selector.value).toBe('standard')
    fireEvent.change(selector, { target: { value: 'responsive' } })
    expect(selector.value).toBe('responsive')
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    expect(selector).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng đo' }))
    fireEvent.change(selector, { target: { value: 'standard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ smoothing: { profile: 'responsive', version: 'one-euro-v4', config: { minCutoff: 2, beta: .5, dCutoff: 1, resetAfterMs: 500 } } })
  })
  it('resets display smoothing on profile change while retaining raw Pose and Hand observations', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], draw!: FrameRequestCallback
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock({ submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }, value) })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    const drawLandmarks = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const first = [{ x: .2, y: .2, visibility: 1 }], second = [{ x: .8, y: .8, visibility: 1 }]
    const hand = [{ x: .3, y: .4 }]
    act(() => deliverWorkerResult(options, { timestamp: 1000, pose: first, hands: [hand] }))
    clock.mockReturnValue(1040); act(() => deliverWorkerResult(options, { timestamp: 1040, pose: second, hands: null }))
    act(() => draw(1040))
    expect(drawLandmarks.mock.calls.find(call => call[5] === false)?.[3][0].x).toBeLessThan(.8)
    expect(second).toEqual([{ x: .8, y: .8, visibility: 1 }])
    fireEvent.change(screen.getByLabelText('Cấu hình làm mượt'), { target: { value: 'responsive' } })
    clock.mockReturnValue(1080); const next = [{ x: .6, y: .6, visibility: 1 }]
    act(() => deliverWorkerResult(options, { timestamp: 1080, pose: next, hands: null }))
    drawLandmarks.mockClear(); act(() => draw(1080))
    expect(drawLandmarks.mock.calls.find(call => call[5] === false)?.[3]).toEqual(next)
    expect(drawLandmarks.mock.calls.find(call => call[5] === true)?.[3]).toBe(hand)
    fireEvent.click(screen.getByLabelText('Smoothed (tắt để xem Raw)'))
    drawLandmarks.mockClear(); act(() => draw(1080))
    expect(drawLandmarks.mock.calls.find(call => call[5] === false)?.[3]).toBe(next)
    expect(next).toEqual([{ x: .6, y: .6, visibility: 1 }])
    clock.mockRestore()
  })
  it('keeps Pose and Hand from parallel workers independent and counts each model separately', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1], draw!: FrameRequestCallback
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async value => { options = value; return tracker })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    const drawLandmarks = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    expect(screen.getByLabelText('Hai Worker CPU (thử nghiệm)')).toBeDisabled()
    enableHand()
    fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(screen.getByLabelText('Hai Worker CPU (thử nghiệm)')).toBeDisabled()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    clock.mockReturnValue(1010); act(() => onFrame({ now: 1010, mediaTime: 1, inferenceTimestamp: 1010 }))
    const raw = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    const hands = [Array.from({ length: 21 }, () => ({ x: .3, y: .3 }))]
    clock.mockReturnValue(1030); act(() => options.onHand({ timestamp: 1010, pose: [], hands, inferenceMs: 15 }))
    clock.mockReturnValue(1050); act(() => options.onPose({ timestamp: 1010, pose: raw, hands: null, inferenceMs: 25 }))
    act(() => draw(1050))
    expect(drawLandmarks.mock.calls.some(call => call[5] === true && call[3] === hands[0])).toBe(true)
    expect(drawLandmarks.mock.calls.some(call => call[5] === false && call[3].length === 33)).toBe(true)
    clock.mockReturnValue(1500); act(() => options.onPose({ timestamp: 1500, pose: raw, hands: null, inferenceMs: 20 }))
    clock.mockReturnValue(1711); drawLandmarks.mockClear(); act(() => draw(1711))
    expect(drawLandmarks.mock.calls.some(call => call[5] === true)).toBe(false)
    expect(drawLandmarks.mock.calls.some(call => call[5] === false)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ engine: 'parallel', dualPose: { inferenceTimingSamples: 1 }, dualHand: { inferenceTimingSamples: 1 } })
    clock.mockRestore()
  })
  it('freezes a dual-worker measurement and clears Hand on stale Hand failure while Pose continues', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1], draw!: FrameRequestCallback
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async value => { options = value; return tracker })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    const drawingSpy = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })); await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1001, mediaTime: 1, inferenceTimestamp: 1001 }))
    clock.mockReturnValue(1050); act(() => options.onHand({ timestamp: 1001, pose: [], hands: [[{ x: .3, y: .3 }]] }))
    clock.mockReturnValue(2000); act(() => options.onHand({ timestamp: 1001, pose: [], hands: [], handFailed: true, handCleanupFailed: true }))
    expect(screen.getByRole('status')).toHaveTextContent(/không xác nhận được việc giải phóng/i)
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled()
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(tracker.close).not.toHaveBeenCalled()
    const handCalls = tracker.submitHand.mock.calls.length
    clock.mockReturnValue(2100); act(() => onFrame({ now: 2100, mediaTime: 2.1, inferenceTimestamp: 2100 }))
    act(() => options.onPose({ timestamp: 2100, pose: [{ x: .5, y: .5, visibility: 1 }], hands: null }))
    drawingSpy.mockClear(); act(() => draw(2100))
    expect(tracker.submitHand).toHaveBeenCalledTimes(handCalls)
    expect(drawingSpy.mock.calls.some(call => call[5] === true)).toBe(false)
    expect(drawingSpy.mock.calls.some(call => call[5] === false)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ engine: 'parallel', handEnabled: true })
    clock.mockRestore()
  })

  it('closes late parallel initialization and ignores callbacks after source closure', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0], resolve!: (value: Awaited<ReturnType<typeof createParallelWorkerTracker>>) => void
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(value => { options = value; return new Promise(done => { resolve = done }) })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await waitFor(() => expect(createParallelWorkerTracker).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Đóng nguồn' }))
    expect(options.signal?.aborted).toBe(true)
    await act(async () => { resolve(tracker) })
    expect(tracker.close).toHaveBeenCalledOnce(); expect(startVideoFrameScheduler).not.toHaveBeenCalled()
    act(() => options.onHandError(new Error('late error')))
    expect(screen.queryByText(/Hand không khả dụng/)).not.toBeInTheDocument()
  })

  it('continues Pose alone if the parallel Hand worker fails during startup', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async options => {
      options.onHandError(new Error('Hand startup failed'))
      return tracker
    })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(screen.getByRole('status')).toHaveTextContent(/Hand không khả dụng/)
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(screen.getByText('Delegate / model').nextElementSibling).toHaveTextContent('Pose CPU · Hand Tắt · Hai Worker / Sẵn sàng')
    act(() => onFrame({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }))
    expect(tracker.submitPose).toHaveBeenCalledOnce()
    expect(tracker.submitHand).not.toHaveBeenCalled()
  })

  it('freezes the parallel measurement and falls back to main CPU on Pose worker failure', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0]
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async value => { options = value; return tracker })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => options.onPoseError(new Error('Pose worker failed')))
    expect(await screen.findByRole('status')).toHaveTextContent(/Worker không khả dụng/)
    await waitFor(() => expect(screen.getByText('Delegate / model').nextElementSibling).toHaveTextContent('Pose CPU · Hand CPU / Sẵn sàng'))
    expect(tracker.close).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ engine: 'parallel', handEnabled: true })
  })

  it('excludes in-flight results submitted before a dual-worker benchmark reset', async () => {
    let options!: Parameters<typeof createParallelWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockImplementation(async value => { options = value; return tracker })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })); await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1001, mediaTime: 1, inferenceTimestamp: 1001 }))
    clock.mockReturnValue(1010); fireEvent.click(screen.getByRole('button', { name: 'Đặt lại benchmark' }))
    clock.mockReturnValue(1050)
    act(() => { options.onPose({ timestamp: 1001, pose: [], hands: null, inferenceMs: 900 }); options.onHand({ timestamp: 1001, pose: [], hands: [], inferenceMs: 800 }) })
    act(() => onFrame({ now: 1200, mediaTime: 1.2, inferenceTimestamp: 1200 }))
    clock.mockReturnValue(1250)
    act(() => { options.onPose({ timestamp: 1200, pose: [], hands: null, inferenceMs: 25 }); options.onHand({ timestamp: 1200, pose: [], hands: [], inferenceMs: 35 }) })
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ dualPose: { inferenceTimingSamples: 1, inferenceP95Ms: 25 }, dualHand: { inferenceTimingSamples: 1, inferenceP95Ms: 35 } })
    clock.mockRestore()
  })

  it('counts shared throttling for both streams and Hand-only throttling separately', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1], scheduler!: NonNullable<Parameters<typeof startVideoFrameScheduler>[2]>
    const tracker = { submitPose: vi.fn(() => true), submitHand: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createParallelWorkerTracker).mockResolvedValue(tracker)
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame, options) => { onFrame = frame; scheduler = options!; return vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand(); fireEvent.click(screen.getByLabelText('Hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })); await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => { onFrame({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }); onFrame({ now: 1010, mediaTime: 1.01, inferenceTimestamp: 1010 }); scheduler.onSkip?.('throttled') })
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ dualPose: { throttledFrames: 2 }, dualHand: { throttledFrames: 2 } })
  })
  it('uses local blob URLs and revokes the old URL on source replacement and unmount', () => {
    renderLab(<TrackingTestLab />)
    const input = screen.getByLabelText('Chọn video MP4')
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [new File(['b'], 'b.mp4', { type: 'video/mp4' })] } })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-test')
    cleanup()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
  it('allows selecting the same local video after closing the source', async () => {
    const user = userEvent.setup()
    renderLab(<TrackingTestLab />)
    const input = screen.getByLabelText('Chọn video MP4') as HTMLInputElement
    const file = new File(['a'], 'a.mp4', { type: 'video/mp4' })
    await user.upload(input, file)
    expect(input.value).toBe('')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Đóng nguồn' }))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-test')
    await user.upload(input, file)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled()
  })
  it('explains camera permission denial', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) } })
    renderLab(<TrackingTestLab />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    expect(await screen.findByText(/Quyền camera bị từ chối/)).toBeInTheDocument()
  })
  it.each(['ended', 'missing'] as const)('rejects a camera with %s video track before awaiting playback', async (kind) => {
    const track = new EventTarget() as MediaStreamTrack
    Object.defineProperty(track, 'stop', { value: vi.fn() })
    Object.defineProperty(track, 'readyState', { value: 'ended' })
    const camera = { getTracks: () => [track], getVideoTracks: () => kind === 'ended' ? [track] : [] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(camera) } })
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => new Promise(() => {}))
    const view = renderLab(<TrackingTestLab />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    expect(await screen.findByText(/Camera đã ngắt kết nối/)).toBeInTheDocument()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(view.container.querySelector('video')?.srcObject).toBeNull()
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
  })
  it('stops tracking and measurement if the camera disconnects', async () => {
    const track = new EventTarget() as MediaStreamTrack
    Object.defineProperty(track, 'stop', { value: vi.fn() })
    const camera = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(camera) } })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => track.dispatchEvent(new Event('ended')))
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/Camera đã ngắt kết nối/)
    expect(track.stop).toHaveBeenCalled()
  })

  it('ignores a late disconnect from a camera replaced by a local video', async () => {
    const track = new EventTarget() as MediaStreamTrack
    Object.defineProperty(track, 'stop', { value: vi.fn() })
    const camera = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(camera) } })
    renderLab(<TrackingTestLab />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Đóng nguồn' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    act(() => track.dispatchEvent(new Event('ended')))
    expect(screen.getByRole('button', { name: 'Phát / Tạm dừng' })).toBeEnabled()
    expect(screen.queryByText(/Camera đã ngắt kết nối/)).not.toBeInTheDocument()
  })

  it('keeps Pose running and records Hand as disabled when the Hand model fails', async () => {
    vi.mocked(HandLandmarker.createFromOptions).mockRejectedValueOnce(new Error('hand model unavailable'))
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(screen.getByRole('status')).toHaveTextContent(/không tải được mô hình bàn tay/i)
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ poseEnabled: true, handEnabled: false, delegate: 'Pose CPU · Hand Lỗi' })
  })

  it('stops measurement and keeps Pose running after a Hand inference failure', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    let draw!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
    const drawLandmarks = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    const stop = vi.fn(), handClose = vi.fn(), poseClose = vi.fn()
    const poseDetect = vi.fn(() => ({ landmarks: [[{ x: .2, y: .3, visibility: 1 }]] }))
    const handDetect = vi.fn().mockReturnValueOnce({ landmarks: [[{ x: .5, y: .5 }]] }).mockImplementationOnce(() => { throw new Error('Hand failed') })
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: poseDetect, close: poseClose } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: handDetect, close: handClose } as never)
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return stop })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    clock.mockReturnValue(1001)
    act(() => onFrame({ now: 1001, mediaTime: 1, inferenceTimestamp: 1001 }))
    act(() => draw(1001)); expect(drawLandmarks.mock.calls.filter(call => call[5] === true)).toHaveLength(1)
    drawLandmarks.mockClear()
    clock.mockReturnValue(1150)
    act(() => onFrame({ now: 1150, mediaTime: 1.15, inferenceTimestamp: 1150 }))
    act(() => draw(1150)); expect(drawLandmarks.mock.calls.filter(call => call[5] === true)).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent(/bàn tay.*tư thế vẫn hoạt động/i)
    expect(screen.getByRole('button', { name: 'Dừng nhận diện' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled()
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(screen.getByText('Trạng thái Hand').parentElement).toHaveTextContent('Tắt')
    expect(handClose).toHaveBeenCalledOnce(); expect(poseClose).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ poseEnabled: true, handEnabled: true, delegate: 'Pose CPU · Hand CPU' })
    clock.mockReturnValue(1300)
    act(() => onFrame({ now: 1300, mediaTime: 1.3, inferenceTimestamp: 1300 }))
    expect(poseDetect).toHaveBeenCalledTimes(3); expect(handDetect).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const nextBlob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const nextText = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(nextBlob) })
    expect(JSON.parse(nextText)).toMatchObject({ poseEnabled: true, handEnabled: false, delegate: 'Pose CPU · Hand Lỗi' })
    clock.mockRestore()
  })

  it('keeps Pose running when Hand cleanup also throws', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const stop = vi.fn(), poseClose = vi.fn(), handClose = vi.fn(() => { throw new Error('close failed') })
    const poseDetect = vi.fn(() => ({ landmarks: [[{ x: .5, y: .5, visibility: 1 }]] }))
    const handDetect = vi.fn(() => { throw new Error('inference failed') })
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: poseDetect, close: poseClose } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: handDetect, close: handClose } as never)
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return stop })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }))
    expect(screen.getByRole('button', { name: 'Dừng nhận diện' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled()
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent(/không xác nhận.*giải phóng/i)
    expect(handClose).toHaveBeenCalledOnce(); expect(poseClose).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    act(() => onFrame({ now: 1200, mediaTime: 1.2, inferenceTimestamp: 1200 }))
    expect(poseDetect).toHaveBeenCalledTimes(2); expect(handDetect).toHaveBeenCalledOnce()
  })

  it('stops tracking when the only Hand model fails during inference', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const stop = vi.fn(), handClose = vi.fn()
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: vi.fn(() => { throw new Error('Hand failed') }), close: handClose } as never)
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return stop })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Pose')); enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }))
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeDisabled()
    expect(handClose).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce()
  })

  it('cleans only each model loader after GPU failures and CPU fallback', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'loader-test' })
    const scripts: HTMLScriptElement[] = []
    const addScript = (src: string) => { const script = document.createElement('script'); script.dataset.loaderProbe = ''; script.src = src; document.body.appendChild(script); scripts.push(script) }
    addScript('/mediapipe/wasm/vision_wasm_internal.js')
    const appendLoader = (files: { wasmLoaderPath: string }) => addScript(files.wasmLoaderPath)
    vi.mocked(PoseLandmarker.createFromOptions)
      .mockImplementationOnce(async files => { appendLoader(files); throw new Error('GPU unavailable') })
      .mockImplementationOnce(async files => { appendLoader(files); return { detectForVideo: vi.fn(() => ({ landmarks: [[]] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] } as never })
    vi.mocked(HandLandmarker.createFromOptions)
      .mockImplementationOnce(async files => { appendLoader(files); throw new Error('GPU unavailable') })
      .mockImplementationOnce(async files => { appendLoader(files); return { detectForVideo: vi.fn(() => ({ landmarks: [] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] } as never })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Thử GPU (fallback CPU)'))
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(screen.getByText(/Pose CPU · Hand CPU/)).toBeInTheDocument()
    expect(scripts).toHaveLength(5)
    expect(scripts[0].isConnected).toBe(true)
    expect(scripts.slice(1).every(script => !script.isConnected)).toBe(true)
  })

  it('reports model failure if Hand is the only requested model', async () => {
    vi.mocked(HandLandmarker.createFromOptions).mockRejectedValueOnce(new Error('hand model unavailable'))
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Pose'))
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    expect(await screen.findByText(/Không tải được MediaPipe hoặc model cục bộ/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled()
  })
  it('restarts a local file with playback', () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play)
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Phát lại từ đầu' }))
    expect(play).toHaveBeenCalledTimes(2)
  })
  it('stores the selected profile without losing existing settings', () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ mirrored: false }))
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Cấu hình hiệu năng'), { target: { value: 'economy' } })
    expect(JSON.parse(localStorage.getItem('rehab.settings') || '{}')).toMatchObject({ mirrored: false, trackingProfile: 'economy' })
  })
  it('exports aggregate benchmark settings without video content or landmark samples', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderLab(<TrackingTestLab />)
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    const report = JSON.parse(text)
    expect(report).toMatchObject({ version: 2, source: 'none', profile: 'balanced', smoothing: { version: 'one-euro-v4', visibilityPolicy: { requireVisibility: true } } })
    expect(report).not.toHaveProperty('landmarks')
    expect(report).not.toHaveProperty('video')
    expect(click).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-test')
  })

  it('reports Worker model latency separately from frame-to-result time and busy skips', async () => {
    let workerOptions!: Parameters<typeof createWorkerTracker>[0]
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submit: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async options => { workerOptions = options; return prepareWorkerMock(tracker, options) })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => { onFrame({ now: 1001, mediaTime: 1, inferenceTimestamp: 1001 }); onFrame({ now: 1080, mediaTime: 1.08, inferenceTimestamp: 1080 }) })
    clock.mockReturnValue(1051)
    act(() => deliverWorkerResult(workerOptions, { timestamp: 1001, pose: [{ x: .2, y: .3 }], hands: null, inferenceMs: 20 }))
    clock.mockReturnValue(1100)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ engine: 'worker', inferenceP95Ms: 20, workerRoundTripP95Ms: 50, workerBusyFrames: 1, inferenceFps: 10, leftUpperLimbVisibleFraction: 0, rightUpperLimbVisibleFraction: 0, metricDefinitions: { resultAgeMs: expect.stringContaining('not motion-to-photon') } })
    expect(screen.getByText('Tuổi Pose / Hand từ callback')).toBeInTheDocument()
    expect(screen.getByText(/Giới hạn tươi: Hand 150 ms, Pose 250 ms/)).toBeInTheDocument()
    expect(click).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng đo' })); clock.mockRestore()
  })

  it('clears Hand and freezes measurement when a stale Worker result reports Hand failure', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1], draw!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
    const drawLandmarks = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }))
    const pose = [{ x: .5, y: .5, visibility: 1 }], hand = [{ x: .3, y: .3 }]
    act(() => deliverWorkerResult(options, { timestamp: 1000, pose, hands: [hand], inferenceMs: 20 }))
    act(() => draw(1000))
    expect(drawLandmarks.mock.calls.some(call => call[5] === true)).toBe(true)
    act(() => onFrame({ now: 1100, mediaTime: 1.1, inferenceTimestamp: 1100 }))
    clock.mockReturnValue(2000)
    act(() => deliverWorkerResult(options, Object.assign({ timestamp: 1100, pose, hands: [], inferenceMs: 20 }, { handFailed: true })))
    expect(screen.getByRole('status')).toHaveTextContent(/bàn tay.*thất bại/i)
    expect(screen.getByRole('button', { name: 'Dừng nhận diện' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled()
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(tracker.close).not.toHaveBeenCalled()
    // Rewind the mocked clock to make the old hand otherwise fresh: failure must clear it immediately.
    clock.mockReturnValue(1200); drawLandmarks.mockClear(); act(() => draw(1200))
    expect(drawLandmarks.mock.calls.some(call => call[5] === true)).toBe(false)
    act(() => onFrame({ now: 1200, mediaTime: 1.2, inferenceTimestamp: 1200 }))
    expect(tracker.submit).toHaveBeenLastCalledWith(expect.anything(), 1200, false, true, { sourceFrameId: null, sourceMediaTimeMs: 1200, sourcePerformanceMs: 1200 })
    act(() => deliverWorkerResult(options, { timestamp: 1200, pose, hands: null, inferenceMs: 20 }))
    drawLandmarks.mockClear(); act(() => draw(1200))
    expect(drawLandmarks.mock.calls.some(call => call[5] === false)).toBe(true)
    expect(drawLandmarks.mock.calls.some(call => call[5] === true)).toBe(false)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    let blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const read = (value: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(value) })
    expect(JSON.parse(await read(blob))).toMatchObject({ engine: 'worker', handEnabled: true, delegate: 'Pose CPU · Hand CPU · Worker CPU' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    expect(JSON.parse(await read(blob))).toMatchObject({ engine: 'worker', handEnabled: false, delegate: 'Pose CPU · Hand Lỗi · Worker CPU' })
    clock.mockRestore()
  })

  it('warns when the Worker cannot confirm Hand cleanup while keeping Pose running', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)')); enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    const now = performance.now()
    act(() => onFrame({ now, mediaTime: 1, inferenceTimestamp: now }))
    act(() => deliverWorkerResult(options, Object.assign({ timestamp: now, pose: [{ x: .5, y: .5, visibility: 1 }], hands: [], handFailed: true }, { handCleanupFailed: true })))
    expect(screen.getByRole('status')).toHaveTextContent(/không xác nhận.*giải phóng/i)
    expect(screen.getByRole('button', { name: 'Dừng nhận diện' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled()
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(tracker.close).not.toHaveBeenCalled()
  })

  it('does not reload Hand after Worker Hand failure followed by a fatal Worker failure', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0]
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)')); enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    act(() => deliverWorkerResult(options, { timestamp: performance.now(), pose: [{ x: .5, y: .5, visibility: 1 }], hands: [], handFailed: true }))
    act(() => options.onError(new Error('worker failed later')))
    await waitFor(() => expect(screen.getByText('Delegate / model').nextElementSibling).toHaveTextContent('Pose CPU / Sẵn sàng'))
    expect(HandLandmarker.createFromOptions).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Hand (21 mốc)')).not.toBeChecked()
    expect(tracker.close).toHaveBeenCalledOnce()
  })

  it('stops an active measurement and falls back to main CPU on Worker failure', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0]
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => options.onError(new Error('worker failed')))
    expect(await screen.findByText(/Worker không khả dụng/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeEnabled())
    expect(tracker.close).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Dừng đo' })).not.toBeInTheDocument()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ engine: 'worker', delegate: 'Pose CPU · Hand Tắt · Worker CPU' })
  })

  it('closes a Worker that finishes initializing after the source is closed', async () => {
    let resolve!: (value: { submit: () => boolean; close: () => void }) => void
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(() => new Promise(done => { resolve = done }))
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await waitFor(() => expect(createWorkerTracker).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Đóng nguồn' }))
    await act(async () => { resolve(tracker) })
    expect(tracker.close).toHaveBeenCalledOnce()
    expect(startVideoFrameScheduler).not.toHaveBeenCalled()
  })

  it('locks model configuration while Worker initialization is pending', async () => {
    vi.mocked(createWorkerTracker).mockImplementation(() => new Promise(() => {}))
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await waitFor(() => expect(createWorkerTracker).toHaveBeenCalledOnce())
    expect(screen.getByLabelText('Worker CPU (thử nghiệm)')).toBeDisabled()
    expect(screen.getByLabelText('Pose')).toBeDisabled()
    expect(screen.getByLabelText('Hand (21 mốc)')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Đang tải…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Đóng nguồn' })).toBeEnabled()
  })

  it('uses a Hand-only Worker without initializing Pose on the main thread', async () => {
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: null, hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockResolvedValue(tracker as never)
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByLabelText('Pose')); enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(createWorkerTracker).toHaveBeenCalledWith(expect.objectContaining({ role: 'hand', handEnabled: true, preferGpu: false }))
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled()
    expect(HandLandmarker.createFromOptions).not.toHaveBeenCalled()
  })

  it('does not mix a Worker result submitted before benchmark reset into the new measurement', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1001, mediaTime: 1, inferenceTimestamp: 1001 }))
    clock.mockReturnValue(1010); fireEvent.click(screen.getByRole('button', { name: 'Đặt lại benchmark' }))
    clock.mockReturnValue(1050); act(() => deliverWorkerResult(options, { timestamp: 1001, pose: [{ x: .2, y: .3 }], hands: null, inferenceMs: 900 }))
    act(() => onFrame({ now: 1080, mediaTime: 1.06, inferenceTimestamp: 1080 }))
    clock.mockReturnValue(1110); act(() => deliverWorkerResult(options, { timestamp: 1080, pose: [{ x: .2, y: .3 }], hands: null, inferenceMs: 25 }))
    clock.mockReturnValue(1120); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ inferenceTimingSamples: 1, inferenceP95Ms: 25 })
    clock.mockRestore()
  })

  it('closes the Worker and ignores its late result when the video is sought', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], scheduler!: NonNullable<Parameters<typeof startVideoFrameScheduler>[2]>
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, _frame, value) => { scheduler = value!; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => scheduler.onReset?.())
    expect(tracker.close).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled()
    act(() => deliverWorkerResult(options, Object.assign({ timestamp: performance.now(), pose: [{ x: .2, y: .3 }], hands: null, inferenceMs: 1 }, { handFailed: true })))
    expect(screen.getByText(/Nguồn đã seek hoặc phát lại/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bắt đầu đo' })).toBeDisabled()
  })

  it('reports upper-limb visibility separately from a nonempty model result', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const tracker = { submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock(tracker, value) })
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu đo' }))
    act(() => onFrame({ now: 1001, mediaTime: 1, inferenceTimestamp: 1001 }))
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    pose[14] = { x: NaN, y: .5, visibility: .9 }
    clock.mockReturnValue(1050); act(() => deliverWorkerResult(options, { timestamp: 1001, pose, hands: null, inferenceMs: 20 }))
    clock.mockReturnValue(1100); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Xuất benchmark JSON' }))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
    expect(JSON.parse(text)).toMatchObject({ validFraction: 1, leftUpperLimbVisibleFraction: 1, rightUpperLimbVisibleFraction: 0 })
    clock.mockRestore()
  })

  it('does not report usable upper limbs when nonempty pose landmarks are unreliable', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0]
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock({ submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }, value) })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .1 }))
    act(() => deliverWorkerResult(options, { timestamp: 1000, pose, hands: null }))
    fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(screen.getByText('Trạng thái tracking').nextElementSibling).toHaveTextContent('Mốc chi trên không tin cậy')
    for (const index of [11, 13, 15]) pose[index].visibility = .9
    pose[14] = { x: 1.1, y: .5, visibility: .9 }
    pose[12].visibility = .9; pose[16].visibility = .9
    clock.mockReturnValue(1100); act(() => deliverWorkerResult(options, { timestamp: 1100, pose, hands: null }))
    fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(screen.getByText('Trạng thái tracking').nextElementSibling).toHaveTextContent('Chi trên trái đủ mốc · phải không tin cậy')
    fireEvent.click(screen.getByRole('button', { name: 'Đóng nguồn' }))
    expect(screen.getByText('Trạng thái tracking').nextElementSibling).toHaveTextContent('Đã dừng')
    clock.mockRestore()
  })

  it('expires hands independently of newly updated pose and clears an empty hand result immediately', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], draw!: FrameRequestCallback
    const canvasContext = { setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    const drawLandmarks = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock({ submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }, value) })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    const hand = Array.from({ length: 21 }, () => ({ x: .3, y: .3 }))
    act(() => deliverWorkerResult(options, { timestamp: 1000, pose, hands: [hand] }))
    act(() => draw(1000))
    expect(drawLandmarks.mock.calls.filter(call => call[5] === true)).toHaveLength(1)
    clock.mockReturnValue(1850)
    act(() => deliverWorkerResult(options, { timestamp: 1850, pose, hands: null }))
    fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(screen.getByText('Trạng thái Hand').nextElementSibling).toHaveTextContent('Không có kết quả Hand mới')
    drawLandmarks.mockClear(); act(() => draw(1850))
    expect(drawLandmarks.mock.calls.filter(call => call[5] === true)).toHaveLength(0)
    clock.mockReturnValue(1890); act(() => deliverWorkerResult(options, { timestamp: 1890, pose, hands: [hand] }))
    drawLandmarks.mockClear(); act(() => draw(1890))
    expect(drawLandmarks.mock.calls.filter(call => call[5] === true)).toHaveLength(1)
    clock.mockReturnValue(1930)
    act(() => deliverWorkerResult(options, { timestamp: 1930, pose, hands: [] }))
    fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(screen.getByText('Trạng thái Hand').nextElementSibling).toHaveTextContent('Không thấy bàn tay')
    drawLandmarks.mockClear(); act(() => draw(1930))
    expect(drawLandmarks.mock.calls.filter(call => call[5] === true)).toHaveLength(0)
    clock.mockRestore()
  })

  it('does not filter Pose through an observation without visibility in the Worker result path', async () => {
    let options!: Parameters<typeof createWorkerTracker>[0], draw!: FrameRequestCallback
    const canvasContext = { setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    const drawLandmarks = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return prepareWorkerMock({ submit: vi.fn(() => true), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] }, value) })
    vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const unknown = [{ x: .8, y: .8 }]
    act(() => deliverWorkerResult(options, { timestamp: 1000, pose: [{ x: .2, y: .2, visibility: 1 }], hands: null }))
    clock.mockReturnValue(1080); act(() => deliverWorkerResult(options, { timestamp: 1080, pose: unknown, hands: null }))
    expect(unknown).toEqual([{ x: .8, y: .8 }])
    clock.mockReturnValue(1160); act(() => deliverWorkerResult(options, { timestamp: 1160, pose: [{ x: .5, y: .5, visibility: 1 }], hands: null }))
    act(() => draw(1160))
    expect(drawLandmarks.mock.calls.at(-1)?.[3]).toEqual([{ x: .5, y: .5, visibility: 1 }])
    clock.mockRestore()
  })

  it('reports hand-only tracking separately and expires it on stalled input', async () => {
    let onFrame!: Parameters<typeof startVideoFrameScheduler>[1]
    const hand = Array.from({ length: 21 }, () => ({ x: .3, y: .3 }))
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ detectForVideo: vi.fn(() => ({ landmarks: [hand], handedness: [[{ categoryName: 'Left' }]] })), close: vi.fn(), delegates: { pose: 'CPU', hand: 'CPU' }, initializationErrors: [] } as never)
    vi.mocked(startVideoFrameScheduler).mockImplementation((_video, frame) => { onFrame = frame; return vi.fn() })
    renderLab(<TrackingTestLab />)
    fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'a.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(screen.getByLabelText('Pose')); enableHand()
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    act(() => onFrame({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }))
    fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(screen.getByText('Trạng thái tracking').nextElementSibling).toHaveTextContent('Có mốc bàn tay')
    clock.mockReturnValue(1701); fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(screen.getByText('Trạng thái tracking').nextElementSibling).toHaveTextContent('Không có frame mới')
    clock.mockRestore()
  })

  describe('hand-first audit', () => {
    beforeEach(() => {
      localStorage.removeItem('rehab.settings')
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    })
    const sourceFile = () => fireEvent.change(screen.getByLabelText('Chọn video MP4'), { target: { files: [new File(['a'], 'audit.mp4', { type: 'video/mp4' })] } })
    const start = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
      await screen.findByRole('button', { name: 'Dừng nhận diện' })
    }
    const makeTracker = (dispose = vi.fn().mockResolvedValue(undefined)) => {
      let sequence = 0
      return { submit: vi.fn(() => { sequence++; return true }), get lastRequestId() { return sequence }, close: vi.fn(), dispose,
        delegates: { pose: 'GPU', hand: 'GPU' }, initializationErrors: [] }
    }
    it('waits for disposal acknowledgement before initializing a replacement worker', async () => {
      let finish!: () => void
      const tracker = makeTracker(vi.fn(() => new Promise<void>(resolve => { finish = resolve })))
      vi.mocked(createWorkerTracker).mockResolvedValue(tracker as never)
      vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
      render(<TrackingTestLab />); sourceFile(); await start()
      fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
      fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
      await act(async () => { await Promise.resolve() })
      expect(createWorkerTracker).toHaveBeenCalledTimes(1)
      await act(async () => { finish(); await Promise.resolve() })
      await waitFor(() => expect(createWorkerTracker).toHaveBeenCalledTimes(2))
    })
    it('shows cleanup failure and blocks replacement rather than claiming successful release', async () => {
      const tracker = makeTracker(vi.fn().mockRejectedValue(new Error('dispose acknowledgement failed')))
      vi.mocked(createWorkerTracker).mockResolvedValue(tracker as never)
      vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
      render(<TrackingTestLab />); sourceFile(); await start()
      fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/không xác nhận.*giải phóng/i))
      fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
      await act(async () => { await Promise.resolve() })
      expect(createWorkerTracker).toHaveBeenCalledTimes(1)
    })
    it('preserves source identity and excludes foreign results and unscheduled hands from replay observations', async () => {
      let options!: Parameters<typeof createWorkerTracker>[0], frame!: Parameters<typeof startVideoFrameScheduler>[1]
      const tracker = makeTracker(), replay = vi.fn()
      vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return tracker as never })
      vi.mocked(startVideoFrameScheduler).mockImplementation((_video, callback) => { frame = callback; return vi.fn() })
      const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
      render(<TrackingTestLab onReplayFrame={replay} />); sourceFile(); await start()
      act(() => frame({ now: 1000, mediaTime: 1.25, inferenceTimestamp: 1000, sourceFrameId: 71 }))
      expect(tracker.submit.mock.calls[0][4]).toEqual({ sourceFrameId: 71, sourceMediaTimeMs: 1250, sourcePerformanceMs: 1000 })
      const identity = { id: 1, requestId: 1, timestamp: 1000, sourceFrameId: 71, sourceMediaTimeMs: 1250, sourcePerformanceMs: 1000 }
      act(() => options.onHandResult!({ ...identity, hands: [[{ x: .4, y: .5, z: .1 }]], handWorldLandmarks: [], handedness: [], handInferenceMs: 3, handProcessed: true }))
      act(() => options.onFrameComplete!({ ...identity, inferenceMs: 3, handProcessed: true, poseProcessed: false, handInferenceMs: 3, poseInferenceMs: null }))
      expect(replay.mock.calls[0][0]).toMatchObject({ source_frame_id: 71, video_media_time_ms: 1250, pose_detected: null, hand_detected: true })
      clock.mockReturnValue(1100)
      act(() => frame({ now: 1100, mediaTime: 1.35, inferenceTimestamp: 1000, sourceFrameId: 72 }))
      act(() => options.onHandResult!({ ...identity, hands: [[{ x: .9, y: .9, z: .1 }]], handWorldLandmarks: [], handedness: [], handInferenceMs: 3, handProcessed: true }))
      const second = { ...identity, id: 2, requestId: 2, sourceFrameId: 72, sourceMediaTimeMs: 1350, sourcePerformanceMs: 1100 }
      act(() => options.onPoseResult!({ ...second, pose: [{ x: .2, y: .3, z: .1, visibility: 1 }], poseWorldLandmarks: [], poseInferenceMs: 5, poseProcessed: true }))
      act(() => options.onFrameComplete!({ ...second, inferenceMs: 5, handProcessed: false, poseProcessed: true, handInferenceMs: null, poseInferenceMs: 5 }))
      expect(replay.mock.calls[1][0]).toMatchObject({ source_frame_id: 72, video_media_time_ms: 1350, hand_detected: null, pose_detected: true })
      expect(replay.mock.calls[1][0].landmarks.every((point: { landmark_source: string }) => point.landmark_source === 'pose')).toBe(true)
    })
    it('requests the highest model source rate and rejects callbacks from an old session', async () => {
      let options!: Parameters<typeof createWorkerTracker>[0]
      const tracker = makeTracker(), replay = vi.fn()
      vi.mocked(createWorkerTracker).mockImplementation(async value => { options = value; return tracker as never })
      vi.mocked(startVideoFrameScheduler).mockReturnValue(vi.fn())
      render(<TrackingTestLab onReplayFrame={replay} />); sourceFile(); await start()
      expect(vi.mocked(startVideoFrameScheduler).mock.calls.at(-1)?.[2]?.maxFps).toBe(30)
      fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
      act(() => options.onFrameComplete!({ id: 1, requestId: 1, timestamp: 1000, inferenceMs: 3, handProcessed: true, poseProcessed: false, handInferenceMs: 3, poseInferenceMs: null }))
      expect(replay).not.toHaveBeenCalled()
    })
  })
})

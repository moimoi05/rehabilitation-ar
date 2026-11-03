import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePage from './WorkspacePage'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import * as drawing from './drawing'
import { AdaptiveWorkerBudget } from './adaptiveWorkerBudget'

vi.mock('../../services/api', () => ({ api: { sessions: () => Promise.resolve([{ id: 7, patient_id: 3, affected_side: 'left', session_type: 'training', status: 'draft' }, { id: 8, patient_id: 4, affected_side: 'right', session_type: 'training', status: 'draft' }]) } }))
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: { forVisionTasks: vi.fn().mockResolvedValue({ wasmLoaderPath: '/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm' }) }, PoseLandmarker: { createFromOptions: vi.fn().mockRejectedValue(new Error('model unavailable')) }, HandLandmarker: { createFromOptions: vi.fn() } }))
vi.mock('./videoFrameScheduler', () => ({ startVideoFrameScheduler: vi.fn(() => vi.fn()) }))

const enableHands = () => {
  const checkbox = screen.getByLabelText('Theo dõi 21 mốc bàn tay') as HTMLInputElement
  if (!checkbox.checked) fireEvent.click(checkbox)
}

describe('workspace calibration', () => {
  const stop = vi.fn()
  const trackListener = vi.fn()
  beforeEach(() => {
    vi.mocked(FilesetResolver.forVisionTasks).mockResolvedValue({ wasmLoaderPath: '/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm' })
    vi.mocked(PoseLandmarker.createFromOptions).mockReset().mockRejectedValue(new Error('model unavailable'))
    vi.mocked(HandLandmarker.createFromOptions).mockReset().mockResolvedValue({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [], handedness: [] })) } as never)
    vi.mocked(startVideoFrameScheduler).mockClear()
    localStorage.clear(); history.replaceState({}, '', '/workspace?sessionId=7')
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const track = { label: 'Test camera', getSettings: () => ({ width: 1280, height: 720, deviceId: 'camera-1' }), addEventListener: trackListener, stop }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }), enumerateDevices: vi.fn().mockResolvedValue([]) } })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); stop.mockClear(); trackListener.mockClear() })

  it('requires consent and saves observed skipped source frames during a camera capture', async () => {
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [] })) } as never)
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => ({ ok: true, json: async () => String(args[0]).endsWith('/api/captures') ? { id: 'camera-test', trial_id: 9, status: 'recording' } : { status: 'complete' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const start = screen.getByRole('button', { name: 'Bắt đầu thu dữ liệu' })
    expect(start).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Xác nhận quyền thu landmark'))
    expect(start).toBeEnabled()
    fireEvent.click(start)
    await screen.findByRole('button', { name: 'Dừng và lưu' })
    expect(screen.getByLabelText('Phiên tập')).toBeDisabled()
    const schedulerOptions = vi.mocked(startVideoFrameScheduler).mock.lastCall![2]
    act(() => schedulerOptions.onSkippedFrame?.({ now: performance.now(), mediaTime: 1.2, sourceFrameId: 15, skippedSourceFrames: 2 }))
    fireEvent.click(screen.getByRole('button', { name: 'Dừng và lưu' }))
    await screen.findByText(/Đã hoàn tất và xác minh capture/)
    const batch = fetchMock.mock.calls.find(([url]) => String(url).includes('landmark-batches'))
    expect(batch).toBeDefined()
    const init = batch![1] as RequestInit
    expect(JSON.parse(String(init.body)).frames[0]).toMatchObject({ source_frame_id: 15, video_media_time_ms: 1200, inference_performed: false, pose_detected: null, hand_detected: null, skipped_frames: 2, landmarks: [] })
    expect(screen.getByLabelText('Phiên tập')).toBeEnabled()
  }, 20_000)

  it('offers an independent adaptive budget for the two Worker mode', async () => {
    class ReadyWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror = null; onmessageerror = null
      terminate = vi.fn()
      postMessage(message: { type: string }) { queueMicrotask(() => this.onmessage?.({ data: message.type === 'dispose' ? { type: 'disposed' } : { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } })) }
    }
    vi.stubGlobal('Worker', ReadyWorker)
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }))
    render(<WorkspacePage />)
    const adaptive = screen.getByLabelText('Tự điều chỉnh nhịp hai Worker (thử nghiệm)')
    expect(adaptive).toBeDisabled()
    enableHands()
    fireEvent.click(screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)'))
    expect(adaptive).toBeEnabled(); expect(adaptive).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(adaptive).toBeDisabled()
    expect(vi.mocked(startVideoFrameScheduler).mock.lastCall![2].maxFps).toBe(120)
    expect(screen.getByText(/Giới hạn tự điều chỉnh Pose/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    expect(screen.queryByText(/Giới hạn tự điều chỉnh Pose/)).not.toBeInTheDocument()
  })

  it('drops busy frames, applies independent budgets, and resets after visibility changes', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    class ReadyWorker {
      static instances: ReadyWorker[] = []
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror = null; onmessageerror = null
      frames: number[] = []
      terminate = vi.fn()
      constructor() { ReadyWorker.instances.push(this) }
      postMessage(message: { type: string; id: number }) {
        if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } }))
        if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } }))
        if (message.type === 'frame') this.frames.push(message.id)
      }
    }
    vi.stubGlobal('Worker', ReadyWorker)
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }))
    const removed = vi.spyOn(document, 'removeEventListener')
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const [pose, hand] = ReadyWorker.instances
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1000); act(() => callback({ now: 1000, mediaTime: 1, inferenceTimestamp: 1000 }))
    await waitFor(() => { expect(pose.frames).toHaveLength(1); expect(hand.frames).toHaveLength(1) })
    clock.mockReturnValue(1010); act(() => callback({ now: 1010, mediaTime: 1.01, inferenceTimestamp: 1010 }))
    expect(pose.frames).toHaveLength(1); expect(hand.frames).toHaveLength(1)
    act(() => { pose.onmessage?.({ data: { type: 'result', id: 1, pose: [], hands: null, inferenceMs: 5 } }); hand.onmessage?.({ data: { type: 'result', id: 1, pose: [], hands: [], inferenceMs: 5 } }) })
    clock.mockReturnValue(1040); act(() => callback({ now: 1040, mediaTime: 1.04, inferenceTimestamp: 1040 }))
    await waitFor(() => expect(pose.frames).toHaveLength(2)); expect(hand.frames).toHaveLength(1)
    visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')))
    clock.mockReturnValue(1100); act(() => callback({ now: 1100, mediaTime: 1.1, inferenceTimestamp: 1100 }))
    expect(hand.frames).toHaveLength(1)
    visibility.mockReturnValue('visible'); clock.mockReturnValue(1200); act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => pose.onmessage?.({ data: { type: 'result', id: 2, pose: [], hands: null, inferenceMs: 5 } }))
    clock.mockReturnValue(1210); act(() => callback({ now: 1210, mediaTime: 1.21, inferenceTimestamp: 1210 }))
    await waitFor(() => { expect(pose.frames).toHaveLength(3); expect(hand.frames).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    expect(removed.mock.calls.some(call => call[0] === 'visibilitychange')).toBe(true)
    await waitFor(() => { expect(pose.terminate).toHaveBeenCalledOnce(); expect(hand.terminate).toHaveBeenCalledOnce() })
  })

  it('samples UI pressure only while the camera video is visible and playing', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    let paused = false, seeking = false, ready = 2, tick: (() => void) | undefined
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused)
    vi.spyOn(HTMLMediaElement.prototype, 'seeking', 'get').mockImplementation(() => seeking)
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => ready)
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const sample = vi.spyOn(AdaptiveWorkerBudget.prototype, 'recordUiDelay')
    const reset = vi.spyOn(AdaptiveWorkerBudget.prototype, 'reset')
    const nativeInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 250 && typeof handler === 'function') tick = handler as () => void
      return nativeInterval(handler, delay, ...args)
    }) as typeof setInterval)
    class ReadyWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror = null; onmessageerror = null; terminate = vi.fn()
      postMessage(message: { type: string }) { queueMicrotask(() => this.onmessage?.({ data: message.type === 'dispose' ? { type: 'disposed' } : { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } })) }
    }
    vi.stubGlobal('Worker', ReadyWorker); vi.stubGlobal('createImageBitmap', vi.fn())
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    clock.mockReturnValue(400); act(() => tick?.()); expect(sample).toHaveBeenCalledTimes(1)
    paused = true; clock.mockReturnValue(700); act(() => tick?.())
    paused = false; seeking = true; clock.mockReturnValue(1000); act(() => tick?.())
    seeking = false; ready = 1; clock.mockReturnValue(1300); act(() => tick?.())
    ready = 2; visible.mockReturnValue('hidden'); clock.mockReturnValue(1600); act(() => tick?.())
    expect(sample).toHaveBeenCalledTimes(1)
    const video = document.querySelector('video')!
    const previous = reset.mock.calls.length
    act(() => { video.dispatchEvent(new Event('pause')); video.dispatchEvent(new Event('playing')) })
    expect(reset.mock.calls.length).toBe(previous + 2)
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    act(() => video.dispatchEvent(new Event('playing')))
    expect(reset.mock.calls.length).toBe(previous + 2)
  })

  it('keeps asynchronous Pose and Hand results separate and falls back after a Pose worker error', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    let draw: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1280, height: 720 } as DOMRect)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as never)
    vi.spyOn(drawing, 'drawGhost').mockImplementation(() => {})
    const drawn = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    class TestWorker {
      static instances: TestWorker[] = []
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: ((event: { message: string }) => void) | null = null
      onmessageerror = null
      frames: number[] = []
      terminate = vi.fn()
      constructor() { TestWorker.instances.push(this) }
      postMessage(message: { type: string; id: number }) {
        if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } }))
        if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } }))
        else if (message.type === 'frame') this.frames.push(message.id)
      }
      result(data: object) { this.onmessage?.({ data }) }
    }
    vi.stubGlobal('Worker', TestWorker)
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }))
    render(<WorkspacePage />)
    const parallel = screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)')
    expect(parallel).toBeEnabled()
    enableHands()
    fireEvent.click(parallel)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(parallel).toBeDisabled()
    expect(screen.getByText(/Pose: CPU.*hai Worker/)).toBeInTheDocument()
    const [poseWorker, handWorker] = TestWorker.instances
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1200); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    await waitFor(() => { expect(poseWorker.frames).toHaveLength(1); expect(handWorker.frames).toHaveLength(1) })
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    act(() => handWorker.result({ type: 'result', id: handWorker.frames[0], pose: [], hands: [[{ x: .2, y: .3 }]] }))
    act(() => poseWorker.result({ type: 'result', id: poseWorker.frames[0], pose, hands: null }))
    act(() => draw(1200))
    expect(drawn.mock.calls.some(call => call[5] === false && call[3].length === 33)).toBe(true)
    expect(drawn.mock.calls.some(call => call[5] === true)).toBe(true)
    clock.mockReturnValue(1400); act(() => callback({ now: 1400, mediaTime: 1.2, inferenceTimestamp: 1400 }))
    await waitFor(() => { expect(poseWorker.frames).toHaveLength(2); expect(handWorker.frames).toHaveLength(2) })
    act(() => poseWorker.result({ type: 'result', id: poseWorker.frames[1], pose, hands: null }))
    act(() => handWorker.result({ type: 'result', id: handWorker.frames[1], pose: [], hands: [] }))
    drawn.mockClear(); act(() => draw(1400))
    expect(drawn.mock.calls.some(call => call[5] === false && call[3].length === 33)).toBe(true)
    expect(drawn.mock.calls.some(call => call[5] === true)).toBe(false)
    // A source reset invalidates both in-flight snapshots, even if they arrive afterward.
    clock.mockReturnValue(1600); act(() => callback({ now: 1600, mediaTime: 1.4, inferenceTimestamp: 1600 }))
    await waitFor(() => { expect(poseWorker.frames).toHaveLength(3); expect(handWorker.frames).toHaveLength(3) })
    clock.mockReturnValue(1650); act(() => vi.mocked(startVideoFrameScheduler).mock.lastCall![2].onReset?.())
    act(() => poseWorker.result({ type: 'result', id: poseWorker.frames[2], pose, hands: null }))
    act(() => handWorker.result({ type: 'result', id: handWorker.frames[2], pose: [], hands: [[{ x: .2, y: .3 }]] }))
    drawn.mockClear(); act(() => draw(1650)); expect(drawn).not.toHaveBeenCalled()
    clock.mockReturnValue(1700); act(() => callback({ now: 1700, mediaTime: 0.1, inferenceTimestamp: 1700 }))
    await waitFor(() => { expect(poseWorker.frames).toHaveLength(4); expect(handWorker.frames).toHaveLength(4) })
    act(() => poseWorker.result({ type: 'result', id: poseWorker.frames[3], pose, hands: null }))
    act(() => handWorker.result({ type: 'result', id: handWorker.frames[3], pose: [], hands: [[{ x: .2, y: .3 }]] }))
    drawn.mockClear(); act(() => draw(1700))
    expect(drawn.mock.calls.some(call => call[5] === false && call[3].length === 33)).toBe(true)
    expect(drawn.mock.calls.some(call => call[5] === true)).toBe(true)
    act(() => handWorker.onerror?.({ message: 'Hand failure' }))
    expect(screen.getByText(/Nhận diện bàn tay bị lỗi/)).toBeInTheDocument()
    expect(screen.getByText(/Pose: CPU.*Worker Pose/)).toBeInTheDocument()
    expect(screen.getByText(/Giới hạn tự điều chỉnh Pose .* Hand không khả dụng/)).toBeInTheDocument()
    await waitFor(() => expect(handWorker.terminate).toHaveBeenCalledOnce())
    expect(poseWorker.terminate).not.toHaveBeenCalled()
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never)
    act(() => poseWorker.onerror?.({ message: 'Pose failure' }))
    await waitFor(() => expect(screen.getByText(/Pose: GPU.*luồng chính/)).toBeInTheDocument())
    expect(screen.getByText(/Bàn tay vẫn không khả dụng/)).toBeInTheDocument()
    expect(poseWorker.terminate).toHaveBeenCalledOnce()
    expect(HandLandmarker.createFromOptions).not.toHaveBeenCalled()
  })

  it('cancels both Workers if camera stops while they initialize', async () => {
    class PendingWorker {
      static instances: PendingWorker[] = []
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror = null; onmessageerror = null
      postMessage(message: { type: string }) { if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } })) }
      terminate = vi.fn()
      constructor() { PendingWorker.instances.push(this) }
    }
    vi.stubGlobal('Worker', PendingWorker)
    vi.stubGlobal('createImageBitmap', vi.fn())
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await waitFor(() => expect(PendingWorker.instances).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' }))
    await waitFor(() => expect(PendingWorker.instances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true))
    expect(startVideoFrameScheduler).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
  })

  it('keeps Pose available if the Hand worker fails during initialization', async () => {
    class HandInitFailsWorker {
      static instances: HandInitFailsWorker[] = []
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror = null; onmessageerror = null
      terminate = vi.fn()
      constructor() { HandInitFailsWorker.instances.push(this) }
      postMessage(message: { type: string; role?: string }) {
        if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } }))
        if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: message.role === 'hand' ? { type: 'error', message: 'hand unavailable' } : { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } }))
      }
    }
    vi.stubGlobal('Worker', HandInitFailsWorker)
    vi.stubGlobal('createImageBitmap', vi.fn())
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(screen.getByText(/Nhận diện bàn tay bị lỗi/)).toBeInTheDocument()
    expect(screen.getByText(/Pose: CPU.*Worker Pose/)).toBeInTheDocument()
    expect(HandInitFailsWorker.instances[0].terminate).not.toHaveBeenCalled()
    expect(HandInitFailsWorker.instances[1].terminate).toHaveBeenCalledOnce()
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    await waitFor(() => expect(HandInitFailsWorker.instances[0].terminate).toHaveBeenCalledOnce())
  })

  it('restores the saved single Worker preference after trying the two Worker option', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ workerTracking: true }))
    render(<WorkspacePage />)
    const single = screen.getByLabelText('Sử dụng Worker GPU (thử nghiệm)')
    const parallel = screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)')
    expect(single).toBeChecked()
    enableHands()
    fireEvent.click(parallel)
    expect(single).not.toBeChecked()
    expect(JSON.parse(localStorage.getItem('rehab.settings')!).workerTracking).toBe(true)
    fireEvent.click(parallel)
    expect(single).toBeChecked()
    await waitFor(() => expect(JSON.parse(localStorage.getItem('rehab.settings')!).workerTracking).toBe(true))
  })

  it('closes the first Worker if constructing the second Worker fails', async () => {
    const terminate = vi.fn()
    let created = 0
    class ConstructorFailureWorker {
      constructor() { if (++created === 2) throw new Error('worker blocked') }
      terminate = terminate
    }
    vi.stubGlobal('Worker', ConstructorFailureWorker)
    vi.stubGlobal('createImageBitmap', vi.fn())
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never)
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByLabelText('Sử dụng hai Worker CPU (thử nghiệm)'))
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByText(/Pose: GPU.*luồng chính/)
    expect(terminate).toHaveBeenCalledOnce()
    expect(screen.getByText(/Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính/)).toBeInTheDocument()
  })

  it('saves the Worker preference, locks it while tracking and reports unavailable Worker fallback', async () => {
    vi.stubGlobal('Worker', undefined)
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never)
    render(<WorkspacePage />)
    const preference = screen.getByRole('checkbox', { name: 'Sử dụng Worker GPU (thử nghiệm)' })
    expect(preference).toBeChecked()
    fireEvent.click(preference)
    expect(preference).not.toBeChecked()
    fireEvent.click(preference)
    await waitFor(() => expect(JSON.parse(localStorage.getItem('rehab.settings')!).workerTracking).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(preference).toBeDisabled()
    expect(screen.getByText(/Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính/)).toBeInTheDocument()
    expect(screen.getByText(/Pose: GPU.*luồng chính/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    expect(preference).toBeEnabled()
  })

  it('starts the selected Worker and shows the active engine', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ workerTracking: true }))
    const terminate = vi.fn()
    class ReadyWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: ((event: { message: string }) => void) | null = null
      postMessage(message: { type: string }) { queueMicrotask(() => this.onmessage?.({ data: message.type === 'dispose' ? { type: 'disposed' } : { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } })) }
      terminate = terminate
    }
    vi.stubGlobal('Worker', ReadyWorker)
    vi.stubGlobal('createImageBitmap', vi.fn())
    render(<WorkspacePage />)
    expect(screen.getByRole('checkbox', { name: 'Sử dụng Worker GPU (thử nghiệm)' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    expect(screen.getByText(/Pose: CPU.*Worker CPU/)).toBeInTheDocument()
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    await waitFor(() => expect(terminate).toHaveBeenCalled())
  })

  it.each([false, true])('clears a previous Hand on a stale Worker failure; cleanup fails: %s', async cleanupFailed => {
    localStorage.setItem('rehab.settings', JSON.stringify({ workerTracking: true }))
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    let draw: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1280, height: 720 } as DOMRect)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as never)
    vi.spyOn(drawing, 'drawGhost').mockImplementation(() => {})
    const drawn = vi.spyOn(drawing, 'drawLandmarks').mockImplementation(() => {})
    const frames: Array<{ id: number; hand: boolean }> = []
    class TestWorker {
      static instances: TestWorker[] = []
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: ((event: { message: string }) => void) | null = null
      onmessageerror = null
      terminate = vi.fn()
      constructor() { TestWorker.instances.push(this) }
      postMessage(message: { type: string; id: number; hand: boolean }) {
        if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } }))
        if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', delegates: { pose: 'CPU', hand: 'CPU' } } }))
        else if (message.type === 'frame') frames.push(message)
      }
      result(data: Record<string, unknown>) {
        const frame = frames.find(item => item.id === data.id)
        if (!frame) throw new Error('Unknown source request')
        if (data.hands !== null) this.onmessage?.({ data: { ...frame, ...data, type: 'hand_result', handProcessed: !data.handFailed } })
        this.onmessage?.({ data: { ...frame, ...data, type: 'pose_result', poseProcessed: true } })
        this.onmessage?.({ data: { ...frame, ...data, type: 'frame_complete', poseProcessed: true, handProcessed: data.hands !== null && !data.handFailed, inferenceMs: 5 } })
      }
    }
    vi.stubGlobal('Worker', TestWorker)
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }))
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const worker = TestWorker.instances[0]
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1200); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    await waitFor(() => expect(frames).toHaveLength(1))
    act(() => worker.result({ type: 'result', id: frames[0].id, pose: [], hands: [[{ x: .5, y: .5 }]] }))
    act(() => draw(1200)); expect(drawn.mock.calls.filter(call => call[5] === true)).toHaveLength(1)
    clock.mockReturnValue(1300); act(() => callback({ now: 1300, mediaTime: 1.1, inferenceTimestamp: 1300 }))
    await waitFor(() => expect(frames).toHaveLength(2))
    // Its callback timestamp is stale, but the failure must invalidate the previous Hand immediately.
    clock.mockReturnValue(2101)
    act(() => worker.result({ type: 'result', id: frames[1].id, pose: [], hands: [], handFailed: true, handCleanupFailed: cleanupFailed }))
    expect(screen.getByText(/Nhận diện bàn tay bị lỗi/)).toBeInTheDocument()
    if (cleanupFailed) expect(screen.getByText(/Không thể giải phóng model bàn tay/)).toBeInTheDocument()
    expect(screen.getByText(/Pose: CPU.*Worker CPU/)).toBeInTheDocument()
    expect(worker.terminate).not.toHaveBeenCalled()
    drawn.mockClear(); act(() => draw(2101)); expect(drawn.mock.calls.filter(call => call[5] === true)).toHaveLength(0)
    clock.mockReturnValue(2200); act(() => callback({ now: 2200, mediaTime: 2, inferenceTimestamp: 2200 }))
    await waitFor(() => expect(frames).toHaveLength(3))
    expect(frames[0].hand).toBe(true); expect(frames[1].hand).toBe(true); expect(frames[2].hand).toBe(false)
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    act(() => worker.result({ type: 'result', id: frames[2].id, pose, hands: null }))
    drawn.mockClear(); act(() => draw(2200))
    expect(drawn.mock.calls.some(call => call[5] === false && call[3].length === 33)).toBe(true)
    expect(drawn.mock.calls.some(call => call[5] === true)).toBe(false)
    expect(startVideoFrameScheduler).toHaveBeenCalledTimes(1)
    expect(PoseLandmarker.createFromOptions).not.toHaveBeenCalled()
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never)
    act(() => worker.onerror?.({ message: 'fatal worker failure' }))
    await waitFor(() => expect(screen.getByText(/Pose: GPU.*luồng chính/)).toBeInTheDocument())
    expect(HandLandmarker.createFromOptions).not.toHaveBeenCalled()
  })

  it('cleans each main-thread model loader without removing unrelated scripts when Hand fails', async () => {
    const unrelated = document.createElement('script')
    unrelated.src = '/other-loader.js'
    document.body.appendChild(unrelated)
    const loaderUrls: string[] = []
    const appendLoader = (files: { wasmLoaderPath: string }) => {
      const script = document.createElement('script')
      script.src = files.wasmLoaderPath
      loaderUrls.push(script.src)
      document.body.appendChild(script)
    }
    vi.mocked(PoseLandmarker.createFromOptions).mockImplementationOnce(async files => {
      appendLoader(files)
      return { close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never
    })
    vi.mocked(HandLandmarker.createFromOptions).mockImplementation(async files => {
      appendLoader(files)
      throw new Error('hand unavailable')
    })
    try {
      render(<WorkspacePage />)
      enableHands()
      fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
      fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
      await screen.findByRole('button', { name: 'Dừng nhận diện' })
      expect(screen.getByText(/Không tải được mô hình bàn tay/)).toBeInTheDocument()
      expect(loaderUrls).toHaveLength(3)
      expect(document.querySelectorAll('script[src]')).not.toContainEqual(expect.objectContaining({ src: loaderUrls[0] }))
      expect(document.querySelectorAll('script[src]')).not.toContainEqual(expect.objectContaining({ src: loaderUrls[1] }))
      expect(unrelated.isConnected).toBe(true)
    } finally { unrelated.remove() }
  })

  it('reports the selected upper limb as unreliable until shoulder, elbow and wrist are in frame with adequate visibility', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const vision = await import('@mediapipe/tasks-vision')
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    pose[15] = { x: .5, y: .5, visibility: .1 }
    vi.mocked(vision.PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [pose] })) } as never)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1200); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    expect(screen.getAllByText(/^Mốc vai, khuỷu hoặc cổ tay trái chưa đáng tin cậy/)[0]).toBeInTheDocument()
    pose[15] = { x: 1.1, y: .5, visibility: .9 }
    clock.mockReturnValue(2300); act(() => callback({ now: 2300, mediaTime: 2, inferenceTimestamp: 2300 }))
    expect(screen.getAllByText(/^Mốc vai, khuỷu hoặc cổ tay trái chưa đáng tin cậy/)[0]).toBeInTheDocument()
    pose[15] = { x: .5, y: .5, visibility: .9 }
    clock.mockReturnValue(3400); act(() => callback({ now: 3400, mediaTime: 3, inferenceTimestamp: 3400 }))
    expect(screen.getAllByText(/Đang theo dõi chi trên trái/)[0]).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Tay ảnh hưởng'), { target: { value: 'right' } })
    pose[16] = { x: Number.NaN, y: .5, visibility: .9 }
    clock.mockReturnValue(4500); act(() => callback({ now: 4500, mediaTime: 4, inferenceTimestamp: 4500 }))
    expect(screen.getAllByText(/Mốc vai, khuỷu hoặc cổ tay phải chưa đáng tin cậy/)[0]).toBeInTheDocument()
  })

  it('does not report an old hand as current when only Pose keeps updating', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ trackingProfile: 'quality' }))
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const vision = await import('@mediapipe/tasks-vision')
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    vi.mocked(vision.PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [pose] })) } as never)
    vi.mocked(vision.HandLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [[{ x: .5, y: .5 }]] })) } as never)
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1200); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    expect(screen.getAllByText(/Đang theo dõi chi trên trái · Hand trái:/)[0]).toBeInTheDocument()
    // Quality schedules Pose before the next Hand slot. A delayed Pose result
    // must not refresh the Hand from the previous source observation.
    clock.mockReturnValue(2300); act(() => callback({ now: 1234, mediaTime: 2, inferenceTimestamp: 2300 }))
    expect(screen.getAllByText(/Đang theo dõi chi trên trái · chưa thấy bàn tay/)[0]).toBeInTheDocument()
  })

  it.each([false, true])('keeps Pose running and clears Hand when inference fails; close throws: %s', async closeThrows => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    let draw: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1280, height: 720 } as DOMRect)
    const arc = vi.fn()
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), setLineDash: vi.fn(), arc } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    const poseDetect = vi.fn(() => ({ landmarks: [] }))
    const poseClose = vi.fn(), handClose = vi.fn(() => { if (closeThrows) throw new Error('close failed') })
    const handDetect = vi.fn().mockReturnValueOnce({ landmarks: [[{ x: .5, y: .5 }]] }).mockImplementationOnce(() => { throw new Error('hand failed') })
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: poseClose, detectForVideo: poseDetect } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ close: handClose, detectForVideo: handDetect } as never)
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1200); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    act(() => draw(1200)); expect(arc).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1300); act(() => callback({ now: 1300, mediaTime: 1.1, inferenceTimestamp: 1300 }))
    expect(screen.getByRole('button', { name: 'Dừng nhận diện' })).toBeInTheDocument()
    expect(screen.getByText(/Nhận diện bàn tay bị lỗi/)).toBeInTheDocument()
    if (closeThrows) expect(screen.getByText(/Không thể giải phóng model bàn tay/)).toBeInTheDocument()
    expect(handClose).toHaveBeenCalledTimes(1); expect(poseClose).not.toHaveBeenCalled()
    act(() => draw(1300)); expect(arc).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1500); act(() => callback({ now: 1500, mediaTime: 1.3, inferenceTimestamp: 1500 }))
    expect(poseDetect).toHaveBeenCalledTimes(3)
    expect(handDetect).toHaveBeenCalledTimes(2)
    expect(startVideoFrameScheduler).toHaveBeenCalledTimes(1)
  })

  it('marks Pose stale after its 250 ms lifetime without waiting for camera disconnect', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    let watchdog: (() => void) | undefined
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler => { watchdog = handler as () => void; return 123 as unknown as ReturnType<typeof setInterval> }) as typeof setInterval)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: .9 }))
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [pose] })) } as never)
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    // Inference finishes 200 ms after acquisition; expiry is based on the source observation.
    clock.mockReturnValue(1400); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    expect(screen.getAllByText(/Đang theo dõi chi trên trái/)[0]).toBeInTheDocument()
    clock.mockReturnValue(1451); act(() => watchdog?.())
    expect(screen.getAllByText(/Không có mốc tư thế mới/)[0]).toBeInTheDocument()
    clock.mockReturnValue(4301); act(() => watchdog?.())
    expect(screen.getByText('Camera không cung cấp kết quả mới')).toBeInTheDocument()
  })

  it('retains a newly observed Hand while Pose is absent and removes it after its own expiry', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    let draw: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { draw = callback; return 1 }))
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1280, height: 720 } as DOMRect)
    const arc = vi.fn()
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), setLineDash: vi.fn(), arc } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [] })) } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [[{ x: .5, y: .5 }]] })) } as never)
    render(<WorkspacePage />)
    enableHands()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    clock.mockReturnValue(1200); act(() => callback({ now: 1200, mediaTime: 1, inferenceTimestamp: 1200 }))
    act(() => draw(1200)); expect(arc).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1351); act(() => draw(1351)); expect(arc).toHaveBeenCalledTimes(1)
  })

  it('keeps demo separate and does not allow saving', async () => {
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Chạy demo' }))
    expect(screen.getByText('DEMO — KHÔNG PHẢI DỮ LIỆU BỆNH NHÂN')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeDisabled()
  })

  it('saves normalized settings against the selected session and clears confirmation when changed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    const confirm = await screen.findByLabelText('Tôi đã kiểm tra vị trí và tư thế người bệnh')
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    fireEvent.click(screen.getByLabelText('Lật ảnh ngang'))
    expect(confirm).not.toBeChecked()
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(payload).toMatchObject({ session_id: 7, camera_device_id: 'camera-1', width: 1280, height: 720, mirrored: false, confirmed: true })
    cleanup(); expect(stop).toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('identifies the original session when a delayed save reports %s after switching sessions', async outcome => {
    let resolveFetch!: (value: unknown) => void
    let rejectFetch!: (error: Error) => void
    const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<unknown>>(() => new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject }))
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #8/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).session_id).toBe(7)
    fireEvent.change(screen.getByLabelText('Phiên tập'), { target: { value: '8' } })
    await act(async () => {
      if (outcome === 'success') resolveFetch({ ok: true, json: async () => ({ id: 1 }) })
      else rejectFetch(new Error('network disconnected'))
    })
    expect(screen.getByLabelText('Phiên tập')).toHaveValue('8')
    expect(screen.getAllByRole('status').find(item => item.classList.contains('workspace-message'))).toHaveTextContent(outcome === 'success'
      ? 'Đã lưu xác nhận camera và hiệu chuẩn cho phiên #7.'
      : 'Không xác nhận được lưu hiệu chuẩn cho phiên #7.')
  })

  it.each(['success', 'failure'] as const)('serializes rapid saves until a pending request ends with %s', async outcome => {
    let resolveFetch!: (value: unknown) => void
    let rejectFetch!: (error: Error) => void
    const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<unknown>>(() => new Promise((resolve, reject) => { resolveFetch = resolve; rejectFetch = reject }))
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #8/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    const button = screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })
    await waitFor(() => expect(button).toBeEnabled())
    // The request lock prevents a second POST, including while the button remains mounted.
    act(() => { button.click(); button.click() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('Phiên tập'), { target: { value: '8' } })
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      if (outcome === 'success') resolveFetch({ ok: true, json: async () => ({ id: 1 }) })
      else rejectFetch(new Error('network disconnected'))
    })
    expect(button).toBeEnabled()
    expect(screen.getAllByRole('status').find(item => item.classList.contains('workspace-message'))).toHaveTextContent(outcome === 'success' ? /phiên #7/ : /Không xác nhận được lưu hiệu chuẩn cho phiên #7/)
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).session_id).toBe(8)
    await act(async () => resolveFetch({ ok: true, json: async () => ({ id: 2 }) }))
  })

  it('does not cancel an in-flight save and keeps a remounted Workspace locked until it settles', async () => {
    let resolveFetch!: (value: unknown) => void
    const fetchMock = vi.fn(() => new Promise(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    view.unmount()
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => resolveFetch({ ok: true, json: async () => ({ id: 1 }) }))
    expect(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeEnabled()
  })

  it('does not render the ghost silhouette or its positioning controls', async () => {
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    expect(screen.queryByLabelText('Hiển thị hình bóng')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Vị trí ngang/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Độ trong suốt/)).not.toBeInTheDocument()
  })

  it('includes calibration controls in the fullscreen target', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Toàn màn hình' }))
    expect(requestFullscreen).toHaveBeenCalledOnce()
    const fullscreenElement = requestFullscreen.mock.contexts[0] as HTMLElement
    expect(fullscreenElement).toContainElement(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    expect(fullscreenElement.querySelector('[aria-label="Hiển thị hình bóng"]')).toBeNull()
  })

  it('explains denied camera permission and retains demo access', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    expect(await screen.findByText(/Quyền camera bị từ chối/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Chạy demo' }))
    expect(screen.getByText('DEMO — KHÔNG PHẢI DỮ LIỆU BỆNH NHÂN')).toBeInTheDocument()
  })

  it('honors the existing camera resolution setting independently of tracking profile', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ resolution: '640x480', trackingProfile: 'quality' }))
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      video: expect.objectContaining({ width: { ideal: 640 }, height: { ideal: 480 } }),
    }))
  })

  it('lets the operator opt in to profile camera constraints and restore the saved manual size', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ resolution: '1024x768', trackingProfile: 'quality' }))
    render(<WorkspacePage />)
    const profileSize = screen.getByLabelText('Dùng độ phân giải camera theo cấu hình tracking')
    expect(profileSize).not.toBeChecked()
    fireEvent.click(profileSize)
    await waitFor(() => expect(JSON.parse(localStorage.getItem('rehab.settings')!).profileCameraResolution).toBe(true))
    expect(JSON.parse(localStorage.getItem('rehab.settings')!).resolution).toBe('1024x768')
    expect(screen.getByText('Yêu cầu camera: 1920 × 1080')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeEnabled())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ video: expect.objectContaining({ width: { ideal: 1920 }, height: { ideal: 1080 } }) }))
    expect(profileSize).toBeDisabled()
    expect(screen.getByText('Camera thực tế: 1280 × 720')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' }))
    expect(profileSize).toBeEnabled()
    fireEvent.click(profileSize)
    await waitFor(() => expect(JSON.parse(localStorage.getItem('rehab.settings')!).profileCameraResolution).toBe(false))
    expect(screen.getByText('Yêu cầu camera: 1024 × 768')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2))
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ video: expect.objectContaining({ width: { ideal: 1024 }, height: { ideal: 768 } }) }))
  })

  it('requests Economy camera dimensions only after explicit opt-in and reports the negotiated size', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ resolution: '1920x1080', trackingProfile: 'economy', profileCameraResolution: true }))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeEnabled())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ width: { ideal: 640 }, height: { ideal: 480 } }) }))
    expect(screen.getByText('Yêu cầu camera: 640 × 480')).toBeInTheDocument()
    expect(screen.getByText('Camera thực tế: 1280 × 720')).toBeInTheDocument()
    expect(screen.getByLabelText('Hiệu năng')).toBeDisabled()
    expect(JSON.parse(localStorage.getItem('rehab.settings')!).resolution).toBe('1920x1080')
    const confirm = screen.getByLabelText('Tôi đã kiểm tra vị trí và tư thế người bệnh')
    fireEvent.click(confirm); expect(confirm).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ width: 1280, height: 720 })
    fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' }))
    expect(confirm).not.toBeChecked()
    expect(screen.getByLabelText('Hiệu năng')).toBeEnabled()
  })

  it('locks profile choice during a pending camera request and does not apply an invalid opt-in', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ resolution: '1920x1080', trackingProfile: 'economy', profileCameraResolution: 'true' }))
    let resolveCamera!: (stream: MediaStream) => void
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => new Promise(resolve => { resolveCamera = resolve }))
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    expect(screen.getByLabelText('Hiệu năng')).toBeDisabled()
    expect(screen.getByLabelText('Dùng độ phân giải camera theo cấu hình tracking')).toBeDisabled()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ width: { ideal: 1920 }, height: { ideal: 1080 } }) }))
    const track = { getSettings: () => ({ width: 1024, height: 768 }), addEventListener: vi.fn(), stop: vi.fn() }
    await act(async () => resolveCamera({ getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream))
    expect(screen.getByText('Camera thực tế: 1024 × 768')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('rehab.settings')!).profileCameraResolution).toBe(false)
  })

  it('allows stopping an active camera even when device enumeration never resolves', async () => {
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockImplementationOnce(() => new Promise(() => {}))
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' }))
    expect(stop).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bật camera' })).toBeEnabled()
  })

  it('does not label the requested size as the actual camera size when dimensions are unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) })
    vi.stubGlobal('fetch', fetchMock)
    const track = { getSettings: () => ({}), addEventListener: vi.fn(), stop: vi.fn() }
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce({ getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream)
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeEnabled())
    expect(screen.getByText('Camera thực tế: không xác định')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ width: null, height: null })
  })

  it('keeps manual calibration usable if MediaPipe model loading fails', async () => {
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    expect(await screen.findByText(/Không tải được MediaPipe hoặc model cục bộ/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Vị trí ngang/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeEnabled()
  })

  it('falls back to the main thread when worker initialization is blocked', async () => {
    localStorage.setItem('rehab.workerTracking', 'enabled')
    const terminate = vi.fn()
    vi.stubGlobal('Worker', class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror = null; terminate = terminate
      postMessage(message: { type: string }) {
        if (message.type === 'init') throw new Error('worker blocked')
        if (message.type === 'dispose') queueMicrotask(() => this.onmessage?.({ data: { type: 'disposed' } }))
      }
    })
    vi.stubGlobal('createImageBitmap', vi.fn())
    const vision = await import('@mediapipe/tasks-vision')
    vi.mocked(vision.PoseLandmarker.createFromOptions).mockResolvedValueOnce({ close: vi.fn() } as never)
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    expect(await screen.findByText(/Worker không khả dụng/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Dừng nhận diện' })).toBeEnabled()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('stops the session and invalidates confirmation when the camera disconnects', async () => {
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    const confirm = await screen.findByLabelText('Tôi đã kiểm tra vị trí và tư thế người bệnh')
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    expect(confirm).toBeChecked()
    await waitFor(() => expect(trackListener).toHaveBeenCalled())
    const ended = trackListener.mock.calls.find(call => call[0] === 'ended')?.[1] as () => void
    act(() => ended())
    expect(await screen.findByText(/Camera đã ngắt kết nối/)).toBeInTheDocument()
    expect(confirm).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeDisabled()
    expect(stop).toHaveBeenCalled()
  })

  it('handles camera disconnect while video playback is still starting', async () => {
    const track = new EventTarget() as MediaStreamTrack
    Object.defineProperties(track, { stop: { value: vi.fn() }, getSettings: { value: () => ({ width: 1280, height: 720 }) }, label: { value: 'camera' } })
    const listener = vi.spyOn(track, 'addEventListener')
    let finishPlay!: () => void
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(new Promise<void>(resolve => { finishPlay = resolve }))
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream as unknown as MediaStream)
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(listener).toHaveBeenCalledWith('ended', expect.any(Function), { once: true }))
    act(() => track.dispatchEvent(new Event('ended')))
    await act(async () => finishPlay())
    expect(screen.getByText(/Camera đã ngắt kết nối/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bật camera' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
  })

  it('locks tracking configuration during model load and closes a late model after camera stops', async () => {
    let finishPose!: (value: unknown) => void
    const close = vi.fn()
    vi.mocked(PoseLandmarker.createFromOptions).mockImplementationOnce(() => new Promise(resolve => { finishPose = resolve as (value: unknown) => void }))
    render(<WorkspacePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await waitFor(() => expect(PoseLandmarker.createFromOptions).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Đang tải…' })).toBeDisabled()
    expect(screen.getByLabelText('Theo dõi 21 mốc bàn tay')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' }))
    await act(async () => finishPose({ close }))
    expect(close).toHaveBeenCalledOnce()
    expect(startVideoFrameScheduler).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
  })

  it('requires camera and posture reconfirmation after camera settings change', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 2 }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    const confirm = await screen.findByLabelText('Tôi đã kiểm tra vị trí và tư thế người bệnh')
    await waitFor(() => expect(confirm).toBeEnabled())
    // Ghost positioning controls were removed from calibration.
    fireEvent.click(confirm)
    fireEvent.click(confirm); fireEvent.click(screen.getByLabelText('Lật ảnh ngang')); expect(confirm).not.toBeChecked()
    fireEvent.click(screen.getByLabelText('Hiển thị mốc vận động'))
    enableHands()
    expect(screen.getByLabelText('Hiển thị mốc vận động')).not.toBeChecked()
    expect(screen.getByLabelText('Theo dõi 21 mốc bàn tay')).toBeChecked()
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Lưu hiệu chuẩn' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ mirrored: false, ghost_visible: true, confirmed: true })
  })
})

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePage from './WorkspacePage'
import { createWorkerTracker, waitForWorkerDisposals } from './workerTracker'
import type { WorkerHandResult, WorkerPoseResult } from './workerTracker'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import { drawLandmarks, prepareOverlay } from './drawing'
import { PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'

const capture = vi.hoisted(() => ({ start: vi.fn(), addFrame: vi.fn(), stop: vi.fn(), abort: vi.fn(), isActive: vi.fn(() => false), state: '', busy: false, stats: null, captureId: null, elapsedMs: 0 }))
vi.mock('../../services/api', () => ({ api: { sessions: async () => [{ id: 7, patient_id: 3, affected_side: 'left', status: 'draft', session_type: 'training' }] } }))
vi.mock('./workerTracker', () => ({ createWorkerTracker: vi.fn(), waitForWorkerDisposals: vi.fn(async () => {}) }))
vi.mock('./videoFrameScheduler', () => ({ startVideoFrameScheduler: vi.fn(() => vi.fn()) }))
vi.mock('./useResearchCapture', () => ({ useResearchCapture: () => capture }))
vi.mock('./CaptureArtifactStatus', () => ({ CaptureArtifactStatus: () => null }))
vi.mock('./useVideoMapping', () => ({ useVideoMapping: () => [mapping, box] }))
vi.mock('./drawing', async importOriginal => ({ ...await importOriginal<typeof import('./drawing')>(), prepareOverlay: vi.fn(() => ({ width: 1280, height: 720 })), drawLandmarks: vi.fn() }))
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) }, PoseLandmarker: { createFromOptions: vi.fn() }, HandLandmarker: { createFromOptions: vi.fn() } }))

const mapping = { current: { box: { width: 1280, height: 720 }, rect: { x: 0, y: 0, width: 1280, height: 720 } } }
const box = { current: { width: 1280, height: 720 } }
const pose = Array.from({ length: 33 }, () => ({ x: .4, y: .5, z: 0, visibility: 1 }))
const hands = [Array.from({ length: 21 }, () => ({ x: .7, y: .5, z: 0 }))]

describe('Workspace hand-first integration', () => {
  let now: number
  let animation: FrameRequestCallback | null
  let tracker: { submit: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; delegates: { pose: 'GPU'; hand: 'GPU' }; initializationErrors: string[]; lastRequestId: number }
  const options = () => vi.mocked(createWorkerTracker).mock.lastCall![0]
  const handResult = (timestamp = 100) => ({ id: 1, requestId: 1, sourceFrameId: 20, sourceMediaTimeMs: 800, sourcePerformanceMs: timestamp, timestamp, hands, handWorldLandmarks: [], handedness: [[{ categoryName: 'Left', score: 1, index: 0, displayName: '' }]], handInferenceMs: 8, handProcessed: true } as WorkerHandResult)
  const poseResult = (timestamp = 100) => ({ id: 1, requestId: 1, sourceFrameId: 20, sourceMediaTimeMs: 800, sourcePerformanceMs: timestamp, timestamp, pose, poseWorldLandmarks: [], poseInferenceMs: 12, poseProcessed: true } as WorkerPoseResult)
  const tick = (time: number) => { now = time; act(() => { const draw = animation; animation = null; draw?.(time) }) }
  const start = async () => {
    render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
  }

  beforeEach(() => {
    now = 100; animation = null
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { animation = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('createImageBitmap', vi.fn())
    const track = { stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720 }), addEventListener: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] })), enumerateDevices: vi.fn(async () => []) } })
    tracker = { submit: vi.fn(() => true), dispose: vi.fn(async () => {}), close: vi.fn(), delegates: { pose: 'GPU', hand: 'GPU' }, initializationErrors: [], lastRequestId: 1 }
    vi.mocked(createWorkerTracker).mockReset().mockResolvedValue(tracker as never)
    vi.mocked(waitForWorkerDisposals).mockReset().mockResolvedValue(undefined)
    vi.mocked(startVideoFrameScheduler).mockClear()
    vi.mocked(drawLandmarks).mockClear(); vi.mocked(prepareOverlay).mockClear()
    capture.isActive.mockReturnValue(false); capture.addFrame.mockClear(); capture.start.mockClear()
    localStorage.clear(); history.replaceState({}, '', '/workspace?sessionId=7')
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('draws Hand before Pose completes and expires Hand independently without another inference result', async () => {
    await start(); tick(100)
    act(() => options().onHandResult?.(handResult()))
    tick(101)
    expect(drawLandmarks).toHaveBeenCalledWith(expect.anything(), 1280, 720, hands[0], true, true, mapping.current)
    expect(drawLandmarks).not.toHaveBeenCalledWith(expect.anything(), 1280, 720, pose, true, false, mapping.current)
    act(() => options().onPoseResult?.(poseResult()))
    tick(110)
    vi.mocked(drawLandmarks).mockClear(); vi.mocked(prepareOverlay).mockClear()
    tick(251)
    expect(prepareOverlay).toHaveBeenCalledOnce()
    expect(drawLandmarks).toHaveBeenCalledWith(expect.anything(), 1280, 720, expect.arrayContaining([expect.objectContaining({ x: .4 })]), true, false, mapping.current)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(false)
    tick(351)
    expect(prepareOverlay).toHaveBeenCalledTimes(2)
  })

  it('does not clear and redraw an unchanged overlay every display refresh', async () => {
    await start(); tick(100)
    act(() => options().onHandResult?.(handResult()))
    tick(101)
    vi.mocked(prepareOverlay).mockClear(); vi.mocked(drawLandmarks).mockClear()
    tick(110); tick(120)
    expect(prepareOverlay).not.toHaveBeenCalled()
    expect(drawLandmarks).not.toHaveBeenCalled()
  })

  it('supplies at least 30 callbacks and keeps Hand/Pose budgets independent with explicit source identity', async () => {
    await start()
    expect(vi.mocked(startVideoFrameScheduler).mock.lastCall![2].maxFps).toBeGreaterThanOrEqual(30)
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 100, inferenceTimestamp: 100, mediaTime: .8, sourceFrameId: 20 }))
    act(() => callback({ now: 134, inferenceTimestamp: 134, mediaTime: .834, sourceFrameId: 21 }))
    expect(tracker.submit.mock.calls[0]).toEqual([expect.any(HTMLVideoElement), 100, true, true, { sourceFrameId: 20, sourceMediaTimeMs: 800, sourcePerformanceMs: 100 }])
    expect(tracker.submit.mock.calls[1]).toEqual([expect.any(HTMLVideoElement), 134, true, false, { sourceFrameId: 21, sourceMediaTimeMs: 834, sourcePerformanceMs: 134 }])
  })

  it('waits for old disposal before restart and ignores old session callbacks', async () => {
    await start()
    const old = options()
    let disposed!: () => void
    tracker.dispose.mockImplementationOnce(() => new Promise<void>(resolve => { disposed = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await act(async () => {})
    expect(createWorkerTracker).toHaveBeenCalledOnce()
    await act(async () => disposed())
    await waitFor(() => expect(createWorkerTracker).toHaveBeenCalledTimes(2))
    vi.mocked(drawLandmarks).mockClear()
    act(() => old.onHandResult?.(handResult()))
    tick(120)
    expect(drawLandmarks).not.toHaveBeenCalled()
  })

  it('reports cleanup failure and does not initialize a replacement GPU worker', async () => {
    await start()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    tracker.dispose.mockRejectedValueOnce(new Error('GPU cleanup failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    await screen.findByText('GPU cleanup failed', { exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await act(async () => {})
    expect(createWorkerTracker).toHaveBeenCalledOnce()
    expect(screen.getByText(/Không xác nhận.*giải phóng/)).toBeInTheDocument()
  })

  it('keeps research capture explicitly on the supported main-thread engine', async () => {
    await start()
    fireEvent.click(screen.getByLabelText('Xác nhận quyền thu landmark'))
    expect(screen.getByRole('button', { name: 'Bắt đầu thu dữ liệu' })).toBeDisabled()
    expect(screen.getByText(/Thu landmark yêu cầu nhận diện luồng chính/)).toBeInTheDocument()
    expect(capture.start).not.toHaveBeenCalled()
  })

  it('stops scheduling a failed Pose model while keeping the latest Hand available', async () => {
    await start()
    act(() => {
      options().onHandResult?.(handResult())
      options().onPoseResult?.({ ...poseResult(), pose: [], poseProcessed: false, poseFailed: true, poseError: 'Pose graph failed' })
    })
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 110, inferenceTimestamp: 110, mediaTime: .81, sourceFrameId: 21 }))
    expect(tracker.submit).toHaveBeenLastCalledWith(expect.any(HTMLVideoElement), 110, true, false, expect.anything())
    tick(110)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)
  })

  it('records only the models observed on each main-thread capture frame', async () => {
    localStorage.setItem('rehab.settings', JSON.stringify({ workerTracking: false }))
    vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValue({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [pose], worldLandmarks: [pose] })) } as never)
    vi.mocked(HandLandmarker.createFromOptions).mockResolvedValue({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: hands, worldLandmarks: hands, handedness: [[{ categoryName: 'Left' }]] })) } as never)
    await start()
    capture.isActive.mockReturnValue(true)
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 100, inferenceTimestamp: 100, mediaTime: .8, sourceFrameId: 20 }))
    now = 134
    act(() => callback({ now: 134, inferenceTimestamp: 134, mediaTime: .834, sourceFrameId: 21 }))
    expect(capture.addFrame).toHaveBeenCalledTimes(2)
    expect(capture.addFrame.mock.calls[1][0]).toMatchObject({ source_frame_id: 21, video_media_time_ms: 834, pose_detected: null, hand_detected: true })
    expect(capture.addFrame.mock.calls[1][0].landmarks.every((row: { landmark_source: string }) => row.landmark_source === 'hand')).toBe(true)
  })
})

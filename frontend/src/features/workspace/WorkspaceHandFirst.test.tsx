import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePage from './WorkspacePage'
import { createWorkerTracker, waitForWorkerDisposals } from './workerTracker'
import type { WorkerHandResult, WorkerPoseResult } from './workerTracker'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import { drawLandmarks, prepareOverlay } from './drawing'
import { PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision'

const capture = vi.hoisted(() => ({ start: vi.fn(), addFrame: vi.fn(), stop: vi.fn(), abort: vi.fn(), getScope: vi.fn<() => string | null>(() => null), isActive: vi.fn(() => false), state: '', busy: false, stats: null, captureId: null, elapsedMs: 0 }))
const drawingInput = vi.hoisted(() => ({ onHandObservation: vi.fn(), resetInput: vi.fn(), phase: 'idle', overlay: null, panel: null, hud: null }))
const diagnostics = vi.hoisted(() => ({ recordHand: vi.fn(), recordPose: vi.fn(), recordSource: vi.fn(), recordSubmit: vi.fn(), recordSkip: vi.fn(), reject: vi.fn(), reset: vi.fn(), setActive: vi.fn() }))
vi.mock('./trackingDiagnostics', () => ({ createTrackingDiagnostics: () => diagnostics }))
vi.mock('./TrackingDiagnosticsPanel', () => ({ TrackingDiagnosticsPanel: () => null }))
vi.mock('./useFreeDrawingGame', () => ({ useFreeDrawingGame: () => drawingInput }))
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
    const view = render(<WorkspacePage />)
    await screen.findByRole('option', { name: /Phiên #7/ })
    fireEvent.click(screen.getByRole('button', { name: 'Bật camera' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' }))
    await screen.findByRole('button', { name: 'Dừng nhận diện' })
    return view
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
    capture.isActive.mockReturnValue(false); capture.getScope.mockReturnValue(null); capture.addFrame.mockClear(); capture.start.mockClear()
    drawingInput.onHandObservation.mockClear(); drawingInput.resetInput.mockClear(); drawingInput.phase = 'idle'
    Object.values(diagnostics).forEach(mock => mock.mockClear())
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
    tick(351)
    expect(prepareOverlay).toHaveBeenCalledOnce()
    expect(drawLandmarks).toHaveBeenCalledWith(expect.anything(), 1280, 720, expect.arrayContaining([expect.objectContaining({ x: .4 })]), true, false, mapping.current)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(false)
    tick(461)
    expect(prepareOverlay).toHaveBeenCalledTimes(2)
  })

  it('keeps a near-expiry result visible across the next inference gap without extending raw freshness', async () => {
    await start(); tick(100)
    now = 230
    act(() => options().onHandResult?.(handResult(100)))
    tick(231)
    vi.mocked(drawLandmarks).mockClear()
    act(() => options().onPoseResult?.(poseResult(230)))
    tick(270)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)

    vi.mocked(drawLandmarks).mockClear()
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/))
    tick(271)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(false)
  })

  it('bridges a brief missing detection but repeated misses cannot prolong the last visible landmarks', async () => {
    await start(); tick(100)
    act(() => { options().onHandResult?.(handResult()); options().onPoseResult?.(poseResult()) })
    tick(101)
    now = 140
    act(() => {
      options().onHandResult?.({ ...handResult(140), hands: [] })
      options().onPoseResult?.({ ...poseResult(140), pose: [] })
    })
    vi.mocked(drawLandmarks).mockClear()
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/)); tick(141)
    expect(drawLandmarks).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/)); tick(142)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === false)).toBe(true)
    expect(drawingInput.onHandObservation).toHaveBeenLastCalledWith(expect.objectContaining({ hands: [], timestamp: 140 }))

    now = 340
    act(() => options().onHandResult?.({ ...handResult(340), hands: [] }))
    vi.mocked(drawLandmarks).mockClear()
    tick(351)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(false)
    tick(451)
    vi.mocked(drawLandmarks).mockClear()
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/)); tick(452)
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/)); tick(453)
    expect(drawLandmarks).not.toHaveBeenCalled()
  })

  it('can display a slower result without passing its stale Hand observation to the game or accepting very old results', async () => {
    await start(); tick(100)
    now = 590
    act(() => options().onHandResult?.(handResult(100)))
    tick(591)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)
    expect(drawingInput.onHandObservation).not.toHaveBeenCalled()
    // The source-age cap wins even though the receive-time hold has not elapsed.
    tick(601)
    vi.mocked(drawLandmarks).mockClear()
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/)); tick(602)
    fireEvent.click(screen.getByLabelText(/Hiển thị mốc thô/)); tick(603)
    expect(drawLandmarks).not.toHaveBeenCalled()
    now = 900
    act(() => options().onHandResult?.(handResult(200)))
    tick(901)
    expect(drawLandmarks).not.toHaveBeenCalled()
    expect(drawingInput.onHandObservation).not.toHaveBeenCalled()
  })

  it('clears held landmarks immediately when tracking stops or the source restarts', async () => {
    await start(); tick(100)
    act(() => options().onHandResult?.(handResult()))
    tick(101)
    const scheduler = vi.mocked(startVideoFrameScheduler).mock.lastCall![2]
    now = 130
    act(() => scheduler.onReset?.())
    vi.mocked(drawLandmarks).mockClear(); tick(131)
    expect(drawLandmarks).not.toHaveBeenCalled()
    act(() => options().onHandResult?.(handResult(100)))
    tick(132)
    expect(drawLandmarks).not.toHaveBeenCalled()
    act(() => options().onHandResult?.(handResult(132)))
    tick(133)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    vi.mocked(drawLandmarks).mockClear(); tick(134)
    expect(drawLandmarks).not.toHaveBeenCalled()
  })

  it('delivers raw Hand identity directly to drawing before Pose and rejects stale callbacks', async () => {
    await start()
    const result = handResult()
    act(() => options().onHandResult?.(result))
    expect(drawingInput.onHandObservation).toHaveBeenCalledOnce()
    expect(drawingInput.onHandObservation).toHaveBeenCalledWith({
      hands, handedness: result.handedness, timestamp: 100, frameId: 20,
    })
    now = 300
    act(() => options().onHandResult?.(handResult(110)))
    expect(drawingInput.onHandObservation).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dừng nhận diện' }))
    expect(drawingInput.resetInput).toHaveBeenCalled()
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

  it('lets active Free Drawing own the Hand overlay while retaining Pose and setup landmarks', async () => {
    history.replaceState({}, '', '/workspace?sessionId=7&game=free_drawing')
    const view = await start()
    act(() => { options().onHandResult?.(handResult()); options().onPoseResult?.(poseResult()) })
    tick(101)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)

    vi.mocked(drawLandmarks).mockClear(); vi.mocked(prepareOverlay).mockClear()
    drawingInput.phase = 'playing'; view.rerender(<WorkspacePage />)
    tick(110)
    expect(prepareOverlay).toHaveBeenCalledOnce()
    expect(drawLandmarks).toHaveBeenCalledWith(expect.anything(), 1280, 720, expect.arrayContaining([expect.objectContaining({ x: .4 })]), true, false, mapping.current)
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(false)

    vi.mocked(drawLandmarks).mockClear(); vi.mocked(prepareOverlay).mockClear()
    drawingInput.phase = 'finished'; view.rerender(<WorkspacePage />)
    tick(120)
    expect(prepareOverlay).toHaveBeenCalledOnce()
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)
  })

  it('restores generic Hand rendering on game switch without waiting for another result', async () => {
    history.replaceState({}, '', '/workspace?sessionId=7&game=free_drawing')
    drawingInput.phase = 'playing'
    await start()
    act(() => options().onHandResult?.(handResult()))
    tick(101)
    vi.mocked(drawLandmarks).mockClear(); vi.mocked(prepareOverlay).mockClear()
    fireEvent.change(screen.getByLabelText('Trò chơi thử nghiệm'), { target: { value: 'flower' } })
    tick(110)
    expect(prepareOverlay).toHaveBeenCalledOnce()
    expect(vi.mocked(drawLandmarks).mock.calls.some(call => call[5] === true)).toBe(true)
  })

  it('diagnoses incoming stale results before filtering and counts Worker backpressure only in debug mode', async () => {
    history.replaceState({}, '', '/workspace?sessionId=7&trackingDebug=1')
    await start()
    act(() => options().onHandResult?.(handResult()))
    now = 300
    act(() => options().onHandResult?.(handResult(110)))
    expect(diagnostics.recordHand).toHaveBeenCalledTimes(2)
    expect(diagnostics.recordHand).toHaveBeenLastCalledWith(expect.objectContaining({ timestamp: 110, receivedAt: 300, handCount: 1, validHandCount: 1, requestId: 1, frameId: 20, inferenceMs: 8 }))
    expect(diagnostics.reject).toHaveBeenCalledWith('STALE_HAND', true)
    expect(drawingInput.onHandObservation).toHaveBeenCalledOnce()
    tracker.submit.mockReturnValue(false)
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 300, inferenceTimestamp: 300, mediaTime: 1, sourceFrameId: 21 }))
    expect(diagnostics.recordSkip).toHaveBeenCalledWith('busy')
    expect(diagnostics.recordSource).toHaveBeenCalledWith({ timestamp: 300, visibility: document.visibilityState })
    expect(diagnostics.recordSubmit).not.toHaveBeenCalled()
  })

  it('does not collect diagnostic samples during normal gameplay', async () => {
    await start()
    act(() => options().onHandResult?.(handResult()))
    expect(diagnostics.recordHand).not.toHaveBeenCalled()
  })

  it('supplies at least 30 callbacks and keeps Hand/Pose budgets independent with explicit source identity', async () => {
    await start()
    expect(vi.mocked(startVideoFrameScheduler).mock.lastCall![2].maxFps).toBeGreaterThanOrEqual(30)
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 100, inferenceTimestamp: 100, mediaTime: .8, sourceFrameId: 20 }))
    act(() => callback({ now: 134, inferenceTimestamp: 134, mediaTime: .834, sourceFrameId: 21 }))
    expect(tracker.submit.mock.calls[0]).toEqual([expect.any(HTMLVideoElement), 100, true, true, { sourceFrameId: 20, sourceMediaTimeMs: 800, sourcePerformanceMs: 100, sourceObservationId: 1, captureScope: null }])
    expect(tracker.submit.mock.calls[1]).toEqual([expect.any(HTMLVideoElement), 134, true, false, { sourceFrameId: 21, sourceMediaTimeMs: 834, sourcePerformanceMs: 134, sourceObservationId: 2, captureScope: null }])
  })

  it('does not throttle drawing source callbacks twice and allows cold GPU setup on its first frame', async () => {
    history.replaceState({}, '', '/workspace?sessionId=7&game=free_drawing')
    await start()
    expect(vi.mocked(startVideoFrameScheduler).mock.lastCall![2].maxFps).toBe(120)
    expect(options()).toMatchObject({ initialFrameTimeoutMs: 30000 })
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
    capture.getScope.mockReturnValue('main-capture')
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 100, inferenceTimestamp: 100, mediaTime: .8, sourceFrameId: 20 }))
    now = 134
    act(() => callback({ now: 134, inferenceTimestamp: 134, mediaTime: .834, sourceFrameId: 21 }))
    expect(capture.addFrame).toHaveBeenCalledTimes(2)
    expect(capture.addFrame.mock.calls[1][0]).toMatchObject({ source_frame_id: 21, video_media_time_ms: 834, pose_detected: null, hand_detected: true })
    expect(capture.addFrame.mock.calls[1][0].landmarks.every((row: { landmark_source: string }) => row.landmark_source === 'hand')).toBe(true)
  })

  it('captures actual worker raw/world results with input identity and rejects callbacks belonging to an old scope', async () => {
    await start()
    capture.getScope.mockReturnValue('worker-capture')
    const callback = vi.mocked(startVideoFrameScheduler).mock.lastCall![1]
    act(() => callback({ now: 100, inferenceTimestamp: 100, mediaTime: .8, sourceFrameId: 20 }))
    const source = tracker.submit.mock.calls[0][4]
    const result = { ...source, timestamp: 100, pose, hands, poseWorldLandmarks: pose, handWorldLandmarks: hands, handedness: handResult().handedness, poseProcessed: true, handProcessed: true, poseInferenceMs: 12, handInferenceMs: 8 }
    act(() => options().onResult?.({ ...result, captureScope: 'old-capture' }))
    expect(capture.addFrame).not.toHaveBeenCalled()
    act(() => options().onResult?.(result))
    expect(capture.addFrame).toHaveBeenCalledOnce()
    expect(capture.addFrame.mock.calls[0][0]).toMatchObject({ timestamp: 100, source_frame_id: 20, video_media_time_ms: 800, pose_inference_status: 'detected', hand_inference_status: 'detected' })
    expect(capture.addFrame.mock.calls[0][1]).toBe('worker-capture')
    expect(capture.addFrame.mock.calls[0][0].landmarks.filter((row: { coordinate_space: string }) => row.coordinate_space === 'world')).toHaveLength(54)
  })
})

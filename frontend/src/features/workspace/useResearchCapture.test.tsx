import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResearchCapture } from './useResearchCapture'
import { CaptureUploader, captureRequest, FinalizeOutcomeUnknown } from './captureUploader'
import { acquireCaptureOwnership } from './captureOwnership'

vi.mock('./captureOwnership', () => ({ acquireCaptureOwnership: vi.fn(async () => vi.fn()) }))

vi.mock('./captureUploader', async importOriginal => {
  const actual = await importOriginal<typeof import('./captureUploader')>()
  return { ...actual, captureRequest: vi.fn() }
})

const options = { patientId: 1, sessionId: 2, stream: {} as MediaStream, recordLandmarks: true, recordVideo: false, consentLandmarks: true, consentVideo: false, modelConfig: {} }
const frame = { timestamp: 10, video_media_time_ms: 1, inference_performed: true, pose_detected: false, hand_detected: null, inference_ms: 1, skipped_frames: 0, landmarks: [] }

beforeEach(() => { vi.mocked(captureRequest).mockReset().mockResolvedValue({}); vi.mocked(acquireCaptureOwnership).mockReset().mockResolvedValue(vi.fn()) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('research capture lifecycle', () => {
  it('writes a cancellation terminal before freeing its scope and does not duplicate an existing terminal', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    const event = vi.spyOn(CaptureUploader.prototype, 'addGameEvent').mockImplementation(() => {})
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'cancel', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    const beforeAbort = vi.fn(() => result.current.event('cancel', 'GAME_CANCELLED', { reason: 'camera_stopped' }, { timestamp: now }))
    await act(async () => { await result.current.start({ ...options, autoCapture: true, gameKey: 'free_drawing', trialId: 8, beforeAbort }) })
    act(() => result.current.gameStarted(1100))
    now = 1200
    act(() => result.current.abort('camera_stopped'))
    expect(beforeAbort).toHaveBeenCalledWith('camera_stopped', 1200)
    expect(event).toHaveBeenCalledOnce()
    expect(event).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'GAME_CANCELLED', timestamp_ms: 200 }))
    await waitFor(() => expect(result.current.isActive()).toBe(false))
    now = 2000
    await act(async () => { await result.current.start({ ...options, autoCapture: true, gameKey: 'free_drawing', trialId: 8 }) })
    act(() => result.current.gameStarted(2100))
    now = 2200
    act(() => result.current.abort('source_reset'))
    expect(event).toHaveBeenCalledTimes(2)
    expect(event).toHaveBeenLastCalledWith(expect.objectContaining({ event_type: 'GAME_CANCELLED', payload: { reason: 'source_reset', termination_source: 'capture_abort' } }))
    await waitFor(() => expect(result.current.isActive()).toBe(false))
  })
  it('binds game telemetry to schema 3 capture clock and ignores an old capture scope', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    const event = vi.spyOn(CaptureUploader.prototype, 'addGameEvent').mockImplementation(() => {})
    const sample = vi.spyOn(CaptureUploader.prototype, 'addInteractionSample').mockImplementation(() => {})
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: now === 1000 ? 'first' : 'second', trial_id: now === 1000 ? 8 : 9, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, gameKey: 'free_drawing', trialId: 8 }) })
    act(() => result.current.gameStarted(1100))
    act(() => {
      result.current.event('first', 'STROKE_STARTED', { stroke_id: 1 }, { timestamp: 1200, sourceTimestamp: 1150, sourceObservationId: 55 })
      result.current.sample('first', 'drawing_stroke_point', { x: 3, y: 4 }, { timestamp: 1150, sourceObservationId: 55 })
    })
    expect(captureRequest).toHaveBeenCalledWith('/api/captures', expect.objectContaining({ capture_schema_version: 3 }))
    expect(event).toHaveBeenCalledWith(expect.objectContaining({ timestamp_ms: 200, source_timestamp_ms: 150, source_observation_id: 55, frame_id: null }))
    expect(sample).toHaveBeenCalledWith(expect.objectContaining({ timestamp_ms: 150, trial_id: 8 }))
    await act(async () => { await result.current.stop('completed', 1300) })
    now = 2000
    await act(async () => { await result.current.start({ ...options, autoCapture: true, gameKey: 'glowing_flower', trialId: 9 }) })
    act(() => result.current.gameStarted(2100))
    act(() => result.current.event('first', 'UNDO', {}, { timestamp: 2200 }))
    expect(event).toHaveBeenCalledOnce()
    await act(async () => { await result.current.stop('completed', 2300) })
  })
  it('records and stops both source and tracking streams before finalization', async () => {
    class Recorder extends EventTarget {
      static isTypeSupported = () => true
      static instances: Recorder[] = []
      state = 'inactive'; mimeType = 'video/webm'; ondataavailable: ((event: { data: Blob }) => void) | null = null; onerror = null
      constructor(public stream: MediaStream) { super(); Recorder.instances.push(this) }
      start() { this.state = 'recording'; this.dispatchEvent(new Event('start')) }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['last']) }); this.dispatchEvent(new Event('stop')) }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'addMetadata').mockImplementation(() => {})
    const sourceChunk = vi.spyOn(CaptureUploader.prototype, 'addVideoChunk').mockImplementation(() => {})
    const trackingChunk = vi.spyOn(CaptureUploader.prototype, 'addTrackingVideoChunk').mockImplementation(() => {})
    const finish = vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'both', trial_id: 8, status: 'recording' } : {})
    const close = vi.fn(), trackingStream = {} as MediaStream
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8, recordVideo: true, consentVideo: true, createTrackingVideo: () => ({ stream: trackingStream, close }) }) })
    expect(Recorder.instances).toHaveLength(2)
    expect(Recorder.instances[1].stream).toBe(trackingStream)
    expect(captureRequest).toHaveBeenCalledWith('/api/captures', expect.objectContaining({ model_config: { record_tracking_video: true } }))
    act(() => result.current.gameStarted())
    await act(async () => { await result.current.stop() })
    expect(sourceChunk).toHaveBeenCalledOnce(); expect(trackingChunk).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalled(); expect(finish.mock.calls[0][2]?.tracking_video_complete).toBeUndefined()
  })

  it('keeps source recording and marks tracking incomplete if its stream cannot start', async () => {
    class Recorder extends EventTarget {
      static isTypeSupported = () => true
      state = 'inactive'; mimeType = 'video/webm'; ondataavailable = null; onerror = null
      start() { this.state = 'recording'; this.dispatchEvent(new Event('start')) }
      stop() { this.state = 'inactive'; this.dispatchEvent(new Event('stop')) }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'addMetadata').mockImplementation(() => {})
    vi.spyOn(CaptureUploader.prototype, 'noteGap').mockImplementation(() => {})
    const finish = vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'incomplete' })
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'partial', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8, recordVideo: true, consentVideo: true, createTrackingVideo: () => { throw new Error('unsupported') } }) })
    expect(result.current.isActive()).toBe(true)
    expect(result.current.state).toContain('vẫn tiếp tục lưu')
    act(() => result.current.gameStarted())
    await act(async () => { await result.current.stop() })
    expect(finish.mock.calls[0][2]).toMatchObject({ tracking_video_complete: false, known_data_gaps: [expect.stringContaining('video tracking')] })
  })

  it('includes a tracking failure discovered while closing in the finalize request', async () => {
    class Recorder extends EventTarget {
      static isTypeSupported = () => true
      state = 'inactive'; mimeType = 'video/webm'; ondataavailable = null; onerror = null
      start() { this.state = 'recording'; this.dispatchEvent(new Event('start')) }
      stop() { this.state = 'inactive'; this.dispatchEvent(new Event('stop')) }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'addMetadata').mockImplementation(() => {})
    vi.spyOn(CaptureUploader.prototype, 'noteGap').mockImplementation(() => {})
    const finish = vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'incomplete' })
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'late', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8, recordVideo: true, consentVideo: true, createTrackingVideo: fail => ({ stream: {} as MediaStream, close: fail }) }) })
    act(() => result.current.gameStarted())
    await act(async () => { await result.current.stop() })
    expect(finish.mock.calls[0][2]).toMatchObject({ tracking_video_complete: false, known_data_gaps: [expect.stringContaining('video tracking')] })
  })
  it('holds exclusive ownership until the last upload and releases it after finalization', async () => {
    const release = vi.fn()
    vi.mocked(acquireCaptureOwnership).mockResolvedValue(release)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    let finishUpload!: (result: { status: string }) => void
    vi.spyOn(CaptureUploader.prototype, 'finish').mockImplementation(() => new Promise(resolve => { finishUpload = resolve }))
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'owned', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    expect(acquireCaptureOwnership).toHaveBeenCalledWith('owned')
    expect(release).not.toHaveBeenCalled()
    let stop!: Promise<void>
    act(() => { stop = result.current.stop() })
    await waitFor(() => expect(finishUpload).toBeTypeOf('function'))
    expect(release).not.toHaveBeenCalled()
    await act(async () => { finishUpload({ status: 'complete' }); await stop })
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases ownership when local preparation fails', async () => {
    const release = vi.fn()
    vi.mocked(acquireCaptureOwnership).mockResolvedValue(release)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockRejectedValue(new Error('storage unavailable'))
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'owned', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await expect(result.current.start({ ...options, autoCapture: true, trialId: 8 })).rejects.toThrow('storage unavailable') })
    expect(release).toHaveBeenCalledOnce()
    expect(result.current.isActive()).toBe(false)
  })

  it('releases a late ownership acquisition after pending preparation was cancelled', async () => {
    const release = vi.fn()
    let acquired!: (release: () => void) => void
    vi.mocked(acquireCaptureOwnership).mockImplementationOnce(() => new Promise(resolve => { acquired = resolve }))
    const prepare = vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'owned', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    let start!: ReturnType<typeof result.current.start>
    act(() => { start = result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    await waitFor(() => expect(acquired).toBeTypeOf('function'))
    act(() => result.current.abort('camera_stopped'))
    await act(async () => { acquired(release); expect(await start).toBe(null) })
    expect(prepare).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect(result.current.getScope()).toBe(null)
  })

  it('marks cancellation during initial lease as incomplete without an unmatched gameplay end marker', async () => {
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    const finish = vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'incomplete' })
    let renew!: (value: unknown) => void
    vi.mocked(captureRequest).mockImplementation(async path => {
      if (path === '/api/captures') return { id: 'preparing', trial_id: 8, status: 'recording' }
      if (path.endsWith('/heartbeat')) return new Promise(resolve => { renew = resolve })
      return {}
    })
    const { result } = renderHook(() => useResearchCapture())
    let start!: ReturnType<typeof result.current.start>
    act(() => { start = result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    await waitFor(() => expect(renew).toBeTypeOf('function'))
    act(() => result.current.abort('camera_stopped'))
    await waitFor(() => expect(finish).toHaveBeenCalledOnce())
    const metadata = finish.mock.calls[0][2]!
    expect(metadata.game_started_at_ms).toBeUndefined()
    expect(metadata.game_ended_at_ms).toBeUndefined()
    expect(metadata.known_data_gaps).toEqual([expect.stringContaining('before gameplay')])
    await waitFor(() => expect(captureRequest).toHaveBeenCalledWith('/api/captures/preparing/incomplete', expect.anything()))
    await act(async () => { renew({}); expect(await start).toBe(null) })
  })

  it('rejects missing consent without making an API request', async () => {
    const { result } = renderHook(() => useResearchCapture())
    await expect(result.current.start({ ...options, consentLandmarks: false })).rejects.toThrow('quyền thu thập')
    expect(captureRequest).not.toHaveBeenCalled()
  })

  it('aborts a capture created after tracking was stopped during the request', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(captureRequest).mockImplementation(path => path === '/api/captures' ? new Promise(r => { resolve = r }) : Promise.resolve({}))
    const { result } = renderHook(() => useResearchCapture())
    let start!: ReturnType<typeof result.current.start>
    act(() => { start = result.current.start(options) })
    act(() => result.current.abort())
    await act(async () => { resolve({ id: 'late', trial_id: 3, status: 'recording' }); await start })
    expect(result.current.isActive()).toBe(false)
    expect(captureRequest).toHaveBeenCalledWith('/api/captures/late/abort', expect.anything())
  })

  it('invalidates a pending auto create without starting its recorder or touching the next trial', async () => {
    class Recorder extends EventTarget {
      static isTypeSupported = () => true
      static starts = vi.fn()
      state = 'inactive'; mimeType = 'video/webm'
      start() { Recorder.starts(); this.state = 'recording'; this.dispatchEvent(new Event('start')) }
      stop() { this.state = 'inactive'; this.dispatchEvent(new Event('stop')) }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    let resolveOld!: (value: unknown) => void
    vi.mocked(captureRequest).mockImplementation(async (path, body) => {
      if (path !== '/api/captures') return {}
      return (body as { trial_id: number }).trial_id === 8 ? new Promise(resolve => { resolveOld = resolve }) : { id: 'next', trial_id: 9, status: 'recording' }
    })
    const { result } = renderHook(() => useResearchCapture())
    let oldStart!: ReturnType<typeof result.current.start>
    act(() => { oldStart = result.current.start({ ...options, autoCapture: true, trialId: 8, recordVideo: true, consentVideo: true }) })
    act(() => result.current.abort('camera_stopped'))
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 9 }) })
    await act(async () => { resolveOld({ id: 'late-auto', trial_id: 8, status: 'recording' }); expect(await oldStart).toBe(null) })
    expect(Recorder.starts).not.toHaveBeenCalled()
    expect(captureRequest).toHaveBeenCalledWith('/api/captures/late-auto/incomplete', expect.objectContaining({ reason: 'camera_stopped' }))
    expect(vi.mocked(captureRequest).mock.calls.some(([path]) => path === '/api/captures/late-auto/abort')).toBe(false)
    expect(result.current.getScope()).toBe('next')
    expect(result.current.captureId).toBe('next')
    await act(async () => { await result.current.stop() })
  })

  it('does not cause a React render for each collected frame', async () => {
    vi.useFakeTimers()
    vi.mocked(captureRequest).mockResolvedValue({ id: 'test', trial_id: 3, status: 'recording' })
    let renders = 0
    const { result } = renderHook(() => { renders++; return useResearchCapture() })
    await act(async () => { await result.current.start(options) })
    const before = renders
    for (let index = 0; index < 5; index++) act(() => result.current.addFrame({ ...frame, timestamp: performance.now() }))
    expect(renders).toBe(before)
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.stats?.frames).toBe(5)
  })

  it('uses the per-trial contract and records gameplay end before upload finishes', async () => {
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    const finish = vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'auto', trial_id: 8, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    expect(captureRequest).toHaveBeenCalledWith('/api/captures', expect.objectContaining({ capture_mode: 'per_trial', capture_schema_version: 2, trial_id: 8 }))
    act(() => result.current.gameStarted(performance.now()))
    const end = performance.now()
    let stopping!: Promise<void> | undefined
    act(() => { stopping = result.current.stop('cancelled', end) })
    expect(result.current.getScope()).toBe(null)
    await act(async () => { await stopping })
    expect(finish).toHaveBeenCalledWith(expect.any(Number), expect.any(Function), expect.objectContaining({ termination_reason: 'cancelled', game_started_at_ms: expect.any(Number), game_ended_at_ms: expect.any(Number) }))
    expect(finish.mock.calls[0][2]?.ended_at_utc).toBe(new Date(performance.timeOrigin + end).toISOString())
    expect(result.current.state).toContain('Đã hoàn tất')
  })

  it('rejects late observations from an old capture and observations before t0', async () => {
    vi.useFakeTimers()
    vi.mocked(captureRequest).mockResolvedValue({ id: 'new', trial_id: 3, status: 'recording' })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start(options) })
    act(() => {
      result.current.addFrame({ ...frame, timestamp: performance.now() }, 'old')
      result.current.addFrame({ ...frame, timestamp: -1 }, 'new')
      result.current.addFrame({ ...frame, timestamp: performance.now() }, 'new')
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.stats?.frames).toBe(1)
  })

  it('does not restart a closed automatic capture returned by an idempotent create', async () => {
    vi.mocked(captureRequest).mockResolvedValue({ id: 'done', trial_id: 8, status: 'complete' })
    const { result } = renderHook(() => useResearchCapture())
    let created: unknown
    await act(async () => { created = await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    expect(created).toBe(null)
    expect(result.current.isActive()).toBe(false)
    expect(result.current.captureId).toBe('done')
    expect(vi.mocked(captureRequest).mock.calls).toHaveLength(1)
  })

  it('does not restart a recorder when an automatic capture already exists', async () => {
    vi.mocked(captureRequest).mockResolvedValue({ id: 'existing', trial_id: 8, status: 'recording', reused: true })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { expect(await result.current.start({ ...options, autoCapture: true, trialId: 8 })).toBe(null) })
    expect(result.current.isActive()).toBe(false)
    expect(result.current.state).toContain('khôi phục')
    expect(vi.mocked(captureRequest).mock.calls).toHaveLength(1)
  })

  it('starts the next trial while the previous upload finishes without mixing UI ownership', async () => {
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    let release!: (value: unknown) => void
    vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' }).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    vi.mocked(captureRequest).mockImplementation(async (path, body) => path === '/api/captures' ? { id: `trial-${(body as { trial_id: number }).trial_id}`, trial_id: (body as { trial_id: number }).trial_id, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    let stopping!: Promise<void> | undefined
    await act(async () => { stopping = result.current.stop() })
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 9 }) })
    await act(async () => { release({ status: 'complete' }); await stopping })
    expect(result.current.captureId).toBe('trial-9')
    expect(result.current.getScope()).toBe('trial-9')
    expect(result.current.state).toContain('Đang thu')
    await act(async () => { await result.current.stop() })
  })

  it('does not include a preparation observation returned after gameplay starts', async () => {
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    const addFrame = vi.spyOn(CaptureUploader.prototype, 'addFrame').mockImplementation(() => {})
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    vi.mocked(captureRequest).mockResolvedValue({ id: 'auto', trial_id: 8, status: 'recording' })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    act(() => {
      result.current.gameStarted(1200)
      result.current.addFrame({ ...frame, timestamp: 1100 }, 'auto')
      result.current.addFrame({ ...frame, timestamp: 1300 }, 'auto')
    })
    expect(addFrame).toHaveBeenCalledTimes(1)
    expect(addFrame).toHaveBeenCalledWith(expect.objectContaining({ timestamp_ms: 300 }))
    await act(async () => { await result.current.stop() })
  })

  it('keeps automatic capture isolated from gameplay when local storage fails', async () => {
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.stubGlobal('indexedDB', undefined)
    vi.mocked(captureRequest).mockResolvedValue({ id: 'auto-storage', trial_id: 8, status: 'recording' })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    act(() => {
      result.current.gameStarted()
      for (let index = 0; index < 15; index++) result.current.addFrame({ ...frame, timestamp: performance.now() }, 'auto-storage')
    })
    await waitFor(() => expect(result.current.state).toContain('không hoàn chỉnh'))
    expect(result.current.getScope()).toBe('auto-storage')
    expect(result.current.isActive()).toBe(true)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/abort'))).toBe(false)
    await act(async () => { await result.current.stop() })
  })

  it('drains late source results into their original trial only until its bounded settle ends', async () => {
    vi.spyOn(CaptureUploader.prototype, 'prepare').mockResolvedValue()
    vi.spyOn(CaptureUploader.prototype, 'finish').mockResolvedValue({ status: 'complete' })
    const addFrame = vi.spyOn(CaptureUploader.prototype, 'addFrame').mockImplementation(() => {})
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    vi.mocked(captureRequest).mockImplementation(async (path, body) => path === '/api/captures' ? { id: `trial-${(body as { trial_id: number }).trial_id}`, trial_id: (body as { trial_id: number }).trial_id, status: 'recording' } : {})
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 8 }) })
    act(() => result.current.gameStarted(1200))
    let settle!: () => void
    let stopping!: Promise<void> | undefined
    await act(async () => { stopping = result.current.stop('completed', 1400, () => new Promise<void>(resolve => { settle = resolve })) })
    expect(result.current.getScope()).toBe(null)
    await act(async () => { await result.current.start({ ...options, autoCapture: true, trialId: 9 }) })
    act(() => {
      result.current.gameStarted(1200)
      result.current.addFrame({ ...frame, source_frame_id: 81, timestamp: 1300 }, 'trial-8')
      result.current.addFrame({ ...frame, source_frame_id: 82, timestamp: 1500 }, 'trial-8')
      result.current.addFrame({ ...frame, source_frame_id: 91, timestamp: 1300 }, 'trial-9')
    })
    expect(addFrame.mock.calls.map(([value]) => value.source_frame_id)).toEqual([81, 91])
    await act(async () => { settle(); await stopping })
    act(() => result.current.addFrame({ ...frame, source_frame_id: 83, timestamp: 1300 }, 'trial-8'))
    expect(addFrame).toHaveBeenCalledTimes(2)
    await act(async () => { await result.current.stop() })
  })

  it('records the original stream and waits for the final chunk before finalizing', async () => {
    class FakeRecorder extends EventTarget {
      static isTypeSupported = vi.fn(() => true)
      static instance: FakeRecorder
      state = 'inactive'
      mimeType: string
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onerror: (() => void) | null = null
      constructor(public stream: MediaStream, options: { mimeType: string }) { super(); this.mimeType = options.mimeType; FakeRecorder.instance = this }
      start(timeslice: number) { expect(timeslice).toBe(1000); this.state = 'recording'; this.dispatchEvent(new Event('start')) }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['last'], { type: this.mimeType }) }); this.dispatchEvent(new Event('stop')) }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.mocked(captureRequest).mockImplementation(async path => path === '/api/captures' ? { id: 'test', trial_id: 3, status: 'recording' } : { status: 'complete' })
    const { result } = renderHook(() => useResearchCapture())
    const stream = {} as MediaStream
    await act(async () => { await result.current.start({ ...options, stream, recordLandmarks: false, recordVideo: true, consentVideo: true }) })
    expect(FakeRecorder.instance.stream).toBe(stream)
    await act(async () => { await result.current.stop() })
    const paths = vi.mocked(captureRequest).mock.calls.map(call => call[0])
    expect(paths).toEqual(['/api/captures', '/api/captures/test/heartbeat', '/api/captures/test/recorder-start', '/api/captures/test/video-chunks/0', '/api/captures/test/finalize'])
    expect(vi.mocked(captureRequest).mock.calls[2][1]).toMatchObject({ start_performance_ms: expect.any(Number), started_at_utc: expect.any(String), mime_type: FakeRecorder.instance.mimeType })
    expect(result.current.state).toContain('Đã hoàn tất')
  })

  it('stops and marks an upload failure without finalizing', async () => {
    vi.mocked(captureRequest).mockImplementation(async path => {
      if (path === '/api/captures') return { id: 'test', trial_id: 3, status: 'recording' }
      if (path.includes('landmark-batches')) throw new Error('offline')
      return {}
    })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start(options) })
    act(() => { for (let i = 0; i < 15; i++) result.current.addFrame({ ...frame, timestamp: performance.now() }) })
    await waitFor(() => expect(result.current.state).toContain('không hoàn chỉnh'), { timeout: 3000 })
    expect(result.current.isActive()).toBe(false)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].includes('finalize'))).toBe(false)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/abort'))).toBe(true)
  })

  it('reports an unknown finalize outcome without aborting the capture', async () => {
    vi.mocked(captureRequest).mockImplementation(async path => {
      if (path === '/api/captures') return { id: 'test', trial_id: 3, status: 'recording' }
      if (path.endsWith('/finalize')) throw new FinalizeOutcomeUnknown()
      return {}
    })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start(options) })
    act(() => result.current.addFrame({ ...frame, timestamp: performance.now() }))
    await act(async () => { await result.current.stop() })
    expect(result.current.state).toContain('Kết quả finalize chưa xác định')
    expect(result.current.captureId).toBe('test')
    expect(result.current.isActive()).toBe(false)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/abort'))).toBe(false)
  })

  it('stops the recorder and aborts if recorder start metadata cannot be stored', async () => {
    class Recorder extends EventTarget {
      static isTypeSupported = () => true
      static instance: Recorder
      state = 'inactive'; mimeType = 'video/webm;codecs=vp9'
      ondataavailable = null; onerror = null
      constructor() { super(); Recorder.instance = this }
      start() { this.state = 'recording'; this.dispatchEvent(new Event('start')) }
      stop() { this.state = 'inactive'; this.dispatchEvent(new Event('stop')) }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    vi.mocked(captureRequest).mockImplementation(async path => {
      if (path === '/api/captures') return { id: 'test', trial_id: 3, status: 'recording' }
      if (path.endsWith('/recorder-start')) throw new Error('metadata unavailable')
      return {}
    })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => {
      await expect(result.current.start({ ...options, recordLandmarks: false, recordVideo: true, consentVideo: true })).rejects.toThrow('metadata unavailable')
    })
    expect(Recorder.instance.state).toBe('inactive')
    expect(result.current.isActive()).toBe(false)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/abort'))).toBe(true)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/finalize'))).toBe(false)
  })

  it('retries a failed heartbeat, aborts the capture and never finalizes', async () => {
    vi.useFakeTimers()
    let heartbeats = 0
    vi.mocked(captureRequest).mockImplementation(async path => {
      if (path === '/api/captures') return { id: 'test', trial_id: 3, status: 'recording' }
      if (path.endsWith('/heartbeat') && ++heartbeats > 1) throw new Error('lease expired')
      return {}
    })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start(options) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(heartbeats).toBe(4)
    expect(result.current.isActive()).toBe(false)
    expect(result.current.state).toContain('không hoàn chỉnh')
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/abort'))).toBe(true)
    expect(vi.mocked(captureRequest).mock.calls.some(call => call[0].endsWith('/finalize'))).toBe(false)
  })

  it('keeps the lease alive while the last batch is still uploading', async () => {
    vi.useFakeTimers()
    let release!: () => void
    vi.mocked(captureRequest).mockImplementation(async path => {
      if (path === '/api/captures') return { id: 'test', trial_id: 3, status: 'recording' }
      if (path.includes('landmark-batches')) await new Promise<void>(resolve => { release = resolve })
      return { status: 'complete' }
    })
    const { result } = renderHook(() => useResearchCapture())
    await act(async () => { await result.current.start(options) })
    act(() => result.current.addFrame({ ...frame, timestamp: performance.now() }))
    let stop!: Promise<void> | undefined
    act(() => { stop = result.current.stop() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(vi.mocked(captureRequest).mock.calls.filter(call => call[0].endsWith('/heartbeat'))).toHaveLength(2)
    await act(async () => { release(); await stop })
    expect(result.current.state).toContain('Đã hoàn tất')
  })
})

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResearchCapture } from './useResearchCapture'
import { captureRequest, FinalizeOutcomeUnknown } from './captureUploader'

vi.mock('./captureUploader', async importOriginal => {
  const actual = await importOriginal<typeof import('./captureUploader')>()
  return { ...actual, captureRequest: vi.fn() }
})

const options = { patientId: 1, sessionId: 2, stream: {} as MediaStream, recordLandmarks: true, recordVideo: false, consentLandmarks: true, consentVideo: false, modelConfig: {} }
const frame = { timestamp: 10, video_media_time_ms: 1, inference_performed: true, pose_detected: false, hand_detected: null, inference_ms: 1, skipped_frames: 0, landmarks: [] }

beforeEach(() => { vi.mocked(captureRequest).mockReset().mockResolvedValue({}) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('research capture lifecycle', () => {
  it('rejects missing consent without making an API request', async () => {
    const { result } = renderHook(() => useResearchCapture())
    await expect(result.current.start({ ...options, consentLandmarks: false })).rejects.toThrow('quyền thu thập')
    expect(captureRequest).not.toHaveBeenCalled()
  })

  it('aborts a capture created after tracking was stopped during the request', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(captureRequest).mockImplementation(path => path === '/api/captures' ? new Promise(r => { resolve = r }) : Promise.resolve({}))
    const { result } = renderHook(() => useResearchCapture())
    let start!: Promise<void>
    act(() => { start = result.current.start(options) })
    act(() => result.current.abort())
    await act(async () => { resolve({ id: 'late', trial_id: 3, status: 'recording' }); await start })
    expect(result.current.isActive()).toBe(false)
    expect(captureRequest).toHaveBeenCalledWith('/api/captures/late/abort', expect.anything())
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
    await waitFor(() => expect(result.current.state).toContain('không hoàn chỉnh'))
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

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReplayCapture } from './useReplayCapture'
import { FinalizeOutcomeUnknown } from './captureUploader'

const mock = vi.hoisted(() => ({
  request: vi.fn(), addFrame: vi.fn(), addVideoChunk: vi.fn(), drain: vi.fn(), finish: vi.fn(),
}))
vi.mock('./captureUploader', () => ({
  captureRequest: mock.request,
  FinalizeOutcomeUnknown: class extends Error {},
  CaptureUploader: class {
    addFrame = mock.addFrame
    addVideoChunk = mock.addVideoChunk
    drain = mock.drain
    finish = mock.finish
  },
}))

const options = () => ({ file: new File(['video bytes'], 'test.mp4', { type: 'video/mp4' }), patientId: 1, sessionId: 2, width: 640, height: 480, modelConfig: { hand: true } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('replay capture lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.request.mockImplementation(async (path: string) => path === '/api/captures' ? { id: 'test-capture' } : {})
    mock.drain.mockResolvedValue(undefined)
    mock.finish.mockResolvedValue({ status: 'complete' })
  })
  afterEach(() => { vi.useRealTimers() })

  it('aborts a capture created after the source is interrupted', async () => {
    const create = deferred<{ id: string }>()
    mock.request.mockImplementation((path: string) => path === '/api/captures' ? create.promise : Promise.resolve({}))
    const { result } = renderHook(() => useReplayCapture())
    let start!: Promise<void>
    act(() => { start = result.current.start(options()) })
    act(() => result.current.abort())
    await act(async () => { create.resolve({ id: 'test-capture' }); await expect(start).rejects.toThrow('gián đoạn') })
    expect(mock.request).toHaveBeenCalledWith('/api/captures/test-capture/abort', expect.anything())
    expect(mock.addVideoChunk).not.toHaveBeenCalled()
    expect(result.current.isActive()).toBe(false)
  })

  it('uses the input callback monotonic time relative to capture start, retaining media time', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useReplayCapture())
    await act(async () => { await result.current.start(options()) })
    expect(mock.request).toHaveBeenCalledWith('/api/captures', expect.objectContaining({ start_performance_ms: 1000 }))
    act(() => result.current.addFrame({ frame_id: 1, source_frame_id: 2, frame_performance_ms: 1450, video_media_time_ms: 32, utc_time: '2026-01-01T00:00:00Z', inference_performed: false, pose_detected: null, hand_detected: null, inference_ms: null, skipped_frames: 0, landmarks: [] }))
    expect(mock.addFrame).toHaveBeenCalledWith(expect.objectContaining({ timestamp_ms: 450, video_media_time_ms: 32 }))
    expect(mock.addFrame.mock.calls[0][0]).not.toHaveProperty('frame_performance_ms')
    clock.mockRestore()
  })

  it('does not let a late chunk upload resume replay after abort', async () => {
    const pending = deferred<void>()
    mock.drain.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useReplayCapture())
    let start!: Promise<void>
    await act(async () => { start = result.current.start(options()); await Promise.resolve(); await Promise.resolve() })
    expect(mock.addVideoChunk).toHaveBeenCalledTimes(1)
    act(() => result.current.abort())
    await act(async () => { pending.resolve(); await expect(start).rejects.toThrow('gián đoạn') })
    expect(result.current.isActive()).toBe(false)
  })

  it('waits for finalize and reports partial backend results as incomplete', async () => {
    const pending = deferred<{ status: string }>()
    mock.finish.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useReplayCapture())
    await act(async () => { await result.current.start(options()) })
    let stopping!: Promise<void>
    act(() => { stopping = result.current.stop(1250) })
    expect(result.current.state).toContain('Đang hoàn tất')
    await act(async () => { pending.resolve({ status: 'incomplete' }); await stopping })
    expect(mock.finish).toHaveBeenCalledWith(1250, expect.any(Function))
    expect(result.current.state).toContain('không hoàn chỉnh')
    expect(result.current.isActive()).toBe(false)
  })

  it('reports an unknown finalize outcome without aborting the capture', async () => {
    mock.finish.mockRejectedValue(new FinalizeOutcomeUnknown())
    const { result } = renderHook(() => useReplayCapture())
    await act(async () => { await result.current.start(options()); await result.current.stop(1250) })
    expect(result.current.state).toContain('Kết quả finalize chưa xác định')
    expect(result.current.captureId).toBe('test-capture')
    expect(result.current.isActive()).toBe(false)
    expect(mock.request.mock.calls.some(([path]) => path.endsWith('/abort'))).toBe(false)
  })

  it('aborts an active capture on unmount', async () => {
    const { result, unmount } = renderHook(() => useReplayCapture())
    await act(async () => { await result.current.start(options()) })
    unmount()
    expect(mock.request).toHaveBeenCalledWith('/api/captures/test-capture/abort', expect.anything())
    expect(mock.finish).not.toHaveBeenCalled()
  })

  it.each(['stop', 'abort'] as const)('sends heartbeat every 30 seconds and clears it after %s', async end => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useReplayCapture())
    await act(async () => { await result.current.start(options()) })
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999) })
    expect(mock.request).not.toHaveBeenCalledWith('/api/captures/test-capture/heartbeat', {})
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mock.request).toHaveBeenCalledWith('/api/captures/test-capture/heartbeat', {})
    await act(async () => { if (end === 'stop') await result.current.stop(1000); else result.current.abort() })
    const heartbeats = mock.request.mock.calls.filter(([path]) => path.endsWith('/heartbeat')).length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(mock.request.mock.calls.filter(([path]) => path.endsWith('/heartbeat'))).toHaveLength(heartbeats)
  })

  it('stops capture after three failed heartbeat attempts and refuses to finalize', async () => {
    vi.useFakeTimers()
    mock.request.mockImplementation(async (path: string) => {
      if (path.endsWith('/heartbeat')) throw new Error('offline')
      return path === '/api/captures' ? { id: 'test-capture' } : {}
    })
    const { result } = renderHook(() => useReplayCapture())
    await act(async () => { await result.current.start(options()) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(mock.request.mock.calls.filter(([path]) => path.endsWith('/heartbeat'))).toHaveLength(3)
    expect(result.current.state).toContain('heartbeat thất bại')
    expect(result.current.isActive()).toBe(false)
    act(() => result.current.addFrame({ frame_id: 1, source_frame_id: null, frame_performance_ms: performance.now(), video_media_time_ms: 10, utc_time: new Date().toISOString(), inference_performed: false, pose_detected: null, hand_detected: null, inference_ms: null, skipped_frames: 0, landmarks: [] }))
    await act(async () => { await result.current.stop(10); await vi.advanceTimersByTimeAsync(60_000) })
    expect(mock.addFrame).not.toHaveBeenCalled()
    expect(mock.finish).not.toHaveBeenCalled()
    expect(mock.request.mock.calls.filter(([path]) => path.endsWith('/heartbeat'))).toHaveLength(3)
  })

  it('keeps staged data recoverable if the lease fails during video upload', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    mock.drain.mockReturnValue(pending.promise)
    mock.request.mockImplementation(async (path: string) => {
      if (path.endsWith('/heartbeat')) throw new Error('offline')
      return path === '/api/captures' ? { id: 'test-capture' } : {}
    })
    const { result } = renderHook(() => useReplayCapture())
    let start!: Promise<void>
    await act(async () => { start = result.current.start(options()); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await act(async () => { pending.resolve(); await expect(start).rejects.toThrow('gián đoạn') })
    expect(mock.request.mock.calls.some(([path]) => path.endsWith('/abort'))).toBe(false)
  })
})

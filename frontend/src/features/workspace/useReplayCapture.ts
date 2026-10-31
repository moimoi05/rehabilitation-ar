import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUploader, captureRequest, FinalizeOutcomeUnknown } from './captureUploader'
import type { CaptureFrame, CaptureStats } from './captureUploader'
import type { ReplayFrame } from './replayFrame'

type Options = { file: File; patientId: number; sessionId: number; trialId?: number; width: number; height: number; modelConfig: object }
type Active = { id: string; start: number; uploader: CaptureUploader; stopping: boolean; leaseLost?: boolean; heartbeat?: ReturnType<typeof setInterval>; heartbeatPromise?: Promise<void> }

/** Stores the original selected file as ordered chunks, without recording the video element. */
export function useReplayCapture() {
  const active = useRef<Active | null>(null)
  const generation = useRef(0)
  const creating = useRef(false)
  const latestStats = useRef<CaptureStats | null>(null)
  const lastStatsUpdate = useRef(0)
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState('Chưa thu dữ liệu replay')
  const [captureId, setCaptureId] = useState('')
  const [stats, setStats] = useState<CaptureStats | null>(null)

  const start = useCallback(async (options: Options) => {
    if (active.current || creating.current) throw new Error('Đã có capture đang chạy.')
    const requestGeneration = ++generation.current
    creating.current = true
    latestStats.current = null; lastStatsUpdate.current = 0
    setBusy(true); setStats(null); setState('Đang tạo capture và gửi video gốc…')
    let capture: Active | null = null
    try {
      const start = performance.now()
      const result = await captureRequest('/api/captures', {
        patient_id: options.patientId, session_id: options.sessionId,
        ...(options.trialId ? { trial_id: options.trialId } : { exercise_code: 'video_replay_test' }),
        source_type: 'pre_recorded_video', record_landmarks: true, record_video: true,
        consent_landmarks: true, consent_video: true, started_at_utc: new Date(performance.timeOrigin + start).toISOString(),
        start_performance_ms: start, video_mime_type: options.file.type || 'video/mp4',
        width: options.width, height: options.height, model_config: options.modelConfig,
      }) as { id: string }
      const uploader = new CaptureUploader(result.id, captureRequest, next => {
        latestStats.current = next
        const now = performance.now()
        if (next.error || now - lastStatsUpdate.current >= 500) { lastStatsUpdate.current = now; setStats(next) }
        if (next.error) setState(`Lỗi upload: ${next.error}`)
      })
      capture = { id: result.id, start, uploader, stopping: false }
      if (generation.current !== requestGeneration) throw new Error('Replay đã bị gián đoạn.')
      active.current = capture; setCaptureId(result.id)
      let heartbeatPending = false
      capture.heartbeat = setInterval(() => {
        if (heartbeatPending || !capture || active.current !== capture) return
        heartbeatPending = true
        const currentCapture = capture
        currentCapture.heartbeatPromise = (async () => {
          let lastError: unknown
          for (let attempt = 0; attempt < 3; attempt++) {
            try { await captureRequest(`/api/captures/${result.id}/heartbeat`, {}); return }
            catch (error) { lastError = error }
          }
          if (capture && active.current === capture) {
            capture.leaseLost = true; capture.stopping = true; clearInterval(capture.heartbeat); active.current = null; generation.current++
            setState(`Capture không hoàn chỉnh: heartbeat thất bại (${lastError instanceof Error ? lastError.message : 'không xác định'}).`)
          }
        })().finally(() => { heartbeatPending = false; currentCapture.heartbeatPromise = undefined })
      }, 30000)
      const chunkSize = 2 * 1024 * 1024
      for (let offset = 0; offset < options.file.size; offset += chunkSize) {
        if (active.current !== capture || capture.stopping) throw new Error('Replay đã bị gián đoạn.')
        uploader.addVideoChunk(options.file.slice(offset, offset + chunkSize, options.file.type || 'video/mp4'))
        await uploader.drain()
        if (generation.current !== requestGeneration || active.current !== capture || capture.stopping) throw new Error('Replay đã bị gián đoạn.')
      }
      setState('Đang xử lý video bằng MediaPipe')
    } catch (error) {
      if (capture) { clearInterval(capture.heartbeat); active.current = null; if (!capture.leaseLost) void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Replay could not start' }).catch(() => {}) }
      setState(`Capture không hoàn chỉnh: ${error instanceof Error ? error.message : 'lỗi không xác định'}`)
      throw error
    } finally { creating.current = false; setBusy(false) }
  }, [])
  const addFrame = useCallback((frame: ReplayFrame) => {
    const capture = active.current
    if (!capture || capture.stopping) return
    const { frame_performance_ms, ...data } = frame
    const timestamp_ms = frame_performance_ms - capture.start
    if (!Number.isFinite(timestamp_ms) || timestamp_ms < 0) {
      capture.stopping = true; clearInterval(capture.heartbeat); active.current = null
      setState('Capture không hoàn chỉnh: timestamp frame không hợp lệ.')
      void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Invalid frame timestamp' }).catch(() => {})
      return
    }
    capture.uploader.addFrame({ ...data, timestamp_ms } satisfies CaptureFrame)
  }, [])
  const stop = useCallback(async (durationMs: number) => {
    const capture = active.current
    if (!capture || capture.stopping) return
    capture.stopping = true; setBusy(true); setState('Đang hoàn tất artifact…')
    try {
      const result = await capture.uploader.finish(durationMs, async () => {
        clearInterval(capture.heartbeat)
        await capture.heartbeatPromise
        if (capture.leaseLost) throw new Error('Không gia hạn được lease của capture.')
      }) as { status?: string }
      if (capture.leaseLost || result.status !== 'complete') throw new Error(`Backend báo trạng thái ${result.status || 'không xác định'} hoặc heartbeat đã thất bại`)
      setState('Đã hoàn tất và xác minh capture replay')
    } catch (error) {
      if (error instanceof FinalizeOutcomeUnknown) {
        setState('Kết quả finalize chưa xác định; kiểm tra trạng thái capture trước khi thử lại.')
      } else {
        setState(`Capture không hoàn chỉnh: ${error instanceof Error ? error.message : 'lỗi không xác định'}`)
        if (!capture.leaseLost) void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Replay upload or finalization failed' }).catch(() => {})
      }
    } finally { clearInterval(capture.heartbeat); if (latestStats.current) setStats(latestStats.current); if (active.current === capture) active.current = null; setBusy(false) }
  }, [])
  const abort = useCallback(() => {
    generation.current++
    const capture = active.current
    if (!capture || capture.stopping) return
    capture.stopping = true; clearInterval(capture.heartbeat); active.current = null; setState('Replay bị gián đoạn; dữ liệu staging được giữ lại.')
    void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Replay interrupted' }).catch(() => {})
  }, [])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (active.current || creating.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn); abort() }
  }, [abort])
  return { start, addFrame, stop, abort, busy, state, captureId, stats, isActive: () => !!active.current || creating.current }
}

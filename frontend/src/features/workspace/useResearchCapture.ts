import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUploader, captureRequest, FinalizeOutcomeUnknown } from './captureUploader'
import type { CaptureFrame, CaptureStats } from './captureUploader'

type CaptureResponse = { id: string; trial_id: number; status: string }
type Options = { patientId: number; sessionId: number; trialId?: number; stream: MediaStream; width?: number; height?: number; recordLandmarks: boolean; recordVideo: boolean; consentLandmarks: boolean; consentVideo: boolean; modelConfig: object }
type Active = { id: string; start: number; uploader: CaptureUploader; recorder: MediaRecorder | null; recordLandmarks: boolean; timer: ReturnType<typeof setInterval>; heartbeatTimer: ReturnType<typeof setInterval> | null; heartbeatPromise: Promise<void> | null; heartbeatError: Error | null; stopPromise?: Promise<void>; stopped: boolean; finalizing: boolean }

function clearTimers(capture: Active) { clearInterval(capture.timer); if (capture.heartbeatTimer !== null) clearInterval(capture.heartbeatTimer) }
async function renewLease(id: string) {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await captureRequest(`/api/captures/${id}/heartbeat`, {}); return }
    catch (error) { last = error }
  }
  throw last instanceof Error ? last : new Error('Không thể gia hạn capture')
}

function startRecorder(recorder: MediaRecorder): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); recorder.removeEventListener('start', started); recorder.removeEventListener('error', failed); recorder.removeEventListener('stop', failed) }
    const started = () => { const timestamp = performance.now(); cleanup(); resolve(timestamp) }
    const failed = () => { cleanup(); reject(new Error('MediaRecorder không bắt đầu được.')) }
    const timeout = setTimeout(failed, 15000)
    recorder.addEventListener('start', started, { once: true })
    recorder.addEventListener('error', failed, { once: true })
    recorder.addEventListener('stop', failed, { once: true })
    try { recorder.start(1000) } catch { failed() }
  })
}

export function useResearchCapture() {
  const active = useRef<Active | null>(null)
  const [state, setState] = useState('Chưa thu dữ liệu')
  const [stats, setStats] = useState<CaptureStats | null>(null)
  const [captureId, setCaptureId] = useState('')
  const [busy, setBusy] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const generation = useRef(0)
  const pendingStart = useRef(false)
  const latestStats = useRef<CaptureStats | null>(null)
  const start = useCallback(async (options: Options) => {
    if (active.current || pendingStart.current) return
    if ((!options.recordLandmarks && !options.recordVideo) || (options.recordLandmarks && !options.consentLandmarks) || (options.recordVideo && !options.consentVideo)) throw new Error('Chọn dữ liệu và xác nhận quyền thu thập tương ứng.')
    const mime = options.recordVideo ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) : undefined
    if (options.recordVideo && !mime) throw new Error('Trình duyệt không hỗ trợ định dạng MediaRecorder phù hợp.')
    const recorder = mime ? new MediaRecorder(options.stream, { mimeType: mime }) : null
    pendingStart.current = true
    const requestGeneration = ++generation.current
    latestStats.current = null
    setBusy(true); setState('Đang tạo capture…'); setStats(null); setElapsedMs(0)
    const start = performance.now(), startedAt = new Date(performance.timeOrigin + start).toISOString()
    let created: CaptureResponse | null = null
    try {
      created = await captureRequest('/api/captures', { patient_id: options.patientId, session_id: options.sessionId, ...(options.trialId ? { trial_id: options.trialId } : { exercise_code: 'camera_capture' }), source_type: 'webcam', record_landmarks: options.recordLandmarks, record_video: options.recordVideo, consent_landmarks: options.consentLandmarks, consent_video: options.consentVideo, started_at_utc: startedAt, start_performance_ms: start, video_mime_type: recorder?.mimeType || mime, width: options.width, height: options.height, model_config: options.modelConfig }) as CaptureResponse
      if (requestGeneration !== generation.current) {
        void captureRequest(`/api/captures/${created.id}/abort`, { reason: 'Tracking stopped before capture creation completed' }).catch(() => {})
        return
      }
      const uploader = new CaptureUploader(created.id, captureRequest, next => {
        latestStats.current = next
        if (next.error) {
          const current = active.current
          if (current && !current.stopped) {
            current.stopped = true; clearTimers(current)
            if (current.recorder && current.recorder.state !== 'inactive') current.recorder.stop()
            active.current = null
            void captureRequest(`/api/captures/${current.id}/abort`, { reason: 'Upload failed' }).catch(() => {})
          }
          setStats(next); setState(`Lỗi upload: ${next.error}. Capture không hoàn chỉnh.`)
        }
      })
      const capture: Active = { id: created.id, start, uploader, recorder, recordLandmarks: options.recordLandmarks, timer: setInterval(() => { uploader.flush(); if (latestStats.current) setStats(latestStats.current); setElapsedMs(performance.now() - start) }, 1000), heartbeatTimer: null, heartbeatPromise: null, heartbeatError: null, stopped: false, finalizing: false }
      active.current = capture
      await renewLease(capture.id)
      if (active.current !== capture || capture.stopped) return
      capture.heartbeatTimer = setInterval(() => {
        if ((capture.stopped && !capture.finalizing) || capture.heartbeatPromise || capture.heartbeatError) return
        const pending = renewLease(capture.id).catch(error => {
          capture.heartbeatError = error instanceof Error ? error : new Error('Không thể gia hạn capture')
          if (active.current === capture && !capture.stopped) {
            capture.stopped = true; clearTimers(capture)
            if (capture.recorder && capture.recorder.state !== 'inactive') capture.recorder.stop()
            active.current = null
            setState(`Không thể gia hạn capture: ${capture.heartbeatError.message}. Capture không hoàn chỉnh.`)
            void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Capture heartbeat failed' }).catch(() => {})
          }
        }).finally(() => { if (capture.heartbeatPromise === pending) capture.heartbeatPromise = null })
        capture.heartbeatPromise = pending
      }, 30000)
      if (recorder) {
        recorder.ondataavailable = event => { if (event.data.size) uploader.addVideoChunk(event.data) }
        recorder.onerror = () => { capture.stopped = true; clearTimers(capture); if (recorder.state !== 'inactive') recorder.stop(); if (active.current === capture) active.current = null; setState('MediaRecorder lỗi; capture không hoàn chỉnh.'); void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'MediaRecorder error' }).catch(() => {}) }
        // The start event is observed on the monotonic clock; encoder buffering
        // can still cause a nonzero video/landmark offset.
        const recorderStart = await startRecorder(recorder)
        if (active.current !== capture || capture.stopped) return
        await captureRequest(`/api/captures/${capture.id}/recorder-start`, { start_performance_ms: recorderStart, started_at_utc: new Date(performance.timeOrigin + recorderStart).toISOString(), mime_type: recorder.mimeType || mime })
        if (active.current !== capture || capture.stopped) return
      }
      setCaptureId(created.id); setState(`Đang thu · lượt #${created.trial_id}${recorder ? ' · ● video nguồn' : ''}`)
    } catch (error) {
      if (active.current) { clearTimers(active.current); if (active.current.recorder?.state === 'recording') active.current.recorder.stop() }
      if (created) void captureRequest(`/api/captures/${created.id}/abort`, { reason: 'Cannot start recorder' }).catch(() => {})
      active.current = null; throw error
    } finally { pendingStart.current = false; setBusy(false) }
  }, [])
  const addFrame = useCallback((frame: Omit<CaptureFrame, 'frame_id' | 'timestamp_ms' | 'utc_time'> & { timestamp: number }) => {
    const capture = active.current
    if (!capture || capture.stopped || !capture.recordLandmarks) return
    const { timestamp, ...data } = frame
    capture.uploader.addFrame({ ...data, frame_id: frameIds.current++, timestamp_ms: Math.max(0, timestamp - capture.start), utc_time: new Date(performance.timeOrigin + timestamp).toISOString() })
  }, [])
  const frameIds = useRef(0)
  const stop = useCallback(async () => {
    const capture = active.current
    if (!capture || capture.stopPromise) return capture?.stopPromise
    capture.stopped = true; capture.finalizing = true; clearInterval(capture.timer); setElapsedMs(performance.now() - capture.start); setBusy(true); setState('Đang gửi dữ liệu và hoàn tất…')
    capture.stopPromise = (async () => {
      try {
        if (capture.recorder && capture.recorder.state !== 'inactive') await new Promise<void>((resolve, reject) => {
          capture.recorder!.addEventListener('stop', () => resolve(), { once: true })
          capture.recorder!.addEventListener('error', () => reject(new Error('MediaRecorder lỗi khi dừng')), { once: true })
          capture.recorder!.stop()
        })
        const result = await capture.uploader.finish(performance.now() - capture.start, async () => {
          if (capture.heartbeatPromise) await capture.heartbeatPromise
          if (capture.heartbeatError) throw capture.heartbeatError
        }) as { status?: string }
        if (result.status !== 'complete') throw new Error(`Backend báo trạng thái ${result.status || 'không xác định'}`)
        setState('Đã hoàn tất và xác minh capture')
      } catch (error) {
        if (capture.recorder && capture.recorder.state !== 'inactive') capture.recorder.stop()
        if (error instanceof FinalizeOutcomeUnknown) {
          setState('Kết quả finalize chưa xác định; kiểm tra trạng thái capture trước khi thử lại.')
        } else {
          setState(`Capture không hoàn chỉnh: ${error instanceof Error ? error.message : 'lỗi không xác định'}`)
          void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Upload or finalization failed' }).catch(() => {})
        }
      } finally { capture.finalizing = false; clearTimers(capture); if (active.current === capture) active.current = null; frameIds.current = 0; setBusy(false) }
    })()
    return capture.stopPromise
  }, [])
  const abort = useCallback(() => {
    generation.current++
    const capture = active.current
    if (!capture || capture.stopped) { if (pendingStart.current) setState('Capture bị gián đoạn trong khi tạo.'); return }
    capture.stopped = true; clearTimers(capture)
    if (capture.recorder?.state !== 'inactive') capture.recorder?.stop()
    active.current = null; frameIds.current = 0; setState('Capture bị gián đoạn; dữ liệu staging được giữ lại.')
    void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Tracking or camera stopped' }).catch(() => {})
  }, [])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (active.current || pendingStart.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn); abort() }
  }, [abort])
  return { start, addFrame, stop, abort, state, stats, captureId, busy, elapsedMs, isActive: () => !!active.current || pendingStart.current }
}

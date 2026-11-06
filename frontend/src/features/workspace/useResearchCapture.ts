import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUploader, captureRequest, FinalizeOutcomeUnknown } from './captureUploader'
import type { CaptureFrame, CaptureStats } from './captureUploader'
import { acquireCaptureOwnership } from './captureOwnership'
import type { TrackingVideo } from './trackingVideo'
import { createGameResearchSink } from './gameResearch'
import type { GameResearchSink, ResearchContext } from './gameResearch'

type CaptureResponse = { id: string; trial_id: number; status: string; reused?: boolean }
export type ResearchCaptureOptions = { patientId: number; sessionId: number; trialId?: number; gameKey?: 'glowing_flower' | 'free_drawing'; beforeAbort?: (reason: string, timestamp: number) => void; stream: MediaStream; width?: number; height?: number; recordLandmarks: boolean; recordVideo: boolean; consentLandmarks: boolean; consentVideo: boolean; modelConfig: object; autoCapture?: boolean; sourceType?: 'webcam' | 'replay'; createTrackingVideo?: (onError: () => void) => TrackingVideo }
type InputFrame = Omit<CaptureFrame, 'frame_id' | 'timestamp_ms' | 'utc_time'> & { timestamp: number }
type Active = {
  id: string; trialId: number; start: number; uploader: CaptureUploader; recorder: MediaRecorder | null; trackingRecorder?: MediaRecorder; trackingVideo?: TrackingVideo
  autoCapture: boolean; accepting: boolean; acceptingLate: boolean; recordLandmarks: boolean; frames: number; latestStats: CaptureStats | null
  timer: ReturnType<typeof setInterval> | null; heartbeatTimer: ReturnType<typeof setInterval> | null
  heartbeatPromise: Promise<void> | null; heartbeatError: Error | null; stopped: boolean; finalizing: boolean
  gameStarted?: number; gameEnded?: number; stopPromise?: Promise<void>; knownGaps: string[]
  reportedError?: string; releaseOwnership?: () => void; trackingVideoFailed?: boolean
  gameResearch?: GameResearchSink
  gameTerminal?: boolean; beforeAbort?: ResearchCaptureOptions['beforeAbort']
}

function clearTimers(capture: Active) { if (capture.timer !== null) clearInterval(capture.timer); if (capture.heartbeatTimer !== null) clearInterval(capture.heartbeatTimer) }
function utc(timestamp: number) { return new Date(performance.timeOrigin + timestamp).toISOString() }
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

function stopRecorder(recorder: MediaRecorder | null): Promise<void> {
  if (!recorder || recorder.state === 'inactive') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); recorder.removeEventListener('stop', stopped); recorder.removeEventListener('error', failed) }
    const stopped = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('MediaRecorder lỗi khi dừng; chunk cuối có thể bị thiếu.')) }
    const timeout = setTimeout(failed, 15000)
    recorder.addEventListener('stop', stopped, { once: true })
    recorder.addEventListener('error', failed, { once: true })
    try { recorder.stop() } catch { failed() }
  })
}

export function useResearchCapture() {
  const active = useRef<Active | null>(null)
  const finishing = useRef(new Set<Active>())
  const [state, setState] = useState('Chưa thu dữ liệu')
  const [stats, setStats] = useState<CaptureStats | null>(null)
  const [captureId, setCaptureId] = useState('')
  const [trialId, setTrialId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const generation = useRef(0)
  const pendingStart = useRef<Promise<CaptureResponse | null> | null>(null)
  const pendingTrial = useRef<number | undefined>(undefined)
  const pendingCancellation = useRef<{ reason?: string } | null>(null)
  const displayed = useRef('')

  const start = useCallback((options: ResearchCaptureOptions): Promise<CaptureResponse | null> => {
    if (pendingStart.current) return pendingTrial.current === options.trialId ? pendingStart.current : Promise.reject(new Error('Một capture khác đang được chuẩn bị.'))
    if (active.current) return Promise.resolve(active.current.trialId === options.trialId ? { id: active.current.id, trial_id: active.current.trialId, status: 'recording' } : null)
    const requestGeneration = ++generation.current
    const cancellation: { reason?: string } = {}
    pendingCancellation.current = cancellation
    const pending = (async () => {
      if ((!options.recordLandmarks && !options.recordVideo) || (options.recordLandmarks && !options.consentLandmarks) || (options.recordVideo && !options.consentVideo)) throw new Error('Chọn dữ liệu và xác nhận quyền thu thập tương ứng.')
      if (options.createTrackingVideo && (!options.recordLandmarks || !options.recordVideo || !options.consentLandmarks || !options.consentVideo)) throw new Error('Video tracking cần xác nhận thu video và landmark.')
      if (options.autoCapture && !options.trialId) throw new Error('Thu dữ liệu tự động cần lượt chơi đã được tạo.')
      const mime = options.recordVideo ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) : undefined
      if (options.recordVideo && !mime) throw new Error('Trình duyệt không hỗ trợ định dạng MediaRecorder phù hợp.')
      // getUserMedia is owned by Workspace; the recorder uses only the existing camera track.
      const videoTracks = options.stream.getVideoTracks?.()
      const source = videoTracks && typeof MediaStream !== 'undefined' ? new MediaStream(videoTracks) : options.stream
      const recorder = mime ? new MediaRecorder(source, { mimeType: mime }) : null
      displayed.current = ''; setCaptureId(''); setTrialId(options.trialId || null)
      setBusy(true); setState('Đang tạo capture…'); setStats(null); setElapsedMs(0)
      const start = performance.now()
      let created: CaptureResponse | null = null
      let capture: Active | null = null
      let releaseOwnership: (() => void) | undefined
      try {
        created = await captureRequest('/api/captures', { patient_id: options.patientId, session_id: options.sessionId, ...(options.trialId ? { trial_id: options.trialId } : { exercise_code: 'camera_capture' }), ...(options.autoCapture ? { capture_mode: 'per_trial', capture_schema_version: options.gameKey ? 3 : 2 } : {}), source_type: options.sourceType || 'webcam', record_landmarks: options.recordLandmarks, record_video: options.recordVideo, consent_landmarks: options.consentLandmarks, consent_video: options.consentVideo, started_at_utc: utc(start), start_performance_ms: start, video_mime_type: recorder?.mimeType || mime, width: options.width, height: options.height, model_config: { ...options.modelConfig, ...(options.gameKey ? { game_key: options.gameKey } : {}), ...(options.createTrackingVideo ? { record_tracking_video: true } : {}) } }) as CaptureResponse
        if (requestGeneration !== generation.current) {
          if (!options.autoCapture || (!created.reused && created.status === 'recording')) void captureRequest(`/api/captures/${created.id}/${options.autoCapture ? 'incomplete' : 'abort'}`, { reason: cancellation.reason || 'Tracking stopped before capture creation completed' }).catch(() => {})
          return null
        }
        displayed.current = created.id; setCaptureId(created.id); setTrialId(created.trial_id)
        if (options.autoCapture && created.reused) {
          setState('Capture đã tồn tại; cần kiểm tra và khôi phục phần đã lưu, không ghi lại video.')
          return null
        }
        if (options.autoCapture && created.status !== 'recording') {
          setState(`Capture ${created.status}; không mở lại lượt đã đóng.`)
          return null
        }
        if (options.autoCapture) {
          releaseOwnership = await acquireCaptureOwnership(created.id)
          if (requestGeneration !== generation.current) {
            releaseOwnership()
            void captureRequest(`/api/captures/${created.id}/incomplete`, { reason: cancellation.reason || 'Capture preparation cancelled' }).catch(() => {})
            return null
          }
        }
        const uploader = new CaptureUploader(created.id, captureRequest, next => {
          if (!capture) return
          capture.latestStats = next
          if (!next.error) { capture.reportedError = undefined; return }
          if (capture.reportedError === next.error) return
          capture.reportedError = next.error
          if (displayed.current !== capture.id) return
          if (!capture.autoCapture && !capture.stopped) {
            capture.stopped = true; clearTimers(capture)
            if (capture.recorder && capture.recorder.state !== 'inactive') capture.recorder.stop()
            if (active.current === capture) active.current = null
            void captureRequest(`/api/captures/${capture.id}/abort`, { reason: 'Upload failed' }).catch(() => {})
          }
          setStats(next); setState(`Capture không hoàn chỉnh: ${next.error}`)
        }, { durable: Boolean(options.autoCapture), gameData: Boolean(options.autoCapture && options.gameKey) })
        capture = { id: created.id, trialId: created.trial_id, start, uploader, recorder, autoCapture: Boolean(options.autoCapture), accepting: !options.autoCapture, acceptingLate: false, recordLandmarks: options.recordLandmarks, frames: 0, latestStats: null, timer: null, heartbeatTimer: null, heartbeatPromise: null, heartbeatError: null, stopped: false, finalizing: false, knownGaps: [], releaseOwnership }
        const current = capture
        current.beforeAbort = options.beforeAbort
        if (options.autoCapture && options.gameKey) current.gameResearch = createGameResearchSink({
          captureId: current.id, trialId: current.trialId, gameKey: options.gameKey, start,
          event: row => uploader.addGameEvent(row), sample: row => uploader.addInteractionSample(row), gap: reason => uploader.noteGap(reason),
        })
        active.current = current
        if (options.autoCapture) await uploader.prepare()
        await renewLease(current.id)
        if (active.current !== current || current.stopped) return null
        current.timer = setInterval(() => {
          uploader.flush()
          if (displayed.current === current.id) { if (current.latestStats) setStats(current.latestStats); setElapsedMs(performance.now() - start) }
        }, 1000)
        current.heartbeatTimer = setInterval(() => {
          if ((current.stopped && !current.finalizing) || current.heartbeatPromise) return
          const pending = renewLease(current.id).then(() => { current.heartbeatError = null }).catch(error => {
            current.heartbeatError = error instanceof Error ? error : new Error('Không thể gia hạn capture')
            if (displayed.current === current.id) setState(`Không thể gia hạn capture: ${current.heartbeatError.message}. Dữ liệu không hoàn chỉnh nếu lease hết hạn.`)
            if (!current.autoCapture && !current.stopped) {
              current.stopped = true; clearTimers(current)
              if (current.recorder && current.recorder.state !== 'inactive') current.recorder.stop()
              if (active.current === current) active.current = null
              void captureRequest(`/api/captures/${current.id}/abort`, { reason: 'Capture heartbeat failed' }).catch(() => {})
            }
          }).finally(() => { if (current.heartbeatPromise === pending) current.heartbeatPromise = null })
          current.heartbeatPromise = pending
        }, 30000)
        if (recorder) {
          recorder.ondataavailable = event => { if (event.data.size) uploader.addVideoChunk(event.data) }
          recorder.onerror = () => {
            const reason = 'MediaRecorder error; video data may be missing'
            current.accepting = false; current.knownGaps = [...current.knownGaps, reason]; uploader.markIncomplete(reason)
            if (recorder.state !== 'inactive') recorder.stop()
            if (displayed.current === current.id) setState('MediaRecorder lỗi; capture không hoàn chỉnh.')
          }
          const recorderStart = await startRecorder(recorder)
          if (active.current !== current || current.stopped) return null
          const metadata = { start_performance_ms: recorderStart, started_at_utc: utc(recorderStart), mime_type: recorder.mimeType || mime }
          if (options.autoCapture) uploader.addMetadata(`/api/captures/${current.id}/recorder-start`, metadata)
          else await captureRequest(`/api/captures/${current.id}/recorder-start`, metadata)
          if (active.current !== current || current.stopped) return null
        }
        if (options.createTrackingVideo && mime) {
          const trackingFailed = () => {
            const reason = 'Không ghi đầy đủ video tracking.'
            current.trackingVideoFailed = true
            if (!current.knownGaps.includes(reason)) current.knownGaps = [...current.knownGaps, reason]
            uploader.noteGap(reason)
            if (displayed.current === current.id) setState('Video tracking bị lỗi; vẫn tiếp tục lưu video nguồn và landmarks.')
          }
          try {
            current.trackingVideo = options.createTrackingVideo(trackingFailed)
            const trackingRecorder = new MediaRecorder(current.trackingVideo.stream, { mimeType: mime })
            current.trackingRecorder = trackingRecorder
            trackingRecorder.ondataavailable = event => { if (event.data.size) uploader.addTrackingVideoChunk(event.data) }
            trackingRecorder.onerror = () => { trackingFailed(); if (trackingRecorder.state !== 'inactive') trackingRecorder.stop() }
            const trackingStart = await startRecorder(trackingRecorder)
            if (active.current !== current || current.stopped) return null
            uploader.addMetadata(`/api/captures/${current.id}/tracking-recorder-start`, { start_performance_ms: trackingStart, started_at_utc: utc(trackingStart), mime_type: trackingRecorder.mimeType || mime })
          } catch { trackingFailed(); if (current.trackingRecorder?.state === 'recording') current.trackingRecorder.stop(); current.trackingVideo?.close() }
        }
        if (!current.latestStats?.error && !current.knownGaps.length) setState(`Đang thu · lượt #${created.trial_id}${recorder ? ' · ● video nguồn' : ''}${current.trackingRecorder ? ' · ● video tracking' : ''}`)
        return created
      } catch (error) {
        if (capture) { clearTimers(capture); if (capture.recorder?.state === 'recording') capture.recorder.stop(); if (capture.trackingRecorder?.state === 'recording') capture.trackingRecorder.stop(); capture.trackingVideo?.close() }
        if (!capture?.finalizing) releaseOwnership?.()
        // A failed lock acquisition does not authorize changing another tab's capture.
        if (created && (!options.autoCapture || releaseOwnership)) void captureRequest(`/api/captures/${created.id}/${options.autoCapture ? 'incomplete' : 'abort'}`, { reason: 'Cannot start recorder or capture storage' }).catch(() => {})
        if (active.current === capture) active.current = null
        if (requestGeneration === generation.current) setState(`Không thu: ${error instanceof Error ? error.message : 'chưa sẵn sàng'}`)
        throw error
      }
    })()
    pendingStart.current = pending
    pendingTrial.current = options.trialId
    void pending.finally(() => { if (pendingStart.current === pending) { pendingStart.current = null; pendingCancellation.current = null; setBusy(false) } }).catch(() => {})
    return pending
  }, [])

  const getScope = useCallback(() => active.current?.id || null, [])
  const gameStarted = useCallback((timestamp = performance.now()) => {
    const capture = active.current
    if (!capture || capture.stopped || capture.gameStarted !== undefined || timestamp < capture.start) return
    capture.gameStarted = timestamp - capture.start; capture.accepting = true
  }, [])
  const addFrame = useCallback((frame: InputFrame, scopeId?: string | null) => {
    const capture = scopeId && active.current?.id !== scopeId ? [...finishing.current].find(item => item.id === scopeId && item.acceptingLate) : active.current
    if (!capture || (!capture.acceptingLate && (capture.stopped || !capture.accepting)) || (capture.autoCapture && capture.gameStarted === undefined) || !capture.recordLandmarks || (scopeId !== undefined && scopeId !== capture.id) || frame.timestamp < capture.start + (capture.autoCapture ? capture.gameStarted || 0 : 0) || (capture.gameEnded !== undefined && frame.timestamp > capture.start + capture.gameEnded)) return
    const { timestamp, ...data } = frame
    capture.uploader.addFrame({ ...data, frame_id: capture.frames++, timestamp_ms: timestamp - capture.start, utc_time: utc(timestamp) })
  }, [])

  const event = useCallback((scope: string, type: string, payload: Record<string, unknown>, context: ResearchContext) => {
    const capture = active.current
    if (capture?.id === scope && !capture.stopped && capture.accepting && capture.gameStarted !== undefined && context.timestamp >= capture.start + capture.gameStarted) {
      // Cached input from setup was never recorded in this trial's frames artifact.
      const recordedSource = context.sourceTimestamp === undefined || context.sourceTimestamp >= capture.start + capture.gameStarted
      capture.gameResearch?.event(type, payload, recordedSource ? context : { ...context, sourceObservationId: null })
      if (['GAME_COMPLETED', 'GAME_STOPPED', 'GAME_CANCELLED'].includes(type)) capture.gameTerminal = true
    }
  }, [])
  const sample = useCallback((scope: string, type: string, payload: Record<string, unknown>, context: ResearchContext) => {
    const capture = active.current
    if (capture?.id === scope && !capture.stopped && capture.accepting && capture.gameStarted !== undefined && context.timestamp >= capture.start + capture.gameStarted) capture.gameResearch?.sample(type, payload, context)
  }, [])

  const stop = useCallback(async (reason = 'completed', endedTimestamp = performance.now(), settle?: () => Promise<void>) => {
    const capture = active.current
    if (!capture) return
    if (capture.stopPromise) return capture.stopPromise
    capture.stopped = true; capture.accepting = false; capture.acceptingLate = Boolean(capture.autoCapture && settle); capture.finalizing = true
    capture.gameEnded = Math.max(0, endedTimestamp - capture.start)
    if (capture.autoCapture && capture.gameStarted === undefined) capture.knownGaps = [...capture.knownGaps, 'Capture stopped before gameplay started.']
    if (capture.timer !== null) clearInterval(capture.timer)
    // Keep lease renewal for outstanding uploads; free the sink before any async work.
    if (capture.autoCapture) active.current = null
    finishing.current.add(capture)
    if (displayed.current === capture.id) { setElapsedMs(capture.gameEnded); setBusy(true); setState('Đang gửi dữ liệu và hoàn tất…') }
    capture.stopPromise = (async () => {
      try {
        const recordGap = (error: unknown) => { const gap = error instanceof Error ? error.message : 'Recorder stopped without final chunk'; capture.knownGaps = [...capture.knownGaps, gap]; capture.uploader.markIncomplete(gap) }
        const recorderStopped = Promise.all([stopRecorder(capture.recorder).catch(recordGap), stopRecorder(capture.trackingRecorder || null).catch(() => {
          capture.trackingVideoFailed = true
          capture.knownGaps = [...capture.knownGaps, 'Không ghi đầy đủ video tracking.']
          capture.uploader.noteGap('Không ghi đầy đủ video tracking.')
        })])
        let settleTimer: ReturnType<typeof setTimeout> | undefined
        const resultsSettled = settle ? Promise.race([Promise.resolve().then(settle), new Promise<never>((_, reject) => { settleTimer = setTimeout(() => reject(new Error('Tracking results did not settle before capture cutoff.')), 2500) })]).catch(recordGap).finally(() => clearTimeout(settleTimer)) : Promise.resolve()
        await Promise.all([recorderStopped, resultsSettled])
        capture.trackingVideo?.close()
        capture.acceptingLate = false
        capture.knownGaps = [...new Set([...capture.knownGaps, ...(capture.latestStats?.knownDataGaps || [])])]
        const result = await capture.uploader.finish(capture.gameEnded!, async () => {
          if (capture.heartbeatPromise) await capture.heartbeatPromise
          if (capture.autoCapture && capture.heartbeatError) { await renewLease(capture.id); capture.heartbeatError = null }
          if (capture.heartbeatError) throw capture.heartbeatError
        }, capture.autoCapture ? { ...(capture.gameStarted === undefined ? {} : { game_started_at_ms: capture.gameStarted, game_ended_at_ms: capture.gameEnded }), ended_at_utc: utc(endedTimestamp), termination_reason: reason, known_data_gaps: capture.knownGaps, ...(capture.trackingVideoFailed ? { tracking_video_complete: false } : {}) } : undefined) as { status?: string }
        if (result.status !== 'complete') throw new Error(`Backend báo trạng thái ${result.status || 'không xác định'}`)
        if (displayed.current === capture.id) setState('Đã hoàn tất và xác minh capture')
      } catch (error) {
        if (capture.recorder && capture.recorder.state !== 'inactive') capture.recorder.stop()
        if (displayed.current === capture.id) setState(error instanceof FinalizeOutcomeUnknown ? 'Kết quả finalize chưa xác định; kiểm tra trạng thái capture trước khi thử lại.' : `Capture không hoàn chỉnh: ${error instanceof Error ? error.message : 'lỗi không xác định'}`)
        if (!(error instanceof FinalizeOutcomeUnknown) && (!capture.autoCapture || capture.knownGaps.length)) void captureRequest(`/api/captures/${capture.id}/${capture.autoCapture ? 'incomplete' : 'abort'}`, { reason: 'Upload or finalization failed', ...(capture.autoCapture ? { known_data_gaps: capture.knownGaps } : {}) }).catch(() => {})
      } finally {
        capture.trackingVideo?.close()
        capture.acceptingLate = false; capture.finalizing = false; clearTimers(capture); finishing.current.delete(capture)
        capture.releaseOwnership?.()
        if (active.current === capture) active.current = null
        if (displayed.current === capture.id) setBusy(false)
      }
    })()
    return capture.stopPromise
  }, [])

  const abort = useCallback((reason = 'tracking_or_camera_stopped') => {
    generation.current++
    if (pendingCancellation.current) pendingCancellation.current.reason = reason.slice(0, 256)
    const wasPending = !!pendingStart.current
    pendingStart.current = null; pendingCancellation.current = null; pendingTrial.current = undefined
    const capture = active.current
    if (!capture || capture.stopped) { if (wasPending) { setState('Capture bị gián đoạn trong khi tạo.'); setBusy(false) }; return }
    if (capture.autoCapture) {
      const timestamp = performance.now()
      // The game closes any open stroke/drag while its capture scope still exists.
      try { capture.beforeAbort?.(reason, timestamp) }
      catch { capture.uploader.noteGap('Game did not close cleanly before capture interruption.') }
      if (!capture.stopped) {
        if (capture.gameStarted !== undefined && !capture.gameTerminal) {
          capture.gameResearch?.event('GAME_CANCELLED', { reason, termination_source: 'capture_abort' }, { timestamp })
          capture.gameTerminal = true
        }
        void stop(reason, timestamp)
      }
      return
    }
    capture.stopped = true; clearTimers(capture)
    if (capture.recorder?.state !== 'inactive') capture.recorder?.stop()
    active.current = null; setState('Capture bị gián đoạn; dữ liệu staging được giữ lại.')
    void captureRequest(`/api/captures/${capture.id}/abort`, { reason }).catch(() => {})
  }, [stop])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (active.current || pendingStart.current || finishing.current.size) { event.preventDefault(); event.returnValue = '' } }
    const online = () => {
      const captures = [...finishing.current, ...(active.current ? [active.current] : [])]
      for (const capture of captures) if (capture.autoCapture) void capture.uploader.resume().catch(() => { /* uploader reports and retains unacknowledged parts */ })
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener('online', online)
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('online', online); abort() }
  }, [abort])
  return { start, addFrame, event, sample, stop, abort, gameStarted, getScope, state, stats, captureId, trialId, busy, elapsedMs, isActive: () => !!active.current || !!pendingStart.current || finishing.current.size > 0 }
}

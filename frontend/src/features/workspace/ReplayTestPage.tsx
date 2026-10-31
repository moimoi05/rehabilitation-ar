import { useCallback, useRef, useState } from 'react'
import TrackingTestLab from './TrackingTestLab'
import type { ReplayFrame } from './replayFrame'
import { useReplayCapture } from './useReplayCapture'
import { CaptureNavigationGuard } from './CaptureNavigationGuard'
import { CaptureArtifactStatus } from './CaptureArtifactStatus'

export default function ReplayTestPage() {
  const replay = useReplayCapture()
  const { abort, addFrame, stop } = replay
  const selected = useRef<{ file: File; video: HTMLVideoElement } | null>(null)
  const modelConfig = useRef<object>({})
  const [ready, setReady] = useState(false)
  const [patient, setPatient] = useState('')
  const [session, setSession] = useState('')
  const [trial, setTrial] = useState('')
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const onSource = useCallback((file: File | null, video: HTMLVideoElement | null) => {
    abort(); selected.current = file && video ? { file, video } : null; setReady(false)
  }, [abort])
  const onReady = useCallback((_video: HTMLVideoElement, config: object) => { modelConfig.current = config; setReady(true) }, [])
  const onInterrupted = useCallback(() => { setReady(false); abort() }, [abort])
  const onFrame = useCallback((frame: ReplayFrame) => addFrame(frame), [addFrame])
  const onEnded = useCallback(() => {
    const video = selected.current?.video
    if (video) void stop(video.currentTime * 1000)
  }, [stop])
  const start = async () => {
    const current = selected.current
    if (!current || !ready || !consent || !Number.isInteger(Number(patient)) || Number(patient) <= 0 || !Number.isInteger(Number(session)) || Number(session) <= 0 || (trial && (!Number.isInteger(Number(trial)) || Number(trial) <= 0))) {
      setError('Chọn video, khởi động MediaPipe, nhập patient/session hợp lệ và xác nhận quyền thu thập.'); return
    }
    try {
      setError('')
      if (current.video.currentTime > 0.05) throw new Error('Hãy chọn lại video và khởi động nhận diện từ đầu trước khi thu.')
      await replay.start({ file: current.file, patientId: Number(patient), sessionId: Number(session), ...(trial ? { trialId: Number(trial) } : {}), width: current.video.videoWidth, height: current.video.videoHeight, modelConfig: modelConfig.current })
      await current.video.play()
    } catch (cause) { replay.abort(); setError(cause instanceof Error ? cause.message : 'Không thể bắt đầu replay.') }
  }
  return <>
    <CaptureNavigationGuard shouldBlock={() => replay.busy || replay.isActive()} />
    <section className="workspace-panel" aria-label="Video Replay Test">
      <h2>Video Replay Test</h2>
      <p>Chọn video bên dưới, bật Pose và Hand nếu cần, sau đó bấm Bắt đầu nhận diện. Khi model sẵn sàng, nhập thông tin capture và bắt đầu replay. Video nguồn được lưu nguyên trạng, không có overlay.</p>
      <label>Patient ID <input aria-label="Replay patient ID" type="number" min="1" value={patient} onChange={event => setPatient(event.target.value)} /></label>{' '}
      <label>Session ID <input aria-label="Replay session ID" type="number" min="1" value={session} onChange={event => setSession(event.target.value)} /></label>{' '}
      <label>Trial ID (tùy chọn) <input aria-label="Replay trial ID" type="number" min="1" value={trial} onChange={event => setTrial(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Tôi xác nhận quyền thu thập video và landmark cho lần kiểm thử này</label>
      <button onClick={() => void start()} disabled={!ready || !consent || replay.busy || replay.isActive()}>Bắt đầu thu replay</button>{' '}
      <button onClick={() => { selected.current?.video.pause(); void replay.stop((selected.current?.video.currentTime || 0) * 1000) }} disabled={!replay.isActive() || replay.busy}>Dừng và lưu replay</button>
      <p role="status">{replay.state}{replay.captureId && ` · Capture ${replay.captureId}`}</p>
      <CaptureArtifactStatus captureId={replay.captureId} busy={replay.busy || replay.isActive()} state={replay.state} />
      {replay.stats && <p>Frame: {replay.stats.frames} · Landmark: {replay.stats.landmarks} · Batch đã gửi: {replay.stats.uploadedBatches} · Đang chờ: {replay.stats.pending} · Video: {replay.stats.videoBytes} byte</p>}
      {error && <p role="alert">{error}</p>}
    </section>
    <TrackingTestLab onReplaySource={onSource} onReplayReady={onReady} onReplayFrame={onFrame} onReplayEnded={onEnded} onReplayInterrupted={onInterrupted} replayLocked={replay.busy || replay.isActive()} />
  </>
}

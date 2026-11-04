import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { TrackingDiagnostics } from './trackingDiagnostics'
import { computeInferenceDimensions } from './inferenceResolution'

export const developmentReplayEnabled = (query: URLSearchParams, development: boolean, clinical: boolean) =>
  development && !clinical && query.get('drawingReplay') === '1' && !query.get('sessionId') && !query.get('session')

type ReplayState = 'loading' | 'ready' | 'initializing' | 'running' | 'finished' | 'error'
type Props = {
  enabled: boolean; video: RefObject<HTMLVideoElement | null>; sourceActive: boolean; tracking: boolean
  engine: string | null; delegate: { hand: string; pose: string }; side: 'left' | 'right'; mirrored: boolean; run: number
  setSourceReady: (size: { width: number; height: number }) => void
  startTracking: () => Promise<void>; stopTracking: () => void
  game: { start: () => Promise<void>; stop: () => void; resetReplay: () => void; phase: string; getCompletedStrokes: () => number }
  diagnostics: TrackingDiagnostics | null
  inferenceTarget?: { width: number; height: number }; trackingErrors?: string[]
}

/** Development-only source adapter. All frames still enter Workspace's normal scheduler/Worker. */
export function useFreeDrawingReplay(props: Props) {
  const [state, setState] = useState<ReplayState>('loading'), [message, setMessage] = useState('Đang tải video kiểm tra…')
  const latest = useRef(props); latest.current = props
  const config = useRef<{ sourcePath: string } | null>(null)
  const runPipeline = useRef<{ engine: string | null; delegate: Props['delegate'] } | null>(null)
  const alive = useRef(false), reporting = useRef(false), initializing = useRef(false), playing = useRef(false)
  const generation = useRef(0), metadataGeneration = useRef<number | null>(null)
  const report = async (failure?: string) => {
    if (reporting.current || !alive.current) return
    const epoch = generation.current
    const isCurrent = () => alive.current && generation.current === epoch
    reporting.current = true
    const current = latest.current, video = current.video.current
    if (!failure && (!current.tracking || current.engine !== 'worker' || current.game.phase !== 'playing')) failure = 'Pipeline tracking đã ngừng trước khi xử lý hết video.'
    if (failure) video?.pause()
    current.game.stop()
    const endedAt = performance.now()
    const payload = {
      run: current.run, sourcePath: config.current?.sourcePath, outcome: failure ? 'error' : 'finished', error: failure,
      video: { durationSeconds: video?.duration, width: video?.videoWidth, height: video?.videoHeight, playbackRate: video?.playbackRate, processedUntilSeconds: video?.currentTime },
      delegate: runPipeline.current?.delegate ?? current.delegate, engine: runPipeline.current?.engine ?? current.engine,
      inputResolution: computeInferenceDimensions(video?.videoWidth ?? 0, video?.videoHeight ?? 0, current.inferenceTarget ?? { width: 1280, height: 720 }) ?? { width: video?.videoWidth, height: video?.videoHeight },
      trackingErrors: current.trackingErrors?.slice(0, 10) ?? [],
      configuration: { tasksVision: '0.10.35', handCount: 2, minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5, maxHandAgeMs: 150, side: current.side, mirrored: current.mirrored },
      diagnostics: current.diagnostics?.report(endedAt, current.game.getCompletedStrokes()),
      exercise: { phase: failure ? 'interrupted' : 'finished', prescribed: false, timed: false },
      limitations: ['Recorded video at normal speed; not live-camera latency.', 'No clinical data saved. No raw landmarks exported.', 'Drag/release is validated separately by controller tests.'],
    }
    try {
      const response = await fetch('/__free-drawing-replay/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error(`Không ghi được báo cáo replay (${response.status}).`)
      if (isCurrent()) { setState(failure ? 'error' : 'finished'); setMessage(failure || 'Đã chạy hết video và ghi báo cáo chẩn đoán.') }
    } catch (error) {
      if (isCurrent()) { setState('error'); setMessage(error instanceof Error ? error.message : 'Không ghi được báo cáo replay.') }
    } finally { if (isCurrent()) current.stopTracking() }
  }
  const reportRef = useRef(report); reportRef.current = report

  useEffect(() => {
    if (!props.enabled) return
    const video = props.video.current
    if (!video) return
    const epoch = ++generation.current
    metadataGeneration.current = null; config.current = null
    alive.current = true; reporting.current = false; initializing.current = false; playing.current = false; runPipeline.current = null
    props.game.resetReplay()
    setState('loading'); setMessage('Đang tải video kiểm tra…')
    let cancelled = false, drain: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const loaded = () => {
      if (cancelled || metadataGeneration.current === epoch || !video.videoWidth || !video.videoHeight) return
      metadataGeneration.current = epoch
      latest.current.setSourceReady({ width: video.videoWidth, height: video.videoHeight })
      setState('ready'); setMessage('Đang chuẩn bị Worker cho video kiểm tra…')
    }
    const ended = () => {
      if (cancelled || !playing.current || reporting.current) return
      // Allow the final in-flight fresh callback to finish before aggregating.
      drain = setTimeout(() => { void reportRef.current() }, 160)
    }
    const failed = () => { void reportRef.current('Không đọc được video MP4 trong trình duyệt.') }
    const seeking = () => {
      if (!cancelled && playing.current) void reportRef.current('Replay đã tua video. Bắt đầu lượt mới để xóa tracking cũ và giữ timestamp nhất quán.')
    }
    video.addEventListener('loadeddata', loaded); video.addEventListener('ended', ended); video.addEventListener('error', failed); video.addEventListener('seeking', seeking)
    void fetch('/__free-drawing-replay/config', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Replay chưa được bật trên Vite. Chạy npm run replay:free-drawing.')
      const value = await response.json()
      if (cancelled) return
      if (value.videoUrl !== '/__free-drawing-replay/video' || typeof value.sourcePath !== 'string') throw new Error('Cấu hình replay không hợp lệ.')
      config.current = { sourcePath: value.sourcePath }
      video.srcObject = null; video.src = value.videoUrl; video.preload = 'auto'; video.loop = false; video.playbackRate = 1; video.load()
    }).catch(error => { if (!cancelled) void reportRef.current(error instanceof Error ? error.message : 'Không tải được replay.') })
    return () => {
      cancelled = true; alive.current = false; generation.current += 1; controller.abort(); clearTimeout(drain)
      video.removeEventListener('loadeddata', loaded); video.removeEventListener('ended', ended); video.removeEventListener('error', failed); video.removeEventListener('seeking', seeking)
      if (initializing.current || playing.current) { props.game.stop(); props.stopTracking() }
      video.pause(); video.removeAttribute('src'); video.load()
    }
  }, [props.enabled, props.video, props.run])

  useEffect(() => {
    if (!props.enabled || metadataGeneration.current !== generation.current || state !== 'ready' || !props.sourceActive || initializing.current) return
    const epoch = generation.current
    initializing.current = true; setState('initializing')
    void latest.current.startTracking().catch(error => { if (alive.current && generation.current === epoch) void reportRef.current(String(error)) })
  }, [props.enabled, state, props.sourceActive])
  useEffect(() => {
    if (!props.enabled || metadataGeneration.current !== generation.current || state !== 'initializing' || !props.tracking || playing.current) return
    const epoch = generation.current
    const isCurrent = () => alive.current && generation.current === epoch
    playing.current = true
    if (props.engine !== 'worker') { void reportRef.current('Replay yêu cầu Worker MediaPipe hiện có; không đo bằng pipeline dự phòng.'); return }
    runPipeline.current = { engine: props.engine, delegate: { ...props.delegate } }
    void latest.current.game.start().then(async () => {
      if (!isCurrent()) return
      // Exclude model setup and React's development cleanup from video-only counters.
      latest.current.diagnostics?.reset()
      await latest.current.video.current?.play()
      if (isCurrent()) { setState('running'); setMessage('Đang phát video 1× qua MediaPipe Worker; không lưu kết quả lâm sàng.') }
    }).catch(error => { if (isCurrent()) void reportRef.current(String(error)) })
  }, [props.enabled, props.tracking, props.engine, state])
  useEffect(() => {
    if (props.enabled && metadataGeneration.current === generation.current && state === 'running' && (!props.tracking || props.engine !== 'worker' || props.game.phase !== 'playing')) {
      void reportRef.current('Pipeline tracking đã ngừng khi video còn đang chạy.')
    }
  }, [props.enabled, props.tracking, props.engine, props.game.phase, state])
  useEffect(() => {
    if (!props.enabled || state !== 'initializing') return
    const timer = setTimeout(() => { void reportRef.current('Hết thời gian khởi tạo MediaPipe Worker.') }, 60000)
    return () => clearTimeout(timer)
  }, [props.enabled, state])
  return { state, message }
}

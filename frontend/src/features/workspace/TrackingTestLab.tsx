import { useCallback, useEffect, useRef, useState } from 'react'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { drawLandmarks, prepareOverlay } from './drawing'
import type { Point } from './drawing'
import { createReplayFrame } from './replayFrame'
import type { ReplayFrame } from './replayFrame'
import { LandmarkSmoother, POSE_SMOOTHING_POLICY, SMOOTHING_PROFILES, SMOOTHING_VERSION } from './landmarkSmoothing'
import type { SmoothingProfileName } from './landmarkSmoothing'
import { initializePose, initializeHand, modelErrorMessage } from './mediaPipeModels'
import { handFreshness } from './handObservation'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import { getTrackingProfile, TRACKING_PROFILES } from './trackingProfiles'
import type { TrackingProfileName } from './trackingProfiles'
import { useVideoMapping } from './useVideoMapping'
import { createWorkerTracker } from './workerTracker'
import type { WorkerTracker } from './workerTracker'
import { createParallelWorkerTracker } from './parallelWorkerTracker'
import type { ParallelWorkerTracker } from './parallelWorkerTracker'
import { AdaptiveWorkerBudget, AUTO_WORKER_MAX_FPS } from './adaptiveWorkerBudget'
import './workspace.css'
import './trackingLab.css'

type Engine = 'main' | 'worker' | 'parallel'
const RESULT_MAX_AGE_MS = 700
type MeasurementConfig = { source: 'none' | 'video' | 'camera'; profile: TrackingProfileName; engine: Engine; delegate: string; resolution: { width: number; height: number }; poseEnabled: boolean; handEnabled: boolean; smoothed: boolean; smoothingProfile: SmoothingProfileName; mirrored: boolean; adaptiveWorkerBudget: boolean }
type BudgetSnapshot = ReturnType<AdaptiveWorkerBudget['snapshot']> & { enabled: true }
type StreamMetrics = { inferences: number; busyFrames: number; throttledFrames: number; durations: number[]; roundTrips: number[] }
type Snapshot = { config: MeasurementConfig | null; adaptiveWorkerBudget: BudgetSnapshot | null; videoFrames: number; inferences: number; renders: number; throttled: number; duplicates: number; workerBusy: number; valid: number; leftVisible: number; rightVisible: number; durations: number[]; roundTrips: number[]; overlayDurations: number[]; dualPose: StreamMetrics; dualHand: StreamMetrics; started: number; snapshotAt: number; ended: number | null }
const emptyStream = (): StreamMetrics => ({ inferences: 0, busyFrames: 0, throttledFrames: 0, durations: [], roundTrips: [] })
const emptySnapshot = (config: MeasurementConfig | null = null): Snapshot => { const now = performance.now(); return { config, adaptiveWorkerBudget: null, videoFrames: 0, inferences: 0, renders: 0, throttled: 0, duplicates: 0, workerBusy: 0, valid: 0, leftVisible: 0, rightVisible: 0, durations: [], roundTrips: [], overlayDurations: [], dualPose: emptyStream(), dualHand: emptyStream(), started: now, snapshotAt: now, ended: null } }
const percentile = (values: number[], fraction: number) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] }
const fmt = (value: number | null) => value === null ? '—' : value.toFixed(1)
const settings = () => { try { return JSON.parse(localStorage.getItem('rehab.settings') || '{}') as Record<string, unknown> } catch { return {} } }
const upperLimbVisible = (pose: Point[], indexes: number[]) => indexes.every(index => { const point = pose[index]; return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && point.visibility !== undefined && Number.isFinite(point.visibility) && point.visibility >= .4 })
const isFresh = (timestamp: number, now: number) => timestamp > 0 && now >= timestamp && now - timestamp <= RESULT_MAX_AGE_MS
type Landmarks = { raw: Point[]; display: Point[]; hands: Point[][]; poseTime: number; handTime: number; resultTime: number }
const emptyLandmarks = (): Landmarks => ({ raw: [], display: [], hands: [], poseTime: 0, handTime: 0, resultTime: 0 })

export type TrackingTestLabProps = {
  onReplaySource?: (file: File | null, video: HTMLVideoElement | null) => void
  onReplayFrame?: (frame: ReplayFrame) => void
  onReplayReady?: (video: HTMLVideoElement, config: object) => void
  onReplayEnded?: () => void
  onReplayInterrupted?: () => void
  replayLocked?: boolean
}

export default function TrackingTestLab({ onReplaySource, onReplayFrame, onReplayReady, onReplayEnded, onReplayInterrupted, replayLocked = false }: TrackingTestLabProps = {}) {
  const [profileName, setProfileName] = useState<TrackingProfileName>(() => { const value = settings().trackingProfile; return value === 'economy' || value === 'quality' ? value : 'balanced' })
  const [source, setSource] = useState<'none' | 'video' | 'camera'>('none')
  const [poseEnabled, setPoseEnabled] = useState(true)
  const [handEnabled, setHandEnabled] = useState(true)
  const [smoothed, setSmoothed] = useState(true)
  const [smoothingProfile, setSmoothingProfile] = useState<SmoothingProfileName>('standard')
  const [mirrored, setMirrored] = useState(false)
  const [model, setModel] = useState('Chưa tải')
  const [delegate, setDelegate] = useState('—')
  const [preferGpu, setPreferGpu] = useState(true)
  const [modelErrors, setModelErrors] = useState<string[]>([])
  const [preferWorker, setPreferWorker] = useState(false)
  const [preferParallel, setPreferParallel] = useState(false)
  const [preferAdaptive, setPreferAdaptive] = useState(false)
  const [engine, setEngine] = useState<Engine>('main')
  const [running, setRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const [message, setMessage] = useState('')
  const [size, setSize] = useState({ width: 1280, height: 720 })
  const [stats, setStats] = useState(() => emptySnapshot())
  const [, setUiClock] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const [videoMapping, displayBox] = useVideoMapping(video)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const url = useRef<string | null>(null)
  const generation = useRef(0)
  const stopScheduler = useRef<(() => void) | null>(null)
  const pose = useRef<PoseLandmarker | null>(null)
  const hand = useRef<HandLandmarker | null>(null)
  const worker = useRef<WorkerTracker | null>(null)
  const parallelWorker = useRef<ParallelWorkerTracker | null>(null)
  const adaptiveBudget = useRef<AdaptiveWorkerBudget | null>(null)
  const stopAdaptive = useRef<(() => void) | null>(null)
  const workerAbort = useRef<AbortController | null>(null)
  const smoother = useRef(new LandmarkSmoother())
  const handSides = useRef({ left: 0, right: 0 })
  const landmarks = useRef<Landmarks>(emptyLandmarks())
  const measurement = useRef(emptySnapshot())
  const measuringRef = useRef(false)
  const drawOptions = useRef({ smoothed, mirrored })
  drawOptions.current = { smoothed, mirrored }

  const clearResults = useCallback(() => { smoother.current.reset(); landmarks.current = emptyLandmarks(); handSides.current = { left: 0, right: 0 } }, [])
  const captureBudget = useCallback((sample: Snapshot) => {
    if (sample.config?.adaptiveWorkerBudget && adaptiveBudget.current) sample.adaptiveWorkerBudget = { enabled: true, ...adaptiveBudget.current.snapshot() }
  }, [])
  const stopTracking = useCallback(() => {
    onReplayInterrupted?.()
    generation.current++
    if (measuringRef.current) { captureBudget(measurement.current); measurement.current.ended = performance.now(); measuringRef.current = false; setMeasuring(false); setStats({ ...measurement.current }) }
    stopAdaptive.current?.(); stopAdaptive.current = null; adaptiveBudget.current = null
    stopScheduler.current?.(); stopScheduler.current = null
    worker.current?.close(); worker.current = null; parallelWorker.current?.close(); parallelWorker.current = null; workerAbort.current?.abort(); workerAbort.current = null
    pose.current?.close(); hand.current?.close(); pose.current = null; hand.current = null
    clearResults(); setRunning(false); setStarting(false); setModel('Đã dừng')
  }, [clearResults, captureBudget, onReplayInterrupted])
  const stopSource = useCallback(() => {
    stopTracking()
    const oldStream = stream.current; stream.current = null
    oldStream?.getTracks().forEach(track => track.stop())
    if (video.current) { video.current.pause(); video.current.srcObject = null; video.current.removeAttribute('src') }
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = null; setSource('none'); onReplaySource?.(null, video.current)
  }, [stopTracking, onReplaySource])
  useEffect(() => () => { stopSource() }, [stopSource])
  useEffect(() => {
    const timer = window.setInterval(() => { setUiClock(value => value + 1); if (measuringRef.current) { const value = measurement.current; setStats({ ...value, snapshotAt: performance.now(), durations: [...value.durations], roundTrips: [...value.roundTrips], overlayDurations: [...value.overlayDurations], dualPose: { ...value.dualPose, durations: [...value.dualPose.durations], roundTrips: [...value.dualPose.roundTrips] }, dualHand: { ...value.dualHand, durations: [...value.dualHand.durations], roundTrips: [...value.dualHand.roundTrips] } }) } }, 500)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const started = performance.now(), target = canvas.current, ctx = target?.getContext('2d')
      if (target && ctx) {
        const display = prepareOverlay(ctx, target.width, target.height, displayBox.current)
        const value = landmarks.current
        if (videoMapping.current) {
          const mapping = videoMapping.current
          if (isFresh(value.poseTime, started)) drawLandmarks(ctx, display.width, display.height, drawOptions.current.smoothed ? value.display : value.raw, drawOptions.current.mirrored, false, mapping)
          if (isFresh(value.handTime, started)) value.hands.forEach(points => drawLandmarks(ctx, display.width, display.height, points, drawOptions.current.mirrored, true, mapping))
        }
      }
      if (measuringRef.current) { const m = measurement.current; m.renders++; if (m.overlayDurations.length < 10000) m.overlayDurations.push(performance.now() - started) }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [videoMapping, displayBox])
  const measurementConfig = (): MeasurementConfig => ({ source, profile: profileName, engine, delegate, resolution: size, poseEnabled, handEnabled, smoothed, smoothingProfile, mirrored, adaptiveWorkerBudget: engine === 'parallel' && adaptiveBudget.current !== null })
  const resetMeasurement = () => { measurement.current = emptySnapshot(measurementConfig()); captureBudget(measurement.current); setStats({ ...measurement.current }) }
  const toggleMeasurement = () => { const next = !measuringRef.current; if (next) resetMeasurement(); else { captureBudget(measurement.current); measurement.current.ended = performance.now() }; measuringRef.current = next; setMeasuring(next); if (!next) setStats({ ...measurement.current }) }
  const changeProfile = (value: TrackingProfileName) => { setProfileName(value); localStorage.setItem('rehab.settings', JSON.stringify({ ...settings(), trackingProfile: value })) }
  const changeSmoothingProfile = (value: SmoothingProfileName) => {
    if (measuringRef.current) return
    smoother.current = new LandmarkSmoother(SMOOTHING_PROFILES[value])
    landmarks.current = { ...landmarks.current, display: landmarks.current.raw }
    setSmoothingProfile(value)
  }
  const openFile = (file?: File) => {
    if (!file || !video.current) return
    stopSource(); setMessage(''); const objectUrl = URL.createObjectURL(file); url.current = objectUrl
    video.current.src = objectUrl; setSource('video'); onReplaySource?.(file, video.current)
    if (!onReplayFrame) video.current.play().catch(() => setMessage('Nhấn Phát để bắt đầu video.'))
  }
  const openCamera = async () => {
    stopSource(); setMessage(''); const requestId = ++generation.current
    if (!navigator.mediaDevices?.getUserMedia) { setMessage('Trình duyệt không hỗ trợ camera.'); return }
    try {
      const profile = getTrackingProfile(profileName)
      const camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: profile.width }, height: { ideal: profile.height } }, audio: false })
      if (requestId !== generation.current || !video.current) { camera.getTracks().forEach(track => track.stop()); return }
      stream.current = camera
      const track = camera.getVideoTracks()[0]
      const disconnected = () => { if (stream.current === camera) { stopSource(); setMessage('Camera đã ngắt kết nối. Hãy kết nối lại và bật camera.') } }
      track?.addEventListener('ended', disconnected, { once: true })
      if (!track) { disconnected(); return }
      const trackEnded = () => track.readyState === 'ended'
      if (trackEnded()) { disconnected(); return }
      video.current.srcObject = camera; await video.current.play()
      if (requestId !== generation.current) { camera.getTracks().forEach(track => track.stop()); return }
      if (trackEnded()) { disconnected(); return }
      setSource('camera')
    } catch (error) { if (requestId === generation.current) { stopSource(); setMessage(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Quyền camera bị từ chối. Hãy cho phép camera trong trình duyệt.' : 'Không mở được camera. Kiểm tra quyền và thiết bị.'); } }
  }
  const startTracking = async () => {
    if (!video.current || source === 'none' || (!poseEnabled && !handEnabled)) return
    stopTracking(); const requestId = ++generation.current; setModel('Đang tải'); setStarting(true); setMessage(''); setModelErrors([])
    const input = video.current, profile = getTrackingProfile(profileName)
    let useHand = handEnabled
    type Inference = (timestamp: number, doHand: boolean, sample: Snapshot | null, sourceFrame: { frameId: number; framePerformanceMs: number; mediaTime: number; capturedAt: string; sourceFrameId?: number | null; skippedSourceFrames?: number }) => boolean
    const accept = (id: number, timestamp: number, raw: Point[], nextHands: Point[][] | null, inferenceMs: number | undefined, sample: Snapshot | null, roundTrip?: number, posePerformed = poseEnabled) => {
      if (id !== generation.current) return null
      if (sample && measuringRef.current && sample === measurement.current && timestamp >= sample.started) {
        sample.inferences++; if (raw.length || nextHands?.length) sample.valid++
        if (sample.config?.poseEnabled && posePerformed) { if (upperLimbVisible(raw, [11, 13, 15])) sample.leftVisible++; if (upperLimbVisible(raw, [12, 14, 16])) sample.rightVisible++ }
        if (inferenceMs !== undefined && sample.durations.length < 10000) sample.durations.push(inferenceMs)
        if (roundTrip !== undefined && sample.roundTrips.length < 10000) sample.roundTrips.push(roundTrip)
      }
      if (!isFresh(timestamp, performance.now()) || input.seeking) return null
      const previous = landmarks.current
      landmarks.current = { raw: posePerformed ? raw : previous.raw, display: posePerformed ? smoother.current.filter('pose', raw, timestamp, POSE_SMOOTHING_POLICY) : previous.display, hands: nextHands ?? previous.hands, poseTime: posePerformed ? timestamp : previous.poseTime, handTime: nextHands === null ? previous.handTime : timestamp, resultTime: timestamp }
      return landmarks.current.display
    }
    const schedule = (id: number, infer: Inference, replayConfig: object = {}, independent = false) => {
      if (id !== generation.current) return
      setModel('Sẵn sàng'); setStarting(false); setRunning(true)
      let lastHand = -Infinity, sourceFrameId = 0
      if (source === 'video') onReplayReady?.(input, replayConfig)
      stopScheduler.current = startVideoFrameScheduler(input, ({ now, mediaTime, inferenceTimestamp, sourceFrameId: presentedFrame, skippedSourceFrames }) => {
        if (id !== generation.current) return
        const sample = measuringRef.current ? measurement.current : null
        if (sample) sample.videoFrames++
        const doHand = useHand && now >= lastHand
        const sourceFrame = { frameId: ++sourceFrameId, framePerformanceMs: now, mediaTime, capturedAt: new Date(performance.timeOrigin + now).toISOString(), sourceFrameId: presentedFrame, skippedSourceFrames }
        if (infer(inferenceTimestamp, doHand, sample, sourceFrame)) { if (doHand) lastHand = now + 1000 / profile.handFps - (Number.isFinite(lastHand) ? (now - lastHand) % (1000 / profile.handFps) : 0) }
        else if (sample) sample.workerBusy++
      }, { maxFps: independent ? 120 : poseEnabled ? profile.poseFps : profile.handFps, onReset: () => { stopTracking(); setMessage('Nguồn đã seek hoặc phát lại. Khởi động nhận diện lại để reset trạng thái model.') }, onSkip: reason => { if (measuringRef.current) { const m = measurement.current; if (reason === 'duplicate') m.duplicates++; else { m.throttled++; m.videoFrames++ } } }, onSkippedFrame: frame => { if (source === 'video' && onReplayFrame) onReplayFrame({ frame_id: ++sourceFrameId, source_frame_id: frame.sourceFrameId, frame_performance_ms: frame.now, video_media_time_ms: frame.mediaTime * 1000, utc_time: new Date(performance.timeOrigin + frame.now).toISOString(), inference_performed: false, pose_detected: null, hand_detected: null, inference_ms: null, skipped_frames: frame.skippedSourceFrames, landmarks: [] }) } })
    }
    const startMain = async (id: number, useGpu: boolean) => {
      try {
        const { FilesetResolver } = await import('@mediapipe/tasks-vision')
        const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
        const delegates: string[] = []
        if (poseEnabled) { const created = await initializePose(files, useGpu); if (id !== generation.current) { created.model.close(); return }; pose.current = created.model; delegates.push(`Pose ${created.delegate}`); if (created.gpuError) setModelErrors(previous => [...previous, `Pose GPU: ${created.gpuError}`]) }
        if (useHand) {
          try { const created = await initializeHand(files, useGpu); if (id !== generation.current) { created.model.close(); return }; hand.current = created.model; delegates.push(`Hand ${created.delegate}`); if (created.gpuError) setModelErrors(previous => [...previous, `Hand GPU: ${created.gpuError}`]) }
          catch (error) {
            if (id !== generation.current) return
            if (!poseEnabled) throw error
            useHand = false; delegates.push('Hand Lỗi'); setModelErrors(previous => [...previous, modelErrorMessage(error)]); setHandEnabled(false); setMessage('Không tải được mô hình bàn tay; theo dõi tư thế vẫn hoạt động.')
          }
        }
        if (id !== generation.current) return
        setEngine('main'); setDelegate(delegates.join(' · '))
        let nextPose = -Infinity
        schedule(id, (timestamp, doHand, sample, sourceFrame) => {
          const start = performance.now()
          try {
            const doPose = poseEnabled && sourceFrame.framePerformanceMs >= nextPose
            if (!doPose && !doHand) return true
            const poseStart = performance.now()
            const poseResult = doPose ? pose.current?.detectForVideo(input, timestamp) : undefined
            if (doPose) nextPose = sourceFrame.framePerformanceMs + 1000 / profile.poseFps - (Number.isFinite(nextPose) ? (sourceFrame.framePerformanceMs - nextPose) % (1000 / profile.poseFps) : 0)
            if (sample && doPose) { sample.dualPose.inferences++; if (sample.dualPose.durations.length < 10000) sample.dualPose.durations.push(performance.now() - poseStart) }
            const raw = poseResult?.landmarks[0] || []
            let handResult: ReturnType<HandLandmarker['detectForVideo']> | null = null
            let hands: Point[][] | null = null
            if (doHand && hand.current) {
              try { const handStart = performance.now(); handResult = hand.current.detectForVideo(input, timestamp); hands = handResult.landmarks; handSides.current = handFreshness(hands, handResult.handedness, timestamp); if (sample) { sample.dualHand.inferences++; if (sample.dualHand.durations.length < 10000) sample.dualHand.durations.push(performance.now() - handStart) } }
              catch (error) {
                if (!pose.current) throw error
                if (source === 'video' && onReplayFrame) throw error
                // End the current measurement before changing its model configuration.
                if (measuringRef.current) { measurement.current.ended = performance.now(); measuringRef.current = false; setMeasuring(false); setStats({ ...measurement.current }) }
                setModelErrors(previous => [...previous, `Hand inference: ${modelErrorMessage(error)}`])
                const failedHand = hand.current; hand.current = null; useHand = false; hands = []
                landmarks.current = { ...landmarks.current, hands: [], handTime: 0 }
                let released = true
                try { failedHand.close() } catch { released = false }
                setHandEnabled(false); setDelegate([...delegates.filter(value => value.startsWith('Pose ')), 'Hand Lỗi'].join(' · '))
                setMessage(released ? 'Suy luận bàn tay thất bại; phép đo đã dừng và theo dõi tư thế vẫn hoạt động.' : 'Suy luận bàn tay thất bại; không xác nhận được việc giải phóng model Hand. Phép đo đã dừng và theo dõi tư thế vẫn hoạt động.')
              }
            }
            const inferenceMs = performance.now() - start
            const acceptedDisplay = accept(id, timestamp, raw, hands, inferenceMs, sample, undefined, doPose)
            if (source === 'video' && onReplayFrame) {
              onReplayFrame(createReplayFrame({ ...sourceFrame, inferenceMs, pose: raw, posePerformed: poseResult !== undefined, poseWorld: poseResult?.worldLandmarks?.[0] ?? [], displayPose: doPose ? acceptedDisplay ?? [] : [],
                hands: handResult?.landmarks ?? [], handsWorld: handResult?.worldLandmarks ?? [], handedness: handResult?.handedness ?? [], handPerformed: handResult !== null }))
            }
            return true
          } catch (error) { stopTracking(); setModelErrors(previous => [...previous, modelErrorMessage(error)]); setMessage('Suy luận thất bại; hãy thử lại.'); return false }
        }, { pipeline: 'tracking_test_lab', tasks_vision_version: '0.10.35', timestamp: 'capture_relative_monotonic_callback', video_timestamp: 'video_media_time', pose_enabled: poseEnabled, hand_enabled: useHand, pose_model: poseEnabled ? 'pose_landmarker_lite.task' : null, hand_model: useHand ? 'hand_landmarker.task' : null, delegate: delegates, profile: profileName, smoothing_profile: smoothingProfile }, true)
      } catch (error) { if (id === generation.current) { stopTracking(); setModelErrors(previous => [...previous, modelErrorMessage(error)]); setModel('Lỗi tải model'); setMessage('Không tải được MediaPipe hoặc model cục bộ.') } }
    }
    const fallback = (id: number) => {
      if (id !== generation.current) return
      stopTracking(); const fallbackId = ++generation.current
      setMessage('Worker không khả dụng; phép đo đã dừng và Lab đang chuyển sang CPU trên luồng chính.')
      setModel('Đang tải CPU'); setStarting(true); void startMain(fallbackId, false)
    }
    if (!(source === 'video' && onReplayFrame) && preferParallel && poseEnabled && handEnabled && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
      let poseThread: Worker | null = null, handThread: Worker | null = null
      let pendingPose: Snapshot | null = null, pendingHand: Snapshot | null = null
      const budget = preferAdaptive ? new AdaptiveWorkerBudget(AUTO_WORKER_MAX_FPS) : null
      const disableHand = (cleanupFailed = false) => {
        if (requestId !== generation.current || !useHand) return
        budget?.setHandAvailable(false)
        const wasMeasuring = measuringRef.current
        if (wasMeasuring) { captureBudget(measurement.current); measurement.current.ended = performance.now(); measuringRef.current = false; setMeasuring(false); setStats({ ...measurement.current }) }
        useHand = false; pendingHand = null
        landmarks.current = { ...landmarks.current, hands: [], handTime: 0 }
        setHandEnabled(false); setPreferParallel(false); setDelegate('Pose CPU · Worker riêng')
        setMessage(cleanupFailed
          ? 'Hand thất bại; không xác nhận được việc giải phóng model. Pose vẫn chạy; dừng nhận diện hoặc tải lại trang để đóng Worker.'
          : `Hand không khả dụng; ${wasMeasuring ? 'phép đo đã dừng và ' : ''}Pose vẫn hoạt động.`)
      }
      const recordStream = (sample: Snapshot | null, stream: 'dualPose' | 'dualHand', timestamp: number, inferenceMs: number | undefined) => {
        if (!sample || !measuringRef.current || sample !== measurement.current || timestamp < sample.started) return false
        const values = sample[stream]; values.inferences++
        if (inferenceMs !== undefined && values.durations.length < 10000) values.durations.push(inferenceMs)
        if (values.roundTrips.length < 10000) values.roundTrips.push(Math.max(0, performance.now() - timestamp))
        return true
      }
      try {
        const controller = new AbortController(); workerAbort.current = controller
        poseThread = new Worker('/tracking-worker.js'); handThread = new Worker('/tracking-worker.js')
        const moduleUrl = new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href
        const tracker = await createParallelWorkerTracker({ poseWorker: poseThread, handWorker: handThread, moduleUrl, signal: controller.signal, capture: element => createImageBitmap(element), preferGpu,
          onPose: result => {
            const sample = pendingPose; pendingPose = null
            if (requestId !== generation.current) return
            if (!document.hidden) budget?.recordResult('pose', { timestamp: result.timestamp, receivedAt: performance.now(), inferenceMs: result.inferenceMs })
            if (sample && measuringRef.current && sample === measurement.current) captureBudget(sample)
            if (recordStream(sample, 'dualPose', result.timestamp, result.inferenceMs) && sample) {
              sample.inferences++; if (result.pose.length) sample.valid++
              if (upperLimbVisible(result.pose, [11, 13, 15])) sample.leftVisible++
              if (upperLimbVisible(result.pose, [12, 14, 16])) sample.rightVisible++
              if (result.inferenceMs !== undefined && sample.durations.length < 10000) sample.durations.push(result.inferenceMs)
              if (sample.roundTrips.length < 10000) sample.roundTrips.push(Math.max(0, performance.now() - result.timestamp))
            }
            if (!isFresh(result.timestamp, performance.now()) || input.seeking || result.timestamp < landmarks.current.poseTime) return
            landmarks.current = { ...landmarks.current, raw: result.pose, display: smoother.current.filter('pose', result.pose, result.timestamp, POSE_SMOOTHING_POLICY), poseTime: result.timestamp, resultTime: result.timestamp }
          },
          onHand: result => {
            const sample = pendingHand; pendingHand = null
            if (requestId !== generation.current) return
            if (result.handFailed) { disableHand(result.handCleanupFailed === true); return }
            if (!document.hidden) budget?.recordResult('hand', { timestamp: result.timestamp, receivedAt: performance.now(), inferenceMs: result.inferenceMs })
            if (sample && measuringRef.current && sample === measurement.current) captureBudget(sample)
            recordStream(sample, 'dualHand', result.timestamp, result.inferenceMs)
            if (!useHand || !isFresh(result.timestamp, performance.now()) || input.seeking || result.timestamp < landmarks.current.handTime) return
            landmarks.current = { ...landmarks.current, hands: result.hands ?? [], handTime: result.timestamp }
          },
          onPoseError: () => fallback(requestId), onHandError: () => disableHand(),
        })
        if (requestId !== generation.current) { tracker.close(); return }
        parallelWorker.current = tracker; setEngine('parallel');
        const parallelDelegates = [tracker.delegates.pose ? `Pose ${tracker.delegates.pose}` : 'Pose —', useHand && tracker.delegates.hand ? `Hand ${tracker.delegates.hand}` : 'Hand Tắt', 'Worker riêng'].join(' · ')
        setDelegate(parallelDelegates)
        if (tracker.initializationErrors.length) setModelErrors(previous => [...previous, ...tracker.initializationErrors])
        if (budget) {
          adaptiveBudget.current = budget
          let expected = performance.now() + 250
          budget.reset(performance.now())
          const playable = () => !document.hidden && !input.paused && !input.ended && !input.seeking && input.readyState >= 2
          let wasPlayable = playable()
          const visibility = () => { if (!document.hidden) { const now = performance.now(); budget.reset(now); expected = now + 250; wasPlayable = playable() } else wasPlayable = false }
          document.addEventListener('visibilitychange', visibility)
          const timer = window.setInterval(() => {
            const now = performance.now()
            const active = playable()
            if (active) {
              if (!wasPlayable) { budget.reset(now); expected = now }
              budget.recordUiDelay(now, Math.max(0, now - expected))
              if (measuringRef.current) captureBudget(measurement.current)
            }
            wasPlayable = active
            expected = now + 250
          }, 250)
          stopAdaptive.current = () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
        }
        setModel('Sẵn sàng'); setStarting(false); setRunning(true)
        let lastHand = -Infinity
        stopScheduler.current = startVideoFrameScheduler(input, ({ now, inferenceTimestamp }) => {
          if (requestId !== generation.current || (budget && document.hidden)) return
          const sample = measuringRef.current ? measurement.current : null
          if (sample) sample.videoFrames++
          if (budget && !budget.canSubmit('pose', now)) { if (sample) sample.dualPose.throttledFrames++ }
          else if (tracker.submitPose(input, inferenceTimestamp)) { pendingPose = sample; budget?.submitted('pose', now) }
          else if (sample) { sample.workerBusy++; sample.dualPose.busyFrames++ }
          if (useHand) {
            if (budget ? !budget.canSubmit('hand', now) : now - lastHand < 1000 / profile.handFps) { if (sample) sample.dualHand.throttledFrames++ }
            else if (tracker.submitHand(input, inferenceTimestamp)) { pendingHand = sample; lastHand = now; budget?.submitted('hand', now) }
            else if (sample) sample.dualHand.busyFrames++
          }
        }, { maxFps: budget ? 60 : profile.poseFps, onReset: () => { stopTracking(); setMessage('Nguồn đã seek hoặc phát lại. Khởi động nhận diện lại để reset trạng thái model.') }, onSkip: reason => { if (measuringRef.current) { const sample = measurement.current; if (reason === 'duplicate') sample.duplicates++; else { sample.throttled++; sample.dualPose.throttledFrames++; if (useHand) sample.dualHand.throttledFrames++; sample.videoFrames++ } } } })
      } catch {
        // Constructors may fail before the coordinator takes ownership.
        poseThread?.terminate(); handThread?.terminate(); fallback(requestId)
      }
      return
    }
    if ((source === 'video' && onReplayFrame) || !preferWorker || !poseEnabled || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      if (preferParallel) setMessage('Hai Worker không được hỗ trợ; Lab dùng CPU trên luồng chính.')
      else if (preferWorker) setMessage(!poseEnabled ? 'Worker CPU cần Pose; Lab dùng luồng chính cho chế độ chỉ Hand.' : 'Worker không được hỗ trợ; Lab dùng CPU trên luồng chính.')
      await startMain(requestId, preferWorker || preferParallel ? false : preferGpu)
      return
    }
    try {
      const controller = new AbortController(); workerAbort.current = controller
      const thread = new Worker('/tracking-worker.js')
      const moduleUrl = new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href
      let pending: Snapshot | null = null
      const tracker = await createWorkerTracker({ worker: thread, moduleUrl, handEnabled, preferGpu, signal: controller.signal, capture: element => createImageBitmap(element),
        onResult: result => {
          const sample = pending; pending = null
          if (requestId !== generation.current) return
          if (result.handFailed && useHand) {
            // A failure is a model state change even if its frame is too old to display.
            const wasMeasuring = measuringRef.current
            if (wasMeasuring) { measurement.current.ended = performance.now(); measuringRef.current = false; setMeasuring(false); setStats({ ...measurement.current }) }
            useHand = false
            landmarks.current = { ...landmarks.current, hands: [], handTime: 0 }
            setHandEnabled(false); setDelegate('Pose CPU · Worker')
            const cleanupFailed = 'handCleanupFailed' in result && result.handCleanupFailed === true
            setMessage(cleanupFailed
              ? `Suy luận bàn tay thất bại; không xác nhận được việc giải phóng model Hand.${wasMeasuring ? ' Phép đo đã dừng.' : ''} Theo dõi tư thế vẫn hoạt động; dừng nhận diện hoặc tải lại trang để đóng Worker.`
              : wasMeasuring ? 'Suy luận bàn tay thất bại; phép đo đã dừng và theo dõi tư thế vẫn hoạt động.' : 'Suy luận bàn tay thất bại; theo dõi tư thế vẫn hoạt động.')
          }
          accept(requestId, result.timestamp, result.pose, result.handFailed ? [] : result.hands, result.inferenceMs, sample, Math.max(0, performance.now() - result.timestamp))
        },
        onError: () => fallback(requestId) })
      if (requestId !== generation.current) { tracker.close(); return }
      worker.current = tracker; setEngine('worker');
      const workerDelegates = [tracker.delegates.pose ? `Pose ${tracker.delegates.pose}` : 'Pose —', handEnabled && tracker.delegates.hand ? `Hand ${tracker.delegates.hand}` : 'Hand Tắt', 'Worker'].join(' · ')
      setDelegate(workerDelegates)
      if (tracker.initializationErrors.length) setModelErrors(previous => [...previous, ...tracker.initializationErrors])
      schedule(requestId, (timestamp, doHand, sample) => { const accepted = tracker.submit(input, timestamp, doHand); if (accepted) pending = sample; return accepted })
    } catch { fallback(requestId) }
  }
  const elapsed = Math.max(0, ((stats.ended ?? stats.snapshotAt) - stats.started) / 1000)
  const rate = (count: number) => elapsed > 0 ? count / elapsed : 0
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const live = landmarks.current, now = performance.now()
  const livePose = isFresh(live.poseTime, now), liveHand = isFresh(live.handTime, now)
  const left = livePose && upperLimbVisible(live.raw, [11, 13, 15]), right = livePose && upperLimbVisible(live.raw, [12, 14, 16])
  const trackingStatus = !running ? 'Đã dừng' : !isFresh(live.resultTime, now) ? 'Không có frame mới' : poseEnabled ?
    (!livePose || !live.raw.length ? 'Không thấy người' : left && right ? 'Chi trên trái và phải đủ mốc' : left ? 'Chi trên trái đủ mốc · phải không tin cậy' : right ? 'Chi trên phải đủ mốc · trái không tin cậy' : 'Mốc chi trên không tin cậy') :
    (liveHand && live.hands.length ? 'Có mốc bàn tay' : 'Không thấy bàn tay')
  const handStatus = !handEnabled ? 'Tắt' : !running ? 'Đã dừng' : !liveHand ? 'Không có kết quả Hand mới' : live.hands.length ? `Trái: ${isFresh(handSides.current.left, now) ? 'mới' : 'thiếu/không hợp lệ'} | Phải: ${isFresh(handSides.current.right, now) ? 'mới' : 'thiếu/không hợp lệ'}` : 'Không thấy bàn tay'
  const exportJson = () => {
    const snapshot = measuringRef.current ? measurement.current : stats
    const config = snapshot.config ?? measurementConfig()
    const seconds = Math.max(0, ((snapshot.ended ?? performance.now()) - snapshot.started) / 1000)
    const rateAtExport = (count: number) => seconds > 0 ? count / seconds : 0
    const fraction = (count: number) => config.poseEnabled && snapshot.inferences ? count / snapshot.inferences : null
    const data = { version: 1, capturedAt: new Date().toISOString(), source: config.source, profile: config.profile, engine: config.engine, delegate: config.delegate, resolution: config.resolution, inferenceResolution: config.resolution, poseEnabled: config.poseEnabled, handEnabled: config.handEnabled, mirrored: config.mirrored, smoothing: config.smoothed ? { version: SMOOTHING_VERSION, profile: config.smoothingProfile, config: SMOOTHING_PROFILES[config.smoothingProfile], visibilityPolicy: POSE_SMOOTHING_POLICY, scope: 'pose display' } : 'raw', elapsedSeconds: seconds, observedVideoFps: rateAtExport(snapshot.videoFrames), inferenceFps: rateAtExport(snapshot.inferences), renderFps: rateAtExport(snapshot.renders), inferenceMeanMs: mean(snapshot.durations), inferenceP50Ms: percentile(snapshot.durations, .5), inferenceP95Ms: percentile(snapshot.durations, .95), inferenceTimingSamples: snapshot.durations.length, workerRoundTripMeanMs: mean(snapshot.roundTrips), workerRoundTripP50Ms: percentile(snapshot.roundTrips, .5), workerRoundTripP95Ms: percentile(snapshot.roundTrips, .95), overlayP95Ms: percentile(snapshot.overlayDurations, .95), throttledFrames: snapshot.throttled, workerBusyFrames: snapshot.workerBusy, duplicateCallbacks: snapshot.duplicates, validFraction: snapshot.inferences ? snapshot.valid / snapshot.inferences : null, leftUpperLimbVisibleFraction: fraction(snapshot.leftVisible), rightUpperLimbVisibleFraction: fraction(snapshot.rightVisible), metricDefinitions: { resultAgeMs: 'Elapsed time since the video frame callback timestamp used for the latest accepted inference result, adjusted if needed for monotonicity; not camera capture time or motion-to-photon latency. Null when measurement is stopped or no result is available.', workerRoundTripMs: 'Elapsed time from the video callback timestamp used for inference to receiving the Worker result; includes image capture and transfer, not camera capture or display latency.', validFraction: 'Fraction with any model landmark output, not a confidence or accuracy measure.', upperLimbVisibleFraction: 'Fraction of Pose inference callbacks where all shoulder, elbow and wrist coordinates are finite, inside the image, and have visibility >= 0.4; not absolute accuracy.' }, resultAgeMs: measuringRef.current && landmarks.current.resultTime ? performance.now() - landmarks.current.resultTime : null, sampleLimit: 10000 }
    const summarizeStream = (value: StreamMetrics, timestamp: number) => ({ inferenceFps: rateAtExport(value.inferences), inferenceTimingSamples: value.durations.length, inferenceP50Ms: percentile(value.durations, .5), inferenceP95Ms: percentile(value.durations, .95), workerRoundTripP50Ms: percentile(value.roundTrips, .5), workerRoundTripP95Ms: percentile(value.roundTrips, .95), busyFrames: value.busyFrames, throttledFrames: value.throttledFrames, resultAgeMs: measuringRef.current && timestamp ? Math.max(0, performance.now() - timestamp) : null })
    const report = config.engine === 'parallel' ? { ...data, adaptiveWorkerBudget: snapshot.adaptiveWorkerBudget, dualPose: summarizeStream(snapshot.dualPose, landmarks.current.poseTime), dualHand: summarizeStream(snapshot.dualHand, landmarks.current.handTime), metricDefinitions: { ...data.metricDefinitions, inferenceFps: 'In parallel mode legacy inference fields describe Pose only. dualPose and dualHand report each worker separately; no p95 values are summed.', dualWorkers: 'Each worker independently snapshots the video, so their results may describe different frames. Ages and round-trip times start at the video callback, not camera capture. Each throttledFrames count includes shared scheduler throttling plus that stream’s own rate limit.', adaptiveWorkerBudget: 'Experimental FPS limits and timing estimates, not CPU utilization. Actual inference rates may be lower.' } } : config.engine === 'main' ? { ...data, pose: summarizeStream(snapshot.dualPose, landmarks.current.poseTime), hand: summarizeStream(snapshot.dualHand, landmarks.current.handTime), metricDefinitions: { ...data.metricDefinitions, inferenceFps: 'Callbacks with Pose or Hand inference; pose and hand report independent model counts and latencies.' } } : data
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const objectUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = objectUrl; link.download = 'tracking-benchmark.json'; link.click(); URL.revokeObjectURL(objectUrl)
  }
  return <section className="workspace tracking-lab">
    <div className="workspace-heading"><div><p className="workspace-eyebrow">PHÒNG THỬ NGHIỆM</p><h1>Tracking Test Lab</h1><p>Video chỉ được xử lý trong trình duyệt. Số liệu không chứng minh độ chính xác lâm sàng.</p></div><a href="/workspace">← Camera & hiệu chuẩn</a></div>
    {message && <div className="workspace-message" role="status">{message}</div>}
    {modelErrors.length > 0 && <details><summary>Lỗi khởi tạo / suy luận MediaPipe</summary>{modelErrors.map((error, index) => <p key={index}>{error}</p>)}</details>}
    <div className="workspace-grid"><div className="workspace-main"><div className="workspace-stage"><div className="workspace-image" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
      <video ref={video} onEnded={onReplayEnded} muted playsInline className={mirrored ? 'mirrored' : ''} onLoadedMetadata={() => { if (video.current?.videoWidth && video.current.videoHeight) setSize({ width: video.current.videoWidth, height: video.current.videoHeight }) }} />
      {source === 'none' && <div className="workspace-empty">Chọn video cục bộ hoặc bật camera</div>}
      <canvas ref={canvas} width={size.width} height={size.height} aria-label="Landmark overlay" />
    </div></div><div className="workspace-controls">
      <button onClick={openCamera}>Bật camera</button><button onClick={stopSource} disabled={source === 'none'}>Đóng nguồn</button>
      <button onClick={() => video.current?.paused ? video.current.play().catch(() => setMessage('Không thể phát video.')) : video.current?.pause()} disabled={source !== 'video' || replayLocked}>Phát / Tạm dừng</button>
      <button onClick={() => { if (video.current) { stopTracking(); video.current.currentTime = 0; video.current.play().catch(() => setMessage('Không thể phát lại video.')); setMessage('Đã phát lại. Khởi động nhận diện lại để reset trạng thái model.') } }} disabled={source !== 'video' || replayLocked}>Phát lại từ đầu</button>
      <button className="primary" onClick={running ? stopTracking : startTracking} disabled={source === 'none' || starting}>{starting ? 'Đang tải…' : running ? 'Dừng nhận diện' : 'Bắt đầu nhận diện'}</button>
    </div><div className="workspace-controls"><button onClick={toggleMeasurement} disabled={!running && !measuring}>{measuring ? 'Dừng đo' : 'Bắt đầu đo'}</button><button onClick={resetMeasurement}>Đặt lại benchmark</button><button onClick={exportJson}>Xuất benchmark JSON</button></div>
    <p className="workspace-hint">Đo sau khi model đã sẵn sàng và video đã chạy ổn định. FPS nguồn là số frame quan sát được; frame bị giới hạn, callback trùng và frame bỏ khi Worker bận được đếm riêng. Phần trăm vai/khuỷu/cổ tay yêu cầu cả ba mốc trong ảnh có visibility ≥0,4 và không đo độ chính xác. Thời gian suy luận là tổng thời gian các model ở chế độ nối tiếp; với hai Worker, chỉ số chung mô tả Pose, còn chỉ số riêng mô tả từng model. Số frame giới hạn riêng gồm cả giới hạn chung và giới hạn riêng của từng luồng. Thời gian Worker từ callback frame đến kết quả gồm cả tạo và chuyển ảnh. Tuổi kết quả tính từ timestamp callback video đã điều chỉnh tăng đơn điệu; không phải độ trễ từ cảm biến camera đến màn hình. Tối đa 10.000 mẫu mỗi loại.</p>
    <dl className="tracking-stats"><div><dt>FPS video quan sát</dt><dd>{fmt(rate(stats.videoFrames))}</dd></div><div><dt>FPS suy luận</dt><dd>{fmt(rate(stats.inferences))}</dd></div><div><dt>FPS render</dt><dd>{fmt(rate(stats.renders))}</dd></div><div><dt>Suy luận p50 / p95</dt><dd>{fmt(percentile(stats.durations, .5))} / {fmt(percentile(stats.durations, .95))} ms</dd></div><div><dt>Worker callback đến kết quả p50 / p95</dt><dd>{fmt(percentile(stats.roundTrips, .5))} / {fmt(percentile(stats.roundTrips, .95))} ms</dd></div><div><dt>Overlay p95</dt><dd>{fmt(percentile(stats.overlayDurations, .95))} ms</dd></div><div><dt>Frame giới hạn / Worker bận / callback trùng</dt><dd>{stats.throttled} / {stats.workerBusy} / {stats.duplicates}</dd></div><div><dt>Mẫu có đầu ra model</dt><dd>{stats.inferences ? `${(stats.valid * 100 / stats.inferences).toFixed(1)}%` : '—'}</dd></div><div><dt>Vai / khuỷu / cổ tay trái ≥0,4</dt><dd>{stats.config?.poseEnabled && stats.inferences ? `${(stats.leftVisible * 100 / stats.inferences).toFixed(1)}%` : '—'}</dd></div><div><dt>Vai / khuỷu / cổ tay phải ≥0,4</dt><dd>{stats.config?.poseEnabled && stats.inferences ? `${(stats.rightVisible * 100 / stats.inferences).toFixed(1)}%` : '—'}</dd></div><div><dt>Cấu hình phép đo</dt><dd>{stats.config ? `${stats.config.engine} · ${stats.config.delegate} · ${stats.config.profile}` : 'Chưa đo'}</dd></div><div><dt>Trạng thái tracking</dt><dd>{trackingStatus}</dd></div><div><dt>Trạng thái Hand</dt><dd>{handStatus}</dd></div><div><dt>Tuổi kết quả từ callback video</dt><dd>{running && landmarks.current.resultTime ? `${(performance.now() - landmarks.current.resultTime).toFixed(0)} ms` : '—'}</dd></div><div><dt>Delegate / model</dt><dd>{delegate} / {model}</dd></div><div><dt>Độ phân giải video / suy luận</dt><dd>{size.width} × {size.height} / {size.width} × {size.height}</dd></div>{stats.config && stats.config.engine !== 'worker' && <><div><dt>FPS Pose / Hand riêng</dt><dd>{fmt(rate(stats.dualPose.inferences))} / {fmt(rate(stats.dualHand.inferences))}</dd></div><div><dt>Pose p50 / p95</dt><dd>{fmt(percentile(stats.dualPose.durations, .5))} / {fmt(percentile(stats.dualPose.durations, .95))} ms</dd></div><div><dt>Hand p50 / p95</dt><dd>{fmt(percentile(stats.dualHand.durations, .5))} / {fmt(percentile(stats.dualHand.durations, .95))} ms</dd></div><div><dt>Callback đến kết quả Pose p95 / Hand p95</dt><dd>{fmt(percentile(stats.dualPose.roundTrips, .95))} / {fmt(percentile(stats.dualHand.roundTrips, .95))} ms</dd></div><div><dt>Worker bận Pose / Hand</dt><dd>{stats.dualPose.busyFrames} / {stats.dualHand.busyFrames}</dd></div><div><dt>Tuổi Pose / Hand từ callback</dt><dd>{running && live.poseTime ? `${Math.max(0, now-live.poseTime).toFixed(0)} ms` : '—'} / {running && live.handTime ? `${Math.max(0, now-live.handTime).toFixed(0)} ms` : '—'}</dd></div></>}</dl>{adaptiveBudget.current && <p>Ngân sách Worker hiện tại: Pose tối đa {adaptiveBudget.current.snapshot().poseFps.toFixed(1)} FPS · Hand {adaptiveBudget.current.snapshot().handAvailable ? `tối đa ${adaptiveBudget.current.snapshot().handFps.toFixed(1)} FPS` : 'không khả dụng'} · {adaptiveBudget.current.snapshot().phase === 'normal' ? 'bình thường' : 'đã giảm'}. Đây là giới hạn, không phải FPS thực hay mức dùng CPU.</p>}</div>
    <aside className="workspace-panel"><h2>Nguồn và cấu hình</h2><label>Chọn video MP4<input type="file" accept="video/mp4,video/*" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; openFile(file) }} /></label><label>Cấu hình hiệu năng<select value={profileName} disabled={running || starting} onChange={event => changeProfile(event.target.value as TrackingProfileName)}>{Object.entries(TRACKING_PROFILES).map(([name, profile]) => <option key={name} value={name}>{profile.label}</option>)}</select></label><label className="check"><input type="checkbox" disabled={running || starting} checked={preferWorker} onChange={event => { setPreferWorker(event.target.checked); if (event.target.checked) { setPreferGpu(false); setPreferParallel(false) } }} />Worker CPU (thử nghiệm)</label><label className="check"><input type="checkbox" disabled={running || starting || !poseEnabled || !handEnabled} checked={preferParallel} onChange={event => { setPreferParallel(event.target.checked); if (event.target.checked) { setPreferWorker(false); setPreferGpu(false) } }} />Hai Worker CPU (thử nghiệm)</label><label className="check"><input type="checkbox" disabled={running || starting || !preferParallel} checked={preferAdaptive && preferParallel} onChange={event => setPreferAdaptive(event.target.checked)} />Tự điều chỉnh nhịp Worker</label><p>Thử nghiệm: bắt đầu tối đa Pose 30 và Hand 20 FPS, rồi điều chỉnh theo độ trễ giao diện và thời gian Worker; không đo được tổng CPU máy.</p><label className="check"><input type="checkbox" disabled={running || starting || preferWorker || preferParallel} checked={preferGpu} onChange={event => setPreferGpu(event.target.checked)} />Thử GPU (fallback CPU)</label><label className="check"><input type="checkbox" disabled={running || starting} checked={poseEnabled} onChange={event => { setPoseEnabled(event.target.checked); if (!event.target.checked) setPreferParallel(false) }} />Pose</label><label className="check"><input type="checkbox" disabled={running || starting} checked={handEnabled} onChange={event => { setHandEnabled(event.target.checked); if (!event.target.checked) setPreferParallel(false) }} />Hand (21 mốc)</label><label>Cấu hình làm mượt<select value={smoothingProfile} disabled={measuring} onChange={event => changeSmoothingProfile(event.target.value as SmoothingProfileName)}><option value="standard">Tiêu chuẩn</option><option value="responsive">Đáp ứng nhanh (thử nghiệm)</option></select></label><p>Đáp ứng nhanh bám đầu ra thô hơn và có thể thấy rung nhiều hơn; chỉ dùng để so sánh hiển thị.</p><label className="check"><input type="checkbox" disabled={measuring} checked={smoothed} onChange={event => setSmoothed(event.target.checked)} />Smoothed (tắt để xem Raw)</label><label className="check"><input type="checkbox" disabled={measuring} checked={mirrored} onChange={event => setMirrored(event.target.checked)} />Lật ảnh ngang</label><p>Raw là đầu ra MediaPipe. Bộ lọc chỉ áp dụng cho hiển thị pose; bàn tay hiển thị raw để tránh ghép nhầm danh tính. Worker CPU yêu cầu Pose; chế độ chỉ Hand dùng luồng chính. Hai Worker có thể xử lý những frame khác nhau.</p></aside></div>
  </section>
}

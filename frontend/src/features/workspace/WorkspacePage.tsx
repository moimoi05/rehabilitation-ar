import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { api } from '../../services/api'
import type { Session } from '../../types'
import { demoPose, drawLandmarks, initialGhost, prepareOverlay } from './drawing'
import type { Ghost, Point } from './drawing'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { useFlowerGame } from './useFlowerGame'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import { LandmarkSmoother, POSE_SMOOTHING_POLICY } from './landmarkSmoothing'
import { getTrackingProfile, resolveCameraResolution } from './trackingProfiles'
import type { TrackingProfileName } from './trackingProfiles'
import { createWorkerTracker } from './workerTracker'
import type { WorkerHandResult, WorkerPoseResult, WorkerTracker } from './workerTracker'
import { captureInferenceBitmap } from './inferenceResolution'
import { createParallelWorkerTracker } from './parallelWorkerTracker'
import type { ParallelWorkerTracker } from './parallelWorkerTracker'
import { AdaptiveWorkerBudget, AUTO_WORKER_MAX_FPS } from './adaptiveWorkerBudget'
import { useVideoMapping } from './useVideoMapping'
import { resolveWorkerPreference } from './trackingEnginePreference'
import { initializePose, initializeHand, modelErrorMessage } from './mediaPipeModels'
import { handFreshness } from './handObservation'
import { createRTMPoseEngine, waitForRTMPoseDrain } from './rtmposeEngine'
import { usableTrackingPoint } from './trackingLandmark'
import { useResearchCapture } from './useResearchCapture'
import { CaptureNavigationGuard } from './CaptureNavigationGuard'
import { CaptureArtifactStatus } from './CaptureArtifactStatus'
import { landmarkRows } from './captureLandmarks'
import type { WorkspaceWorkflow } from './gameWorkflow'
import './workspace.css'

type TrackingModel = 'mediapipe' | 'rtmpose'
type CameraSettings = { mirrored: boolean; resolution: string; cameraId?: string; tvMode?: boolean; trackingProfile?: TrackingProfileName; profileCameraResolution: boolean; workerTracking: boolean; trackingModel?: TrackingModel; poseTrackingModel?: TrackingModel; handTrackingModel?: TrackingModel }
type Calibration = Ghost & { id: number; session_id: number; camera_label: string | null; camera_device_id: string | null; width: number | null; height: number | null; mirrored: boolean; created_at: string; image_anchor?: unknown }
const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
const maxLandmarkAgeMs = 700
// A request can outlive this component. Keep the lock for the lifetime of the
// request so navigating away and back cannot start a competing calibration POST.
let calibrationSavePending = false
const calibrationSaveListeners = new Set<() => void>()
const subscribeCalibrationSave = (listener: () => void) => { calibrationSaveListeners.add(listener); return () => { calibrationSaveListeners.delete(listener) } }
const getCalibrationSavePending = () => calibrationSavePending
const setCalibrationSavePending = (pending: boolean) => { calibrationSavePending = pending; calibrationSaveListeners.forEach(listener => listener()) }
const actualDimension = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const upperLimbVisible = (pose: Point[], side: 'left' | 'right') => (side === 'left' ? [11, 13, 15] : [12, 14, 16]).every(index => usableTrackingPoint(pose[index]))
const loadSettings = (): CameraSettings => {
  try { const saved = JSON.parse(localStorage.getItem('rehab.settings') || '{}'); return { mirrored: true, resolution: '1280x720', ...saved, trackingModel: saved.trackingModel === 'rtmpose' ? 'rtmpose' : 'mediapipe', poseTrackingModel: saved.poseTrackingModel === 'rtmpose' ? 'rtmpose' : 'mediapipe', handTrackingModel: saved.handTrackingModel === 'rtmpose' ? 'rtmpose' : 'mediapipe', profileCameraResolution: saved.profileCameraResolution === true, workerTracking: resolveWorkerPreference(saved.workerTracking, localStorage.getItem('rehab.workerTracking')) } }
  catch { return { mirrored: true, resolution: '1280x720', profileCameraResolution: false, workerTracking: true } }
}

async function calibrationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } })
  if (!response.ok) throw new Error(`Không thể kết nối hoặc lưu hiệu chuẩn (HTTP ${response.status}).`)
  return response.json() as Promise<T>
}

export interface WorkspacePageProps { session?: Session; workflow?: WorkspaceWorkflow }
export default function WorkspacePage({ session: controlledSession, workflow }: WorkspacePageProps = {}) {
  const initialSession = new URLSearchParams(window.location.search)
  const [legacySessionId, setSessionId] = useState(initialSession.get('sessionId') || initialSession.get('session') || '')
  const sessionId = controlledSession ? String(controlledSession.id) : legacySessionId
  const [sessions, setSessions] = useState<Session[]>([])
  const selectedSession = controlledSession || sessions.find(item => String(item.id) === sessionId)
  const workflowRef = useRef(workflow)
  workflowRef.current = workflow
  const savedSetup = useRef(false)
  const invalidateWorkflow = useCallback(() => { savedSetup.current = false; workflowRef.current?.onSetupInvalidated() }, [])
  const [captureTrial, setCaptureTrial] = useState('')
  const [saveLandmarks, setSaveLandmarks] = useState(true)
  const [saveVideo, setSaveVideo] = useState(false)
  const [landmarkConsent, setLandmarkConsent] = useState(false)
  const [videoConsent, setVideoConsent] = useState(false)
  const capture = useResearchCapture()
  const { abort: abortCapture } = capture
  const [sessionsError, setSessionsError] = useState('')
  const [settings, setSettings] = useState(loadSettings)
  const [ghost, setGhost] = useState<Ghost>(initialGhost)
  const ghostRef = useRef(ghost)
  ghostRef.current = ghost
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [streamActive, setStreamActive] = useState(false)
  const [cameraOpening, setCameraOpening] = useState(false)
  const [actualCameraSize, setActualCameraSize] = useState<{ width: number; height: number } | null>(null)
  const [demo, setDemo] = useState(false)
  const [handEnabled, setHandEnabled] = useState(true)
  // RTMPose is selectable during camera setup only. Clinical games stay on MediaPipe.
  const selectedPoseModel: TrackingModel = workflow ? (workflow.view === 'setup' ? settings.poseTrackingModel || 'mediapipe' : 'mediapipe') : settings.trackingModel || 'mediapipe'
  const selectedHandModel: TrackingModel = workflow ? (workflow.view === 'setup' ? settings.handTrackingModel || 'mediapipe' : 'mediapipe') : settings.trackingModel || 'mediapipe'
  const selectedTrackingModel: TrackingModel | 'mixed' = !handEnabled || selectedPoseModel === selectedHandModel ? selectedPoseModel : 'mixed'
  const [roi, setRoi] = useState({ x: 0, y: 0, width: 1, height: 1 })
  const [roiConfirmed, setRoiConfirmed] = useState(false)
  const [personDetection, setPersonDetection] = useState(false)
  const [preferParallel, setPreferParallel] = useState(false)
  const [adaptiveParallel, setAdaptiveParallel] = useState(true)
  const [budgetStatus, setBudgetStatus] = useState<ReturnType<AdaptiveWorkerBudget['snapshot']> | null>(null)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showRaw, setShowRaw] = useState(false)
  const [tracking, setTracking] = useState(false)
  const [modelDelegates, setModelDelegates] = useState({ pose: '—', hand: 'Tắt' })
  const [modelErrors, setModelErrors] = useState<string[]>([])
  const [activeEngine, setActiveEngine] = useState<'main' | 'worker' | 'parallel' | 'rtmpose' | 'mixed' | null>(null)
  const [parallelHandAvailable, setParallelHandAvailable] = useState(false)
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState('Chưa khởi động nhận diện')
  const [fps, setFps] = useState(0)
  const [message, setMessage] = useState('')
  const saving = useSyncExternalStore(subscribeCalibrationSave, getCalibrationSavePending, () => false)
  const [size, setSize] = useState({ width: 1280, height: 720 })
  const [fullscreen, setFullscreen] = useState(false)
  const requestedCameraSize = resolveCameraResolution(settings.trackingProfile, settings.profileCameraResolution, settings.resolution)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoMapping, displayBox] = useVideoMapping(videoRef)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const generation = useRef(0)
  const requestedTrackingEngine = useRef<TrackingModel | 'mixed' | null>(null)
  const startingRef = useRef(false)
  const cameraGeneration = useRef(0)
  const restoreGeneration = useRef(0)
  const saveGeneration = useRef(0)
  const stopFrameScheduler = useRef<(() => void) | null>(null)
  const watchdog = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopBudgetObserver = useRef<(() => void) | null>(null)
  const poseRef = useRef<PoseLandmarker | null>(null)
  const handRef = useRef<HandLandmarker | null>(null)
  const workerRef = useRef<WorkerTracker | null>(null)
  const parallelWorkerRef = useRef<ParallelWorkerTracker | null>(null)
  const workerAbort = useRef<AbortController | null>(null)
  const rtmposeRef = useRef<Awaited<ReturnType<typeof createRTMPoseEngine>> | null>(null)
  const points = useRef<{ pose: Point[]; hands: Point[][] }>({ pose: [], hands: [] })
  const displayPoints = useRef<{ pose: Point[]; hands: Point[][] }>({ pose: [], hands: [] })
  const smoother = useRef(new LandmarkSmoother())
  const poseTime = useRef(0)
  const handTime = useRef(0)
  const handSides = useRef({ left: 0, right: 0 })
  const affectedSide = useRef(ghost.affected_side)
  affectedSide.current = ghost.affected_side
  const game = useFlowerGame({ demo, streamActive, tracking, mirrored: settings.mirrored, side: ghost.affected_side, confirmed: ghost.confirmed, session: selectedSession, size, pose: points, poseTime, mapping: videoMapping, displayBox, workflow: workflow?.game })

  const controlledSessionId = controlledSession?.id
  useEffect(() => { if (controlledSessionId) return; let live = true; api.sessions().then(data => { if (live) setSessions(data) }).catch(() => { if (live) setSessionsError('Không tải được danh sách phiên. Kiểm tra backend và cơ sở dữ liệu.') }); return () => { live = false } }, [controlledSessionId])
  const selectedId = selectedSession?.id, selectedSide = selectedSession?.affected_side
  useEffect(() => { if (selectedId && selectedSide) { savedSetup.current = false; setGhost(previous => ({ ...previous, affected_side: selectedSide, confirmed: false })) } }, [selectedId, selectedSide])
  useEffect(() => { if (savedSetup.current && (!ghost.confirmed || !streamActive)) invalidateWorkflow() }, [ghost.confirmed, streamActive, invalidateWorkflow])
  useEffect(() => { localStorage.setItem('rehab.settings', JSON.stringify(settings)) }, [settings])
  useEffect(() => {
    const listener = () => setFullscreen(document.fullscreenElement === workspaceRef.current)
    document.addEventListener('fullscreenchange', listener)
    return () => document.removeEventListener('fullscreenchange', listener)
  }, [])

  const stopTracking = useCallback(() => {
    abortCapture()
    rtmposeRef.current?.close(); rtmposeRef.current = null
    generation.current += 1
    requestedTrackingEngine.current = null
    startingRef.current = false; setStarting(false)
    stopFrameScheduler.current?.(); stopFrameScheduler.current = null
    if (watchdog.current !== null) clearInterval(watchdog.current); watchdog.current = null
    stopBudgetObserver.current?.(); stopBudgetObserver.current = null; setBudgetStatus(null)
    const oldWorker = workerRef.current
    workerRef.current = null
    oldWorker?.dispose().catch(() => {})
    parallelWorkerRef.current?.close(); parallelWorkerRef.current = null; workerAbort.current?.abort(); workerAbort.current = null
    poseRef.current?.close(); handRef.current?.close()
    poseRef.current = null; handRef.current = null
    points.current = { pose: [], hands: [] }; displayPoints.current = { pose: [], hands: [] }; smoother.current.reset(); poseTime.current = 0; handTime.current = 0; handSides.current = { left: 0, right: 0 }; setTracking(false); setActiveEngine(null); setModelDelegates({ pose: '—', hand: 'Tắt' }); setParallelHandAvailable(false); setFps(0); setStatus('Đã dừng nhận diện')
  }, [abortCapture])

  const stopCamera = useCallback(() => {
    cameraGeneration.current += 1
    stopTracking()
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setStreamActive(false); setCameraOpening(false); setActualCameraSize(null)
    setGhost(previous => ({ ...previous, confirmed: false }))
  }, [stopTracking])
  useEffect(() => () => { cameraGeneration.current += 1; generation.current += 1; restoreGeneration.current += 1; saveGeneration.current += 1; stopFrameScheduler.current?.(); if (watchdog.current !== null) clearInterval(watchdog.current); stopBudgetObserver.current?.(); workerRef.current?.close(); parallelWorkerRef.current?.close(); workerAbort.current?.abort(); rtmposeRef.current?.close(); poseRef.current?.close(); handRef.current?.close(); streamRef.current?.getTracks().forEach(track => track.stop()) }, [])

  const startCamera = async () => {
    stopCamera(); setRoiConfirmed(false); setDemo(false); setMessage('')
    if (!navigator.mediaDevices?.getUserMedia) { setMessage('Trình duyệt không hỗ trợ camera hoặc trang không ở localhost/HTTPS.'); return }
    const requestId = ++cameraGeneration.current
    const { width, height } = requestedCameraSize
    setCameraOpening(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(settings.cameraId ? { deviceId: { exact: settings.cameraId } } : {}), width: { ideal: width }, height: { ideal: height } }, audio: false })
      if (requestId !== cameraGeneration.current) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('Camera has no video track')
      const trackEnded = () => track.readyState === 'ended'
      const disconnected = () => { if (streamRef.current === stream) { stopCamera(); setMessage('Camera đã ngắt kết nối. Hãy kết nối lại và bật camera.') } }
      track.addEventListener('ended', disconnected, { once: true })
      if (trackEnded()) { disconnected(); return }
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }
      if (requestId !== cameraGeneration.current) { stream.getTracks().forEach(track => track.stop()); return }
      if (trackEnded()) { disconnected(); return }
      const actual = track.getSettings()
      const actualSize = actual.width && actual.height && Number.isFinite(actual.width) && Number.isFinite(actual.height) && actual.width > 0 && actual.height > 0 ? { width: actual.width, height: actual.height } : null
      setActualCameraSize(actualSize); setSize(actualSize || { width, height }); setStreamActive(true); setCameraOpening(false)
      try { const list = await navigator.mediaDevices.enumerateDevices(); if (requestId === cameraGeneration.current) setDevices(list.filter(item => item.kind === 'videoinput')) }
      catch { if (requestId === cameraGeneration.current) setMessage('Camera đang bật nhưng không thể liệt kê thiết bị khác.') }
    } catch (error) {
      if (requestId !== cameraGeneration.current) return
      stopCamera()
      const name = error instanceof DOMException ? error.name : ''
      setMessage(name === 'NotAllowedError' ? 'Quyền camera bị từ chối. Hãy cho phép camera trong cài đặt trình duyệt rồi thử lại.' : 'Không mở được camera. Kiểm tra thiết bị, quyền truy cập và ứng dụng khác đang sử dụng camera.')
    } finally { if (requestId === cameraGeneration.current) setCameraOpening(false) }
  }

  const startTracking = async () => {
    if (!streamActive || !videoRef.current || startingRef.current) return
    stopTracking(); requestedTrackingEngine.current = selectedTrackingModel; const requestId = ++generation.current; setStatus(selectedTrackingModel === 'mixed' ? 'Đang tải MediaPipe + RTMPose…' : selectedTrackingModel === 'rtmpose' ? 'Đang tải RTMPose GPU…' : 'Đang tải MediaPipe…'); setMessage(''); setModelErrors([])
    startingRef.current = true; setStarting(true)
    const video = videoRef.current
    const profile = getTrackingProfile(settings.trackingProfile)
    let handActive = handEnabled
    let lastUpdate = performance.now(), lastFrame = lastUpdate, lastHand = -Infinity, nextPose = -Infinity, count = 0, stalled = false, sourceEpoch = 0, hasResult = false
    let lastPoseTimestamp = -Infinity, lastHandTimestamp = -Infinity
    let publishedStatus = 'Đang chờ hình từ camera'
    const publishStatus = (next: string) => { if (next !== publishedStatus) { publishedStatus = next; setStatus(next) } }
    const clearResults = () => { points.current = { pose: [], hands: [] }; displayPoints.current = { pose: [], hands: [] }; poseTime.current = 0; handTime.current = 0; handSides.current = { left: 0, right: 0 }; smoother.current.reset(); lastHand = -Infinity; nextPose = -Infinity; lastPoseTimestamp = -Infinity; lastHandTimestamp = -Infinity; hasResult = false }
    const currentStatus = (now: number) => {
      const side = affectedSide.current, sideLabel = side === 'left' ? 'trái' : 'phải'
      const poseFresh = poseTime.current > 0 && now >= poseTime.current && now - poseTime.current <= maxLandmarkAgeMs
      const leftFresh = handSides.current.left > 0 && now - handSides.current.left <= maxLandmarkAgeMs
      const rightFresh = handSides.current.right > 0 && now - handSides.current.right <= maxLandmarkAgeMs
      const handFresh = handTime.current > 0 && now >= handTime.current && now - handTime.current <= maxLandmarkAgeMs && points.current.hands.length > 0
      const poseStatus = !poseFresh ? 'Không có mốc tư thế mới' : upperLimbVisible(points.current.pose, side) ? `Đang theo dõi chi trên ${sideLabel}` : `Mốc vai, khuỷu hoặc cổ tay ${sideLabel} chưa đáng tin cậy`
      return handActive ? `${poseStatus} · ${handFresh ? `Hand trái: ${leftFresh ? 'mới' : 'thiếu/không hợp lệ'} | phải: ${rightFresh ? 'mới' : 'thiếu/không hợp lệ'}` : 'chưa thấy bàn tay'}` : poseStatus
    }
    const acceptable = (timestamp: number, lastTimestamp: number) => requestId === generation.current && Number.isFinite(timestamp) && timestamp >= sourceEpoch && timestamp > lastTimestamp && performance.now() - timestamp <= maxLandmarkAgeMs
    const acceptPose = (rawPose: Point[], timestamp: number) => {
      if (!acceptable(timestamp, lastPoseTimestamp)) return
      lastPoseTimestamp = timestamp
      const now = performance.now(); lastFrame = now; stalled = false; hasResult = true
      points.current = { ...points.current, pose: rawPose }
      displayPoints.current = { ...displayPoints.current, pose: selectedPoseModel === 'rtmpose' ? rawPose : smoother.current.filter('pose', rawPose, timestamp, POSE_SMOOTHING_POLICY) }
      poseTime.current = rawPose.length ? timestamp : 0
      count++
      if (now - lastUpdate >= 1000) {
        setFps(Math.round(count * 1000 / (now - lastUpdate))); count = 0; lastUpdate = now
        publishStatus(currentStatus(now))
      }
    }
    const acceptHand = (hands: Point[][], timestamp: number) => {
      if (!handActive || !acceptable(timestamp, lastHandTimestamp)) return
      lastHandTimestamp = timestamp; handTime.current = hands.length ? timestamp : 0
      points.current = { ...points.current, hands }; displayPoints.current = { ...displayPoints.current, hands }
      publishStatus(currentStatus(performance.now()))
    }
    const accept = (rawPose: Point[], hands: Point[][] | null, timestamp: number) => {
      acceptPose(rawPose, timestamp)
      if (hands !== null) acceptHand(hands, timestamp)
    }
    const schedule = (engine: 'main' | 'worker' | 'parallel' | 'rtmpose' | 'mixed', infer: (timestamp: number, doHand: boolean, now: number, mediaTime: number, sourceFrameId?: number | null, skippedSourceFrames?: number) => boolean, budget?: AdaptiveWorkerBudget) => {
      if (requestId !== generation.current) return
      lastFrame = performance.now(); startingRef.current = false; setStarting(false); setTracking(true); setActiveEngine(engine); publishedStatus = 'Đang chờ hình từ camera'; setStatus(publishedStatus)
      let expectedTick = performance.now() + 250, lastBudgetPublish = 0
      if (budget) {
        budget.reset(performance.now()); setBudgetStatus(budget.snapshot())
        const resetBudget = () => {
          expectedTick = performance.now() + 250
          sourceEpoch = performance.now(); clearResults(); budget.reset(sourceEpoch); setBudgetStatus(budget.snapshot())
        }
        const onVisibility = () => { if (document.visibilityState === 'visible') resetBudget(); else expectedTick = performance.now() + 250 }
        document.addEventListener('visibilitychange', onVisibility)
        video.addEventListener('pause', resetBudget); video.addEventListener('playing', resetBudget)
        stopBudgetObserver.current = () => { document.removeEventListener('visibilitychange', onVisibility); video.removeEventListener('pause', resetBudget); video.removeEventListener('playing', resetBudget) }
      }
      stopFrameScheduler.current = startVideoFrameScheduler(video, ({ now, inferenceTimestamp, mediaTime, sourceFrameId, skippedSourceFrames }) => {
        if (requestId !== generation.current) return
        const doHand = handActive && (budget ? document.visibilityState === 'visible' : now >= lastHand)
        if (budget && document.visibilityState !== 'visible') return
        if (infer(inferenceTimestamp, doHand, now, mediaTime, sourceFrameId, skippedSourceFrames) && doHand && !budget) lastHand = now + 1000 / profile.handFps - (Number.isFinite(lastHand) ? (now - lastHand) % (1000 / profile.handFps) : 0)
      }, { maxFps: budget || engine === 'main' ? 120 : profile.poseFps, onSkippedFrame: frame => { if (engine === 'main' && capture.isActive()) capture.addFrame({ timestamp: frame.now, source_frame_id: frame.sourceFrameId, video_media_time_ms: frame.mediaTime * 1000, inference_performed: false, pose_detected: null, hand_detected: null, inference_ms: null, skipped_frames: frame.skippedSourceFrames, landmarks: [] }) }, onReset: () => { capture.abort(); sourceEpoch = performance.now(); clearResults(); budget?.reset(sourceEpoch); if (budget) setBudgetStatus(budget.snapshot()) } })
      watchdog.current = setInterval(() => {
        const now = performance.now()
        if (budget && document.visibilityState === 'visible' && streamRef.current && !video.paused && !video.seeking && video.readyState >= 2) {
          budget.recordUiDelay(now, Math.max(0, now - expectedTick))
          if (now - lastBudgetPublish >= 1000) { setBudgetStatus(budget.snapshot()); lastBudgetPublish = now }
        }
        expectedTick = now + 250
        if (!stalled && now - lastFrame > 2500) {
          stalled = true; setFps(0); publishStatus('Camera không cung cấp kết quả mới'); clearResults()
        } else if (!stalled && (hasResult || now - lastFrame > maxLandmarkAgeMs)) publishStatus(currentStatus(now))
      }, 250)
    }
    const startMainThread = async () => {
      startingRef.current = true; setStarting(true); setTracking(false); setActiveEngine(null)
      stopFrameScheduler.current?.(); stopFrameScheduler.current = null
      if (watchdog.current !== null) clearInterval(watchdog.current); watchdog.current = null
      stopBudgetObserver.current?.(); stopBudgetObserver.current = null; setBudgetStatus(null)
      const oldWorker = workerRef.current
    workerRef.current = null
    oldWorker?.dispose().catch(() => {})
    parallelWorkerRef.current?.close(); parallelWorkerRef.current = null; workerAbort.current?.abort(); workerAbort.current = null
      clearResults()
      try {
        const { FilesetResolver } = await import('@mediapipe/tasks-vision')
        const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
        const createdPose = await initializePose(files)
        const pose = createdPose.model
        if (requestId !== generation.current) { pose.close(); return }
        poseRef.current = pose
        setModelDelegates({ pose: createdPose.delegate, hand: handActive ? 'Đang tải' : 'Tắt' })
        if (createdPose.gpuError) setModelErrors(previous => [...previous, `Pose GPU: ${createdPose.gpuError}`])
        if (handActive) {
          try {
            const createdHand = await initializeHand(files)
            const hand = createdHand.model
            if (requestId !== generation.current) { hand.close(); return }
            handRef.current = hand
            setModelDelegates(previous => ({ ...previous, hand: createdHand.delegate }))
            if (createdHand.gpuError) setModelErrors(previous => [...previous, `Hand GPU: ${createdHand.gpuError}`])
          } catch (error) { if (requestId === generation.current) { handActive = false; setModelDelegates(previous => ({ ...previous, hand: 'Lỗi' })); setModelErrors(previous => [...previous, modelErrorMessage(error)]); setMessage('Không tải được mô hình bàn tay; theo dõi tư thế vẫn hoạt động.') } }
        }
        schedule('main', (timestamp, doHand, _now, mediaTime, sourceFrameId, skippedSourceFrames) => {
          try {
            const started = performance.now()
            const doPose = _now >= nextPose
            if (!doPose && !doHand) return true
            const poseResult = doPose ? pose.detectForVideo(video, timestamp) : null
            if (doPose) nextPose = _now + 1000 / profile.poseFps - (Number.isFinite(nextPose) ? (_now - nextPose) % (1000 / profile.poseFps) : 0)
            const raw = poseResult?.landmarks[0] || []
            let handResult: ReturnType<HandLandmarker['detectForVideo']> | null = null
            let hands: Point[][] | null = null
            if (doHand && handRef.current) {
              try { handResult = handRef.current.detectForVideo(video, timestamp); hands = handResult.landmarks; handSides.current = handFreshness(hands, handResult.handedness, timestamp) }
              catch (error) {
                setModelDelegates(previous => ({ ...previous, hand: 'Lỗi' })); setModelErrors(previous => [...previous, `Hand inference: ${modelErrorMessage(error)}`])
                // The capture configuration no longer describes what is being collected.
                // Preserve the staged data and stop rather than silently completing it.
                if (capture.isActive()) capture.abort()
                const failedHand = handRef.current; handRef.current = null; handActive = false
                handTime.current = 0
                points.current = { ...points.current, hands: [] }; displayPoints.current = { ...displayPoints.current, hands: [] }
                let closeFailed = false
                try { failedHand.close() } catch { closeFailed = true }
                hands = []
                setMessage(closeFailed
                  ? 'Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Không thể giải phóng model bàn tay; hãy tải lại trang trước khi thử lại.'
                  : 'Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Dừng và khởi động lại nhận diện để thử lại bàn tay.')
              }
            }
            if (poseResult) acceptPose(raw, timestamp)
            if (hands !== null) acceptHand(hands, timestamp)
            if (capture.isActive()) {
              const rows = [
                ...landmarkRows(raw, 'pose', 'normalized_image'),
                ...landmarkRows(poseResult?.worldLandmarks[0] || [], 'pose', 'world'),
                ...landmarkRows(poseResult ? displayPoints.current.pose as typeof raw : [], 'pose', 'normalized_image', 'display'),
                ...(handResult?.landmarks.flatMap((hand, index) => landmarkRows(hand, 'hand', 'normalized_image', 'raw', handResult?.handedness[index])) || []),
                ...(handResult?.worldLandmarks.flatMap((hand, index) => landmarkRows(hand, 'hand', 'world', 'raw', handResult?.handedness[index])) || []),
              ]
              capture.addFrame({ timestamp: _now, source_frame_id: sourceFrameId ?? null, video_media_time_ms: mediaTime * 1000, inference_performed: true, pose_detected: poseResult ? raw.length > 0 : null, hand_detected: handResult ? handResult.landmarks.length > 0 : null, inference_ms: performance.now() - started, skipped_frames: skippedSourceFrames ?? 0, landmarks: rows })
            }
            return true
          } catch (error) { stopTracking(); setModelErrors(previous => [...previous, modelErrorMessage(error)]); setMessage('Nhận diện bị lỗi. Có thể tiếp tục hiệu chuẩn thủ công; thử khởi động lại nhận diện.'); return false }
        })
      } catch (error) {
        if (requestId !== generation.current) return
        stopTracking(); setModelErrors(previous => [...previous, modelErrorMessage(error)]); setStatus('MediaPipe chưa sẵn sàng'); setMessage('Không tải được MediaPipe hoặc model cục bộ. Hiệu chuẩn thủ công vẫn sử dụng được.')
      }
    }
    try { await waitForRTMPoseDrain() } catch (error) { if (requestId === generation.current) { stopTracking(); setModelErrors([String(error)]); setMessage('Chưa xác nhận được engine GPU cũ đã dừng. Hãy chờ dịch vụ RTMPose rồi thử lại.') }; return }
    if (requestId !== generation.current) return
    if (selectedTrackingModel === 'mixed') {
      const needsMediaPipePose = selectedPoseModel === 'mediapipe'
      const needsMediaPipeHand = handActive && selectedHandModel === 'mediapipe'
      const needsRtmpose = selectedPoseModel === 'rtmpose' || (handActive && selectedHandModel === 'rtmpose')
      let mixedPose: PoseLandmarker | null = null
      let mixedHand: HandLandmarker | null = null
      let mixedRtmpose: Awaited<ReturnType<typeof createRTMPoseEngine>> | null = null
      let waitingForRtmpose = false
      let nextEngine: 'mediapipe' | 'rtmpose' = 'rtmpose'
      const controller = new AbortController()
      workerAbort.current = controller
      const fail = (error: Error) => {
        if (requestId !== generation.current) return
        stopTracking(); setRoiConfirmed(false); setModelErrors([error.message]); setMessage(`Tracking nối tiếp bị lỗi: ${error.message}`)
      }
      if (needsRtmpose && !personDetection && !roiConfirmed) { fail(new Error('Cần xác nhận ROI chứa toàn bộ người tập trước khi chạy RTMPose.')); return }
      try {
        const { FilesetResolver } = await import('@mediapipe/tasks-vision')
        const files = needsMediaPipePose || needsMediaPipeHand ? await FilesetResolver.forVisionTasks('/mediapipe/wasm') : null
        if (files && needsMediaPipePose) {
          const createdPose = await initializePose(files)
          if (requestId !== generation.current) { createdPose.model.close(); return }
          mixedPose = createdPose.model; poseRef.current = mixedPose
          setModelDelegates(previous => ({ ...previous, pose: createdPose.delegate }))
          if (createdPose.gpuError) setModelErrors(previous => [...previous, `Pose GPU: ${createdPose.gpuError}`])
        }
        if (files && needsMediaPipeHand) {
          const createdHand = await initializeHand(files)
          if (requestId !== generation.current) { createdHand.model.close(); return }
          mixedHand = createdHand.model; handRef.current = mixedHand
          setModelDelegates(previous => ({ ...previous, hand: createdHand.delegate }))
          if (createdHand.gpuError) setModelErrors(previous => [...previous, `Hand GPU: ${createdHand.gpuError}`])
        }
        mixedRtmpose = await createRTMPoseEngine({ roi, personDetection, signal: controller.signal, onError: fail, onResult: result => {
          if (requestId !== generation.current) return
          if (!result.roiValid) { fail(new Error('ROI không còn hợp lệ hoặc mất mốc vai. Kiểm tra người tập trong vùng và xác nhận lại ROI.')); return }
          if (selectedPoseModel === 'rtmpose') acceptPose(result.pose, result.timestamp)
          if (handActive && selectedHandModel === 'rtmpose') {
            handSides.current = result.hands.reduce((sides, hand, index) => {
              const complete = hand.length === 21 && Array.from({ length: 21 }, (_, point) => usableTrackingPoint(hand[point], true)).every(Boolean)
              const side = result.handedness[index]?.[0]?.categoryName
              return complete && side === 'Left' ? { ...sides, left: result.timestamp } : complete && side === 'Right' ? { ...sides, right: result.timestamp } : sides
            }, { left: 0, right: 0 })
            acceptHand(result.hands, result.timestamp)
          }
          waitingForRtmpose = false
          nextEngine = needsMediaPipePose || needsMediaPipeHand ? 'mediapipe' : 'rtmpose'
        } })
        if (requestId !== generation.current) { mixedRtmpose.close(); mixedPose?.close(); mixedHand?.close(); return }
        rtmposeRef.current = mixedRtmpose
        const info = mixedRtmpose.runtimeInfo
        setModelDelegates(previous => ({ ...previous, ...(selectedPoseModel === 'rtmpose' ? { pose: `${info.runtime} · ${info.device} · ${info.model}` } : {}), ...(handActive && selectedHandModel === 'rtmpose' ? { hand: 'RTMPose WholeBody: cùng lượt suy luận' } : {}) }))
        setMessage('Hai model được chạy nối tiếp trên các frame khác nhau, không chạy inference đồng thời. Chuyển sang bài tập lâm sàng sẽ dùng MediaPipe. RTMPose chỉ có tọa độ 2D.')
        schedule('mixed', (timestamp) => {
          if (waitingForRtmpose) return false
          if (nextEngine === 'rtmpose') {
            if (!mixedRtmpose || !mixedRtmpose.submit(video, timestamp)) return false
            waitingForRtmpose = true
            return true
          }
          try {
            if (mixedPose) {
              const result = mixedPose.detectForVideo(video, timestamp)
              acceptPose(result.landmarks[0] || [], timestamp)
            }
            if (handActive && mixedHand) {
              const result = mixedHand.detectForVideo(video, timestamp)
              acceptHand(result.landmarks, timestamp)
              handSides.current = handFreshness(result.landmarks, result.handedness, timestamp)
            }
            nextEngine = 'rtmpose'
            return true
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return false }
        })
      } catch (error) {
        mixedRtmpose?.close(); mixedPose?.close(); mixedHand?.close()
        fail(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (selectedTrackingModel === 'rtmpose') {
      const fail = (error: Error) => {
        if (requestId !== generation.current) return
        stopTracking(); setRoiConfirmed(false); setModelErrors([error.message]); setMessage(`RTMPose GPU: ${error.message}`)
      }
      if (!roiConfirmed && !personDetection) { fail(new Error('Cần xác nhận ROI chứa toàn bộ người tập trước khi chạy RTMPose.')); return }
      try {
        const controller = new AbortController(); workerAbort.current = controller
        const tracker = await createRTMPoseEngine({ roi, personDetection, signal: controller.signal, onError: fail, onResult: result => {
          if (requestId !== generation.current) return
          if (!result.roiValid) { fail(new Error('ROI không còn hợp lệ hoặc mất mốc vai. Kiểm tra người tập trong vùng và xác nhận lại ROI.')); return }
          handSides.current = result.hands.reduce((sides, hand, index) => {
            const complete = hand.length === 21 && Array.from({ length: 21 }, (_, i) => usableTrackingPoint(hand[i], true)).every(Boolean)
            const side = result.handedness[index]?.[0]?.categoryName
            return complete && side === 'Left' ? { ...sides, left: result.timestamp } : complete && side === 'Right' ? { ...sides, right: result.timestamp } : sides
          }, { left: 0, right: 0 })
          accept(result.pose, handActive ? result.hands : [], result.timestamp)
        } })
        if (requestId !== generation.current) { tracker.close(); return }
        rtmposeRef.current = tracker
        const info = tracker.runtimeInfo
        setModelDelegates({ pose: `${info.runtime} · ${info.device} · ${info.model}`, hand: handActive ? 'WholeBody: cùng lượt suy luận' : 'Ẩn' })
        schedule('rtmpose', timestamp => tracker.submit(video, timestamp))
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
      return
    }
    if (!settings.workerTracking && !preferParallel) { await startMainThread(); return }
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') { setMessage('Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính.'); await startMainThread(); return }
    if (preferParallel && handActive) {
      let poseThread: Worker | null = null, handThread: Worker | null = null, ownedByCoordinator = false
      const budget = adaptiveParallel ? new AdaptiveWorkerBudget(AUTO_WORKER_MAX_FPS) : undefined
      setParallelHandAvailable(true)
      const disableHand = () => {
        if (requestId !== generation.current || !handActive) return
        handActive = false; budget?.setHandAvailable(false); handTime.current = 0; handSides.current = { left: 0, right: 0 }; setParallelHandAvailable(false)
        if (budget && parallelWorkerRef.current) setBudgetStatus(budget.snapshot())
        points.current = { ...points.current, hands: [] }; displayPoints.current = { ...displayPoints.current, hands: [] }
        setMessage('Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Dừng và khởi động lại nhận diện để thử lại bàn tay.')
        publishStatus(currentStatus(performance.now()))
      }
      const fallback = () => {
        if (requestId !== generation.current) return
        setMessage(handActive
          ? 'Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính.'
          : 'Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính. Bàn tay vẫn không khả dụng; dừng và khởi động lại nhận diện để thử lại.')
        void startMainThread()
      }
      try {
        const controller = new AbortController(); workerAbort.current = controller
        poseThread = new Worker('/tracking-worker.js'); handThread = new Worker('/tracking-worker.js')
        const moduleUrl = new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href
        ownedByCoordinator = true
        const tracker = await createParallelWorkerTracker({ poseWorker: poseThread, handWorker: handThread, moduleUrl, signal: controller.signal, capture: element => createImageBitmap(element), preferGpu: true,
          onPose: result => { if (requestId === generation.current) budget?.recordResult('pose', { timestamp: result.timestamp, receivedAt: performance.now(), inferenceMs: result.inferenceMs }); acceptPose(result.pose, result.timestamp) },
          onHand: result => { if (result.handFailed) disableHand(); else { if (requestId === generation.current && handActive) budget?.recordResult('hand', { timestamp: result.timestamp, receivedAt: performance.now(), inferenceMs: result.inferenceMs }); handSides.current = handFreshness(result.hands ?? [], result.handedness ?? [], result.timestamp); acceptHand(result.hands ?? [], result.timestamp) } },
          onPoseError: fallback, onHandError: disableHand,
        })
        if (requestId !== generation.current) { tracker.close(); return }
        parallelWorkerRef.current = tracker
        setModelDelegates({
          pose: tracker.delegates.pose || '—',
          hand: tracker.delegates.hand || (handActive ? '—' : 'Tắt'),
        })
        if (tracker.initializationErrors.length) {
          setModelErrors(previous => [...previous, ...tracker.initializationErrors])
        }
        schedule('parallel', (timestamp, doHand, now) => {
          if (!budget || budget.canSubmit('pose', now)) { if (tracker.submitPose(video, timestamp)) budget?.submitted('pose', now) }
          if (!doHand || (budget && !budget.canSubmit('hand', now))) return false
          const accepted = tracker.submitHand(video, timestamp)
          if (accepted) budget?.submitted('hand', now)
          return accepted
        }, budget)
      } catch {
        if (!ownedByCoordinator) { poseThread?.terminate(); handThread?.terminate() }
        fallback()
      }
      return
    }
    try {
      if (workerRef.current) {
        const old = workerRef.current
        workerRef.current = null
        try { await old.dispose() } catch (err) { setModelErrors(p => [...p, err instanceof Error ? err.message : String(err)]) }
      }
      const controller = new AbortController(); workerAbort.current = controller
      const worker = new Worker('/tracking-worker.js')
      const moduleUrl = new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href

      type InFlightCapture = {
        now: number
        sourceFrameId: number | null
        mediaTime: number
        skippedSourceFrames: number
        timestamp: number
        scheduledPose: boolean
        scheduledHand: boolean
        poseResult: WorkerPoseResult | null
        handResult: WorkerHandResult | null
      }
      const inFlightCaptures = new Map<number, InFlightCapture>()

      const tracker = await createWorkerTracker({
        worker,
        moduleUrl,
        handEnabled,
        preferGpu: true,
        signal: controller.signal,
        capture: element => captureInferenceBitmap(element, { width: 1280, height: 720 }),
        onHandResult: (result: WorkerHandResult) => {
          if (requestId !== generation.current) return
          const inFlight = inFlightCaptures.get(result.timestamp)
          if (inFlight) inFlight.handResult = result

          if (result.handFailed && handActive) {
            handActive = false; handTime.current = 0
            points.current = { ...points.current, hands: [] }; displayPoints.current = { ...displayPoints.current, hands: [] }
            setMessage(result.handCleanupFailed
              ? 'Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Không thể giải phóng model bàn tay; hãy tải lại trang trước khi thử lại.'
              : 'Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Dừng và khởi động lại nhận diện để thử lại bàn tay.')
            publishStatus(currentStatus(performance.now()))
          }
          if (result.handProcessed && result.hands.length) {
            handSides.current = handFreshness(result.hands, result.handedness ?? [], result.timestamp)
          }
          acceptHand(result.hands, result.timestamp)
        },
        onPoseResult: (result: WorkerPoseResult) => {
          if (requestId !== generation.current) return
          const inFlight = inFlightCaptures.get(result.timestamp)
          if (inFlight) inFlight.poseResult = result

          acceptPose(result.pose, result.timestamp)
        },
        onFrameComplete: complete => {
          if (requestId !== generation.current) return
          const inFlight = inFlightCaptures.get(complete.timestamp)
          if (inFlight) {
            inFlightCaptures.delete(complete.timestamp)
            if (capture.isActive()) {
              const rawPose = inFlight.poseResult?.pose ?? []
              const poseWorld = inFlight.poseResult?.poseWorldLandmarks ?? []
              const displayPose = displayPoints.current.pose
              const handRes = inFlight.handResult
              const hands = handRes?.hands ?? []
              const handWorld = handRes?.handWorldLandmarks ?? []
              const handedness = handRes?.handedness ?? []

              const rows = [
                ...landmarkRows(rawPose, 'pose', 'normalized_image'),
                ...landmarkRows(poseWorld, 'pose', 'world'),
                ...landmarkRows(inFlight.scheduledPose ? displayPose as typeof rawPose : [], 'pose', 'normalized_image', 'display'),
                ...(hands.flatMap((hand, index) => landmarkRows(hand, 'hand', 'normalized_image', 'raw', handedness[index])) || []),
                ...(handWorld.flatMap((hand, index) => landmarkRows(hand, 'hand', 'world', 'raw', handedness[index])) || []),
              ]
              capture.addFrame({
                timestamp: inFlight.now,
                source_frame_id: inFlight.sourceFrameId,
                video_media_time_ms: inFlight.mediaTime * 1000,
                inference_performed: true,
                pose_detected: inFlight.scheduledPose ? rawPose.length > 0 : null,
                hand_detected: inFlight.scheduledHand ? hands.length > 0 : null,
                inference_ms: complete.inferenceMs,
                skipped_frames: inFlight.skippedSourceFrames,
                landmarks: rows,
              })
            }
          }
        },
        onError: () => {
          if (requestId === generation.current) { setMessage('Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính.'); void startMainThread() }
        },
      })
      if (requestId !== generation.current) { tracker.close(); return }
      workerRef.current = tracker
      setModelDelegates({
        pose: tracker.delegates.pose || '—',
        hand: tracker.delegates.hand || (handActive ? '—' : 'Tắt'),
      })
      if (tracker.initializationErrors.length) {
        setModelErrors(previous => [...previous, ...tracker.initializationErrors])
      }

      let nextWorkerPose = -Infinity
      let nextWorkerHand = -Infinity
      schedule('worker', (timestamp, _doHand, now, mediaTime, sourceFrameId, skippedSourceFrames) => {
        const doPose = now >= nextWorkerPose
        const doHand = handActive && now >= nextWorkerHand
        if (!doPose && !doHand) return false

        if (capture.isActive()) {
          inFlightCaptures.set(timestamp, {
            now,
            sourceFrameId: sourceFrameId ?? null,
            mediaTime,
            skippedSourceFrames: skippedSourceFrames ?? 0,
            timestamp,
            scheduledPose: doPose,
            scheduledHand: doHand,
            poseResult: null,
            handResult: null,
          })
          if (inFlightCaptures.size > 50) {
            const oldest = inFlightCaptures.keys().next().value
            if (oldest !== undefined) inFlightCaptures.delete(oldest)
          }
        }

        const accepted = tracker.submit(video, timestamp, doHand, doPose)
        if (accepted) {
          if (doPose) nextWorkerPose = now + 1000 / 15 - (Number.isFinite(nextWorkerPose) && nextWorkerPose > -Infinity ? (now - nextWorkerPose) % (1000 / 15) : 0)
          if (doHand) nextWorkerHand = now + 1000 / 30 - (Number.isFinite(nextWorkerHand) && nextWorkerHand > -Infinity ? (now - nextWorkerHand) % (1000 / 30) : 0)
        }
        return accepted
      })
    } catch {
      if (requestId === generation.current) { setMessage('Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính.'); await startMainThread() }
    }
  }

  useEffect(() => {
    let animation = 0
    const draw = (time: number) => {
      const canvas = canvasRef.current; const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        const display = prepareOverlay(ctx, canvas.width, canvas.height, displayBox.current)
        if (showSkeleton) {
          if (demo) drawLandmarks(ctx, display.width, display.height, demoPose(time), settings.mirrored)
          else if (videoMapping.current) {
            const visible = showRaw ? points.current : displayPoints.current
            const mapping = videoMapping.current
            const now = performance.now()
            if (poseTime.current && now >= poseTime.current && now - poseTime.current <= maxLandmarkAgeMs) drawLandmarks(ctx, display.width, display.height, visible.pose, settings.mirrored, false, mapping)
            if (handTime.current && now >= handTime.current && now - handTime.current <= maxLandmarkAgeMs) visible.hands.forEach(hand => drawLandmarks(ctx, display.width, display.height, hand, settings.mirrored, true, mapping))
          }
        }
      }
      animation = requestAnimationFrame(draw)
    }
    animation = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animation)
  }, [ghost, settings.mirrored, showSkeleton, showRaw, demo, videoMapping, displayBox])

  const updateGhost = (changes: Partial<Ghost>) => {
    restoreGeneration.current += 1
    const next = { ...ghostRef.current, ...changes, confirmed: false }
    ghostRef.current = next
    setGhost(next)
  }
  const updateSettings = (changes: Partial<CameraSettings>) => {
    restoreGeneration.current += 1
    const next = { ...ghostRef.current, confirmed: false }
    ghostRef.current = next
    setSettings(previous => ({ ...previous, ...changes }))
    setGhost(next)
  }
  const onSessionChange = (value: string) => {
    restoreGeneration.current += 1
    setSessionId(value); const session = sessions.find(item => String(item.id) === value)
    setGhost(previous => ({ ...previous, affected_side: session?.affected_side || previous.affected_side, confirmed: false }))
  }
  const save = async () => {
    if (calibrationSavePending) return
    if (demo || !streamActive || !sessionId) { setMessage('Chọn phiên và bật camera thật trước khi lưu. Chế độ demo không ghi dữ liệu.'); return }
    const currentGhost = ghostRef.current
    if (workflow && !currentGhost.confirmed) { setMessage('Hãy xác nhận đã kiểm tra camera và tư thế trước khi lưu.'); return }
    setCalibrationSavePending(true)
    const requestId = ++saveGeneration.current
    const savedSessionId = sessionId
    const savedCameraGeneration = cameraGeneration.current
    const savedRestoreGeneration = restoreGeneration.current
    const isCurrent = () => {
      const current = ghostRef.current
      return requestId === saveGeneration.current && savedCameraGeneration === cameraGeneration.current && savedRestoreGeneration === restoreGeneration.current && current.x === currentGhost.x && current.y === currentGhost.y && current.scale === currentGhost.scale && current.confirmed === currentGhost.confirmed && current.affected_side === currentGhost.affected_side && current.opacity === currentGhost.opacity && current.ghost_visible === currentGhost.ghost_visible
    }
    try {
      const setupRevision = workflow ? await workflow.beforeCalibrationSave() : undefined
      if (workflow && !isCurrent()) { setMessage('Camera hoặc hiệu chuẩn đã thay đổi; hãy kiểm tra và lưu lại.'); return }
      const track = streamRef.current?.getVideoTracks()[0]; const actual = track?.getSettings()
      const saved = await calibrationRequest<Calibration>('/api/calibrations', { method: 'POST', body: JSON.stringify({ session_id: Number(savedSessionId), ...currentGhost, camera_label: track?.label || null, camera_device_id: actual?.deviceId || null, width: actualDimension(actual?.width), height: actualDimension(actual?.height), mirrored: settings.mirrored, ...(setupRevision !== undefined ? { setup_revision: setupRevision } : {}) }) })
      if (workflow && !isCurrent()) { invalidateWorkflow(); if (requestId === saveGeneration.current) setMessage('Camera hoặc hiệu chuẩn đã thay đổi; hãy kiểm tra và lưu lại.'); return }
      if (requestId === saveGeneration.current) {
        setMessage(`Đã lưu xác nhận camera và hiệu chuẩn cho phiên #${savedSessionId}.`)
        if (workflow && saved.confirmed) { savedSetup.current = true; workflow.onSetupSaved(saved.id) }
      }
    } catch { if (requestId === saveGeneration.current) setMessage(`Không xác nhận được lưu hiệu chuẩn cho phiên #${savedSessionId}. Hãy kiểm tra cấu hình đã lưu trước khi thử lại.`) }
    finally { setCalibrationSavePending(false) }
  }
  const continueSetup = () => {
    if (!workflow || !ghostRef.current.confirmed) return
    void save()
  }
  const toggleFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await workspaceRef.current?.requestFullscreen() }
    catch { setMessage('Trình duyệt không cho phép toàn màn hình. Hãy kiểm tra quyền trình duyệt.') }
  }

  const startCollection = async () => {
    const session = sessions.find(item => String(item.id) === sessionId)
    if (selectedTrackingModel !== 'mediapipe') { setMessage('Thu dữ liệu nghiên cứu chỉ hỗ trợ MediaPipe. Dùng benchmark riêng để lưu artifact RTMPose.'); return }
    if (!session || !streamRef.current || demo || !tracking || activeEngine !== 'main') { setMessage('Chọn phiên và bật nhận diện trên luồng chính với camera thật trước khi thu.'); return }
    const trial = captureTrial.trim() ? Number(captureTrial) : undefined
    if (trial !== undefined && (!Number.isSafeInteger(trial) || trial <= 0)) { setMessage('Mã lượt tập phải là số nguyên dương.'); return }
    try { await capture.start({ patientId: session.patient_id, sessionId: session.id, trialId: trial, stream: streamRef.current, width: actualCameraSize?.width, height: actualCameraSize?.height, recordLandmarks: saveLandmarks, recordVideo: saveVideo, consentLandmarks: landmarkConsent, consentVideo: videoConsent, modelConfig: { pose: 'pose_landmarker_lite.task', hand: handRef.current ? 'hand_landmarker.task' : null, profile: settings.trackingProfile || 'balanced', engine: 'main' } }) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể bắt đầu thu dữ liệu.') }
  }

  const previousWorkflowView = useRef(workflow?.view)
  const pendingClinicalTrackingRestart = useRef(false)
  useEffect(() => {
    const viewChanged = previousWorkflowView.current !== workflow?.view
    previousWorkflowView.current = workflow?.view
    if (!viewChanged) return
    const experimentalEngineActive = activeEngine === 'rtmpose' || activeEngine === 'mixed' || ((tracking || starting) && requestedTrackingEngine.current !== 'mediapipe')
    if (workflow && workflow.view !== 'setup' && experimentalEngineActive) {
      pendingClinicalTrackingRestart.current = true
      stopTracking()
    }
    if (workflow?.view === 'game' && pendingClinicalTrackingRestart.current) {
      pendingClinicalTrackingRestart.current = false
      setTimeout(() => { if (streamRef.current) void startTracking() }, 0)
    }
  }, [workflow?.view])

  return <section ref={workspaceRef} hidden={!!workflow && workflow.view === 'monitor'} className={`${settings.tvMode ? 'workspace workspace-tv' : 'workspace'}${workflow ? ` clinical-workspace clinical-${workflow.view}` : ''}`}>
    <CaptureNavigationGuard shouldBlock={() => capture.busy || capture.isActive()} />
    <div className="workspace-heading"><div><p className="workspace-eyebrow">{workflow?.view === 'game' ? 'KHÔNG GIAN THỰC HÀNH' : 'THIẾT LẬP CAMERA'}</p>{workflow ? <h2>{workflow.view === 'game' ? 'Thực hiện bài tập' : 'Căn chỉnh camera'}</h2> : <h1>Camera & hiệu chuẩn</h1>}<p>{workflow?.view === 'game' ? 'Thực hiện trò chơi theo hướng dẫn trên màn hình.' : 'Đặt người tập trong khung hình và kiểm tra camera trước khi tiếp tục.'}</p></div>{workflow?.view === 'setup' && <span className="workspace-tag">Nhân viên kiểm tra tư thế</span>}</div>
    {message && <div className="workspace-message" role="status" aria-label="Thông báo camera và hiệu chuẩn">{message}<button aria-label="Đóng thông báo" onClick={() => setMessage('')}>×</button></div>}
    {sessionsError && <div className="workspace-message" role="alert">{sessionsError}</div>}
    <div className="workspace-grid">
      <div className="workspace-main">
        <div className="workspace-stage" style={{ '--stage-aspect': size.width / size.height } as CSSProperties}>
          <div className="workspace-image" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
            <video ref={videoRef} muted playsInline className={settings.mirrored ? 'mirrored' : ''} />
            {!streamActive && <div className="workspace-empty">{demo ? 'KHUNG MÔ PHỎNG' : 'Camera đang tắt'}<small>{demo ? 'Chuyển động mốc được tạo để thử giao diện' : 'Bật camera hoặc chọn chế độ demo để bắt đầu'}</small></div>}
            <canvas ref={canvasRef} width={size.width} height={size.height} aria-label="Lớp phủ mốc vận động" />
            {game.overlay}
            {(!workflow || workflow.view === 'game') && game.hud}
            {demo && <div className="demo-badge">DEMO — KHÔNG PHẢI DỮ LIỆU BỆNH NHÂN</div>}
            <div className="workspace-stage-status"><span className={streamActive || demo ? 'live-dot' : ''} />{demo ? 'Mô phỏng' : streamActive ? 'Camera đang bật' : 'Camera đang tắt'}</div>
            <button className="workspace-fullscreen" onClick={toggleFullscreen}>{fullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}</button>
          </div>
        </div>
        <div className="workspace-controls">
          <button className="primary" disabled={cameraOpening} onClick={() => { if (streamActive) stopCamera(); else void startCamera() }}>{streamActive ? 'Tắt camera' : 'Bật camera'}</button>
          {!workflow && <button onClick={() => { stopCamera(); setDemo(value => !value); setSize({ width: 1280, height: 720 }); setMessage('') }}>{demo ? 'Thoát demo' : 'Chạy demo'}</button>}
          <button disabled={!streamActive || demo || starting} onClick={tracking ? stopTracking : startTracking}>{starting ? 'Đang tải…' : tracking ? 'Dừng nhận diện' : 'Bắt đầu nhận diện'}</button>
        </div>
        {!workflow && <div className="workspace-meta"><span>{demo ? 'Mốc mô phỏng' : status}</span><span>{fps} FPS suy luận {activeEngine === 'rtmpose' ? 'WholeBody' : 'Pose'}</span>{activeEngine && <span>Pose: {modelDelegates.pose} | Hand: {modelDelegates.hand} · {activeEngine === 'parallel' ? (parallelHandAvailable ? 'hai Worker' : 'Worker Pose') : activeEngine === 'worker' ? ((modelDelegates.pose === 'GPU' || modelDelegates.hand === 'GPU') ? 'Worker GPU' : 'Worker CPU') : activeEngine === 'rtmpose' ? 'dịch vụ GPU localhost' : 'luồng chính'}</span>}<span>Yêu cầu camera: {requestedCameraSize.width} × {requestedCameraSize.height}</span>{streamActive && <span>Camera thực tế: {actualCameraSize ? `${actualCameraSize.width} × ${actualCameraSize.height}` : 'không xác định'}</span>}</div>}
        {!workflow && budgetStatus && <p>Giới hạn tự điều chỉnh Pose {budgetStatus.poseFps.toFixed(1)} / Hand {budgetStatus.handAvailable ? `${budgetStatus.handFps.toFixed(1)} FPS` : 'không khả dụng'} · {budgetStatus.phase === 'normal' ? 'bình thường' : 'đã giảm tải'}</p>}
        {!workflow && <><p><a href="/tracking-lab">Mở Tracking Test Lab</a></p>
        <div className="workspace-panel" aria-label="Thu thập dữ liệu nghiên cứu">
          <h2>Thu thập dữ liệu nghiên cứu</h2>
          <p>Phiên #{sessionId || 'chưa chọn'} · Bệnh nhân #{sessions.find(item => String(item.id) === sessionId)?.patient_id || 'chưa chọn'}</p>
          <label>Mã lượt tập (để trống để tạo mới)<input type="number" min="1" value={captureTrial} onChange={event => setCaptureTrial(event.target.value)} disabled={capture.isActive() || capture.busy} /></label>
          <label className="check"><input type="checkbox" checked={saveLandmarks} disabled={capture.isActive() || capture.busy} onChange={event => setSaveLandmarks(event.target.checked)} /> Lưu landmark</label>
          <label className="check"><input type="checkbox" checked={landmarkConsent} disabled={capture.isActive() || capture.busy} onChange={event => setLandmarkConsent(event.target.checked)} /> Xác nhận quyền thu landmark</label>
          <label className="check"><input type="checkbox" checked={saveVideo} disabled={capture.isActive() || capture.busy} onChange={event => setSaveVideo(event.target.checked)} /> Ghi video nguồn từ camera, không có overlay</label>
          <label className="check"><input type="checkbox" checked={videoConsent} disabled={capture.isActive() || capture.busy} onChange={event => setVideoConsent(event.target.checked)} /> Xác nhận quyền ghi video</label>
          <p>Thu landmark yêu cầu nhận diện luồng chính; video nguồn được mã hóa bởi trình duyệt và không có âm thanh.</p>
          <button disabled={capture.busy || (!capture.isActive() && (!sessionId || !streamActive || !tracking || activeEngine !== 'main' || (!saveLandmarks && !saveVideo) || (saveLandmarks && !landmarkConsent) || (saveVideo && !videoConsent)))} onClick={() => { if (capture.isActive()) void capture.stop(); else void startCollection() }}>{capture.isActive() ? 'Dừng và lưu' : 'Bắt đầu thu dữ liệu'}</button>
          <p role="status">{capture.state}{capture.captureId && ` · ${capture.captureId}`}{capture.isActive() && ` · ${Math.floor(capture.elapsedMs / 1000)} giây`}</p>
          <CaptureArtifactStatus captureId={capture.captureId} busy={capture.busy || capture.isActive()} state={capture.state} />
          {capture.stats && <p>Frame: {capture.stats.frames} · Landmark: {capture.stats.landmarks} · Batch đã gửi: {capture.stats.uploadedBatches} · Đang chờ: {capture.stats.pending} · Video: {capture.stats.videoBytes} byte / {capture.stats.videoChunks} chunk {capture.stats.error && `· Lỗi: ${capture.stats.error}`}</p>}
        </div></>}
        {(!workflow || workflow.view === 'game') && game.panel}
      </div>
      <aside className="workspace-panel" hidden={!!workflow && workflow.view !== 'setup'}>
        <div><p className="workspace-eyebrow">{workflow ? 'CĂN CHỈNH' : 'THIẾT LẬP PHIÊN'}</p><h2>{workflow ? 'Căn chỉnh camera' : 'Hiệu chuẩn tư thế'}</h2><p>{workflow ? 'Đặt người tập thoải mái trong khung hình. Nhân viên quan sát và xác nhận thủ công.' : 'Đặt người tập trong khung hình camera rồi bật theo dõi để kiểm tra mốc vận động.'}</p></div>
        {!controlledSession && <label>Phiên tập<select value={sessionId} disabled={capture.isActive() || capture.busy} onChange={event => onSessionChange(event.target.value)}><option value="">Chọn phiên</option>{sessions.map(item => <option key={item.id} value={item.id}>Phiên #{item.id} · Bệnh nhân #{item.patient_id}</option>)}</select></label>}
        <label>Camera<select value={settings.cameraId || ''} onChange={event => { stopCamera(); updateSettings({ cameraId: event.target.value }) }}><option value="">Camera mặc định</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Camera'}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={settings.mirrored} onChange={event => updateSettings({ mirrored: event.target.checked })} /> Lật ảnh ngang</label>
        {workflow?.view === 'setup' ? <>
          <fieldset className="tracking-model-options"><legend>Model theo dõi</legend>
            <label>Pose<select aria-label="Model tracking Pose" value={settings.poseTrackingModel || 'mediapipe'} disabled={tracking || starting} onChange={event => { stopTracking(); setSettings(previous => ({ ...previous, poseTrackingModel: event.target.value === 'rtmpose' ? 'rtmpose' : 'mediapipe' })); setModelErrors([]); setModelDelegates({ pose: '—', hand: 'Tắt' }); setRoiConfirmed(false) }}><option value="mediapipe">MediaPipe Pose</option><option value="rtmpose">RTMPose WholeBody Pose (thử nghiệm)</option></select></label>
            <label>Hand<select aria-label="Model tracking Hand" value={settings.handTrackingModel || 'mediapipe'} disabled={tracking || starting} onChange={event => { stopTracking(); setSettings(previous => ({ ...previous, handTrackingModel: event.target.value === 'rtmpose' ? 'rtmpose' : 'mediapipe' })); setModelErrors([]); setModelDelegates({ pose: '—', hand: 'Tắt' }); setRoiConfirmed(false) }}><option value="mediapipe">MediaPipe Hand</option><option value="rtmpose">RTMPose WholeBody Hand (thử nghiệm)</option></select></label>
          </fieldset>
          <p className="workspace-hint">Mặc định MediaPipe cho Pose và Hand. RTMPose WholeBody trả hai nhóm mốc trong cùng lượt; khi chọn model khác nhau, hai bộ tracking xử lý nối tiếp. Bài tập lâm sàng luôn dùng MediaPipe.</p>
          {(selectedPoseModel === 'rtmpose' || (handEnabled && selectedHandModel === 'rtmpose')) && <details><summary>ROI một người tập (tọa độ ảnh chuẩn hóa)</summary><label className="check"><input type="checkbox" aria-label="RTMPose person detector" disabled={tracking || starting} checked={personDetection} onChange={event => { setPersonDetection(event.target.checked); setRoiConfirmed(false) }} />Phát hiện vùng người bằng RTMDet GPU (thử nghiệm)</label><p>Detector thêm chi phí suy luận nhưng crop người sát hơn. Nếu tắt, phải xác nhận ROI thủ công. Cả hai cách chỉ phục vụ một người.</p><p>Chỉ dùng khi người tập nằm trọn trong ROI. Mất mốc hoặc chạm biên không bảo đảm phát hiện mọi trường hợp ra ngoài ROI; dừng và xác nhận lại khi đổi vị trí.</p>{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{key}<input type="number" min="0" max="1" step="0.01" value={roi[key]} disabled={tracking || starting} onChange={event => { setRoi(previous => ({ ...previous, [key]: Number(event.target.value) })); setRoiConfirmed(false) }} /></label>)}<label className="check"><input type="checkbox" checked={roiConfirmed} disabled={tracking || starting} onChange={event => setRoiConfirmed(event.target.checked)} />Tôi đã kiểm tra ROI chứa toàn bộ người tập</label></details>}
        </> : !workflow ? <>
          <label>Model tracking<select aria-label="Model tracking" value={settings.trackingModel || 'mediapipe'} disabled={capture.busy || capture.isActive()} onChange={event => { stopTracking(); setSettings(previous => ({ ...previous, trackingModel: event.target.value === 'rtmpose' ? 'rtmpose' : 'mediapipe' })); setModelErrors([]); setModelDelegates({ pose: '—', hand: '—' }); setRoiConfirmed(false) }}><option value="mediapipe">MediaPipe Pose + Hand</option><option value="rtmpose">MMPose RTMPose WholeBody (thử nghiệm)</option></select></label>
          <p className="workspace-hint">{selectedTrackingModel === 'rtmpose' ? 'Whole-body pose + 21 landmarks per hand. Chỉ có tọa độ 2D; chưa hỗ trợ thu nghiên cứu z/world. Không tự chuyển sang CPU hoặc MediaPipe.' : 'Pose Landmarker Lite + Hand Landmarker. Delegate Pose và Hand hiển thị riêng; có CPU fallback.'}</p>
          {selectedTrackingModel === 'rtmpose' && <details><summary>ROI một người tập (tọa độ ảnh chuẩn hóa)</summary><label className="check"><input type="checkbox" aria-label="RTMPose person detector" disabled={tracking || starting} checked={personDetection} onChange={event => { setPersonDetection(event.target.checked); setRoiConfirmed(false) }} />Phát hiện vùng người bằng RTMDet GPU (thử nghiệm)</label><p>Detector thêm chi phí suy luận nhưng crop người sát hơn. Nếu tắt, phải xác nhận ROI thủ công. Cả hai cách chỉ phục vụ một người.</p><p>Chỉ dùng khi người tập nằm trọn trong ROI. Mất mốc hoặc chạm biên không bảo đảm phát hiện mọi trường hợp ra ngoài ROI; dừng và xác nhận lại khi đổi vị trí.</p>{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{key}<input type="number" min="0" max="1" step="0.01" value={roi[key]} disabled={tracking || starting} onChange={event => { setRoi(previous => ({ ...previous, [key]: Number(event.target.value) })); setRoiConfirmed(false) }} /></label>)}<label className="check"><input type="checkbox" checked={roiConfirmed} disabled={tracking || starting} onChange={event => setRoiConfirmed(event.target.checked)} />Tôi đã kiểm tra ROI chứa toàn bộ người tập</label></details>}
        </> : <p className="workspace-hint">Bài tập lâm sàng luôn dùng MediaPipe Pose + Hand.</p>}
        <p role="status">{status}{activeEngine && <> · Pose: {modelDelegates.pose} | Hand: {modelDelegates.hand}</>}</p>
        {modelErrors.length > 0 && <details open><summary>Lỗi khởi tạo / suy luận model</summary>{modelErrors.map((error, index) => <p key={index}>{error}</p>)}</details>}
        <label className="check"><input type="checkbox" disabled={tracking || starting} checked={handEnabled} onChange={event => { setHandEnabled(event.target.checked); if (!event.target.checked) setPreferParallel(false) }} /> Theo dõi 21 mốc bàn tay</label>
        {!workflow && <>
        <label className="check"><input type="checkbox" checked={showSkeleton} onChange={event => setShowSkeleton(event.target.checked)} /> Hiển thị mốc vận động</label>
        <label className="check"><input type="checkbox" checked={showRaw} onChange={event => setShowRaw(event.target.checked)} /> Hiển thị mốc thô (không làm mượt)</label>
        <label>Hiệu năng<select disabled={streamActive || cameraOpening} value={settings.trackingProfile || 'balanced'} onChange={event => updateSettings({ trackingProfile: event.target.value as TrackingProfileName })}><option value="economy">Economy</option><option value="balanced">Balanced</option><option value="quality">Quality</option></select></label>
        <label className="check"><input type="checkbox" disabled={streamActive || cameraOpening} checked={settings.profileCameraResolution} onChange={event => updateSettings({ profileCameraResolution: event.target.checked })} /> Dùng độ phân giải camera theo cấu hình tracking</label>
        <p className="workspace-hint">Kích thước theo cấu hình là yêu cầu gửi tới camera; thiết bị có thể chọn kích thước khác. Kiểm tra lại hiệu chuẩn khi thay đổi khung hình.</p>
        <label className="check"><input type="checkbox" aria-label="Sử dụng Worker CPU (thử nghiệm)" disabled={tracking || starting || settings.trackingModel === 'rtmpose'} checked={settings.workerTracking && !preferParallel} onChange={event => { setSettings(previous => ({ ...previous, workerTracking: event.target.checked })); if (event.target.checked) setPreferParallel(false) }} /> Sử dụng Worker GPU (thử nghiệm)</label>
        <label className="check"><input type="checkbox" disabled={tracking || starting || !handEnabled || settings.trackingModel === 'rtmpose'} checked={preferParallel} onChange={event => setPreferParallel(event.target.checked)} /> Sử dụng hai Worker CPU (thử nghiệm)</label>
        <label className="check"><input type="checkbox" disabled={tracking || starting || !preferParallel || settings.trackingModel === 'rtmpose'} checked={adaptiveParallel} onChange={event => setAdaptiveParallel(event.target.checked)} /> Tự điều chỉnh nhịp hai Worker (thử nghiệm)</label>
        {preferParallel && <p className="workspace-hint">Tự điều chỉnh dùng thời gian nhận kết quả và độ phản hồi giao diện; không đo hoặc bảo đảm phần CPU còn lại của toàn máy. Giới hạn FPS không phải FPS thực tế.</p>}
        <p className="workspace-hint">Dừng nhận diện để thay đổi. Hai Worker cần bật bàn tay và có thể xử lý các frame khác nhau. Nếu Pose Worker không khả dụng, hệ thống sẽ thử GPU trên luồng chính, rồi CPU nếu GPU lỗi.</p>
        </>}
        {!workflow && <label>Tay ảnh hưởng<select value={ghost.affected_side} onChange={event => updateGhost({ affected_side: event.target.value as 'left' | 'right' })}><option value="left">Trái</option><option value="right">Phải</option></select></label>}
        {workflow ? <><label className="check confirm"><input type="checkbox" checked={ghost.confirmed} disabled={demo || !streamActive} onChange={event => { const next = { ...ghostRef.current, confirmed: event.target.checked }; ghostRef.current = next; setGhost(next) }} /> Nhân viên đã kiểm tra camera và tư thế người tập</label><div className="workspace-panel-actions"><button className="primary" onClick={continueSetup} disabled={!sessionId || demo || !streamActive || saving || !ghost.confirmed}>Tiếp theo</button></div></> : <>
          <label className="check confirm"><input type="checkbox" checked={ghost.confirmed} disabled={demo || !streamActive} onChange={event => { const next = { ...ghostRef.current, confirmed: event.target.checked }; ghostRef.current = next; setGhost(next) }} /> Tôi đã kiểm tra vị trí và tư thế người bệnh</label>
          <div className="workspace-panel-actions"><button className="primary" onClick={save} disabled={!sessionId || demo || !streamActive}>Lưu hiệu chuẩn</button></div>
          <p className="workspace-hint">Hiệu chuẩn này ghi nhận camera và xác nhận thủ công, không tự đánh giá tư thế lâm sàng. Không lưu dữ liệu demo.</p>
        </>}
      </aside>
    </div>
  </section>
}

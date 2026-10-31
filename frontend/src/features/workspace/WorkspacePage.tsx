import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { api } from '../../services/api'
import type { Session } from '../../types'
import { demoPose, drawGhost, drawLandmarks, initialGhost, prepareOverlay } from './drawing'
import type { Ghost, Point } from './drawing'
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { useFlowerGame } from './useFlowerGame'
import { startVideoFrameScheduler } from './videoFrameScheduler'
import { LandmarkSmoother, POSE_SMOOTHING_POLICY } from './landmarkSmoothing'
import { getTrackingProfile, resolveCameraResolution } from './trackingProfiles'
import type { TrackingProfileName } from './trackingProfiles'
import { createWorkerTracker } from './workerTracker'
import type { WorkerTracker } from './workerTracker'
import { createParallelWorkerTracker } from './parallelWorkerTracker'
import type { ParallelWorkerTracker } from './parallelWorkerTracker'
import { AdaptiveWorkerBudget, AUTO_WORKER_MAX_FPS } from './adaptiveWorkerBudget'
import { useVideoMapping } from './useVideoMapping'
import { anchorGhost, ghostFitsCalibration, mapGhostAnchor, toPersistedGhostAnchor, fromPersistedGhostAnchor } from './ghostGeometry'
import type { GhostAnchor, PersistedGhostAnchor } from './ghostGeometry'
import { resolveWorkerPreference } from './trackingEnginePreference'
import { initializePose, initializeHand, modelErrorMessage } from './mediaPipeModels'
import { handFreshness } from './handObservation'
import { useResearchCapture } from './useResearchCapture'
import { CaptureNavigationGuard } from './CaptureNavigationGuard'
import { CaptureArtifactStatus } from './CaptureArtifactStatus'
import { landmarkRows } from './captureLandmarks'
import type { WorkspaceWorkflow } from './gameWorkflow'
import './workspace.css'

type CameraSettings = { mirrored: boolean; resolution: string; cameraId?: string; tvMode?: boolean; trackingProfile?: TrackingProfileName; profileCameraResolution: boolean; workerTracking: boolean }
type Calibration = Ghost & { id: number; session_id: number; camera_label: string | null; camera_device_id: string | null; width: number | null; height: number | null; mirrored: boolean; created_at: string; image_anchor?: unknown }
type PendingAnchor = { image: PersistedGhostAnchor; deviceId: string; width: number; height: number; mirrored: boolean }
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
const upperLimbVisible = (pose: Point[], side: 'left' | 'right') => (side === 'left' ? [11, 13, 15] : [12, 14, 16]).every(index => {
  const point = pose[index]
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && point.visibility !== undefined && Number.isFinite(point.visibility) && point.visibility >= .4
})
const loadSettings = (): CameraSettings => {
  try { const saved = JSON.parse(localStorage.getItem('rehab.settings') || '{}'); return { mirrored: true, resolution: '1280x720', ...saved, profileCameraResolution: saved.profileCameraResolution === true, workerTracking: resolveWorkerPreference(saved.workerTracking, localStorage.getItem('rehab.workerTracking')) } }
  catch { return { mirrored: true, resolution: '1280x720', profileCameraResolution: false, workerTracking: false } }
}

async function calibrationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { 'Content-Type': 'application/json' } })
  if (!response.ok) throw new Error(`Không thể kết nối hoặc lưu hiệu chuẩn (HTTP ${response.status}).`)
  return response.json() as Promise<T>
}

/** Older backends do not know image_anchor. Check before POST, never retry a write. */
async function imageAnchorSupported(): Promise<boolean> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<false>(resolve => { timeout = setTimeout(() => { controller.abort(); resolve(false) }, 2500) })
    const request = fetch(`${apiBase}/api/capabilities`, { signal: controller.signal }).then(async response => {
      if (!response.ok) return false
      const body: unknown = await response.json()
      return !!body && typeof body === 'object' && 'imageAnchorV1' in body && body.imageAnchorV1 === true && 'status' in body && body.status === 'ok'
    }).catch(() => false)
    return await Promise.race([request, expired])
  } finally { if (timeout !== undefined) clearTimeout(timeout) }
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
  const ghostAnchor = useRef<GhostAnchor | null>(null)
  const pendingAnchor = useRef<PendingAnchor | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [streamActive, setStreamActive] = useState(false)
  const [cameraOpening, setCameraOpening] = useState(false)
  const [actualCameraSize, setActualCameraSize] = useState<{ width: number; height: number } | null>(null)
  const [demo, setDemo] = useState(false)
  const [handEnabled, setHandEnabled] = useState(true)
  const [preferParallel, setPreferParallel] = useState(false)
  const [adaptiveParallel, setAdaptiveParallel] = useState(true)
  const [budgetStatus, setBudgetStatus] = useState<ReturnType<AdaptiveWorkerBudget['snapshot']> | null>(null)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showRaw, setShowRaw] = useState(false)
  const [tracking, setTracking] = useState(false)
  const [modelDelegates, setModelDelegates] = useState({ pose: '—', hand: 'Tắt' })
  const [modelErrors, setModelErrors] = useState<string[]>([])
  const [activeEngine, setActiveEngine] = useState<'main' | 'worker' | 'parallel' | null>(null)
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
    generation.current += 1
    startingRef.current = false; setStarting(false)
    stopFrameScheduler.current?.(); stopFrameScheduler.current = null
    if (watchdog.current !== null) clearInterval(watchdog.current); watchdog.current = null
    stopBudgetObserver.current?.(); stopBudgetObserver.current = null; setBudgetStatus(null)
    workerRef.current?.close(); workerRef.current = null; parallelWorkerRef.current?.close(); parallelWorkerRef.current = null; workerAbort.current?.abort(); workerAbort.current = null
    poseRef.current?.close(); handRef.current?.close()
    poseRef.current = null; handRef.current = null
    points.current = { pose: [], hands: [] }; displayPoints.current = { pose: [], hands: [] }; smoother.current.reset(); poseTime.current = 0; handTime.current = 0; handSides.current = { left: 0, right: 0 }; setTracking(false); setActiveEngine(null); setModelDelegates({ pose: '—', hand: 'Tắt' }); setParallelHandAvailable(false); setFps(0); setStatus('Đã dừng nhận diện')
  }, [abortCapture])

  const stopCamera = useCallback((preservePending = false) => {
    cameraGeneration.current += 1
    ghostAnchor.current = null
    if (!preservePending) pendingAnchor.current = null
    stopTracking()
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setStreamActive(false); setCameraOpening(false); setActualCameraSize(null)
    setGhost(previous => ({ ...previous, confirmed: false }))
  }, [stopTracking])
  useEffect(() => () => { cameraGeneration.current += 1; generation.current += 1; restoreGeneration.current += 1; saveGeneration.current += 1; stopFrameScheduler.current?.(); if (watchdog.current !== null) clearInterval(watchdog.current); stopBudgetObserver.current?.(); workerRef.current?.close(); parallelWorkerRef.current?.close(); workerAbort.current?.abort(); poseRef.current?.close(); handRef.current?.close(); streamRef.current?.getTracks().forEach(track => track.stop()) }, [])

  const startCamera = async () => {
    stopCamera(!streamRef.current); setDemo(false); setMessage('')
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
    stopTracking(); const requestId = ++generation.current; setStatus('Đang tải MediaPipe…'); setMessage(''); setModelErrors([])
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
      displayPoints.current = { ...displayPoints.current, pose: smoother.current.filter('pose', rawPose, timestamp, POSE_SMOOTHING_POLICY) }
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
    const schedule = (engine: 'main' | 'worker' | 'parallel', infer: (timestamp: number, doHand: boolean, now: number, mediaTime: number, sourceFrameId?: number | null, skippedSourceFrames?: number) => boolean, budget?: AdaptiveWorkerBudget) => {
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
      workerRef.current?.close(); workerRef.current = null; parallelWorkerRef.current?.close(); parallelWorkerRef.current = null; workerAbort.current?.abort(); workerAbort.current = null
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
        const tracker = await createParallelWorkerTracker({ poseWorker: poseThread, handWorker: handThread, moduleUrl, signal: controller.signal, capture: element => createImageBitmap(element),
          onPose: result => { if (requestId === generation.current) budget?.recordResult('pose', { timestamp: result.timestamp, receivedAt: performance.now(), inferenceMs: result.inferenceMs }); acceptPose(result.pose, result.timestamp) },
          onHand: result => { if (result.handFailed) disableHand(); else { if (requestId === generation.current && handActive) budget?.recordResult('hand', { timestamp: result.timestamp, receivedAt: performance.now(), inferenceMs: result.inferenceMs }); handSides.current = handFreshness(result.hands ?? [], result.handedness ?? [], result.timestamp); acceptHand(result.hands ?? [], result.timestamp) } },
          onPoseError: fallback, onHandError: disableHand,
        })
        if (requestId !== generation.current) { tracker.close(); return }
        parallelWorkerRef.current = tracker
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
      const controller = new AbortController(); workerAbort.current = controller
      const worker = new Worker('/tracking-worker.js')
      // Vite emits the MediaPipe module as a same-origin asset for production builds.
      const moduleUrl = new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url).href
      const tracker = await createWorkerTracker({ worker, moduleUrl, handEnabled, signal: controller.signal, capture: element => createImageBitmap(element), onResult: result => {
        if (requestId !== generation.current) return
        if (result.handFailed && handActive) {
          // The failure applies to the model, even when this frame is too old to display.
          handActive = false; handTime.current = 0
          points.current = { ...points.current, hands: [] }; displayPoints.current = { ...displayPoints.current, hands: [] }
          setMessage(result.handCleanupFailed
            ? 'Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Không thể giải phóng model bàn tay; hãy tải lại trang trước khi thử lại.'
            : 'Nhận diện bàn tay bị lỗi; theo dõi tư thế vẫn hoạt động. Dừng và khởi động lại nhận diện để thử lại bàn tay.')
          publishStatus(currentStatus(performance.now()))
        }
        if (result.hands !== null) handSides.current = handFreshness(result.hands, result.handedness ?? [], result.timestamp)
        accept(result.pose, handActive ? result.hands : [], result.timestamp)
      }, onError: () => {
        if (requestId === generation.current) { setMessage('Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính.'); void startMainThread() }
      } })
      if (requestId !== generation.current) { tracker.close(); return }
      workerRef.current = tracker
      schedule('worker', (timestamp, doHand) => tracker.submit(video, timestamp, doHand))
    } catch {
      if (requestId === generation.current) { setMessage('Worker không khả dụng; đang chuyển sang nhận diện trên luồng chính.'); await startMainThread() }
    }
  }

  // Existing stored calibration uses box-relative coordinates. The anchor is
  // session-only and starts from the current display; old records keep their meaning.
  const currentMappedGhost = useCallback((): Ghost => {
    const current = ghostRef.current
    const mapping = videoMapping.current
    if (!streamActive || !streamRef.current || demo || !mapping) return current
    if (pendingAnchor.current) {
      const pending = pendingAnchor.current
      const track = streamRef.current.getVideoTracks()[0]
      const actual = track?.getSettings()
      const video = videoRef.current
      // Wait for the new video mapping; never project onto an old source.
      if (!video?.videoWidth || !video.videoHeight) return current
      pendingAnchor.current = null
      const sameCamera = !!actual?.deviceId && actual.deviceId === pending.deviceId && actual.width === pending.width && actual.height === pending.height && video.videoWidth === pending.width && video.videoHeight === pending.height
      const imageAnchor = fromPersistedGhostAnchor(pending.image, pending.mirrored)
      if (sameCamera && imageAnchor) {
        ghostAnchor.current = imageAnchor
        const next = { ...current, ...mapGhostAnchor(imageAnchor, mapping), confirmed: false }
        ghostRef.current = next; setGhost(next)
        setMessage('Đã khôi phục vị trí theo ảnh. Hãy kiểm tra camera và tư thế, sau đó xác nhận lại.')
        return next
      }
      setMessage('Camera hoặc kích thước khác cấu hình đã lưu; hãy căn chỉnh và xác nhận lại.')
    }
    if (!ghostAnchor.current) { ghostAnchor.current = anchorGhost(current, mapping); return current }
    const mapped = mapGhostAnchor(ghostAnchor.current, mapping)
    if (Math.abs(mapped.x - current.x) < 1e-9 && Math.abs(mapped.y - current.y) < 1e-9 && Math.abs(mapped.scale - current.scale) < 1e-9) return current
    const next = { ...current, ...mapped, confirmed: false }
    ghostRef.current = next
    setGhost(next)
    return next
  }, [streamActive, demo, videoMapping])

  useEffect(() => {
    let animation = 0
    const draw = (time: number) => {
      const canvas = canvasRef.current; const ctx = canvas?.getContext('2d')
      if (canvas && ctx) {
        const display = prepareOverlay(ctx, canvas.width, canvas.height, displayBox.current)
        drawGhost(ctx, display.width, display.height, currentMappedGhost(), settings.mirrored)
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
  }, [ghost, settings.mirrored, showSkeleton, showRaw, demo, videoMapping, displayBox, currentMappedGhost])

  const updateGhost = (changes: Partial<Ghost>) => {
    restoreGeneration.current += 1
    const next = { ...currentMappedGhost(), ...changes, confirmed: false }
    pendingAnchor.current = null
    ghostRef.current = next
    if (streamActive && !demo && videoMapping.current) ghostAnchor.current = anchorGhost(next, videoMapping.current)
    setGhost(next)
  }
  const updateSettings = (changes: Partial<CameraSettings>, restoring = false) => {
    if (!restoring) restoreGeneration.current += 1
    const current = currentMappedGhost()
    if (!restoring) pendingAnchor.current = null
    const reflect = !restoring && streamActive && !!streamRef.current && !demo && !!videoMapping.current && changes.mirrored !== undefined && changes.mirrored !== settings.mirrored
    // The video uses a centered object-position, so reflecting the displayed
    // point around the box center preserves its underlying image location.
    const next = { ...current, x: reflect ? 1 - current.x : current.x, confirmed: false }
    ghostRef.current = next
    if (reflect && videoMapping.current) ghostAnchor.current = anchorGhost(next, videoMapping.current)
    setSettings(previous => ({ ...previous, ...changes }))
    setGhost(next)
  }
  const onSessionChange = (value: string) => {
    restoreGeneration.current += 1
    pendingAnchor.current = null
    setSessionId(value); const session = sessions.find(item => String(item.id) === value)
    setGhost(previous => ({ ...previous, affected_side: session?.affected_side || previous.affected_side, confirmed: false }))
  }
  const restore = async () => {
    if (!sessionId) { setMessage('Hãy chọn một phiên trước khi tải hiệu chuẩn.'); return }
    const requestId = ++restoreGeneration.current
    const cameraRequestId = cameraGeneration.current
    try {
      const records = await calibrationRequest<Calibration[]>(`/api/calibrations?session_id=${encodeURIComponent(sessionId)}`)
      if (requestId !== restoreGeneration.current) return
      if (cameraRequestId !== cameraGeneration.current) { setMessage('Camera đã thay đổi trong khi tải hiệu chuẩn. Hãy khôi phục lại sau khi camera ổn định.'); return }
      const record = records[0]
      if (!record) { setMessage('Chưa có cấu hình hiệu chuẩn cho phiên này.'); return }
      ghostAnchor.current = null
      const restored: Ghost = { ghost_visible: record.ghost_visible, opacity: record.opacity, x: record.x, y: record.y, scale: record.scale, affected_side: record.affected_side, confirmed: false }
      ghostRef.current = restored
      setGhost(restored)
      // Saved x is already expressed in the saved mirror state; do not reflect
      // it again when restoring an unversioned, box-relative calibration.
      updateSettings({ mirrored: record.mirrored }, true)
      const candidate = fromPersistedGhostAnchor(record.image_anchor, false)
      if (candidate && typeof record.mirrored === 'boolean' && typeof record.camera_device_id === 'string' && record.camera_device_id && typeof record.width === 'number' && Number.isFinite(record.width) && record.width > 0 && typeof record.height === 'number' && Number.isFinite(record.height) && record.height > 0) {
        pendingAnchor.current = { image: { version: 1, ...candidate }, deviceId: record.camera_device_id, width: record.width, height: record.height, mirrored: record.mirrored }
      } else pendingAnchor.current = null
      setMessage('Đã tải thông số. Hãy kiểm tra lại camera và tư thế, sau đó xác nhận lại.')
    } catch { if (requestId === restoreGeneration.current) setMessage('Không tải được hiệu chuẩn. Kiểm tra kết nối backend.') }
  }
  const save = async () => {
    if (calibrationSavePending) return
    if (demo || !streamActive || !sessionId) { setMessage('Chọn phiên và bật camera thật trước khi lưu. Chế độ demo không ghi dữ liệu.'); return }
    const currentGhost = currentMappedGhost()
    if (pendingAnchor.current) { setMessage('Đang chờ thông tin camera để khôi phục vị trí theo ảnh; hãy chờ hoặc căn chỉnh thủ công.') ; return }
    if (!ghostFitsCalibration(currentGhost)) { setMessage('Hình bóng nằm ngoài phạm vi hiệu chuẩn. Hãy điều chỉnh lại vị trí và tỷ lệ trước khi lưu.'); return }
    setCalibrationSavePending(true)
    const requestId = ++saveGeneration.current
    const savedSessionId = sessionId
    const savedCameraGeneration = cameraGeneration.current
    const savedRestoreGeneration = restoreGeneration.current
    const isCurrent = () => {
      const current = currentMappedGhost()
      return requestId === saveGeneration.current && savedCameraGeneration === cameraGeneration.current && savedRestoreGeneration === restoreGeneration.current && current.x === currentGhost.x && current.y === currentGhost.y && current.scale === currentGhost.scale && current.confirmed === currentGhost.confirmed && current.affected_side === currentGhost.affected_side && current.opacity === currentGhost.opacity && current.ghost_visible === currentGhost.ghost_visible
    }
    try {
      if (workflow && (!currentGhost.confirmed || !currentGhost.ghost_visible)) { setMessage('Hãy hiển thị hình bóng và xác nhận tư thế trước khi lưu.'); return }
      const setupRevision = workflow ? await workflow.beforeCalibrationSave() : undefined
      if (workflow && !isCurrent()) { setMessage('Camera hoặc hiệu chuẩn đã thay đổi; hãy kiểm tra và lưu lại.'); return }
      const track = streamRef.current?.getVideoTracks()[0]; const actual = track?.getSettings()
      const source = videoRef.current
      const anchor = ghostAnchor.current && videoMapping.current && actual?.deviceId && actualDimension(actual.width) && actualDimension(actual.height) && source && source.videoWidth === actual.width && source.videoHeight === actual.height ? toPersistedGhostAnchor(ghostAnchor.current, settings.mirrored) : null
      const supported = anchor ? await imageAnchorSupported() : false
      if (anchor) {
        const current = currentMappedGhost()
        if (requestId !== saveGeneration.current || savedCameraGeneration !== cameraGeneration.current || savedRestoreGeneration !== restoreGeneration.current || current.x !== currentGhost.x || current.y !== currentGhost.y || current.scale !== currentGhost.scale || current.confirmed !== currentGhost.confirmed || current.affected_side !== currentGhost.affected_side || current.opacity !== currentGhost.opacity || current.ghost_visible !== currentGhost.ghost_visible) {
          if (requestId === saveGeneration.current) setMessage('Camera hoặc hiệu chuẩn đã thay đổi; hãy kiểm tra và lưu lại.')
          return
        }
      }
      const storedAnchor = supported ? anchor : null
      const saved = await calibrationRequest<Calibration>('/api/calibrations', { method: 'POST', body: JSON.stringify({ session_id: Number(savedSessionId), ...currentGhost, camera_label: track?.label || null, camera_device_id: actual?.deviceId || null, width: actualDimension(actual?.width), height: actualDimension(actual?.height), mirrored: settings.mirrored, ...(storedAnchor ? { image_anchor: storedAnchor } : {}), ...(setupRevision !== undefined ? { setup_revision: setupRevision } : {}) }) })
      if (workflow && !isCurrent()) { invalidateWorkflow(); if (requestId === saveGeneration.current) setMessage('Camera hoặc hiệu chuẩn đã thay đổi; hãy kiểm tra và lưu lại.'); return }
      if (requestId === saveGeneration.current) {
        const returned = fromPersistedGhostAnchor(saved.image_anchor, false)
        const retained = !!storedAnchor && !!returned && Math.abs(returned.x - storedAnchor.x) < 1e-9 && Math.abs(returned.y - storedAnchor.y) < 1e-9 && Math.abs(returned.scale - storedAnchor.scale) < 1e-9
        setMessage(retained ? `Đã lưu cấu hình hiệu chuẩn đã gửi cho phiên #${savedSessionId}.` : `Đã lưu cấu hình hiệu chuẩn đã gửi cho phiên #${savedSessionId}. Không xác nhận được vị trí theo ảnh; hãy căn chỉnh lại khi khôi phục.`)
        if (workflow && saved.confirmed) { savedSetup.current = true; workflow.onSetupSaved(saved.id) }
      }
    } catch { if (requestId === saveGeneration.current) setMessage(`Không xác nhận được lưu hiệu chuẩn cho phiên #${savedSessionId}. Hãy kiểm tra cấu hình đã lưu trước khi thử lại.`) }
    finally { setCalibrationSavePending(false) }
  }
  const continueSetup = () => {
    const current = currentMappedGhost()
    if (!workflow || pendingAnchor.current || !current.ghost_visible || !ghostFitsCalibration(current)) return
    const confirmed = { ...current, confirmed: true }
    ghostRef.current = confirmed
    setGhost(confirmed)
    void save()
  }
  const toggleFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await workspaceRef.current?.requestFullscreen() }
    catch { setMessage('Trình duyệt không cho phép toàn màn hình. Hãy kiểm tra quyền trình duyệt.') }
  }

  const startCollection = async () => {
    const session = sessions.find(item => String(item.id) === sessionId)
    if (!session || !streamRef.current || demo || !tracking || activeEngine !== 'main') { setMessage('Chọn phiên và bật nhận diện trên luồng chính với camera thật trước khi thu.'); return }
    const trial = captureTrial.trim() ? Number(captureTrial) : undefined
    if (trial !== undefined && (!Number.isSafeInteger(trial) || trial <= 0)) { setMessage('Mã lượt tập phải là số nguyên dương.'); return }
    try { await capture.start({ patientId: session.patient_id, sessionId: session.id, trialId: trial, stream: streamRef.current, width: actualCameraSize?.width, height: actualCameraSize?.height, recordLandmarks: saveLandmarks, recordVideo: saveVideo, consentLandmarks: landmarkConsent, consentVideo: videoConsent, modelConfig: { pose: 'pose_landmarker_lite.task', hand: handRef.current ? 'hand_landmarker.task' : null, profile: settings.trackingProfile || 'balanced', engine: 'main' } }) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể bắt đầu thu dữ liệu.') }
  }

  return <section ref={workspaceRef} hidden={!!workflow && workflow.view === 'monitor'} className={`${settings.tvMode ? 'workspace workspace-tv' : 'workspace'}${workflow ? ` clinical-workspace clinical-${workflow.view}` : ''}`}>
    <CaptureNavigationGuard shouldBlock={() => capture.busy || capture.isActive()} />
    <div className="workspace-heading"><div><p className="workspace-eyebrow">{workflow?.view === 'game' ? 'KHÔNG GIAN THỰC HÀNH' : 'THIẾT LẬP CAMERA'}</p>{workflow ? <h2>{workflow.view === 'game' ? 'Thực hiện bài tập' : 'Căn chỉnh camera'}</h2> : <h1>Camera & hiệu chuẩn</h1>}<p>{workflow?.view === 'game' ? 'Thực hiện trò chơi theo hướng dẫn trên màn hình.' : 'Điều chỉnh ghế và hình bóng tham chiếu trước khi bắt đầu.'}</p></div>{workflow?.view === 'setup' && <span className="workspace-tag">Nhân viên kiểm tra tư thế</span>}</div>
    {message && <div className="workspace-message" role="status" aria-label="Thông báo camera và hiệu chuẩn">{message}<button aria-label="Đóng thông báo" onClick={() => setMessage('')}>×</button></div>}
    {sessionsError && <div className="workspace-message" role="alert">{sessionsError}</div>}
    <div className="workspace-grid">
      <div className="workspace-main">
        <div className="workspace-stage" style={{ '--stage-aspect': size.width / size.height } as CSSProperties}>
          <div className="workspace-image" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
            <video ref={videoRef} muted playsInline className={settings.mirrored ? 'mirrored' : ''} />
            {!streamActive && <div className="workspace-empty">{demo ? 'KHUNG MÔ PHỎNG' : 'Camera đang tắt'}<small>{demo ? 'Chuyển động mốc được tạo để thử giao diện' : 'Bật camera hoặc chọn chế độ demo để bắt đầu'}</small></div>}
            <canvas ref={canvasRef} width={size.width} height={size.height} aria-label="Lớp phủ hiệu chuẩn và mốc vận động" />
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
        {!workflow && <div className="workspace-meta"><span>{demo ? 'Mốc mô phỏng' : status}</span><span>{fps} FPS suy luận Pose</span>{activeEngine && <span>{activeEngine === 'parallel' ? parallelHandAvailable ? 'CPU · hai Worker' : 'CPU · Worker Pose' : activeEngine === 'worker' ? 'CPU · Worker' : `Pose: ${modelDelegates.pose} | Hand: ${modelDelegates.hand} · luồng chính`}</span>}<span>Yêu cầu camera: {requestedCameraSize.width} × {requestedCameraSize.height}</span>{streamActive && <span>Camera thực tế: {actualCameraSize ? `${actualCameraSize.width} × ${actualCameraSize.height}` : 'không xác định'}</span>}</div>}
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
        <div><p className="workspace-eyebrow">{workflow ? 'CĂN CHỈNH' : 'THIẾT LẬP PHIÊN'}</p><h2>{workflow ? 'Căn chỉnh camera' : 'Hiệu chuẩn tư thế'}</h2><p>{workflow ? 'Điều chỉnh ghế và hình bóng; nhân viên kiểm tra đầu, vai, thân trước khi tiếp tục.' : 'Điều chỉnh ghế để đầu, vai và thân trùng hình bóng. Hình bóng chỉ hỗ trợ căn chỉnh tư thế.'}</p></div>
        {!controlledSession && <label>Phiên tập<select value={sessionId} disabled={capture.isActive() || capture.busy} onChange={event => onSessionChange(event.target.value)}><option value="">Chọn phiên</option>{sessions.map(item => <option key={item.id} value={item.id}>Phiên #{item.id} · Bệnh nhân #{item.patient_id}</option>)}</select></label>}
        <label>Camera<select value={settings.cameraId || ''} onChange={event => { stopCamera(); updateSettings({ cameraId: event.target.value }) }}><option value="">Camera mặc định</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Camera'}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={settings.mirrored} onChange={event => updateSettings({ mirrored: event.target.checked })} /> Lật ảnh ngang</label>
        <label className="check"><input type="checkbox" checked={ghost.ghost_visible} onChange={event => updateGhost({ ghost_visible: event.target.checked })} /> Hiển thị hình bóng</label>
        <label className="check"><input type="checkbox" disabled={tracking || starting} checked={handEnabled} onChange={event => { setHandEnabled(event.target.checked); if (!event.target.checked) setPreferParallel(false) }} /> Theo dõi 21 mốc bàn tay</label>
        {!workflow && <>
        <label className="check"><input type="checkbox" checked={showSkeleton} onChange={event => setShowSkeleton(event.target.checked)} /> Hiển thị mốc vận động</label>
        <label className="check"><input type="checkbox" checked={showRaw} onChange={event => setShowRaw(event.target.checked)} /> Hiển thị mốc thô (không làm mượt)</label>
        <label>Hiệu năng<select disabled={streamActive || cameraOpening} value={settings.trackingProfile || 'balanced'} onChange={event => updateSettings({ trackingProfile: event.target.value as TrackingProfileName })}><option value="economy">Economy</option><option value="balanced">Balanced</option><option value="quality">Quality</option></select></label>
        <label className="check"><input type="checkbox" disabled={streamActive || cameraOpening} checked={settings.profileCameraResolution} onChange={event => updateSettings({ profileCameraResolution: event.target.checked })} /> Dùng độ phân giải camera theo cấu hình tracking</label>
        <p className="workspace-hint">Kích thước theo cấu hình là yêu cầu gửi tới camera; thiết bị có thể chọn kích thước khác. Kiểm tra lại hiệu chuẩn khi thay đổi khung hình.</p>
        <label className="check"><input type="checkbox" disabled={tracking || starting} checked={settings.workerTracking && !preferParallel} onChange={event => { setSettings(previous => ({ ...previous, workerTracking: event.target.checked })); if (event.target.checked) setPreferParallel(false) }} /> Sử dụng Worker CPU (thử nghiệm)</label>
        <label className="check"><input type="checkbox" disabled={tracking || starting || !handEnabled} checked={preferParallel} onChange={event => setPreferParallel(event.target.checked)} /> Sử dụng hai Worker CPU (thử nghiệm)</label>
        <label className="check"><input type="checkbox" disabled={tracking || starting || !preferParallel} checked={adaptiveParallel} onChange={event => setAdaptiveParallel(event.target.checked)} /> Tự điều chỉnh nhịp hai Worker (thử nghiệm)</label>
        {preferParallel && <p className="workspace-hint">Tự điều chỉnh dùng thời gian nhận kết quả và độ phản hồi giao diện; không đo hoặc bảo đảm phần CPU còn lại của toàn máy. Giới hạn FPS không phải FPS thực tế.</p>}
        {activeEngine === 'main' && <p role="status">Pose: {modelDelegates.pose} | Hand: {modelDelegates.hand}</p>}
        {modelErrors.length > 0 && <details><summary>Lỗi khởi tạo / suy luận MediaPipe</summary>{modelErrors.map((error, index) => <p key={index}>{error}</p>)}</details>}
        <p className="workspace-hint">Dừng nhận diện để thay đổi. Hai Worker cần bật bàn tay và có thể xử lý các frame khác nhau. Nếu Pose Worker không khả dụng, hệ thống sẽ thử GPU trên luồng chính, rồi CPU nếu GPU lỗi.</p>
        <label>Độ trong suốt <span>{Math.round(ghost.opacity * 100)}%</span><input type="range" min="0.1" max="1" step="0.05" value={ghost.opacity} onChange={event => updateGhost({ opacity: Number(event.target.value) })} /></label>
        </>}
        <label>Vị trí ngang <span>{Math.round(ghost.x * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={ghost.x} onChange={event => updateGhost({ x: Number(event.target.value) })} /></label>
        <label>Vị trí dọc <span>{Math.round(ghost.y * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={ghost.y} onChange={event => updateGhost({ y: Number(event.target.value) })} /></label>
        <label>Tỷ lệ <span>{Math.round(ghost.scale * 100)}%</span><input type="range" min="0.2" max="3" step="0.05" value={ghost.scale} onChange={event => updateGhost({ scale: Number(event.target.value) })} /></label>
        {!workflow && <label>Tay ảnh hưởng<select value={ghost.affected_side} onChange={event => updateGhost({ affected_side: event.target.value as 'left' | 'right' })}><option value="left">Trái</option><option value="right">Phải</option></select></label>}
        {!ghostFitsCalibration(ghost) && <p role="alert">Hình bóng nằm ngoài phạm vi hiệu chuẩn. Hãy điều chỉnh lại vị trí và tỷ lệ.</p>}
        {pendingAnchor.current && <p>Đang chờ thông tin camera để khôi phục vị trí theo ảnh; căn chỉnh thủ công để bỏ chờ.</p>}
        {workflow ? <div className="workspace-panel-actions"><button className="primary" onClick={continueSetup} disabled={!sessionId || demo || !streamActive || saving || !!pendingAnchor.current || !ghost.ghost_visible || !ghostFitsCalibration(ghost)}>Tiếp theo</button></div> : <>
          <label className="check confirm"><input type="checkbox" checked={ghost.confirmed} disabled={demo || !streamActive || !!pendingAnchor.current || !ghostFitsCalibration(ghost)} onChange={event => { const current = currentMappedGhost(); if (pendingAnchor.current || !ghostFitsCalibration(current)) return; const next = { ...current, confirmed: event.target.checked }; ghostRef.current = next; setGhost(next) }} /> Tôi đã kiểm tra vị trí và tư thế người bệnh</label>
          <div className="workspace-panel-actions"><button onClick={restore} disabled={!sessionId}>Khôi phục cấu hình</button><button className="primary" onClick={save} disabled={!sessionId || demo || !streamActive || saving || !!pendingAnchor.current || !ghostFitsCalibration(ghost)}>Lưu hiệu chuẩn</button></div>
          <p className="workspace-hint">Cánh tay màu vàng biểu thị tay ảnh hưởng. Hình bóng chỉ là công cụ căn chỉnh, không tự xác định tư thế đạt chuẩn lâm sàng. Không lưu dữ liệu demo.</p>
        </>}
      </aside>
    </div>
  </section>
}

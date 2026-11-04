import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, RefObject } from 'react'
import type { Session } from '../../types'
import type { Side } from './drawing'
import { DrawingController } from './freeDrawing'
import type { DrawingObservation, DrawingRejectionReason, DrawingSegment } from './freeDrawing'
import { drawDrawingOverlay, drawingViewport, redrawDrawing, renderDrawingSegment } from './freeDrawingRenderer'
import type { FlowerWorkflow, SavedGameResult } from './gameWorkflow'
import type { Size, VideoMapping } from './videoGeometry'
import type { TrackingDiagnostics } from './trackingDiagnostics'
import './freeDrawing.css'

type Props = {
  enabled: boolean; demo: boolean; streamActive: boolean; tracking: boolean; mirrored: boolean
  side: Side; confirmed: boolean; session: Session | undefined; size: Size
  mapping: RefObject<VideoMapping | null>; displayBox: RefObject<Size | null>; workflow?: FlowerWorkflow
  diagnostics?: TrackingDiagnostics; developmentReplay?: boolean
}
type Phase = 'idle' | 'playing' | 'finished'
type SaveState = 'idle' | 'saving' | 'saved' | 'failed'
const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
const palette = [{ name: 'Hồng', color: '#ff69b4' }, { name: 'Vàng', color: '#ffdf5d' }, { name: 'Xanh ngọc', color: '#51e5ef' }, { name: 'Trắng', color: '#f4f8ff' }]

/** Consumes existing Hand callbacks; this hook owns artwork and never owns inference. */
export function useFreeDrawingGame(props: Props) {
  const { enabled, demo, streamActive, tracking, mirrored, side, confirmed, session, size, mapping, displayBox, workflow } = props
  const [phase, setPhase] = useState<Phase>('idle')
  const [mode, setMode] = useState<'gesture' | 'assisted'>('gesture')
  const [interactionMode, setInteractionMode] = useState<'draw' | 'move'>('draw')
  const [cursorSource, setCursorSource] = useState<'index' | 'wrist'>('index')
  const [color, setColor] = useState(palette[0].color), [width, setWidth] = useState(5)
  const [saveState, setSaveState] = useState<SaveState>('idle'), [message, setMessage] = useState('')
  const [preparing, setPreparing] = useState(false), [clearPending, setClearPending] = useState(false)
  const [verifyHandPending, setVerifyHandPending] = useState(false)
  const inputBlocked = useRef(false); inputBlocked.current = clearPending || verifyHandPending
  const [summary, setSummary] = useState({ elapsedMs: 0, strokes: 0, status: 'ready', penDown: false, observed: false, selected: false, cursorAvailable: false, armed: false, gestureActive: null as boolean | null, reason: null as DrawingRejectionReason | null, selectedStrokeId: null as number | null, draggingInterrupted: false })
  const logicalSize = useRef<Size>({ width: 1000, height: 562.5 })
  const controller = useRef(new DrawingController({ side, mode, interactionMode, cursorSource, color, width, logicalSize: logicalSize.current }))
  const artwork = useRef<HTMLCanvasElement>(null), overlayCanvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props); latest.current = props
  const phaseRef = useRef(phase); phaseRef.current = phase
  const trial = useRef<number | null>(null), roundId = useRef(''), generation = useRef(0)
  const trialOwner = useRef<FlowerWorkflow | undefined>(undefined)
  const preparingRef = useRef(false), saving = useRef(false), saved = useRef(false)
  const startedAt = useRef(0), elapsedMs = useRef(0), observed = useRef(false)
  const pendingStart = useRef<{ context: string; roundId: string } | null>(null)
  const frozenPayload = useRef<string | null>(null), overlayDirty = useRef(true)
  const geometryCutoff = useRef(0)
  const pointerId = useRef<number | null>(null)
  const previousSourceSize = useRef(`${size.width}|${size.height}`)
  const context = `${enabled}|${demo}|${streamActive}|${tracking}|${mirrored}|${side}|${confirmed}|${session?.id}|${workflow?.enabled}|${workflow?.setupReady}|${workflow?.exerciseId}|${workflow?.attempt}|${props.developmentReplay}`
  const liveContext = useRef(context); liveContext.current = context
  const previousContext = useRef(context)
  const replay = Boolean(import.meta.env.DEV && props.developmentReplay && !workflow && !session && !demo)
  const durationMs = replay ? Infinity : Math.min(600, Math.max(1, workflow?.durationSeconds || 120)) * 1000

  const reportDrawing = () => latest.current.diagnostics?.recordDrawing({ ...controller.current.diagnostics, completedStrokes: controller.current.completedStrokeCount })
  const refreshSummary = () => {
    const current = controller.current, state = current.diagnostics
    setSummary({ elapsedMs: elapsedMs.current, strokes: current.completedStrokeCount, status: current.phase, penDown: state.penDown, observed: observed.current, selected: state.selected, cursorAvailable: current.cursor !== null, armed: state.armed, gestureActive: state.gestureActive, reason: state.reason, selectedStrokeId: current.selectedStrokeId, draggingInterrupted: current.draggingInterrupted })
  }
  const display = () => displayBox.current || size
  const prepareContext = (canvas: HTMLCanvasElement | null) => {
    const ctx = canvas?.getContext('2d')
    if (ctx && canvas) { const box = display(); ctx.setTransform(canvas.width / box.width, 0, 0, canvas.height / box.height, 0, 0) }
    return ctx
  }
  const rebuild = () => {
    const ctx = prepareContext(artwork.current)
    if (ctx) redrawDrawing(ctx, controller.current.strokes, logicalSize.current, display())
    overlayDirty.current = true
  }
  const append = (segment: DrawingSegment | null) => {
    const ctx = segment ? prepareContext(artwork.current) : null
    if (ctx && segment) renderDrawingSegment(ctx, segment, logicalSize.current, display())
    overlayDirty.current = true
  }
  const resetInput = () => { controller.current.resetInput(); geometryCutoff.current = performance.now(); pointerId.current = null; overlayDirty.current = true; reportDrawing() }
  const stop = () => {
    if (phaseRef.current !== 'playing') return
    elapsedMs.current = Math.min(durationMs, Math.max(0, performance.now() - startedAt.current))
    controller.current.finish(); phaseRef.current = 'finished'; setPhase('finished'); reportDrawing(); refreshSummary(); overlayDirty.current = true
    setClearPending(false); setVerifyHandPending(false)
  }
  const isPlaying = () => {
    if (phaseRef.current === 'playing' && performance.now() - startedAt.current >= durationMs) stop()
    return phaseRef.current === 'playing'
  }

  useEffect(() => {
    if (previousContext.current === context) return
    previousContext.current = context; generation.current += 1
    preparingRef.current = false; setPreparing(false); pendingStart.current = null
    controller.current.suspend(); overlayDirty.current = true; reportDrawing()
    if (phaseRef.current !== 'idle') {
      if (trial.current && !saved.current) trialOwner.current?.onRoundAbandoned?.()
      phaseRef.current = 'idle'; setPhase('idle'); trial.current = null; roundId.current = ''; frozenPayload.current = null
      setMessage('Điều kiện buổi tập hoặc camera đã thay đổi. Lượt chưa được xác nhận lưu; hãy kiểm tra lại trước khi bắt đầu.')
      setSaveState('idle')
    }
  }, [context])
  useEffect(() => () => {
    generation.current += 1; controller.current.finish()
    if (trial.current && !saved.current) trialOwner.current?.onRoundAbandoned?.()
  }, [])
  useEffect(() => {
    const sourceSize = `${size.width}|${size.height}`
    if (previousSourceSize.current !== sourceSize) { previousSourceSize.current = sourceSize; resetInput() }
    rebuild()
  }, [enabled, size.width, size.height])

  useEffect(() => {
    if (!enabled) return
    let frame = 0, lastPublish = 0, previousBox = '', previousGeometry = ''
    const tick = (now: number) => {
      const current = controller.current, before = current.phase, beforeReason = current.diagnostics.reason
      if (phaseRef.current === 'playing' && !latest.current.demo) current.checkFreshness(now)
      if (current.phase !== before || current.diagnostics.reason !== beforeReason) {
        overlayDirty.current = true; reportDrawing(); refreshSummary()
        const reason = current.diagnostics.reason
        if (reason) latest.current.diagnostics?.reject(reason)
      }
      const box = display(), boxKey = `${box.width}|${box.height}`
      const geometry = mapping.current
      const geometryKey = geometry ? `${boxKey}|${geometry.rect.x}|${geometry.rect.y}|${geometry.rect.width}|${geometry.rect.height}` : ''
      if (previousGeometry && geometryKey !== previousGeometry && phaseRef.current === 'playing') {
        current.resetInput(); geometryCutoff.current = now; overlayDirty.current = true; reportDrawing()
      }
      previousGeometry = geometryKey
      if (boxKey !== previousBox) { previousBox = boxKey; rebuild() }
      if (overlayDirty.current) {
        const ctx = prepareContext(overlayCanvas.current)
        const overlayMapping = mapping.current || (demo ? { box, rect: { x: 0, y: 0, ...box } } : null)
        if (ctx) {
          ctx.clearRect(0, 0, box.width, box.height)
          if (overlayMapping) {
            drawDrawingOverlay(ctx, { cursor: current.cursor, hand: demo ? null : current.hand, drawing: current.phase === 'drawing', dragging: current.phase === 'dragging', grabbedStrokes: current.strokes.filter(stroke => current.grabbedStrokeIds.includes(stroke.id)), highlightedStrokes: current.strokes.filter(stroke => stroke.id === current.selectedStrokeId) }, overlayMapping, mirrored, logicalSize.current, box)
            if (current.hand && !demo) latest.current.diagnostics?.recordRender(current.diagnostics.observationTimestamp)
            overlayDirty.current = false
          }
        }
      }
      if (phaseRef.current === 'playing') {
        elapsedMs.current = Math.min(durationMs, Math.max(0, now - startedAt.current))
        if (elapsedMs.current >= durationMs) stop()
      }
      if (now - lastPublish >= 250 && phaseRef.current === 'playing') { lastPublish = now; refreshSummary() }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [enabled, demo, mirrored, size.width, size.height, durationMs])

  const onHandObservation = (observation: DrawingObservation) => {
    const current = latest.current
    isPlaying()
    if (!current.enabled || current.demo || inputBlocked.current || phaseRef.current !== 'playing' || !current.tracking || !current.streamActive || !current.mapping.current || observation.timestamp < geometryCutoff.current) {
      current.diagnostics?.recordDrawing({ reason: phaseRef.current === 'finished' ? 'EXERCISE_FINISHED' : 'DRAWING_PAUSED', selected: false, armed: false, gestureActive: null, penDown: false, observationTimestamp: observation.timestamp })
      return
    }
    const before = controller.current.diagnostics, previousPhase = controller.current.phase, previousSelection = controller.current.selectedStrokeId
    const result = controller.current.update(observation, performance.now(), current.mapping.current, current.mirrored)
    if (controller.current.cursor) observed.current = true
    reportDrawing()
    const after = controller.current.diagnostics
    if (after.reason) current.diagnostics?.reject(after.reason)
    if (before.selected !== after.selected || before.reason !== after.reason || before.armed !== after.armed || before.penDown !== after.penDown || before.gestureActive !== after.gestureActive || previousPhase !== controller.current.phase || previousSelection !== controller.current.selectedStrokeId) refreshSummary()
    if (result.artworkChanged) rebuild()
    else append(result.segment)
  }
  const sessionReady = workflow ? session?.status === 'in_progress' : !session || session.status === 'in_progress'
  const canStart = enabled && (demo || Boolean(streamActive && tracking && (replay || confirmed && sessionReady))) && (!workflow || Boolean(workflow.enabled && workflow.setupReady && workflow.exerciseId))
  const start = async () => {
    if (!canStart || phaseRef.current !== 'idle' || preparingRef.current || saving.current) return
    if (!demo && typeof crypto.randomUUID !== 'function') { setMessage('Không tạo được mã lượt. Hãy mở ứng dụng trên localhost hoặc HTTPS.'); return }
    const startContext = context, request = ++generation.current
    const id = demo ? '' : pendingStart.current?.context === context ? pendingStart.current.roundId : crypto.randomUUID()
    let persistedTrial: number | null = null
    if (workflow && !demo) {
      preparingRef.current = true; setPreparing(true); setMessage(''); pendingStart.current = { context, roundId: id }
      try {
        persistedTrial = await workflow.createTrial(id)
        if (request !== generation.current || liveContext.current !== startContext) { workflow.onRoundAbandoned?.(); return }
      } catch (error) { if (request === generation.current) setMessage(error instanceof Error ? error.message : 'Không tạo được lượt. Hãy thử lại.'); return }
      finally { if (request === generation.current) { preparingRef.current = false; setPreparing(false) } }
    }
    logicalSize.current = { width: 1000, height: 1000 * size.height / size.width }
    controller.current = new DrawingController({ side, mode, interactionMode, cursorSource: interactionMode === 'draw' && mode === 'gesture' ? 'index' : cursorSource, color, width, logicalSize: logicalSize.current })
    trial.current = persistedTrial; trialOwner.current = workflow; roundId.current = id; pendingStart.current = null; frozenPayload.current = null
    startedAt.current = performance.now(); elapsedMs.current = 0; observed.current = false; saved.current = false; geometryCutoff.current = startedAt.current
    setSaveState('idle'); setMessage(''); setClearPending(false); setVerifyHandPending(false); phaseRef.current = 'playing'; setPhase('playing'); rebuild(); reportDrawing(); refreshSummary()
  }
  const configure = (change: Parameters<DrawingController['configure']>[0]) => { controller.current.configure(change); rebuild(); reportDrawing(); refreshSummary() }
  const changeInteraction = (value: typeof interactionMode) => { setInteractionMode(value); configure({ interactionMode: value, cursorSource: value === 'draw' && mode === 'gesture' ? 'index' : cursorSource }) }
  const toggleGrab = () => {
    if (!isPlaying() || inputBlocked.current) return
    if (controller.current.phase === 'dragging') controller.current.releaseStroke()
    else controller.current.grabStroke(performance.now())
    rebuild(); reportDrawing(); refreshSummary()
  }
  const togglePen = () => { if (!isPlaying() || inputBlocked.current) return; controller.current.checkFreshness(performance.now()); controller.current.setPenDown(!controller.current.penDown); overlayDirty.current = true; reportDrawing(); refreshSummary() }
  const undo = () => { controller.current.undo(); rebuild(); reportDrawing(); refreshSummary() }
  const clear = () => { controller.current.clear(); controller.current.resume(); rebuild(); reportDrawing(); refreshSummary(); setClearPending(false) }
  const reset = () => { controller.current.reset(); phaseRef.current = 'idle'; setPhase('idle'); elapsedMs.current = 0; observed.current = false; setSaveState('idle'); setMessage(''); rebuild(); reportDrawing(); refreshSummary() }
  const cancelEmpty = async () => {
    if (!workflow?.cancelTrial || !trial.current || observed.current || saving.current) return
    const request = ++generation.current; saving.current = true; setSaveState('saving')
    try { await workflow.cancelTrial(trial.current); if (request === generation.current) { trial.current = null; reset() } }
    catch (error) { if (request === generation.current) { setSaveState('failed'); setMessage(error instanceof Error ? error.message : 'Chưa hủy được lượt. Hãy thử lại.') } }
    finally { saving.current = false }
  }
  const save = async () => {
    if (demo || !workflow || !trial.current || session?.session_type !== 'training' || !roundId.current || phaseRef.current !== 'finished' || !observed.current || elapsedMs.current <= 0 || saving.current || saved.current) return
    if (!frozenPayload.current) frozenPayload.current = JSON.stringify({ session_id: session.id, round_id: roundId.current, game_key: 'free_drawing', affected_side: side, duration_seconds: elapsedMs.current / 1000, completed_strokes: controller.current.completedStrokeCount, active_drawing_seconds: Math.min(elapsedMs.current, controller.current.activeDrawingMs) / 1000, source: 'camera', ...(trial.current ? { trial_id: trial.current } : {}) })
    const request = ++generation.current; saving.current = true; setSaveState('saving'); setMessage('')
    try {
      const response = await fetch(`${apiBase}/api/exercise-results`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: frozenPayload.current })
      if (!response.ok) throw new Error('Save failed')
      const result: SavedGameResult = await response.json()
      if (request !== generation.current) return
      saved.current = true; setSaveState('saved'); setMessage('Đã lưu hoạt động vẽ vào buổi tập.'); workflow?.onResultSaved(result)
    } catch { if (request === generation.current) { setSaveState('failed'); setMessage('Chưa xác nhận được kết quả lưu. Thử lại sẽ dùng đúng mã lượt và dữ liệu cũ.') } }
    finally { saving.current = false }
  }
  const exportPNG = () => {
    const canvas = document.createElement('canvas'); canvas.width = Math.round(logicalSize.current.width); canvas.height = Math.round(logicalSize.current.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) { setMessage('Trình duyệt chưa tạo được ảnh PNG.'); return }
    redrawDrawing(ctx, controller.current.strokes, logicalSize.current, logicalSize.current)
    ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#0b1223'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    canvas.toBlob(blob => {
      if (!blob) { setMessage('Không xuất được ảnh PNG. Hãy thử lại.'); return }
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 've-tu-do.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }
  const onPointer = (event: PointerEvent<HTMLCanvasElement>, down: boolean) => {
    if (!demo || inputBlocked.current || !isPlaying() || (pointerId.current !== null && pointerId.current !== event.pointerId)) return
    const bounds = event.currentTarget.getBoundingClientRect(), box = { width: bounds.width, height: bounds.height }
    if (!box.width || !box.height) return
    const viewport = drawingViewport(logicalSize.current, box)
    const point = { x: (event.clientX - bounds.left - viewport.x) * logicalSize.current.width / viewport.width, y: (event.clientY - bounds.top - viewport.y) * logicalSize.current.height / viewport.height }
    if (point.x < 0 || point.y < 0 || point.x > logicalSize.current.width || point.y > logicalSize.current.height) { controller.current.updatePointer(null, performance.now(), false); overlayDirty.current = true; return }
    const previousPhase = controller.current.phase, previousSelection = controller.current.selectedStrokeId
    const result = controller.current.updatePointer(point, performance.now(), down)
    if (previousPhase !== controller.current.phase || previousSelection !== controller.current.selectedStrokeId) refreshSummary()
    if (result.artworkChanged) rebuild()
    else append(result.segment)
  }
  const endPointer = (event: PointerEvent<HTMLCanvasElement>) => { if (!demo || pointerId.current !== event.pointerId) return; onPointer(event, false); pointerId.current = null; controller.current.setPenDown(false); overlayDirty.current = true }
  const locked = phase !== 'idle' || preparing
  const editLocked = phase === 'finished'
  const penDisabled = inputBlocked.current || (!summary.penDown && (!summary.selected || !summary.cursorAvailable || summary.status !== 'ready'))
  const grabbing = summary.status === 'dragging'
  const grabDisabled = inputBlocked.current || phase !== 'playing' || (!grabbing && (!summary.cursorAvailable || summary.selectedStrokeId === null || !demo && !summary.selected))
  const remainingSeconds = Math.max(0, Math.ceil((durationMs - summary.elapsedMs) / 1000))
  const trackingStatus = summary.selected
    ? `Đã nhận tay ${side === 'left' ? 'trái' : 'phải'} bên tập${!summary.cursorAvailable ? ' · Đưa điểm điều khiển vào bảng vẽ' : ''}`
    : summary.reason === 'RAW_HAND_MISSING' ? 'Mất tracking · Chưa nhận diện được bàn tay'
      : summary.reason === 'STALE_HAND' ? 'Mất tracking · Đang chờ mốc bàn tay mới'
        : summary.reason === 'HAND_INVALID' ? 'Mất tracking · Mốc bàn tay chưa hợp lệ'
          : 'Mất tracking · Đang xác định tay bên tập'
  const penStatus = interactionMode === 'move' ? 'Nhấc bút · Chế độ di chuyển' : summary.penDown ? 'Đang vẽ' : summary.gestureActive ? 'Đã nhận ngón trỏ · Đang chờ ổn định' : 'Nhấc bút'
  const selectionStatus = summary.draggingInterrupted ? 'Kéo nét bị gián đoạn · Đưa con trỏ về nét và chọn Cầm nét lại' : grabbing ? 'Đang kéo nét · Chọn Thả nét để đặt' : summary.selectedStrokeId !== null ? 'Đã chọn nét · Chọn Cầm nét' : 'Chưa chọn nét'
  const status = phase === 'finished' ? 'Bài vẽ đã kết thúc' : summary.status === 'paused' ? 'Bài vẽ đang chờ xác nhận · Nhấc bút' : grabbing ? 'Đang kéo nét · Chọn Thả nét để đặt' : `${trackingStatus} · ${penStatus}`
  const modeControls = (inHud = false) => <div className="free-drawing-modes" role="group" aria-label={inHud ? 'Thao tác trên bảng vẽ' : 'Thao tác nét vẽ'}>
    <button aria-label={inHud ? 'Vẽ trên bảng vẽ' : 'Vẽ'} aria-pressed={interactionMode === 'draw'} disabled={editLocked || preparing || inputBlocked.current} onClick={() => changeInteraction('draw')}>Vẽ</button>
    <button aria-label={inHud ? 'Chọn / Di chuyển trên bảng vẽ' : 'Chọn / Di chuyển'} aria-pressed={interactionMode === 'move'} disabled={editLocked || preparing || inputBlocked.current} onClick={() => changeInteraction('move')}>Chọn / Di chuyển</button>
  </div>
  const grabControl = (inHud = false) => <button className="primary free-drawing-grab" aria-label={inHud ? `${grabbing ? 'Thả nét' : 'Cầm nét'} trên bảng vẽ` : grabbing ? 'Thả nét' : 'Cầm nét'} aria-pressed={grabbing} disabled={grabDisabled} onClick={toggleGrab}>{grabbing ? 'Thả nét' : 'Cầm nét'}</button>
  const overlay = enabled ? <div className="free-drawing-board">
    <canvas ref={artwork} width={size.width} height={size.height} className="free-drawing-artwork" aria-label="Tranh vẽ tự do" />
    <canvas ref={overlayCanvas} width={size.width} height={size.height} className={`free-drawing-cursor${demo ? ' free-drawing-demo' : ''}`} aria-label={demo ? 'Vùng vẽ demo bằng chuột hoặc chạm' : 'Con trỏ và bàn tay bên tập'} onPointerDown={event => { if (!demo) return; pointerId.current = event.pointerId; event.currentTarget.setPointerCapture?.(event.pointerId); onPointer(event, true) }} onPointerMove={event => onPointer(event, pointerId.current === event.pointerId)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer} />
    {phase === 'finished' && <div className="free-drawing-finished" aria-label="Bài vẽ đã kết thúc"><strong>Bài vẽ đã kết thúc</strong><p>Không thể vẽ hoặc di chuyển nét sau khi kết thúc lượt.</p><p>{workflow ? 'Xác nhận lưu kết quả bên dưới để tiếp tục theo buổi tập.' : 'Xuất PNG hoặc chọn Vẽ lượt mới để bắt đầu lại.'}</p></div>}
  </div> : null
  const hud = enabled ? <div className="free-drawing-hud" role="group" aria-label="Điều khiển bài vẽ">
    <strong className={`free-drawing-time${phase === 'finished' ? ' is-finished' : ''}`}>{phase === 'finished' ? 'Bài vẽ đã kết thúc' : replay ? 'Replay · Không giới hạn giờ' : `Còn ${remainingSeconds}s`}</strong>
    <span>{Math.floor(summary.elapsedMs / 1000)}s · {summary.strokes} nét</span>
    {phase === 'idle' && <button className="primary" disabled={!canStart || locked} onClick={() => void start()}>{preparing ? 'Đang chuẩn bị…' : 'Bắt đầu vẽ'}</button>}
    {phase === 'playing' && modeControls(true)}
    {phase === 'playing' && interactionMode === 'move' && grabControl(true)}
    {phase === 'playing' && interactionMode === 'draw' && mode === 'assisted' && !demo && <button className="primary" aria-label={summary.penDown ? 'Nhấc bút trên bảng vẽ' : 'Hạ bút trên bảng vẽ'} aria-pressed={summary.penDown} disabled={penDisabled} onClick={togglePen}>{summary.penDown ? 'Nhấc bút' : 'Hạ bút'}</button>}
    {phase === 'playing' && <button onClick={stop}>Kết thúc bài vẽ</button>}
    {phase === 'finished' && !workflow && !replay && <button aria-label="Vẽ lượt mới trên bảng vẽ" onClick={reset}>Vẽ lượt mới</button>}
    {phase === 'playing' && !demo && <small className="free-drawing-live-state">{status}</small>}
  </div> : null
  const panel = enabled ? <div className="workspace-info free-drawing-panel">
    <div><strong>Vẽ tự do · Tay {side === 'left' ? 'trái' : 'phải'}</strong><p>Vẽ và di chuyển hình bằng tay bên tập. Hoạt động này không chấm FMA-UE hoặc đánh giá khả năng phục hồi.</p></div>
    {modeControls()}
    <p>{interactionMode === 'draw' ? 'Giơ ngón trỏ để vẽ. Hạ tay hoặc đổi cử chỉ để nhấc bút.' : 'Đưa con trỏ đến nét vẽ, chọn Cầm nét, di chuyển tay rồi chọn Thả nét.'}</p>
    <div className="free-drawing-options">
      <label>Chế độ vẽ<select aria-label="Chế độ vẽ" value={mode} disabled={locked} onChange={event => { const value = event.target.value as typeof mode; setMode(value); configure({ mode: value, cursorSource: interactionMode === 'draw' && value === 'gesture' ? 'index' : cursorSource }) }}><option value="gesture">Cử chỉ — giơ ngón trỏ để vẽ</option><option value="assisted">Hỗ trợ — nút hạ / nhấc bút</option></select></label>
      {(mode === 'assisted' || interactionMode === 'move') && <label>Điểm điều khiển<select aria-label="Điểm điều khiển" value={cursorSource} disabled={editLocked || preparing || inputBlocked.current || grabbing} onChange={event => { const value = event.target.value as typeof cursorSource; setCursorSource(value); configure({ cursorSource: value }) }}><option value="wrist">Cổ tay</option><option value="index">Đầu ngón trỏ</option></select></label>}
      <div className="free-drawing-palette" role="group" aria-label="Màu bút">{palette.map(item => <button key={item.color} aria-label={item.name} aria-pressed={color === item.color} style={{ background: item.color }} disabled={editLocked} onClick={() => { setColor(item.color); configure({ color: item.color }) }} />)}</div>
      <label>Độ dày<select aria-label="Độ dày bút" value={width} disabled={editLocked} onChange={event => { const value = Number(event.target.value); setWidth(value); configure({ width: value }) }}><option value={3}>Mảnh</option><option value={5}>Vừa</option><option value={9}>Đậm</option></select></label>
    </div>
    {phase === 'playing' && interactionMode === 'draw' && mode === 'assisted' && !demo && <button className="primary free-drawing-pen" aria-pressed={summary.penDown} disabled={penDisabled} onClick={togglePen}>{summary.penDown ? 'Nhấc bút' : 'Hạ bút'}</button>}
    {interactionMode === 'move' && <div className="free-drawing-selection">{grabControl()}<p>{selectionStatus}</p></div>}
    {phase === 'playing' && !demo && <div className="free-drawing-state"><span>Theo dõi: {trackingStatus}</span><span>Bút: {penStatus}</span><span>Nét: {selectionStatus}</span></div>}
    <p className="free-drawing-status" role="status">{demo && phase !== 'finished' ? 'Demo: giữ chuột hoặc chạm để vẽ; không lưu dữ liệu bệnh nhân.' : phase === 'idle' ? canStart ? 'Sẵn sàng · Chọn Bắt đầu vẽ.' : 'Bật camera, nhận diện và xác nhận tư thế trước khi bắt đầu.' : status}</p>
    {phase === 'playing' && !demo && summary.status === 'tracking_lost' && !verifyHandPending && <button onClick={() => { inputBlocked.current = true; controller.current.suspend(); setVerifyHandPending(true) }}>Xác nhận lại tay bên tập</button>}
    {phase === 'playing' && verifyHandPending && <div role="group" aria-label="Xác nhận tay bên tập"><p>Nhân viên kiểm tra chỉ tay {side === 'left' ? 'trái' : 'phải'} bên tập hiện trong camera trước khi xác nhận. Sau đó chờ nhận diện ổn định rồi giơ ngón trỏ hoặc chọn Hạ bút để vẽ.</p><button onClick={() => { resetInput(); controller.current.resume(); setVerifyHandPending(false); refreshSummary() }}>Đã kiểm tra đúng tay {side === 'left' ? 'trái' : 'phải'}</button><button onClick={() => { controller.current.resume(); setVerifyHandPending(false) }}>Hủy xác nhận</button></div>}
    <div className="workspace-controls"><button onClick={undo} disabled={editLocked || !controller.current.strokes.length}>Hoàn tác nét</button><button disabled={editLocked || !controller.current.strokes.length} onClick={() => { inputBlocked.current = true; controller.current.suspend(); overlayDirty.current = true; setClearPending(true) }}>Xóa tranh</button><button onClick={exportPNG} disabled={!controller.current.strokes.length}>Lưu PNG</button></div>
    {clearPending && <div role="group" aria-label="Xác nhận xóa tranh"><p>Xóa tất cả nét vẽ trong tranh hiện tại?</p><button onClick={clear}>Xác nhận xóa</button><button onClick={() => { controller.current.resume(); setClearPending(false) }}>Giữ lại</button></div>}
    {controller.current.limitReached && <p role="status">Tranh đã đạt giới hạn nét / điểm. Hãy xuất PNG và kết thúc bài vẽ.</p>}
    {phase === 'finished' && <><p>Đã kết thúc: {summary.strokes} nét hoàn tất · {(summary.elapsedMs / 1000).toFixed(1)} giây hoạt động. PNG chỉ chứa nét vẽ, không chứa hình camera.</p>
      <div className="workspace-controls">{!demo && workflow && <button className="primary" onClick={() => void save()} disabled={!summary.observed || summary.elapsedMs <= 0 || saveState === 'saving' || saveState === 'saved'}>{saveState === 'saving' ? 'Đang lưu…' : saveState === 'saved' ? 'Đã lưu kết quả' : saveState === 'failed' ? 'Thử lưu lại' : 'Xác nhận lưu kết quả'}</button>}{!workflow && !replay && <button onClick={reset} disabled={saveState === 'saving'}>Vẽ lượt mới</button>}{workflow?.cancelTrial && !summary.observed && <button onClick={() => void cancelEmpty()} disabled={saveState === 'saving'}>Hủy lượt chưa có dữ liệu</button>}</div>
      {demo ? <p>DEMO — kết quả này không được lưu.</p> : !workflow && <p>Chế độ thử độc lập chỉ xuất PNG. Mở bài Vẽ tự do trong buổi luyện tập để lưu kết quả hoạt động.</p>}</>}
    {message && <p role="status">{message}</p>}
  </div> : null
  return { overlay, panel, hud, onHandObservation, resetInput, start, stop, phase,
    resetReplay: () => { if (replay) reset() },
    getCompletedStrokes: () => controller.current.completedStrokeCount }
}

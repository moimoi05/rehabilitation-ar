import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, RefObject } from 'react'
import type { Session } from '../../types'
import { prepareOverlay } from './drawing'
import type { Point, Side } from './drawing'
import { mapVideoPoint, visibleVideoRegion } from './videoGeometry'
import type { Size, VideoMapping } from './videoGeometry'
import { displayPoint, drawFlower, initialRound, ROUND_MS, stepRound, targetForScore, targetRadius, wristForSide } from './flowerGame'
import type { Position, Round } from './flowerGame'

type Props = {
  demo: boolean; streamActive: boolean; tracking: boolean; mirrored: boolean; side: Side
  confirmed: boolean; session: Session | undefined; size: { width: number; height: number }
  pose: RefObject<{ pose: Point[]; hands: Point[][] }>; poseTime: RefObject<number>
  mapping?: RefObject<VideoMapping | null>
  displayBox?: RefObject<Size | null>
}
type Phase = 'idle' | 'playing' | 'finished'
type SaveState = 'idle' | 'saving' | 'saved' | 'failed'
const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
const projectionOf = ({ rect, box }: VideoMapping, display: Size) => [rect.x / box.width, rect.y / box.height, rect.width / box.width, rect.height / box.height, display.width / display.height]
const projectionChanged = (left: number[], right: number[]) => left.some((value, index) => Math.abs(value - right[index]) > 1e-5)

export function useFlowerGame({ demo, streamActive, tracking, mirrored, side, confirmed, session, size, pose, poseTime, mapping, displayBox }: Props) {
  const { width: sourceWidth, height: sourceHeight } = size
  const [phase, setPhase] = useState<Phase>('idle')
  const [round, setRound] = useState<Round>(initialRound)
  const [hasPointer, setHasPointer] = useState(false)
  const [geometryPaused, setGeometryPaused] = useState(false)
  const [resumePending, setResumePending] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [message, setMessage] = useState('')
  const [roundId, setRoundId] = useState('')
  const current = useRef(round)
  const canvas = useRef<HTMLCanvasElement>(null)
  const demoPointer = useRef<{ position: Position; time: number } | null>(null)
  const saving = useRef('')
  const saveGeneration = useRef(0)
  const lastGeometryChange = useRef(0)
  const resumeAfterCheck = useRef<{ timestamp: number; requestedAt: number; projection: number[] } | null>(null)
  const context = `${demo}|${streamActive}|${tracking}|${mirrored}|${side}|${session?.id ?? ''}|${confirmed}|${size.width}|${size.height}`
  const previousContext = useRef(context)

  useEffect(() => {
    if (previousContext.current !== context) {
      previousContext.current = context
      if (phase !== 'idle') {
        saveGeneration.current += 1
        setPhase('idle'); current.current = initialRound(); setRound(current.current)
        setRoundId(''); setSaveState('idle'); setMessage(saveState === 'saving' ? 'Điều kiện phiên hoặc camera đã thay đổi. Yêu cầu lưu có thể đã hoàn tất; hãy kiểm tra trang Kết quả.' : 'Điều kiện phiên hoặc camera đã thay đổi. Lượt trước đã hủy; hãy bắt đầu lại.')
        demoPointer.current = null
      }
    }
  }, [context, phase, saveState])
  useEffect(() => () => { saveGeneration.current += 1 }, [])

  useEffect(() => {
    if (phase !== 'playing') return
    let frame = 0, lastTime = 0, lastUpdate = 0
    let previousProjection: number[] | null = null, geometryLock = false, anchor: Position | null = null, anchorTime = 0, projectionCutoff = 0
    const tick = (now: number) => {
      const clockNow = performance.now()
      const geometry = !demo ? mapping?.current : null
      const region = geometry ? visibleVideoRegion(geometry) : undefined
      const display = displayBox?.current ?? { width: sourceWidth, height: sourceHeight }
      const age = clockNow - poseTime.current
      const rawWrist = poseTime.current && age >= 0 && age < 700 ? wristForSide(pose.current?.pose || [], side) : null
      let approvedResume = false
      if (geometryLock && (!geometry || !rawWrist)) {
        anchor = null; anchorTime = 0
        if (resumeAfterCheck.current) { resumeAfterCheck.current = null; setResumePending(false) }
      }
      if (geometry) {
        const { rect, box } = geometry
        const projection = projectionOf(geometry, display)
        const changed = previousProjection && projectionChanged(projection, previousProjection)
        previousProjection = projection
        if (changed) {
          if (resumeAfterCheck.current) { resumeAfterCheck.current = null; setResumePending(false) }
          projectionCutoff = clockNow; lastGeometryChange.current = clockNow; anchor = null; anchorTime = 0
          if (!geometryLock) { geometryLock = true; setGeometryPaused(true) }
        }
        if (geometryLock && rawWrist && poseTime.current > projectionCutoff) {
          const request = resumeAfterCheck.current
          if (request && (clockNow - request.requestedAt > 1500 || poseTime.current < request.timestamp || poseTime.current - request.timestamp > 500 || projectionChanged(projection, request.projection))) {
            resumeAfterCheck.current = null; setResumePending(false)
          }
          if (resumeAfterCheck.current && poseTime.current > resumeAfterCheck.current.timestamp && poseTime.current > resumeAfterCheck.current.requestedAt) {
            approvedResume = true; resumeAfterCheck.current = null; setResumePending(false); geometryLock = false; anchor = null; anchorTime = 0; setGeometryPaused(false)
          } else {
            const observedAt = poseTime.current
            if (!anchor || (anchorTime && (observedAt < anchorTime || observedAt - anchorTime > 500))) { anchor = rawWrist; anchorTime = observedAt }
            else if (observedAt > anchorTime) {
              const from = mapVideoPoint(anchor, rect, box, mirrored), to = mapVideoPoint(rawWrist, rect, box, mirrored)
              anchorTime = observedAt
              if (Math.hypot((from.x - to.x) * display.width, (from.y - to.y) * display.height) > targetRadius(display.height) * 1.3) {
                geometryLock = false; anchor = null; anchorTime = 0; resumeAfterCheck.current = null; setResumePending(false); setGeometryPaused(false)
              }
            }
          }
        }
      }
      if (demo || !mapping || region) {
        const target = targetForScore(current.current.score, region)
        if (Math.abs(target.x - current.current.target.x) > 1e-6 || Math.abs(target.y - current.current.target.y) > 1e-6) {
          const releaseFrom = current.current.releaseFrom ? targetForScore(current.current.score - 1, region) : null
          current.current = { ...current.current, target, releaseFrom }
        }
      }
      if (approvedResume) current.current = { ...current.current, releaseFrom: current.current.target }
      const pointer = demo
        ? (demoPointer.current && clockNow - demoPointer.current.time < 1000 ? demoPointer.current.position : null)
        : ((!mapping || geometry) ? displayPoint(rawWrist, mirrored, geometry ?? undefined) : null)
      const delta = lastTime ? Math.max(0, now - lastTime) : 0
      lastTime = now
      current.current = stepRound(current.current, geometryLock ? null : pointer, delta, display.width, display.height, region)
      const ctx = canvas.current?.getContext('2d')
      if (ctx) { const box = prepareOverlay(ctx, sourceWidth, sourceHeight, display); drawFlower(ctx, box.width, box.height, current.current.target, pointer) }
      if (now - lastUpdate >= 150 || current.current.finished) {
        setRound(current.current); setHasPointer(Boolean(pointer) && !geometryLock); lastUpdate = now
      }
      if (current.current.finished) { setPhase('finished'); return }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase, demo, mirrored, side, sourceWidth, sourceHeight, pose, poseTime, mapping, displayBox])

  const canStart = demo || Boolean(streamActive && tracking && confirmed && session?.status === 'in_progress')
  const start = () => {
    if (!canStart) return
    if (!demo && typeof crypto.randomUUID !== 'function') { setMessage('Không tạo được mã lượt an toàn. Hãy mở ứng dụng trên localhost hoặc HTTPS.'); return }
    current.current = initialRound(!demo && mapping?.current ? visibleVideoRegion(mapping.current) : undefined); setRound(current.current); demoPointer.current = null; resumeAfterCheck.current = null; lastGeometryChange.current = 0; setResumePending(false); setGeometryPaused(false)
    setRoundId(demo ? '' : crypto.randomUUID()); setSaveState('idle'); setHasPointer(false); setMessage(''); setPhase('playing')
  }
  const stop = () => { setRound(current.current); setPhase('finished') }
  const requestResume = () => {
    const geometry = mapping?.current, now = performance.now(), timestamp = poseTime.current
    if (!geometry || !timestamp || timestamp <= lastGeometryChange.current || now < timestamp || now - timestamp > 500 || !wristForSide(pose.current?.pose || [], side)) {
      setMessage('Chờ mốc cổ tay đáng tin cậy rồi kiểm tra lại trước khi tiếp tục.')
      return
    }
    resumeAfterCheck.current = { timestamp, requestedAt: now, projection: projectionOf(geometry, displayBox?.current ?? { width: sourceWidth, height: sourceHeight }) }
    setMessage(''); setResumePending(true)
  }
  const reset = () => { saveGeneration.current += 1; current.current = initialRound(); setRound(current.current); setPhase('idle'); setMessage(''); setSaveState('idle') }
  const onPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!demo || phase !== 'playing') return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height
    demoPointer.current = { position: { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }, time: performance.now() }
  }
  const save = async () => {
    if (demo || !session || !roundId || round.elapsedMs <= 0 || saveState === 'saved' || saving.current === roundId) return
    const requestGeneration = ++saveGeneration.current
    saving.current = roundId; setSaveState('saving'); setMessage('')
    try {
      const response = await fetch(`${apiBase}/api/exercise-results`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: session.id, round_id: roundId, game_key: 'glowing_flower', affected_side: side, duration_seconds: round.elapsedMs / 1000, score: round.score, target_count: round.targetCount, source: 'camera' }) })
      if (!response.ok) throw new Error('save failed')
      if (requestGeneration !== saveGeneration.current) return
      setSaveState('saved'); setMessage('Đã lưu kết quả lượt tập vào phiên.')
    } catch { if (requestGeneration === saveGeneration.current) { setSaveState('failed'); setMessage('Chưa xác nhận được kết quả lưu. Có thể thử lại an toàn với cùng mã lượt.') } }
    finally { if (saving.current === roundId) saving.current = '' }
  }

  const overlay = phase !== 'idle' ? <canvas ref={canvas} width={size.width} height={size.height} className={`flower-overlay${demo && phase === 'playing' ? ' flower-demo-input' : ''}`} aria-label={demo ? 'Vùng chơi demo bằng chuột hoặc chạm' : 'Hoa và vị trí cổ tay'} onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => { demoPointer.current = null }} /> : null
  const panel = <div className="workspace-info flower-game">
    <div className="flower-game-heading"><div><strong>Trò chơi · Chạm hoa phát sáng</strong><p>Đưa cổ tay bên tập đến hoa, rồi rời hoa trước lần chạm tiếp theo. Nhân viên điều chỉnh tư thế theo khả năng; dừng khi khó chịu.</p></div><span>30 giây hoạt động</span></div>
    {phase === 'idle' && <><p>{demo ? 'Demo: di chuyển chuột hoặc chạm trên khung hình để mô phỏng cổ tay. Không lưu dữ liệu demo.' : 'Chọn phiên đang thực hiện, bật camera và nhận diện, rồi xác nhận tư thế để bắt đầu.'}</p><button className="primary" disabled={!canStart} onClick={start}>Bắt đầu trò chơi</button></>}
    {phase !== 'idle' && <><div className="flower-score"><div><small>Hoa đã chạm</small><strong>{round.score}</strong></div><div><small>Thời gian còn</small><strong>{Math.ceil((ROUND_MS - round.elapsedMs) / 1000)}s</strong></div><div><small>Trạng thái</small><strong>{phase === 'finished' ? 'Đã kết thúc' : geometryPaused ? (resumePending ? 'Tạm dừng · chờ quan sát mới' : 'Tạm dừng · di chuyển cổ tay sau khi đổi khung hình') : hasPointer ? 'Đang chơi' : 'Tạm dừng · mất mốc'}</strong></div></div>
      {phase === 'playing' ? <><p>{demo ? 'Di chuyển chuột hoặc chạm trong khung hình. Thời gian dừng khi không có con trỏ.' : 'Thời gian dừng khi không thấy cổ tay hoặc khung hình ngừng cập nhật.'}</p>{geometryPaused && <button onClick={requestResume} disabled={resumePending}>Tiếp tục sau khi kiểm tra</button>}<button onClick={stop}>Dừng và xem kết quả</button></> : <><p>Kết quả trò chơi chỉ là số hoa chạm được, không phải điểm FMA-UE hay kết luận lâm sàng.</p><div className="workspace-controls"><button onClick={reset} disabled={saveState === 'saving'}>Lượt mới</button>{!demo && <button className="primary" onClick={save} disabled={round.elapsedMs <= 0 || saveState === 'saving' || saveState === 'saved'}>{saveState === 'saving' ? 'Đang lưu…' : saveState === 'saved' ? 'Đã lưu kết quả' : saveState === 'failed' ? 'Thử lưu lại' : 'Xác nhận lưu kết quả'}</button>}</div>{demo && <p>DEMO — kết quả này không được lưu.</p>}</>}
    </>}
    {message && <p role="status">{message}</p>}
  </div>
  return { overlay, panel }
}

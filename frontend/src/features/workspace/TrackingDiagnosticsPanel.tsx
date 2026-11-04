import { useEffect, useState } from 'react'
import type { TrackingDiagnostics } from './trackingDiagnostics'
import './trackingDiagnostics.css'

const number = (value: number | null) => value === null ? '—' : value.toFixed(1)
const yes = (value: boolean) => value ? 'có' : 'không'

/** Mounted only by the development opt-in. Sampling stays outside normal gameplay. */
export function TrackingDiagnosticsPanel({ collector, delegate }: { collector: TrackingDiagnostics; delegate: string }) {
  const [snapshot, setSnapshot] = useState(() => collector.snapshot(performance.now(), delegate, document.visibilityState))
  const [totals, setTotals] = useState(() => collector.report())
  const [message, setMessage] = useState('')
  useEffect(() => {
    const update = () => { const now = performance.now(); setSnapshot(collector.snapshot(now, delegate, document.visibilityState)); setTotals(collector.report(now)) }
    update()
    const timer = setInterval(update, 500)
    return () => clearInterval(timer)
  }, [collector, delegate])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(collector.snapshot(performance.now(), delegate, document.visibilityState), null, 2))
      setMessage('Đã sao chép số liệu tổng hợp.')
    } catch { setMessage('Chưa sao chép được. Cho phép truy cập clipboard rồi thử lại.') }
  }
  return <details className="tracking-diagnostics" open>
    <summary>Chẩn đoán tracking (DEV) · {!snapshot.active ? 'Nhận diện đang dừng' : snapshot.canonicalTrackingReason || snapshot.canonicalDrawingReason}</summary>
    <p>Hand {number(snapshot.handFps)} FPS · Pose {number(snapshot.poseFps)} FPS · cập nhật overlay {number(snapshot.overlayUpdateFps)} FPS · {snapshot.delegate}</p>
    <p>Scheduler nhận frame {number(snapshot.sourceCallbackFps)} FPS · tab {snapshot.visibility}</p>
    <p>Đây là nhịp callback thực trong cửa sổ 10 giây, không phải FPS nguồn camera hay FPS mục tiêu.</p>
    <dl>
      <dt>Khoảng scheduler nhận frame p50 / p95</dt><dd>{number(snapshot.sourceIntervalMs.p50)} / {number(snapshot.sourceIntervalMs.p95)} ms</dd>
      <dt>Từ lần scheduler nhận frame gần nhất</dt><dd>{number(snapshot.sourceCallbackAgeMs)} ms</dd>
      <dt>Capture + resize p50 / p95</dt><dd>{number(snapshot.captureResizeTotalMs.p50)} / {number(snapshot.captureResizeTotalMs.p95)} ms</dd>
      <dt>Gửi frame → Worker p50 / p95</dt><dd>{number(snapshot.transferAndDispatchMs.p50)} / {number(snapshot.transferAndDispatchMs.p95)} ms</dd>
      <dt>Hand inference p50 / p95</dt><dd>{number(snapshot.handInferenceMs.p50)} / {number(snapshot.handInferenceMs.p95)} ms</dd>
      <dt>Pose inference p50 / p95</dt><dd>{number(snapshot.poseInferenceMs.p50)} / {number(snapshot.poseInferenceMs.p95)} ms</dd>
      <dt>Khoảng callback Hand p50 / p95</dt><dd>{number(snapshot.handIntervalMs.p50)} / {number(snapshot.handIntervalMs.p95)} ms</dd>
      <dt>Gap dài nhất từ lần xóa số liệu</dt><dd>{number(snapshot.longestHandGapMs)} ms</dd>
      <dt>Từ callback / phát hiện gần nhất</dt><dd>{number(snapshot.callbackAgeMs)} / {number(snapshot.detectionAgeMs)} ms</dd>
      <dt>Tuổi observation (từ frame nguồn)</dt><dd>{number(snapshot.observationAgeMs)} ms</dd>
      <dt>Hand thô / hợp lệ / đã chọn tay</dt><dd>{snapshot.handCount ?? '—'} / {snapshot.validHandCount ?? '—'} / {yes(snapshot.selected)}</dd>
      <dt>Request / frame</dt><dd>{snapshot.requestId ?? '—'} / {snapshot.frameId ?? '—'}</dd>
      <dt>Lý do loại gần nhất</dt><dd>{snapshot.lastRejection || '—'}</dd>
      <dt>Trạng thái vẽ</dt><dd>{snapshot.canonicalDrawingReason} · sẵn sàng: {yes(snapshot.drawing.armed)} · cử chỉ: {snapshot.drawing.gestureActive === null ? 'không áp dụng' : yes(snapshot.drawing.gestureActive)} · hạ bút: {yes(snapshot.drawing.penDown)}</dd>
      <dt>Callback / raw thiếu / invalid</dt><dd>{snapshot.counts.handCallbacks} / {snapshot.counts.rawMissing} / {snapshot.counts.invalidHands}</dd>
      <dt>Số lần loại theo lý do</dt><dd>{JSON.stringify(snapshot.rejections)}</dd>
      <dt>Callback Hand bị frontend loại (khác hết hạn hiển thị)</dt><dd>{JSON.stringify(totals.frontendRejectionReasons)}</dd>
      <dt>Frame bỏ qua / bận</dt><dd>{JSON.stringify(snapshot.skipped)}</dd>
      <dt>Đã gửi / Hand inference / kết quả hợp lệ (toàn lượt)</dt><dd>{totals.counts.submittedFrames} / {totals.counts.handInferenceCalls} / {totals.counts.validHandResults}</dd>
      <dt>Chọn tay / lỗi liên kết tay / đang nhận lại</dt><dd>{totals.counts.affectedHandSelections} / {totals.counts.affectedHandSelectionFailures} / {totals.counts.affectedHandAcquisitionObservations}</dd>
      <dt>Thay đổi tập nhãn Hand quan sát được</dt><dd>{totals.counts.associationChanges}</dd>
      <dt>Gián đoạn tay đã chọn / dài nhất</dt><dd>{totals.missingSelectedHand.interruptionCount} / {number(totals.missingSelectedHand.longestMs)} ms</dd>
      <dt>Nhận ngón trỏ / hạ bút / nét đã hoàn tất</dt><dd>{totals.counts.gestureActivations} / {totals.counts.penDownEvents} / {totals.counts.completedStrokes}</dd>
      <dt>Lý do chặn vẽ (toàn lượt)</dt><dd>{JSON.stringify(totals.blockedReasons)}</dd>
    </dl>
    <p>Gửi frame → Worker chỉ đo tới lúc Worker nhận frame, chưa gồm suy luận và đường trả kết quả.</p>
    <div><button onClick={() => { collector.reset(); setSnapshot(collector.snapshot(performance.now(), delegate, document.visibilityState)); setMessage('Đã xóa số liệu chẩn đoán.') }}>Xóa số liệu</button><button onClick={() => void copy()}>Sao chép chẩn đoán</button></div>
    <p>Chỉ số tổng hợp, không chứa landmarks, hình camera hoặc thông tin bệnh nhân. Tắt bằng cách bỏ trackingDebug=1 khỏi URL.</p>
    {message && <p role="status">{message}</p>}
  </details>
}

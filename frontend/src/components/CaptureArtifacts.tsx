import { useState } from 'react'
import type { CaptureSummary, ResearchGameMetric } from '../types/rehab'

const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
const metricLabels: Record<string, string> = {
  completed_target_count: 'Số hoa hoàn thành', mean_time_to_touch_ms: 'Thời gian chạm trung bình',
  total_path_length: 'Quãng đường di chuyển', tracking_loss_count: 'Số lần mất tracking',
  completed_stroke_count: 'Số nét hoàn thành', active_drawing_duration_ms: 'Tổng thời gian vẽ',
  total_stroke_length: 'Tổng chiều dài nét', drag_attempt_count: 'Số lần cầm nét',
  drag_completed_count: 'Số lần thả nét hoàn tất', drag_interrupted_count: 'Số lần kéo bị gián đoạn',
}
function metricValue(metric: ResearchGameMetric) {
  if (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || !['valid', 'partial'].includes(metric.quality_status)) return 'Không đủ dữ liệu'
  const value = Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(2)
  const unit = metric.unit === 'count' ? '' : ` ${metric.unit}`
  return `${value}${unit}${metric.quality_status === 'partial' ? ' (dữ liệu một phần)' : ''}`
}
/** Show only artifacts actually linked to these trials and confirmed by the server. */
export default function CaptureArtifacts({ captures }: { captures: CaptureSummary[] }) {
  const [failedVideos, setFailedVideos] = useState<string[]>([])
  if (!captures.length) return null
  return <section className="rehab-section"><h2>Dữ liệu nghiên cứu đã ghi</h2>{captures.map(capture => {
    const available = capture.status === 'complete'
    const summary = capture.artifact_summary
    const video = capture.record_video && summary?.video_status === 'complete'
    const trackingVideoPartial = summary?.tracking_video_status === 'incomplete' && Boolean(summary.tracking_video_file)
    const trackingVideo = (capture.status === 'complete' || capture.status === 'incomplete') && (summary?.tracking_video_status === 'complete' || trackingVideoPartial)
    const trackingLabel = trackingVideoPartial ? 'Video có tracking chưa hoàn chỉnh' : 'Video có tracking'
    const trackingKey = `${capture.id}:tracking_video`
    const url = `${base}/api/captures/${encodeURIComponent(capture.id)}/artifacts`
    return <div className="rehab-capture" key={capture.id}>
      <p>Lượt #{capture.trial_id} · {capture.source_type === 'webcam' ? 'Camera trực tiếp' : 'Video đã quay'} · {available ? 'Đã hoàn tất' : capture.status === 'recording' ? 'Đang thu/gửi dữ liệu' : 'Chưa hoàn tất'} ({capture.status})</p>
      <p>Capture {capture.id}</p>
      <p>Artifact: frames {summary?.frames_status ?? 'chưa xác định'} · landmarks {summary?.landmarks_status ?? 'chưa xác định'} · video {summary?.video_status ?? 'chưa xác định'} · video tracking {summary?.tracking_video_status ?? 'không có thông tin'} · manifest {summary?.manifest_status ?? 'chưa xác định'}</p>
      {(summary?.events_status || summary?.interaction_samples_status || summary?.game_metrics_status) && <p>Game artifacts: events {summary.events_status ?? 'chưa xác định'} · interaction samples {summary.interaction_samples_status ?? 'chưa xác định'} · game metrics {summary.game_metrics_status ?? 'chưa xác định'}</p>}
      {summary?.game_metrics_status === 'complete' && summary.game_metrics && <div aria-label={`Chỉ số game của lượt ${capture.trial_id}`}>{Object.entries(metricLabels).filter(([name]) => summary.game_metrics?.[name]).map(([name, label]) => <p key={name}>{label}: {metricValue(summary.game_metrics![name])}</p>)}</div>}
      {video && <>{!failedVideos.includes(capture.id) && <video controls preload="metadata" src={`${url}/video`} aria-label={`Video đã lưu của lượt ${capture.trial_id}`} onError={() => setFailedVideos(previous => [...previous, capture.id])}/>}
        {failedVideos.includes(capture.id) && <p role="status">Chưa phát được video. Kiểm tra tệp đã lưu hoặc tải video để xem bằng trình phát phù hợp.</p>}
        <a className="text-link" href={`${url}/video`}>Tải video đã lưu</a></>}
      {trackingVideo && <><h3>{trackingLabel}</h3>{!failedVideos.includes(trackingKey) && <video controls preload="metadata" src={`${url}/tracking_video`} aria-label={`${trackingLabel} của lượt ${capture.trial_id}`} onError={() => setFailedVideos(previous => [...previous, trackingKey])}/>}
        {failedVideos.includes(trackingKey) && <p role="status">Chưa phát được video có tracking. Kiểm tra tệp đã lưu hoặc tải video để xem bằng trình phát phù hợp.</p>}
        <a className="text-link" href={`${url}/tracking_video`}>{trackingVideoPartial ? 'Tải video có tracking chưa hoàn chỉnh' : 'Tải video có tracking'}</a></>}
      {capture.record_landmarks && summary?.frames_status === 'complete' && <p><a className="text-link" href={`${url}/frames`}>Tải dữ liệu frame</a></p>}
      {capture.record_landmarks && summary?.landmarks_status === 'complete' && <p><a className="text-link" href={`${url}/landmarks`}>Tải dữ liệu landmark</a></p>}
      {summary?.events_status === 'complete' && <p><a className="text-link" href={`${url}/events`}>Tải sự kiện game</a></p>}
      {summary?.interaction_samples_status === 'complete' && <p><a className="text-link" href={`${url}/interaction_samples`}>Tải quỹ đạo tương tác</a></p>}
      {summary?.game_metrics_status === 'complete' && <p><a className="text-link" href={`${url}/game_metrics`}>Tải chỉ số game</a></p>}
      {summary?.manifest_status === 'complete' && <p><a className="text-link" href={`${url}/manifest`}>Tải manifest</a></p>}
    </div>
  })}</section>
}

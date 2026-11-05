import { useState } from 'react'
import type { CaptureSummary } from '../types/rehab'

const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
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
      {video && <>{!failedVideos.includes(capture.id) && <video controls preload="metadata" src={`${url}/video`} aria-label={`Video đã lưu của lượt ${capture.trial_id}`} onError={() => setFailedVideos(previous => [...previous, capture.id])}/>}
        {failedVideos.includes(capture.id) && <p role="status">Chưa phát được video. Kiểm tra tệp đã lưu hoặc tải video để xem bằng trình phát phù hợp.</p>}
        <a className="text-link" href={`${url}/video`}>Tải video đã lưu</a></>}
      {trackingVideo && <><h3>{trackingLabel}</h3>{!failedVideos.includes(trackingKey) && <video controls preload="metadata" src={`${url}/tracking_video`} aria-label={`${trackingLabel} của lượt ${capture.trial_id}`} onError={() => setFailedVideos(previous => [...previous, trackingKey])}/>}
        {failedVideos.includes(trackingKey) && <p role="status">Chưa phát được video có tracking. Kiểm tra tệp đã lưu hoặc tải video để xem bằng trình phát phù hợp.</p>}
        <a className="text-link" href={`${url}/tracking_video`}>{trackingVideoPartial ? 'Tải video có tracking chưa hoàn chỉnh' : 'Tải video có tracking'}</a></>}
      {capture.record_landmarks && summary?.frames_status === 'complete' && <p><a className="text-link" href={`${url}/frames`}>Tải dữ liệu frame</a></p>}
      {capture.record_landmarks && summary?.landmarks_status === 'complete' && <p><a className="text-link" href={`${url}/landmarks`}>Tải dữ liệu landmark</a></p>}
      {summary?.manifest_status === 'complete' && <p><a className="text-link" href={`${url}/manifest`}>Tải manifest</a></p>}
    </div>
  })}</section>
}

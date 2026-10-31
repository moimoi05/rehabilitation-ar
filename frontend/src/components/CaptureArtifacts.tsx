import { useState } from 'react'
import type { CaptureSummary } from '../types/rehab'

const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
/** Show only artifacts actually linked to these trials and confirmed by the server. */
export default function CaptureArtifacts({ captures }: { captures: CaptureSummary[] }) {
  const [failedVideos, setFailedVideos] = useState<string[]>([])
  if (!captures.length) return null
  return <section className="rehab-section"><h2>Dữ liệu nghiên cứu đã ghi</h2>{captures.map(capture => {
    const available = capture.status === 'complete'
    const video = available && capture.record_video && capture.artifact_summary?.video_status === 'complete'
    const url = `${base}/api/captures/${encodeURIComponent(capture.id)}/artifacts`
    return <div className="rehab-capture" key={capture.id}>
      <p>Lượt #{capture.trial_id} · {capture.source_type === 'webcam' ? 'Camera trực tiếp' : 'Video đã quay'} · {available ? 'Đã hoàn tất' : 'Chưa hoàn tất'}</p>
      {video && <>{!failedVideos.includes(capture.id) && <video controls preload="metadata" src={`${url}/video`} aria-label={`Video đã lưu của lượt ${capture.trial_id}`} onError={() => setFailedVideos(previous => [...previous, capture.id])}/>}
        {failedVideos.includes(capture.id) && <p role="status">Chưa phát được video. Kiểm tra tệp đã lưu hoặc tải video để xem bằng trình phát phù hợp.</p>}
        <a className="text-link" href={`${url}/video`}>Tải video đã lưu</a></>}
      {available && capture.record_landmarks && capture.artifact_summary?.frames_status === 'complete' && <p><a className="text-link" href={`${url}/frames`}>Tải dữ liệu frame</a></p>}
      {available && capture.record_landmarks && capture.artifact_summary?.landmarks_status === 'complete' && <p><a className="text-link" href={`${url}/landmarks`}>Tải dữ liệu landmark</a></p>}
    </div>
  })}</section>
}

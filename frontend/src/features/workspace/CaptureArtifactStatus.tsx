import { useEffect, useState } from 'react'

type Summary = { frames_status?: string; landmarks_status?: string; video_status?: string; tracking_video_status?: string; events_status?: string; interaction_samples_status?: string; game_metrics_status?: string }
const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'

/** Inspect server-confirmed artifact states after collection stops or fails. */
export function CaptureArtifactStatus({ captureId, busy, state }: { captureId: string; busy: boolean; state: string }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    setSummary(null); setError(false)
    if (!captureId || busy) return
    const controller = new AbortController()
    void fetch(`${base}/api/captures/${encodeURIComponent(captureId)}`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Capture status unavailable'); return response.json() })
      .then(data => setSummary(data.artifact_summary ?? null))
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [captureId, busy, state])
  if (error) return <p>Không thể kiểm tra trạng thái từng artifact từ backend.</p>
  if (!summary) return null
  return <p>Artifact: frames {summary.frames_status ?? 'chưa xác định'} · landmarks {summary.landmarks_status ?? 'chưa xác định'} · video {summary.video_status ?? 'chưa xác định'} · video tracking {summary.tracking_video_status ?? 'không có thông tin'}{(summary.events_status || summary.interaction_samples_status || summary.game_metrics_status) && <> · events {summary.events_status ?? 'chưa xác định'} · interaction samples {summary.interaction_samples_status ?? 'chưa xác định'} · game metrics {summary.game_metrics_status ?? 'chưa xác định'}</>}</p>
}

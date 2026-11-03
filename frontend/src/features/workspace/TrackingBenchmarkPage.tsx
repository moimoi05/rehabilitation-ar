import { useEffect, useRef, useState } from 'react'
import { benchmarkRequest } from './benchmarkArtifacts'
import { benchmarkSuite, comparisonSuite, latencyBenchmarkSuite, runBenchmark } from './benchmarkRunner'
import type { RunResult, SourceInfo } from './benchmarkRunner'
import TrackingRecordingComparison, { COMPARISON_RUNS_KEY } from './TrackingRecordingComparison'

function measuredRates(result: RunResult) {
  const requested = result.summary?.requested_fps as { pose?: number; hand?: number } | undefined
  const achieved = result.summary?.actual_fps as { pose?: number | null; hand?: number | null } | undefined
  const delegates = result.summary?.actual_delegates as { pose?: string | null; hand?: string | null } | undefined
  if (!achieved) return null
  return `Đạt/mục tiêu: Hand ${achieved.hand?.toFixed(1) ?? 'N/A'}/${requested?.hand ?? '—'} FPS (${delegates?.hand ?? 'OFF'}); Pose ${achieved.pose?.toFixed(1) ?? 'N/A'}/${requested?.pose ?? '—'} FPS (${delegates?.pose ?? '—'}).`
}

export default function TrackingBenchmarkPage() {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), controller = useRef<AbortController | null>(null)
  const [source, setSource] = useState<SourceInfo | null>(null), [status, setStatus] = useState('Đang đọc video nguồn…')
  const [running, setRunning] = useState(false), [results, setResults] = useState<RunResult[]>([])
  const [selected, setSelected] = useState('latency')
  const [roi, setRoi] = useState({ x: 0, y: 0, width: 1, height: 1 }), [roiConfirmed, setRoiConfirmed] = useState(false)
  const validRoi = Object.values(roi).every(Number.isFinite) && roi.x >= 0 && roi.y >= 0 && roi.width > 0 && roi.height > 0 && roi.x + roi.width <= 1 && roi.y + roi.height <= 1
  useEffect(() => { let active = true; benchmarkRequest<SourceInfo>('/source-info').then(info => { if (active) { setSource(info); setStatus('Sẵn sàng') } }).catch(error => { if (active) setStatus(String(error)) }); return () => { active = false; controller.current?.abort() } }, [])
  useEffect(() => {
    const complete = results.filter(result => result.status === 'COMPLETE').slice(-3)
    if (complete.length >= 2) { try { localStorage.setItem(COMPARISON_RUNS_KEY, JSON.stringify([complete[0].run_id, complete[complete.length - 1].run_id])) } catch { console.warn('Browser prevented saving comparison run selection') } }
  }, [results])
  const start = async () => {
    if (!source || !video.current || !canvas.current || controller.current) return
    const abort = new AbortController(); controller.current = abort; setRunning(true)
    const suite = benchmarkSuite(), comparisons = comparisonSuite(roi), latencySuite = latencyBenchmarkSuite()
    const configurations = selected === 'latency' ? latencySuite : selected.startsWith('latency-') ? [latencySuite[Number(selected.slice(8))]] : selected === 'comparison' ? comparisons : selected === 'mediapipe' ? [comparisons[0]] : selected === 'rtmpose' ? [comparisons[1]] : selected === 'rtmpose-detector' ? [comparisons[2]] : selected === 'suite' ? suite : [suite[Number(selected)]]
    try {
      for (const config of configurations) {
        if (abort.signal.aborted) break
        const result = await runBenchmark(config, video.current, canvas.current, source, abort.signal, setStatus)
        setResults(previous => [...previous, result])
      }
      setStatus(abort.signal.aborted ? 'Đã dừng; dữ liệu từng lần chạy được giữ lại.' : 'Đã kết thúc danh sách. Kiểm tra COMPLETE / INCOMPLETE bên dưới.')
    } catch (error) { setStatus(`Lỗi: ${error instanceof Error ? error.message : String(error)}`) }
    finally { controller.current = null; setRunning(false) }
  }
  return <section style={{ padding: 24, maxWidth: 1500, margin: 'auto' }}>
    <h1>Benchmark Pose + Hand trên video cục bộ</h1>
    <p>Chạy tuần tự trên Microsoft Edge, giữ trang này hiển thị. Video phát 1×, không dùng webcam và không tạo phiên bệnh nhân.</p>
    <p style={{ overflowWrap: 'anywhere' }}>{source?.source_path}</p>
    {source && <p>{source.width} × {source.height} · {source.duration?.toFixed(2)} giây · FPS metadata: {source.fps ?? 'không có'}</p>}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
      <select aria-label="Cấu hình benchmark" disabled={running} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="latency">Bộ kiểm thử Hand-first GPU Worker (5 cấu hình đối chiếu)</option>
        {latencyBenchmarkSuite().map((config, index) => <option key={`latency-${index}`} value={`latency-${index}`}>{config.name}</option>)}
        <option value="comparison">Tuần tự: MediaPipe → RTMPose ROI → RTMPose + detector</option>
        <option value="mediapipe">A MediaPipe GPU Pose + Hand</option>
        <option value="rtmpose">B RTMPose-m GPU — operator ROI</option>
        <option value="rtmpose-detector">B RTMPose-m GPU + person detector</option>
        <option value="suite">Bộ MediaPipe cũ: 15 lần chạy tuần tự</option>
        {benchmarkSuite().map((config, index) => <option key={index} value={index}>{config.name} #{config.repeat}</option>)}
      </select>
      <button disabled={running || !source || ((selected === 'comparison' || selected === 'rtmpose') && (!validRoi || !roiConfirmed))} onClick={() => void start()}>Bắt đầu benchmark</button>
      <button disabled={!running} onClick={() => controller.current?.abort()}>Dừng sau khi lưu dữ liệu</button>
    </div>
    {(selected === 'comparison' || selected === 'rtmpose') && <fieldset disabled={running} style={{ marginBottom: 12 }}>
      <legend>ROI một người cho RTMPose (tọa độ chuẩn hóa ảnh nguồn)</legend>
      {(Object.keys(roi) as (keyof typeof roi)[]).map(key => <label key={key} style={{ marginRight: 12 }}>{key} <input aria-label={`ROI ${key}`} type="number" min="0" max="1" step="0.01" value={roi[key]} onChange={event => { setRoi(previous => ({ ...previous, [key]: Number(event.target.value) })); setRoiConfirmed(false) }} style={{ width: 75 }} /></label>)}
      <p><label><input type="checkbox" checked={roiConfirmed} onChange={event => setRoiConfirmed(event.target.checked)} /> Tôi xác nhận video có một người và ROI bao phủ các chuyển động cần đo.</label></p>
      {!validRoi && <p role="alert">ROI phải nằm trong ảnh, có chiều rộng và cao lớn hơn 0.</p>}
      <p>ROI được khai báo rõ, không phải pipeline detector tổng quát. Cần kiểm tra mất điểm/ra biên và kiểm tra overlay trước khi kết luận chất lượng.</p>
    </fieldset>}
    {selected === 'rtmpose-detector' && <p>Detector xác định vùng người trước mỗi lượt RTMPose; latency pipeline bao gồm detector, crop, WholeBody, serialization và transfer. Đây là phương án phát hiện người của cùng model Medium, không phải model Large.</p>}
    <p role="status" aria-live="polite">{status}</p>
    <video ref={video} muted playsInline preload="auto" style={{ position: 'absolute', top: 0, left: 0, width: 320, height: 180, opacity: 0.001, pointerEvents: 'none', zIndex: -1 }} />
    <canvas ref={canvas} width={1280} height={720} style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain', background: '#0f172a' }} />
    <p>Warm-up: suy luận khung đầu video trong ít nhất 3 giây; sau đó đo toàn bộ video. Mỗi lần lưu MP4 chú thích, JSONL raw/filtered, CSV, summary, báo cáo và manifest. Chỉ backend xác minh đủ artifact mới ghi COMPLETE.</p>
    {selected.startsWith('latency') && <p>Hand-first Worker yêu cầu Hand 30 FPS và Pose 15 FPS; kết quả hiển thị FPS thực đạt riêng từng model. Tuổi overlay Hand/Pose giới hạn 150/250 ms. Có thể chọn riêng 1280 × 720 hoặc 960 × 540. captureResizeTotalMs đo gộp capture/resize; transferAndDispatchMs đo truyền/dispatch. Tỷ lệ thời gian suy luận model không phải mức sử dụng GPU.</p>}
    <p>So sánh mặc định dùng raw overlay, cùng mục tiêu 30 FPS, warm-up 3 giây và toàn bộ video ở 1×; mỗi lượt đóng engine trước khi chạy lượt tiếp. MediaPipe CPU fallback bị từ chối trong so sánh GPU. RTMPose suy luận cả thân và tay trong một graph nên Hand FPS/P95 độc lập là N/A. Bộ MediaPipe cũ giữ lịch và filter cũ. Chỉ số có điểm không phải độ chính xác lâm sàng; CPU/GPU utilization, nhiệt độ và power chưa được đo.</p>
    {!running && <TrackingRecordingComparison />}
    <ul>{results.map(result => <li key={result.run_id}><strong>{result.status}</strong> — {result.directory}<br />{measuredRates(result)}<br />{result.errors?.join(' | ')}</li>)}</ul>
  </section>
}

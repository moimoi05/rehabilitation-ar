import { useEffect, useRef, useState } from 'react'
import { benchmarkRequest } from './benchmarkArtifacts'
import { benchmarkSuite, runBenchmark } from './benchmarkRunner'
import type { RunResult, SourceInfo } from './benchmarkRunner'

export default function TrackingBenchmarkPage() {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), controller = useRef<AbortController | null>(null)
  const [source, setSource] = useState<SourceInfo | null>(null), [status, setStatus] = useState('Đang đọc video nguồn…')
  const [running, setRunning] = useState(false), [results, setResults] = useState<RunResult[]>([])
  const [selected, setSelected] = useState('suite')
  useEffect(() => { let active = true; benchmarkRequest<SourceInfo>('/source-info').then(info => { if (active) { setSource(info); setStatus('Sẵn sàng') } }).catch(error => { if (active) setStatus(String(error)) }); return () => { active = false; controller.current?.abort() } }, [])
  const start = async () => {
    if (!source || !video.current || !canvas.current || controller.current) return
    const abort = new AbortController(); controller.current = abort; setRunning(true)
    const suite = benchmarkSuite(), configurations = selected === 'suite' ? suite : [suite[Number(selected)]]
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
        <option value="suite">Toàn bộ 15 lần chạy tuần tự</option>
        {benchmarkSuite().map((config, index) => <option key={index} value={index}>{config.name} #{config.repeat}</option>)}
      </select>
      <button disabled={running || !source} onClick={() => void start()}>Bắt đầu benchmark</button>
      <button disabled={!running} onClick={() => controller.current?.abort()}>Dừng sau khi lưu dữ liệu</button>
    </div>
    <p role="status" aria-live="polite">{status}</p>
    <video ref={video} muted playsInline preload="auto" style={{ position: 'absolute', top: 0, left: 0, width: 320, height: 180, opacity: 0.001, pointerEvents: 'none', zIndex: -1 }} />
    <canvas ref={canvas} width={1280} height={720} style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain', background: '#0f172a' }} />
    <p>Warm-up: suy luận khung đầu video trong ít nhất 3 giây; sau đó đo toàn bộ video. Mỗi lần lưu MP4 chú thích, JSONL raw/filtered, CSV, summary, báo cáo và manifest. Chỉ backend xác minh đủ artifact mới ghi COMPLETE.</p>
    <p>Cấu hình A giữ lịch gọi cũ (Pose tối đa 24, Hand 12, cùng callback); cấu hình CPU matched và GPU dùng lịch độc lập 20/12 để so sánh. Chỉ số filter là khoảng cách tới raw và chuyển động giữa quan sát, không phải độ chính xác lâm sàng.</p>
    <ul>{results.map(result => <li key={result.run_id}><strong>{result.status}</strong> — {result.directory}<br />{result.errors?.join(' | ')}</li>)}</ul>
  </section>
}

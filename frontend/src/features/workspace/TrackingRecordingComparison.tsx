import { useMemo, useRef, useState } from 'react'
import { BENCHMARK_API } from './benchmarkArtifacts'

export const COMPARISON_RUNS_KEY = 'rehab.trackingComparisonRuns'
const validRun = (value: string) => /^\d{8}T\d{6}Z-[a-f0-9]{32}$/.test(value)
const savedRuns = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COMPARISON_RUNS_KEY) || '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && validRun(item)).slice(0, 2) : []
  } catch { return [] }
}

/** Compare recordings of sequential runs, never start competing inference engines. */
export default function TrackingRecordingComparison({ onOpen }: { onOpen?: () => void }) {
  const [inputs, setInputs] = useState<string[]>(savedRuns)
  const [runs, setRuns] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const players = useRef<(HTMLVideoElement | null)[]>([])
  const pause = () => players.current.forEach(player => player?.pause())
  const bindPlayers = useMemo(() => [0, 1].map(index => (element: HTMLVideoElement | null) => {
    const previous = players.current[index]
    if (previous && previous !== element) { previous.pause(); previous.removeAttribute('src'); previous.load() }
    players.current[index] = element
    // React StrictMode re-attaches the same node after ref cleanup in development.
    const run = element?.dataset.run
    if (element && run && validRun(run) && !element.hasAttribute('src')) element.src = `${BENCHMARK_API}/runs/${encodeURIComponent(run)}/artifacts/annotated.mp4`
  }), [])
  const load = () => {
    if (inputs.length !== 2 || !inputs.every(validRun)) { setMessage('Nhập hai mã run hợp lệ từ báo cáo benchmark.'); return }
    pause(); setRuns([...inputs]); setMessage('')
    try { localStorage.setItem(COMPARISON_RUNS_KEY, JSON.stringify(inputs)) } catch { setMessage('Đã mở bản ghi nhưng trình duyệt không cho lưu lựa chọn.') }
  }
  const play = async () => {
    setMessage('')
    const results = await Promise.allSettled(players.current.map(player => {
      if (!player) return Promise.resolve()
      if (player.readyState > 0) player.currentTime = 0
      player.playbackRate = 1
      return player.play()
    }))
    if (results.some(result => result.status === 'rejected')) setMessage('Không phát được bản ghi. Kiểm tra backend và trạng thái artifact của run.')
  }
  return <details onToggle={event => {
    if (event.currentTarget.open) { onOpen?.(); const saved = savedRuns(); if (saved.length === 2) setInputs(saved) }
    else pause()
  }}>
    <summary>So sánh bản ghi tuần tự cạnh nhau</summary>
    <p>Hai video là output thật từ các lượt đã chạy riêng. Phát lại không đo hiệu năng inference; thời gian bản ghi có thể lệch nguồn, hãy đối chiếu timestamp nguồn trên overlay.</p>
    {[0, 1].map(index => <label key={index} style={{ display: 'block' }}>Run {index === 0 ? 'A' : 'B'} <input aria-label={`Comparison run ${index === 0 ? 'A' : 'B'}`} value={inputs[index] ?? ''} maxLength={49} style={{ width: 'min(100%, 520px)' }} onChange={event => setInputs(previous => [index === 0 ? event.target.value.trim() : previous[0] ?? '', index === 1 ? event.target.value.trim() : previous[1] ?? ''])} /></label>)}
    <button onClick={load}>Mở hai bản ghi</button>{' '}
    <button disabled={runs.length !== 2} onClick={() => void play()}>Phát cả hai từ đầu (1×)</button>{' '}
    <button disabled={!runs.length} onClick={pause}>Tạm dừng cả hai</button>
    {message && <p role="status">{message}</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
      {runs.map((run, index) => <div key={`${index}-${run}`}><p style={{ overflowWrap: 'anywhere' }}>{run}</p><video ref={bindPlayers[index]} data-run={run} controls muted playsInline preload="metadata" src={`${BENCHMARK_API}/runs/${encodeURIComponent(run)}/artifacts/annotated.mp4`} style={{ width: '100%', background: '#0f172a' }} onError={() => setMessage(`Không đọc được annotated.mp4 của run ${run}.`)} /></div>)}
    </div>
  </details>
}

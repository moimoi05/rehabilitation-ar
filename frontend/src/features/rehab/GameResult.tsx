import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import type { CaptureSummary, Exercise } from '../../types/rehab'
import CaptureArtifacts from '../../components/CaptureArtifacts'
import type { SavedGameResult } from './ClinicalWorkspace'

const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'

export default function GameResult({ result, exercise, onContinue, onReturn, training = false, busy = false, captures = [] }: { result: SavedGameResult; exercise: Exercise | null; onContinue: () => void; onReturn: () => void; training?: boolean; busy?: boolean; captures?: CaptureSummary[] }) {
  const [refresh, setRefresh] = useState(0), [checking, setChecking] = useState(false)
  const [research, setResearch] = useState<{ trialId: number; captures?: CaptureSummary[]; error?: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController(), trialId = result.trial_id
    setChecking(true)
    void fetch(`${base}/api/trials/${trialId}/captures`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Capture status unavailable'); return response.json() })
      .then((data: unknown) => {
        if (!Array.isArray(data)) throw new Error('Invalid capture response')
        if (!controller.signal.aborted) setResearch({ trialId, captures: data.filter((capture): capture is CaptureSummary => !!capture && typeof capture === 'object' && capture.trial_id === trialId && typeof capture.id === 'string' && typeof capture.status === 'string') })
      })
      .catch(() => { if (!controller.signal.aborted) setResearch({ trialId, error: 'Chưa kiểm tra được dữ liệu nghiên cứu từ máy chủ. Hãy cập nhật lại trạng thái.' }) })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [result.trial_id, refresh])
  const currentResearch = research?.trialId === result.trial_id ? research : null
  const trialCaptures = currentResearch?.captures ?? captures.filter(capture => capture.trial_id === result.trial_id)
  return <section className="panel"><div className="panel-heading"><div><h2>Kết quả trò chơi</h2><p>{exercise?.name ?? (result.game_key === 'free_drawing' ? 'Vẽ tự do' : 'Hái hoa')}</p></div><span className="badge completed">Đã lưu</span></div>
    <dl className="detail-list"><div><dt>Thời lượng</dt><dd>{result.duration_seconds.toFixed(1)} giây</dd></div>
      {result.game_key === 'free_drawing' ? <><div><dt>Số nét đã hoàn tất</dt><dd>{result.completed_strokes}</dd></div>{result.active_drawing_seconds !== undefined && <div><dt>Thời gian đang vẽ</dt><dd>{result.active_drawing_seconds.toFixed(1)} giây</dd></div>}</> : <><div><dt>Điểm trò chơi</dt><dd>{result.score}</dd></div><div><dt>Số mục tiêu</dt><dd>{result.target_count}</dd></div></>}
      <div><dt>Dữ liệu</dt><dd>{result.data_valid === false ? 'Không hợp lệ' : result.data_valid === true ? 'Đã xác nhận hợp lệ' : 'Chưa xác nhận chất lượng dữ liệu'}</dd></div></dl>
    <p className="help">Kết quả đã được máy chủ xác nhận. {result.game_key === 'free_drawing' ? 'Số nét và thời lượng chỉ mô tả hoạt động, không đánh giá khả năng hồi phục.' : 'Điểm trò chơi không phải điểm FMA-UE hay kết luận lâm sàng.'}</p>
    <CaptureArtifacts captures={trialCaptures}/>
    {currentResearch?.error && <p role="status">{currentResearch.error}</p>}
    {currentResearch?.captures?.length === 0 && <p>Chưa có capture nghiên cứu gắn với lượt này.</p>}
    <Button variant="outline" disabled={checking} onClick={() => setRefresh(value => value + 1)}>{checking ? 'Đang kiểm tra dữ liệu nghiên cứu…' : 'Cập nhật trạng thái dữ liệu'}</Button>
    <div className="form-actions"><Button variant="outline" disabled={busy} onClick={onReturn}>{training ? 'Trở về' : 'Xem tổng kết đánh giá'}</Button><Button disabled={busy} onClick={onContinue}>{training ? 'Tiếp tục' : 'Quay lại danh sách bài'}</Button></div>
  </section>
}

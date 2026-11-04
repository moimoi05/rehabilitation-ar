import { Brain, FileBarChart } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, ErrorState, Loading } from '../components/States'
import { useData } from '../hooks/useData'
import { api } from '../services/api'
import { sideLabel, statusLabel, typeLabel } from '../types'
import type { Side } from '../types'
import CalibrationDetails from '../components/CalibrationDetails'
import type { SavedGameResult } from '../features/workspace/gameWorkflow'

type ExerciseResult = SavedGameResult & { affected_side: Side }

const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
const load = async () => {
  const [patients, sessions] = await Promise.all([api.patients(), api.sessions()])
  return { patients, sessions }
}

async function loadGameResults(sessionId: number): Promise<ExerciseResult[]> {
  let response: Response
  try {
    response = await fetch(`${apiBase}/api/exercise-results?session_id=${encodeURIComponent(sessionId)}`)
  } catch {
    throw new Error('Không kết nối được backend. Hãy kiểm tra dịch vụ và cấu hình API.')
  }
  if (!response.ok) throw new Error(`Không tải được kết quả trò chơi (${response.status}).`)
  return response.json() as Promise<ExerciseResult[]>
}

function GameResults({ sessionId, close }: { sessionId: number; close: () => void }) {
  const loadResults = useCallback(() => loadGameResults(sessionId), [sessionId])
  const { data, loading, error, reload } = useData(loadResults)
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="game-results-title">
      <div className="panel-heading">
        <div><span className="eyebrow">PHIÊN #{sessionId}</span><h2 id="game-results-title">Kết quả trò chơi</h2><p>Hoạt động đã lưu theo từng bài tập</p></div>
        <button className="close" onClick={close} aria-label="Đóng">×</button>
      </div>
      <p className="help">Điểm trò chơi không phải điểm FMA-UE và không phải đánh giá lâm sàng.</p>
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={() => void reload()} /> : !data?.length ? <Empty>Chưa có kết quả trò chơi cho phiên này.</Empty> :
        <div className="table-wrap"><table><thead><tr><th>Ngày giờ</th><th>Bài tập</th><th>Tay tập</th><th>Thời lượng</th><th>Kết quả hoạt động</th></tr></thead>
          <tbody>{data.map(result => <tr key={result.id}><td>{new Date(result.created_at).toLocaleString('vi-VN')}</td><td>{result.game_key === 'free_drawing' ? 'Vẽ tự do' : 'Hái hoa'}</td><td>{sideLabel(result.affected_side)}</td><td>{result.duration_seconds} giây</td><td>{result.game_key === 'free_drawing' ? `${result.completed_strokes} nét${result.active_drawing_seconds === undefined ? '' : ` · ${result.active_drawing_seconds.toFixed(1)} giây đang vẽ`}` : `${result.score} / ${result.target_count} hoa`}</td></tr>)}</tbody></table></div>}
    </div>
  </div>
}

export default function Results() {
  const { data, loading, error, reload } = useData(load)
  const [selected, setSelected] = useState<{ id: number; type: 'calibration' | 'game' } | null>(null)
  return <>
    <div className="page-heading"><div><span className="eyebrow">THEO DÕI NGHIÊN CỨU</span><h1>Kết quả & báo cáo</h1><p>Xem trạng thái phiên, hiệu chuẩn và kết quả trò chơi đã lưu.</p></div></div>
    <div className="notice"><Brain size={19}/><span><strong>Đánh giá AI: Chưa triển khai.</strong> Điểm FMA-UE tham chiếu cần do nhân viên chuyên môn đánh giá; điểm trò chơi không thay thế thang đo này.</span></div>
    <section className="panel">
      <div className="panel-heading"><div><h2>Danh sách phiên</h2><p>Chọn một phiên để xem hiệu chuẩn hoặc kết quả trò chơi</p></div><FileBarChart size={22} className="muted"/></div>
      {loading ? <Loading/> : error ? <ErrorState message={error} retry={() => void reload()}/> : !data?.sessions.length ? <Empty>Chưa có kết quả phiên.</Empty> :
        <div className="table-wrap"><table><thead><tr><th>Phiên</th><th>Bệnh nhân</th><th>Loại</th><th>Trạng thái</th><th>Dữ liệu</th><th/></tr></thead><tbody>{data.sessions.map(session =>
          <tr key={session.id}><td>#{session.id}</td><td>{data.patients.find(patient => patient.id === session.patient_id)?.research_code ?? `#${session.patient_id}`}</td><td>{typeLabel[session.session_type]}</td><td><span className={`badge ${session.status}`}>{statusLabel[session.status]}</span></td><td>Chưa có phân tích AI</td><td className="actions"><button className="text-link" onClick={() => setSelected({ id: session.id, type: 'calibration' })}>Xem hiệu chuẩn</button><button className="text-link" onClick={() => setSelected({ id: session.id, type: 'game' })}>Xem trò chơi</button><Link className="text-link" to={`/workspace?session=${session.id}`}>Mở workspace</Link></td></tr>)}</tbody></table></div>}
    </section>
    {selected?.type === 'calibration' && <CalibrationDetails key={selected.id} sessionId={selected.id} close={() => setSelected(null)}/>}
    {selected?.type === 'game' && <GameResults key={selected.id} sessionId={selected.id} close={() => setSelected(null)}/>}
  </>
}

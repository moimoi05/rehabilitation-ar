import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Empty, ErrorState, Loading } from '../../components/States'
import { Button } from '../../components/ui/button'
import DurationChart from '../../components/DurationChart'
import CaptureArtifacts from '../../components/CaptureArtifacts'
import { useData } from '../../hooks/useData'
import { rehabApi } from '../../services/rehab'
import { sideLabel, statusLabel } from '../../types'
import type { Exercise, ReportFilters, SessionReport, StoredResult } from '../../types/rehab'
import { hospitalDate, hospitalDateTime } from '../../features/rehab/hospitalTime'

function resultData(result: StoredResult): Record<string, unknown> | null {
  try { const data: unknown = JSON.parse(result.result_json); return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null }
  catch { return null }
}
const answerLabel = (value: unknown): string => value === null || value === undefined || value === '' ? 'Chưa trả lời' : typeof value === 'boolean' ? (value ? 'Có' : 'Không') : Array.isArray(value) ? value.join(', ') : String(value)
const dateLabel = hospitalDateTime

function activitySummary(data: Record<string, unknown> | null): string {
  if (!data) return 'Dữ liệu cũ chưa có định dạng hiển thị'
  if (data.game_key === 'free_drawing') {
    if (typeof data.completed_strokes !== 'number' || !Number.isInteger(data.completed_strokes) || data.completed_strokes < 0) return 'Chưa ghi số nét'
    const active = typeof data.active_drawing_seconds === 'number' && Number.isFinite(data.active_drawing_seconds) && data.active_drawing_seconds >= 0 ? ` · ${data.active_drawing_seconds.toFixed(1)} giây đang vẽ` : ''
    return `${data.completed_strokes} nét${active}`
  }
  return typeof data.score === 'number' ? `Điểm: ${data.score}${typeof data.target_count === 'number' ? ` / ${data.target_count} mục tiêu` : ''}` : JSON.stringify(data)
}

export function ReportCard({ report, exercises = [] }: { report: SessionReport; exercises?: Exercise[] }) {
  const { session, patient } = report
  const exerciseName = (code: string, id: number | null) => exercises.find(exercise => exercise.id === id || exercise.code === code)?.name || code
  return <article className="panel rehab-report-card">
    <div className="panel-heading"><div><span className="eyebrow">{session.session_type === 'assessment' ? `ĐÁNH GIÁ #${session.id}` : <Link to={`/reports/training/${session.id}`}>LUYỆN TẬP #{session.id} · MỞ BUỔI</Link>}</span><h2><Link to={`/admin/patients/${patient.id}`}>{patient.research_code}</Link> · {patient.full_name || 'Chưa có họ tên'}</h2><p>{dateLabel(session.started_at || session.created_at)} · Tay bị ảnh hưởng: {sideLabel(session.affected_side)}</p></div><div className="rehab-toolbar">{report.is_baseline && <span className="rehab-badge">Baseline đầu vào</span>}<span className={`badge ${session.status}`}>{statusLabel[session.status]}</span></div></div>
    <div className="rehab-summary"><span>{report.trial_count} lượt thực hiện</span><span>{Math.round(report.duration_seconds * 10) / 10} giây đã lưu</span><span>{report.results.length} kết quả trò chơi</span></div>
    {report.clinical_assessments.length > 0 && <section><h2>FMA-UE do chuyên môn đánh giá</h2>{report.clinical_assessments.map(item => <p className="rehab-result-meta" key={item.id}>{item.clinician_confirmed && item.fma_ue_score !== null ? <><strong>{item.fma_ue_score} / 66</strong> · Đã xác nhận bởi {item.clinician_name || 'nhân viên chuyên môn'}</> : 'Chưa có điểm FMA-UE được chuyên môn xác nhận.'}{item.notes && ` · ${item.notes}`}</p>)}</section>}
    {session.session_type === 'assessment' && <details><summary>Câu hỏi và câu trả lời đã lưu</summary>{!report.questionnaires.length ? <Empty>Chưa có câu trả lời lâm sàng cho lần đánh giá này.</Empty> : report.questionnaires.map(submission => <div key={submission.id}><p className="rehab-result-meta">{submission.template_snapshot.name} · Phiên bản {submission.template_snapshot.version} · {submission.completed ? 'Đã hoàn tất' : 'Chưa hoàn tất'}</p><dl>{submission.template_snapshot.questions.map(question => <div className="rehab-question-answer" key={question.key}><dt>{question.group ? `${question.group} · ` : ''}{question.label}</dt><dd>{answerLabel(submission.answers.find(answer => answer.question_key === question.key)?.value)}</dd></div>)}</dl></div>)}</details>}
    <details open={session.session_type === 'training'}><summary>Chi tiết bài tập và từng lượt</summary>{!report.trials.length ? <Empty>Chưa có lượt thực hiện được ghi nhận.</Empty> : <div className="table-wrap"><table><thead><tr><th>Bài tập / Lượt</th><th>Trạng thái</th><th>Thời lượng</th><th>Kết quả</th><th>Tính hợp lệ dữ liệu</th></tr></thead><tbody>{report.trials.map(trial => {
      const saved = (trial.results || []).map(result => ({ result, data: resultData(result) }))
      return <tr key={trial.id}><td>{session.session_type === 'training' ? <Link className="text-link" to={`/reports/training/${session.id}/trials/${trial.id}`}><strong>{exerciseName(trial.exercise_code, trial.exercise_id)}</strong><span className="cell-sub">Mở lượt {trial.trial_number || trial.id}{trial.started_at ? ` · ${dateLabel(trial.started_at)}` : ''}</span></Link> : <><strong>{exerciseName(trial.exercise_code, trial.exercise_id)}</strong><span className="cell-sub">Lượt {trial.trial_number || trial.id}{trial.started_at ? ` · ${dateLabel(trial.started_at)}` : ''}</span></>}</td><td>{trial.status === 'completed' ? 'Đã hoàn thành' : trial.status === 'cancelled' ? 'Đã hủy' : trial.status ? 'Chưa hoàn thành' : 'Chưa ghi trạng thái'}</td><td>{saved.map(({ result, data }) => <div key={result.id}>{typeof data?.duration_seconds === 'number' ? `${Math.round(data.duration_seconds * 10) / 10} giây` : 'Chưa ghi thời lượng'}</div>)}{!saved.length && 'Chưa có kết quả'}</td><td>{saved.map(({ result, data }) => <div key={result.id}>{activitySummary(data)}</div>)}{!saved.length && 'Chưa lưu'}</td><td>{saved.map(({ result, data }) => <div key={result.id}>{data?.data_valid === true ? 'Hợp lệ theo ghi nhận' : data?.data_valid === false ? 'Không hợp lệ' : 'Chưa đánh giá tính hợp lệ'}</div>)}{!saved.length && 'Chưa có dữ liệu'}</td></tr>
    })}</tbody></table></div>}</details>
    <p className="help rehab-section">Điểm trò chơi không phải điểm FMA-UE. Thời lượng, điểm Hái hoa và số nét Vẽ tự do được trình bày riêng.</p>
    <CaptureArtifacts captures={report.captures || []}/>
  </article>
}

function ReportResults({ kind, filters, exercises }: { kind: 'assessments' | 'training'; filters: ReportFilters; exercises: Exercise[] }) {
  const load = useCallback(() => rehabApi.reports(kind, filters), [kind, filters])
  const { data, error, loading, reload } = useData(load)
  if (loading) return <Loading/>
  if (error) return <ErrorState message={error} retry={() => void reload()}/>
  if (!data?.length) return <Empty>Chưa có báo cáo phù hợp với bộ lọc.</Empty>
  const points = [...data].reverse().flatMap(report => report.results.map(result => ({ label: `${hospitalDate(report.session.started_at || report.session.created_at)} · #${report.session.id}`, duration_seconds: result.duration_seconds, game: exercises.find(exercise => exercise.id === result.exercise_id || exercise.code === (result.exercise_code || result.game_key))?.name || result.exercise_code || result.game_key })))
  return <>{kind === 'training' && <section className="panel"><h2>Tiến triển thời lượng theo ngày / buổi tập</h2><DurationChart data={points}/></section>}{data.map(report => <ReportCard key={report.session.id} report={report} exercises={exercises}/>)}</>
}

export default function ReportsPage() {
  const [params] = useSearchParams()
  const [kind, setKind] = useState<'assessments' | 'training'>(params.get('kind') === 'training' ? 'training' : 'assessments')
  const [form, setForm] = useState({ research_code: params.get('research_code') || '', from_date: params.get('from_date') || '', to_date: params.get('to_date') || '', exercise_id: params.get('exercise_id') || '', session_id: params.get('session_id') || '' })
  const [filters, setFilters] = useState<ReportFilters>({ ...(params.get('patient_id') ? { patient_id: Number(params.get('patient_id')) } : {}), ...(params.get('research_code') ? { research_code: params.get('research_code')! } : {}), ...(params.get('from_date') ? { from_date: params.get('from_date')! } : {}), ...(params.get('to_date') ? { to_date: params.get('to_date')! } : {}), ...(params.get('exercise_id') ? { exercise_id: Number(params.get('exercise_id')) } : {}), ...(params.get('session_id') ? { session_id: Number(params.get('session_id')) } : {}) })
  const [error, setError] = useState('')
  const { data: exercises } = useData(useCallback(() => rehabApi.exercises(), []))
  function apply() {
    if (form.from_date && form.to_date && form.to_date < form.from_date) { setError('Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.'); return }
    setError('')
    setFilters({ ...(params.get('patient_id') ? { patient_id: Number(params.get('patient_id')) } : {}), research_code: form.research_code.trim(), from_date: form.from_date, to_date: form.to_date, ...(form.exercise_id ? { exercise_id: Number(form.exercise_id) } : {}), ...(form.session_id ? { session_id: Number(form.session_id) } : {}) })
  }
  return <>
    <div className="page-heading"><div><span className="eyebrow">BÁO CÁO</span><h1>Báo cáo phục hồi chức năng</h1><p>Xem từng lần đánh giá, Baseline và quá trình luyện tập từ dữ liệu đã lưu.</p></div></div>
    <div className="rehab-tabs" role="tablist" aria-label="Loại báo cáo"><button role="tab" aria-selected={kind === 'assessments'} onClick={() => setKind('assessments')}>Báo cáo đánh giá</button><button role="tab" aria-selected={kind === 'training'} onClick={() => setKind('training')}>Báo cáo luyện tập</button></div>
    <form className="panel rehab-toolbar" onSubmit={event => { event.preventDefault(); apply() }}><label>Mã bệnh nhân<input maxLength={64} value={form.research_code} onChange={event => setForm({ ...form, research_code: event.target.value })}/></label><label>Từ ngày<input type="date" value={form.from_date} onChange={event => setForm({ ...form, from_date: event.target.value })}/></label><label>Đến ngày<input type="date" value={form.to_date} onChange={event => setForm({ ...form, to_date: event.target.value })}/></label><label>Bài tập<select value={form.exercise_id} onChange={event => setForm({ ...form, exercise_id: event.target.value })}><option value="">Tất cả bài</option>{exercises?.map(exercise => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label><label>Mã buổi / lần đánh giá<input type="number" min="1" step="1" value={form.session_id} onChange={event => setForm({ ...form, session_id: event.target.value })}/></label><Button>Áp dụng bộ lọc</Button></form>
    {error && <div className="rehab-inline-error"><ErrorState message={error}/></div>}
    <div className="rehab-section"><ReportResults key={`${kind}:${JSON.stringify(filters)}`} kind={kind} filters={filters} exercises={exercises || []}/></div>
  </>
}

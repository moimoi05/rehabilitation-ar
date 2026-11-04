import { useCallback, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Empty, ErrorState, Loading } from '../../components/States'
import { Button } from '../../components/ui/button'
import PatientForm from '../../components/PatientForm'
import TransferDialog from '../../components/TransferDialog'
import DurationChart from '../../components/DurationChart'
import { useData } from '../../hooks/useData'
import { rehabApi } from '../../services/rehab'
import { sideLabel, statusLabel } from '../../types'
import type { Exercise, ExercisePrescription, RehabPatient } from '../../types/rehab'

function Prescriptions({ patient, prescriptions, exercises, reload }: { patient: RehabPatient; prescriptions: ExercisePrescription[]; exercises: Exercise[]; reload: () => Promise<void> }) {
  const [exerciseId, setExerciseId] = useState('')
  const [clinician, setClinician] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await rehabApi.createPrescription(patient.id, { exercise_id: Number(exerciseId), clinician_name: clinician.trim(), notes: notes.trim() || null }); setExerciseId(''); setNotes(''); await reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không lưu được chỉ định.') }
    finally { setBusy(false) }
  }
  async function toggle(id: number, active: boolean) {
    setBusy(true); setError('')
    try { await rehabApi.updatePrescription(id, { active }); await reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không cập nhật được chỉ định.') }
    finally { setBusy(false) }
  }
  return <section className="panel rehab-section"><div className="panel-heading"><div><h2>Bài tập được bác sĩ chỉ định</h2><p>Hái hoa là bài tập mặc định. Các bài khác cần chỉ định có tên nhân viên chuyên môn.</p></div></div>
    {error && <ErrorState message={error}/>} {!prescriptions.length ? <Empty>Chưa có chỉ định bổ sung.</Empty> : <div className="table-wrap"><table><thead><tr><th>Bài tập</th><th>Người chỉ định</th><th>Trạng thái / Thời hạn</th><th/></tr></thead><tbody>{prescriptions.map(item => <tr key={item.id}><td><strong>{item.exercise.name}</strong><span className="cell-sub">{item.notes}</span></td><td>{item.clinician_name}</td><td>{item.active ? 'Đang áp dụng' : 'Đã ngừng'}<span className="cell-sub">{item.starts_on || 'Từ khi chỉ định'} → {item.ends_on || 'Chưa có ngày kết thúc'}</span></td><td><button className="text-link" disabled={busy} onClick={() => void toggle(item.id, !item.active)}>{item.active ? 'Ngừng chỉ định' : 'Áp dụng lại'}</button></td></tr>)}</tbody></table></div>}
    {patient.patient_type === 'inpatient' && <form className="form rehab-section" onSubmit={event => void create(event)}><div className="form-grid"><label>Bài tập bổ sung<select required value={exerciseId} disabled={busy} onChange={event => setExerciseId(event.target.value)}><option value="">Chọn bài tập</option>{exercises.filter(item => !item.is_default && item.active && (item.renderer === 'flower' || (item.renderer === 'free_drawing' && item.usage_mode === 'training')) && !prescriptions.some(prescription => prescription.exercise_id === item.id && prescription.active)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Người chỉ định<input required minLength={2} maxLength={255} value={clinician} disabled={busy} onChange={event => setClinician(event.target.value)}/></label></div><label>Ghi chú chỉ định<textarea rows={2} maxLength={2000} value={notes} disabled={busy} onChange={event => setNotes(event.target.value)}/></label><div className="form-actions"><Button disabled={busy || !exerciseId || !clinician.trim()}>Lưu chỉ định</Button></div></form>}
  </section>
}

export default function PatientProfile() {
  const params = useParams()
  const patientId = Number(params.patientId || params.id)
  const load = useCallback(async () => { const [report, exercises] = await Promise.all([rehabApi.patientReport(patientId), rehabApi.exercises('training')]); return { report, exercises } }, [patientId])
  const { data, error, loading, reload } = useData(load)
  const [edit, setEdit] = useState(false)
  const [transfer, setTransfer] = useState(false)
  if (loading) return <Loading/>
  if (error) return <ErrorState message={error} retry={() => void reload()}/>
  if (!data) return null
  const { report, exercises } = data
  const { patient } = report
  const date = (value: string | null) => value ? new Date(value).toLocaleDateString('vi-VN') : 'Chưa cung cấp'
  const sexLabel = { male: 'Nam', female: 'Nữ', other: 'Khác', unspecified: 'Chưa cung cấp' }
  const allSessions = [...report.assessments, ...report.training].sort((left, right) => right.session.created_at.localeCompare(left.session.created_at))
  const chart = report.training.flatMap(item => item.results.map(result => ({ label: `${date(item.session.started_at || item.session.created_at)} · #${item.session.id}`, duration_seconds: result.duration_seconds, game: exercises.find(exercise => exercise.code === (result.exercise_code || result.game_key))?.name || result.exercise_code || result.game_key })))
  return <>
    <Link className="back-link" to="/admin"><ArrowLeft size={16}/> Quản trị bệnh nhân</Link><div className="page-heading"><div><span className="eyebrow">{patient.patient_type === 'inpatient' ? 'BỆNH NHÂN ĐIỀU TRỊ' : 'BỆNH NHÂN ĐẾN KHÁM'}</span><h1>{patient.research_code}</h1><p>{patient.full_name || 'Chưa có họ tên'}</p></div><div className="rehab-toolbar"><Button variant="outline" onClick={() => setEdit(true)}>Sửa hồ sơ</Button><Button asChild><Link to={`/${patient.patient_type === 'inpatient' ? 'training' : 'assessment'}/${patient.id}`}>{patient.patient_type === 'inpatient' ? 'Mở luyện tập' : 'Bắt đầu đánh giá'}</Link></Button><Button variant="outline" onClick={() => setTransfer(true)}>{patient.patient_type === 'inpatient' ? 'Chuyển về đến khám' : 'Chuyển sang điều trị'}</Button></div></div>
    <div className="details-grid"><section className="panel"><h2>Thông tin bệnh nhân</h2><dl className="detail-list"><div><dt>Họ tên</dt><dd>{patient.full_name || 'Chưa cung cấp'}</dd></div><div><dt>Ngày sinh</dt><dd>{date(patient.date_of_birth)}</dd></div><div><dt>Giới tính</dt><dd>{sexLabel[patient.sex || 'unspecified']}</dd></div><div><dt>Tay bị ảnh hưởng</dt><dd>{sideLabel(patient.affected_side)}</dd></div><div><dt>Tay thuận</dt><dd>{sideLabel(patient.dominant_hand)}</dd></div><div><dt>Ngày nhập viện</dt><dd>{date(patient.admitted_at)}</dd></div><div><dt>Liên hệ</dt><dd>{patient.contact || 'Chưa cung cấp'}</dd></div><div><dt>Ghi chú</dt><dd>{patient.notes || 'Chưa có ghi chú'}</dd></div></dl></section>
      <section className="panel"><div className="panel-heading"><div><h2>Lịch sử đánh giá và luyện tập</h2><p>{report.assessments.length} lần đánh giá · {report.training.length} buổi luyện tập</p></div><Link className="text-link" to={`/reports?patient_id=${patient.id}`}>Xem báo cáo</Link></div>{!allSessions.length ? <Empty>Chưa có lịch sử.</Empty> : <div className="activity-list">{allSessions.map(item => <div className="activity-row" key={item.session.id}><div className="grow"><strong>{item.session.session_type === 'assessment' ? 'Đánh giá' : 'Luyện tập'} #{item.session.id}{item.is_baseline ? ' · Baseline' : ''}</strong><span>{date(item.session.created_at)} · {item.trial_count} lượt · {item.duration_seconds} giây</span></div><span className={`badge ${item.session.status}`}>{statusLabel[item.session.status]}</span><Link className="text-link" to={`/reports?patient_id=${patient.id}&session_id=${item.session.id}&kind=${item.session.session_type === 'assessment' ? 'assessments' : 'training'}`}>Chi tiết</Link></div>)}</div>}</section></div>
    <section className="panel rehab-section"><h2>Thời lượng luyện tập đã lưu</h2><DurationChart data={chart}/></section>
    <Prescriptions patient={patient} prescriptions={report.prescriptions} exercises={exercises} reload={reload}/>
    <section className="panel rehab-section"><h2>Lịch sử chuyển nhóm</h2>{!report.transfers.length ? <Empty>Chưa có sự kiện chuyển nhóm.</Empty> : <div className="activity-list">{report.transfers.map(item => <div className="activity-row" key={item.id}><div className="grow"><strong>{item.to_type === 'inpatient' ? 'Nhập nhóm điều trị' : 'Chuyển về đến khám'}</strong><span>{date(item.created_at)} · {item.baseline_assessment_session_id ? `Baseline #${item.baseline_assessment_session_id}` : 'Không có Baseline'} · {item.reason || 'Không có ghi chú'}</span></div>{item.baseline_assessment_session_id && <Link className="text-link" to={`/reports?patient_id=${patient.id}&session_id=${item.baseline_assessment_session_id}`}>Xem Baseline</Link>}</div>)}</div>}</section>
    {edit && <PatientForm patient={patient} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); void reload() }}/>} {transfer && <TransferDialog patient={patient} onClose={() => setTransfer(false)} onTransferred={() => { setTransfer(false); void reload() }}/>} 
  </>
}

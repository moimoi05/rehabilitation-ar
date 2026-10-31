import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { Empty, ErrorState, Loading } from '../components/States'
import PatientForm from '../components/PatientForm'
import TransferDialog from '../components/TransferDialog'
import { rehabApi } from '../services/rehab'
import type { Exercise, QuestionnaireAnswer, QuestionnaireSubmission, QuestionnaireTemplate, RehabPatient, RehabSession, SessionReport } from '../types/rehab'
import PatientBanner from '../features/rehab/PatientBanner'
import QuestionnaireForm from '../features/rehab/QuestionnaireForm'
import ExerciseCatalog from '../features/rehab/ExerciseCatalog'
import SessionSummary from '../features/rehab/SessionSummary'
import GameResult from '../features/rehab/GameResult'
import ClinicalWorkspace from '../features/rehab/ClinicalWorkspace'
import type { SavedGameResult } from '../features/rehab/ClinicalWorkspace'

function AssessmentSearch() {
  const navigate = useNavigate()
  const [patients, setPatients] = useState<RehabPatient[]>([]), [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [createOpen, setCreateOpen] = useState(false)
  const searchRevision = useRef(0)
  const load = useCallback(async () => {
    const request = ++searchRevision.current
    setLoading(true); setError('')
    try { const records = await rehabApi.patients({ patient_type: 'outpatient', search: query.trim() }); if (request === searchRevision.current) setPatients(records) }
    catch (err) { if (request === searchRevision.current) setError(err instanceof Error ? err.message : 'Không tải được bệnh nhân.') }
    finally { if (request === searchRevision.current) setLoading(false) }
  }, [query])
  const invalidateSearch = useCallback(() => { searchRevision.current++ }, [])
  useEffect(() => { invalidateSearch(); const timer = setTimeout(() => { void load() }, 200); return () => { invalidateSearch(); clearTimeout(timer) } }, [load, invalidateSearch])
  return <><div className="page-heading"><div><span className="eyebrow">ĐÁNH GIÁ</span><h1>Chọn bệnh nhân đến khám</h1><p>Mỗi lần bắt đầu đánh giá tạo một lần khám mới và giữ nguyên các kết quả trước.</p></div><Button onClick={() => setCreateOpen(true)}>Tạo hồ sơ đến khám</Button></div>
    <section className="panel"><div className="panel-heading"><h2>Bệnh nhân đến khám</h2><label className="search"><input aria-label="Tìm bệnh nhân đến khám" value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm mã hoặc họ tên" /></label></div>
      {loading ? <Loading /> : error ? <ErrorState message={error} retry={() => void load()} /> : patients.length === 0 ? <Empty>Không tìm thấy hồ sơ. Có thể tạo bệnh nhân đến khám mới.</Empty> : <div className="table-wrap"><table><thead><tr><th>Mã bệnh nhân</th><th>Họ tên</th><th /></tr></thead><tbody>{patients.map(patient => <tr key={patient.id}><td>{patient.research_code}</td><td>{patient.full_name || 'Chưa có họ tên'}</td><td><Link className="text-link" to={`/assessment/${patient.id}`}>Chọn bệnh nhân</Link></td></tr>)}</tbody></table></div>}
    </section>{createOpen && <PatientForm onClose={() => setCreateOpen(false)} onSaved={patient => { setCreateOpen(false); navigate(`/assessment/${patient.id}`) }} />}
  </>
}

function FmaForm({ busy, onSave }: { busy: boolean; onSave: (score: number, clinicianName: string) => void }) {
  const [score, setScore] = useState(''), [name, setName] = useState(''), [confirmed, setConfirmed] = useState(false)
  function submit(event: FormEvent) { event.preventDefault(); if (score !== '' && confirmed && name.trim()) onSave(Number(score), name.trim()) }
  return <section className="panel"><h2>FMA-UE do chuyên môn đánh giá</h2><p className="help">Chỉ nhập khi nhân viên chuyên môn đã đánh giá và xác nhận. Không tính từ số hoa hay điểm trò chơi.</p><form className="form" onSubmit={submit}><div className="form-grid"><label>Điểm FMA-UE (0–66)<input type="number" min={0} max={66} step={1} required value={score} onChange={event => setScore(event.target.value)} /></label><label>Nhân viên xác nhận<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label></div><label className="checkbox"><input required type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Tôi xác nhận điểm từ đánh giá chuyên môn</label><div className="form-actions"><Button disabled={busy || !confirmed}>Lưu điểm chuyên môn</Button></div></form></section>
}

type Stage = 'patient' | 'questions' | 'setup' | 'catalog' | 'game' | 'result' | 'summary'
const steps = ['Thông tin bệnh nhân', 'Câu hỏi lâm sàng', 'Setup camera', 'Danh sách bài', 'Thực hiện', 'Kết quả']
const stageIndex: Record<Stage, number> = { patient: 0, questions: 1, setup: 2, catalog: 3, game: 4, result: 5, summary: 5 }

function AssessmentVisit({ patientId }: { patientId: number }) {
  const [patient, setPatient] = useState<RehabPatient | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [templates, setTemplates] = useState<QuestionnaireTemplate[]>([]), [templateId, setTemplateId] = useState(''), [exercises, setExercises] = useState<Exercise[]>([])
  const [history, setHistory] = useState<RehabSession[]>([]), [session, setSession] = useState<RehabSession | null>(null), [submission, setSubmission] = useState<QuestionnaireSubmission | null>(null)
  const [stage, setStage] = useState<Stage>('patient'), [busy, setBusy] = useState(false), [transferOpen, setTransferOpen] = useState(false), [cameraAttached, setCameraAttached] = useState(false)
  const [selectedIds, setSelectedIds] = useState<number[]>([]), [exercise, setExercise] = useState<Exercise | null>(null), [result, setResult] = useState<SavedGameResult | null>(null), [report, setReport] = useState<SessionReport | null>(null)
  const setupRevision = useRef(0)
  const load = useCallback(async () => {
    setError('')
    try {
      const [profile, questionnaires, catalog, visits] = await Promise.all([rehabApi.patient(patientId), rehabApi.questionnaires(), rehabApi.exercises('assessment', patientId), rehabApi.assessments({ patient_id: patientId })])
      setPatient(profile); setTemplates(questionnaires); setTemplateId(String(questionnaires[0]?.id ?? '')); setExercises(catalog); setHistory(visits)
    } catch (err) { setError(err instanceof Error ? err.message : 'Không tải được thông tin đánh giá.') }
    finally { setLoading(false) }
  }, [patientId])
  useEffect(() => { void load() }, [load])
  async function begin() {
    if (!templateId) { setError('Chưa có bộ câu hỏi đang hoạt động. Cần cấu hình trước khi đánh giá.'); return }
    setBusy(true); setError('')
    try {
      const created = await rehabApi.createAssessment(patientId); setSession(created); setStage('questions')
      setSelectedIds(exercises.filter(item => item.is_default).map(item => item.id))
      setSubmission(await rehabApi.createSubmission(created.id, Number(templateId)))
    } catch (err) { setError(err instanceof Error ? err.message : 'Không tạo được lần đánh giá.') }
    finally { setBusy(false) }
  }
  async function saveQuestions(answers: QuestionnaireAnswer[]) {
    if (!submission) return
    setBusy(true); setError('')
    try { if (!submission.completed) setSubmission(await rehabApi.saveAnswers(submission.id, answers, true)); setCameraAttached(true); setStage('setup') }
    catch (err) { setError(err instanceof Error ? err.message : 'Không lưu được câu trả lời.') }
    finally { setBusy(false) }
  }
  function setupSaved() {
    setupRevision.current++
    setSession(previous => previous ? { ...previous, setup_confirmed: true } : previous)
    setStage('catalog'); setError('')
  }
  function setupInvalidated() { setupRevision.current++; setSession(previous => previous ? { ...previous, setup_confirmed: false } : previous); setStage('setup') }
  async function play(selected: Exercise) {
    if (!session?.setup_confirmed || !selectedIds.includes(selected.id)) return
    const revision = setupRevision.current
    setBusy(true); setError('')
    try {
      const configured = await rehabApi.updateAssessment(session.id, { selected_exercise_ids: selectedIds })
      const started = configured.status === 'draft' ? await rehabApi.startAssessment(session.id) : configured
      if (revision !== setupRevision.current) return
      setSession(started); setExercise(selected); setResult(null); setStage('game')
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Không lưu được danh sách bài.') }
    finally { setBusy(false) }
  }
  async function showSummary() {
    if (!session) return
    setBusy(true); setError('')
    try { if (session.status !== 'completed') await rehabApi.updateAssessment(session.id, { selected_exercise_ids: selectedIds }); setReport(await rehabApi.assessmentDetail(session.id)); setStage('summary') }
    catch (err) { setError(err instanceof Error ? err.message : 'Không tải được kết quả.') }
    finally { setBusy(false) }
  }
  async function saved(savedResult: SavedGameResult) {
    if (!session || savedResult.session_id !== session.id) return
    setResult(savedResult); setStage('result'); setError(''); setBusy(true)
    try { setReport(await rehabApi.assessmentDetail(session.id)) }
    catch (err) { setError(err instanceof Error ? err.message : 'Kết quả đã lưu nhưng chưa tải được tổng kết.') }
    finally { setBusy(false) }
  }
  async function fma(score: number, name: string) {
    if (!session) return
    setBusy(true); setError('')
    try { await rehabApi.updateAssessment(session.id, { fma_ue_score: score, clinician_name: name, clinician_confirmed: true }); setReport(await rehabApi.assessmentDetail(session.id)) }
    catch (err) { setError(err instanceof Error ? err.message : 'Không lưu được điểm chuyên môn.') }
    finally { setBusy(false) }
  }
  async function complete() {
    if (!session) return
    setBusy(true); setError('')
    try {
      const completed = await rehabApi.completeAssessment(session.id)
      setSession(completed); setCameraAttached(false); setReport(previous => previous ? { ...previous, session: completed } : previous); setStage('summary')
      try { setReport(await rehabApi.assessmentDetail(session.id)) }
      catch { setError('Đánh giá đã hoàn tất nhưng chưa tải lại được báo cáo. Có thể xem trong phân hệ Báo cáo.') }
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Chưa hoàn tất được đánh giá.') }
    finally { setBusy(false) }
  }
  if (loading) return <Loading />
  if (!patient) return <ErrorState message={error || 'Không tìm thấy bệnh nhân.'} retry={() => void load()} />
  if (patient.patient_type !== 'outpatient' && !session) return <><ErrorState message="Bệnh nhân đã thuộc nhóm điều trị. Hãy mở phân hệ Luyện tập hoặc xem các báo cáo đánh giá trước." /><Link className="text-link" to={`/training/${patientId}`}>Đến Luyện tập</Link></>
  const allSelectedDone = selectedIds.length > 0 && selectedIds.every(id => report?.trials.some(trial => trial.exercise_id === id && trial.status === 'completed' && (trial.results?.length ?? 0) > 0))
  return <><div className="page-heading"><div><span className="eyebrow">ĐÁNH GIÁ</span><h1>Đánh giá phục hồi chức năng</h1><p>{session ? `Lần đánh giá #${session.id}` : 'Bắt đầu một lần khám mới cho hồ sơ đã chọn.'}</p></div><Link className="text-link" to="/assessment">Chọn bệnh nhân khác</Link></div>
    <PatientBanner patient={patient} /><ol className="workflow-steps" aria-label="Các bước đánh giá">{steps.map((step, index) => <li key={step} aria-current={stageIndex[stage] === index ? 'step' : undefined}><span>{index + 1}</span>{step}</li>)}</ol>
    {error && <ErrorState message={error} />}
    {stage === 'patient' && <section className="panel"><h2>Thông tin lần khám</h2><p className="help">{history.length} lần đánh giá trước được giữ nguyên. Hồ sơ đã có sẽ được dùng lại, mỗi lần khám tạo đánh giá mới.</p>{!session ? <><div className="form"><label>Bộ câu hỏi<select value={templateId} onChange={event => setTemplateId(event.target.value)}>{templates.map(item => <option key={item.id} value={item.id}>{item.name} · phiên bản {item.version}</option>)}</select></label></div><div className="form-actions"><Button disabled={busy || !templateId} onClick={() => void begin()}>Bắt đầu đánh giá mới</Button></div></> : <div className="form-actions"><Button onClick={() => setStage('questions')}>Tiếp tục đánh giá</Button></div>}<Link className="text-link" to={`/reports?patient_id=${patientId}&kind=assessments`}>Xem lịch sử đánh giá</Link></section>}
    {stage === 'questions' && submission && <QuestionnaireForm key={submission.id} submission={submission} busy={busy} onSave={answers => void saveQuestions(answers)} onBack={() => setStage('patient')} />}
    {stage === 'questions' && !submission && session && <Button disabled={busy} onClick={() => { setBusy(true); rehabApi.createSubmission(session.id, Number(templateId)).then(setSubmission).catch(err => setError(err instanceof Error ? err.message : 'Không tải được câu hỏi.')).finally(() => setBusy(false)) }}>Tải lại bộ câu hỏi</Button>}
    {stage === 'setup' && <section className="panel"><div className="panel-heading"><div><h2>Thiết lập camera</h2><p>Bật camera, điều chỉnh ghế và hình bóng; kiểm tra đầu, vai, thân trước khi tiếp tục.</p></div><Button variant="outline" disabled={busy} onClick={() => setStage('questions')}>Quay lại câu hỏi</Button></div></section>}
    {stage === 'catalog' && <section className="flow-section"><div className="panel-heading"><div><h2>Danh sách bài đánh giá</h2><p>Có thể chọn nhiều bài và thực hiện nhiều lượt trong cùng lần đánh giá.</p></div><Button variant="outline" disabled={busy || !report?.results.length} onClick={() => void showSummary()}>Xem kết quả đánh giá</Button></div><ExerciseCatalog exercises={exercises} selectedIds={selectedIds} onSelectionChange={setSelectedIds} trials={report?.trials} disabled={busy || !session?.setup_confirmed} onPlay={selected => void play(selected)} /></section>}
    {stage === 'game' && <div className="notice">Đang thực hiện: {exercise?.name}. Xác nhận lưu kết quả để quay lại danh sách hoặc xem tổng kết.</div>}
    {stage === 'result' && result && <GameResult result={result} exercise={exercise} captures={report?.captures} busy={busy} onContinue={() => setStage('catalog')} onReturn={() => void showSummary()} />}
    {stage === 'summary' && report && <><SessionSummary report={report} exercises={exercises} />{session?.status !== 'completed' && <FmaForm busy={busy} onSave={(score, name) => void fma(score, name)} />}<section className="panel"><div className="form-actions"><Link className="text-link" to={`/reports?patient_id=${patientId}&kind=assessments&session_id=${session?.id}`}>Xem chi tiết trong Báo cáo</Link>{session?.status !== 'completed' ? <><Button variant="outline" disabled={busy} onClick={() => setStage('catalog')}>Quay lại danh sách bài</Button><Button disabled={busy || !allSelectedDone} onClick={() => void complete()}>Hoàn tất đánh giá</Button></> : <><span className="badge completed">Đánh giá đã hoàn tất</span>{patient.patient_type === 'outpatient' && <Button onClick={() => setTransferOpen(true)}>Chuyển sang bệnh nhân điều trị</Button>}</>}</div>{!allSelectedDone && session?.status !== 'completed' && <p className="help">Cần thực hiện và lưu ít nhất một lượt cho mỗi bài đã chọn trước khi hoàn tất.</p>}</section></>}
    {cameraAttached && session && <ClinicalWorkspace session={session} exercise={exercise} view={stage === 'setup' ? 'setup' : stage === 'game' ? 'game' : 'monitor'} onSetupSaved={() => void setupSaved()} onSetupInvalidated={setupInvalidated} onResultSaved={savedResult => void saved(savedResult)} />}
    {transferOpen && session && <TransferDialog patient={patient} baselineSessionId={session.id} onClose={() => setTransferOpen(false)} onTransferred={updated => { setPatient(updated); setTransferOpen(false) }} />}
  </>
}

export default function Assessment() {
  const { patientId } = useParams()
  if (!patientId) return <AssessmentSearch />
  const id = Number(patientId)
  return Number.isInteger(id) && id > 0 ? <AssessmentVisit key={id} patientId={id} /> : <ErrorState message="Mã hồ sơ không hợp lệ." />
}

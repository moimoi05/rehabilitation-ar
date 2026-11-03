import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { Empty, ErrorState, Loading } from '../components/States'
import DurationChart from '../components/DurationChart'
import { rehabApi } from '../services/rehab'
import { api } from '../services/api'
import { statusLabel } from '../types'
import type { Exercise, PatientReport, RehabSession, SessionReport } from '../types/rehab'
import ClinicalWorkspace from '../features/rehab/ClinicalWorkspace'
import type { SavedGameResult } from '../features/rehab/ClinicalWorkspace'
import PatientBanner from '../features/rehab/PatientBanner'
import ExerciseCatalog from '../features/rehab/ExerciseCatalog'
import GameResult from '../features/rehab/GameResult'
import { hospitalDate, hospitalDateTime, hospitalDay } from '../features/rehab/hospitalTime'

function TrainingSearch() {
  const navigate = useNavigate()
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [outpatientId, setOutpatientId] = useState<number | null>(null)
  const searchRevision = useRef(0)
  useEffect(() => () => { searchRevision.current++ }, [])
  async function search(event: FormEvent) {
    const request = ++searchRevision.current
    event.preventDefault(); setBusy(true); setError(''); setOutpatientId(null)
    try {
      const researchCode = code.trim()
      const patients = await rehabApi.patients({ patient_type: 'inpatient', search: researchCode })
      if (request !== searchRevision.current) return
      const patient = patients.find(item => item.research_code === researchCode)
      if (patient) { navigate(`/training/${patient.id}`); return }
      const visitors = await rehabApi.patients({ patient_type: 'outpatient', search: researchCode })
      if (request !== searchRevision.current) return
      const visitor = visitors.find(item => item.research_code === researchCode)
      if (visitor) { setOutpatientId(visitor.id); setError('Bệnh nhân thuộc nhóm đến khám. Hãy hoàn tất đánh giá và chuyển nhóm trước khi luyện tập.') }
      else setError('Không tìm thấy bệnh nhân điều trị với mã này. Vui lòng kiểm tra và nhập lại.')
    } catch (err) { if (request === searchRevision.current) setError(err instanceof Error ? err.message : 'Không tìm được bệnh nhân.') }
    finally { if (request === searchRevision.current) setBusy(false) }
  }
  return <><div className="page-heading"><div><span className="eyebrow">LUYỆN TẬP</span><h1>Tìm bệnh nhân luyện tập</h1><p>Nhập chính xác mã bệnh nhân điều trị (phân biệt chữ hoa/thường) để mở hồ sơ và lịch sử buổi tập.</p></div></div>
    <section className="panel"><form className="form" onSubmit={event => void search(event)}><label>Mã bệnh nhân<input value={code} onChange={event => { searchRevision.current++; setCode(event.target.value); setError(''); setOutpatientId(null); setBusy(false) }} required maxLength={64} autoComplete="off" placeholder="VD: NC-001" /></label><div className="form-actions"><Button disabled={busy}>{busy ? 'Đang tìm…' : 'Tìm bệnh nhân'}</Button></div></form>
      {error && <ErrorState message={error} />}{outpatientId && <Link className="text-link" to={`/assessment/${outpatientId}`}>Đến Đánh giá</Link>}
    </section>
  </>
}

function TrainingHistory({ data }: { data: PatientReport }) {
  const [fromDate, setFromDate] = useState(''), [toDate, setToDate] = useState(''), [exerciseId, setExerciseId] = useState('')
  const allExercises = [...data.available_exercises, ...data.prescriptions.map(item => item.exercise)]
  const exercises = allExercises.filter((item, index) => allExercises.findIndex(value => value.id === item.id) === index)
  const history = data.training.filter(report => {
    const day = hospitalDay(report.session.created_at)
    return (!fromDate || day >= fromDate) && (!toDate || day <= toDate) && (!exerciseId || report.trials.some(trial => trial.exercise_id === Number(exerciseId)))
  })
  const chart = [...history].sort((a, b) => new Date(a.session.created_at).getTime() - new Date(b.session.created_at).getTime() || a.session.id - b.session.id).flatMap(report => report.results.filter(result => !exerciseId || report.trials.find(trial => trial.id === result.trial_id)?.exercise_id === Number(exerciseId)).map(result => {
    const trial = report.trials.find(item => item.id === result.trial_id)
    return { label: `${hospitalDate(report.session.created_at)} · #${report.session.id}`, duration_seconds: result.duration_seconds, game: exercises.find(item => item.id === trial?.exercise_id)?.name ?? trial?.exercise_code ?? result.game_key }
  }))
  return <section className="panel"><div className="panel-heading"><div><h2>Lịch sử luyện tập</h2><p>{data.training.length} buổi đã ghi nhận từ cơ sở dữ liệu.</p></div><Link className="text-link" to={`/reports?patient_id=${data.patient.id}&kind=training`}>Xem báo cáo chi tiết</Link></div>
    <div className="form form-grid history-filters"><label>Từ ngày<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>Đến ngày<input type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)} /></label><label>Game trong biểu đồ<select value={exerciseId} onChange={event => setExerciseId(event.target.value)}><option value="">Tất cả game · thời lượng</option>{exercises.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    <DurationChart data={chart} />
    {history.length === 0 ? <Empty>Chưa có buổi luyện tập trong khoảng thời gian đã chọn.</Empty> : <div className="table-wrap"><table><thead><tr><th>Ngày / buổi</th><th>Game</th><th>Số lượt</th><th>Thời lượng</th><th>Trạng thái</th></tr></thead><tbody>{history.map(report => <tr key={report.session.id}><td>{hospitalDateTime(report.session.created_at)} · #{report.session.id}</td><td>{[...new Set(report.trials.map(trial => exercises.find(item => item.id === trial.exercise_id)?.name ?? trial.exercise_code))].join(', ') || 'Chưa thực hiện'}</td><td>{report.trial_count}</td><td>{report.duration_seconds.toFixed(1)} giây</td><td><span className={`badge ${report.session.status}`}>{statusLabel[report.session.status]}</span></td></tr>)}</tbody></table></div>}
    <p className="help">Biểu đồ chỉ dùng thời lượng đã lưu; điểm của các game khác nhau được xem riêng trong báo cáo.</p>
  </section>
}

function TrainingDashboard({ patientId }: { patientId: number }) {
  const navigate = useNavigate()
  const [data, setData] = useState<PatientReport | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [session, setSession] = useState<RehabSession | null>(null), [currentReport, setCurrentReport] = useState<SessionReport | null>(null)
  const [stage, setStage] = useState<'dashboard' | 'setup' | 'game' | 'result'>('dashboard')
  const [exercise, setExercise] = useState<Exercise | null>(null), [result, setResult] = useState<SavedGameResult | null>(null)
  const [busy, setBusy] = useState(false), [finishOpen, setFinishOpen] = useState(false)
  const [cancelId, setCancelId] = useState<number | null>(null)
  const setupRevision = useRef(0)
  const loadRevision = useRef(0)
  const load = useCallback(async () => { const request = ++loadRevision.current; setError(''); try { const report = await rehabApi.patientReport(patientId); if (request === loadRevision.current) setData(report) } catch (err) { if (request === loadRevision.current) setError(err instanceof Error ? err.message : 'Không tải được hồ sơ.') } finally { if (request === loadRevision.current) setLoading(false) } }, [patientId])
  const invalidateLoad = useCallback(() => { loadRevision.current++ }, [])
  useEffect(() => { void load(); return invalidateLoad }, [load, invalidateLoad])
  async function begin() {
    setBusy(true); setError('')
    try { const created = await rehabApi.createTraining(patientId); setSession(created); setCurrentReport(null); setResult(null); setStage('setup') }
    catch (err) { setError(err instanceof Error ? err.message : 'Không tạo được buổi tập.') }
    finally { setBusy(false) }
  }
  async function setupSaved() {
    if (!session) return
    const revision = ++setupRevision.current
    setSession(previous => previous ? { ...previous, setup_confirmed: true } : previous)
    setBusy(true); setError('')
    try {
      const started = await rehabApi.startTraining(session.id)
      if (revision !== setupRevision.current) return
      setSession(started); setStage('dashboard')
    } catch (err) { setError(err instanceof Error ? err.message : 'Chưa bắt đầu được buổi tập.') }
    finally { setBusy(false) }
  }
  function setupInvalidated() { setupRevision.current++; setSession(previous => previous ? { ...previous, setup_confirmed: false } : previous); setStage('setup') }
  function play(selected: Exercise) {
    if (!session?.setup_confirmed || session.status !== 'in_progress') { setStage('setup'); return }
    setExercise(selected); setResult(null); setStage('game')
  }
  async function saved(savedResult: SavedGameResult) {
    if (!session || savedResult.session_id !== session.id) return
    const request = ++loadRevision.current
    setResult(savedResult); setStage('result'); setError(''); setBusy(true)
    try { const [updated, detail] = await Promise.all([rehabApi.patientReport(patientId), rehabApi.trainingDetail(session.id)]); if (request === loadRevision.current) { setData(updated); setCurrentReport(detail) } }
    catch (err) { if (request === loadRevision.current) setError(err instanceof Error ? err.message : 'Kết quả đã lưu nhưng chưa tải lại được lịch sử.') }
    finally { setBusy(false) }
  }
  async function finish() {
    if (!session) return
    setBusy(true); setError('')
    try { if (session.status === 'draft') await api.updateSession(session.id, { status: 'cancelled' }); else await rehabApi.completeTraining(session.id); setSession(null); setFinishOpen(false); navigate('/training') }
    catch (err) { setError(err instanceof Error ? err.message : 'Chưa kết thúc được buổi tập. Hãy thử lại.') }
    finally { setBusy(false) }
  }
  async function cancelUnfinished() {
    if (!cancelId) return
    setBusy(true); setError('')
    try { await api.updateSession(cancelId, { status: 'cancelled' }); setCancelId(null); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Chưa đóng được buổi dang dở.') }
    finally { setBusy(false) }
  }
  if (loading) return <Loading />
  if (!data) return <ErrorState message={error || 'Không tìm thấy bệnh nhân.'} retry={() => void load()} />
  if (data.patient.patient_type !== 'inpatient') return <><ErrorState message="Bệnh nhân thuộc nhóm đến khám. Hoàn tất đánh giá và chuyển nhóm trước khi luyện tập." /><Link className="text-link" to={`/assessment/${patientId}`}>Đến Đánh giá</Link></>
  const unfinished = data.training.filter(item => ['draft', 'in_progress'].includes(item.session.status) && item.session.id !== session?.id)
  return <><div className="page-heading"><div><span className="eyebrow">LUYỆN TẬP</span><h1>Buổi luyện tập</h1><p>{session ? `Buổi #${session.id} · ${statusLabel[session.status]}` : 'Kiểm tra lịch sử và bài tập trước khi bắt đầu.'}</p></div>{session ? <Button variant="outline" disabled={busy || stage === 'game'} onClick={() => setFinishOpen(true)}>Kết thúc buổi tập</Button> : <Button disabled={busy || unfinished.some(item => item.session.managed_workflow)} onClick={() => void begin()}>Bắt đầu buổi tập</Button>}</div>
    <PatientBanner patient={data.patient} />{error && <ErrorState message={error} retry={() => void load()} />}
    {unfinished.length > 0 && <section className="panel"><p>Còn {unfinished.length} buổi dang dở: {unfinished.map(item => `#${item.session.id}`).join(', ')}. Kết quả đã lưu vẫn được giữ; các buổi này chưa được đánh dấu hoàn thành.</p>{unfinished.filter(item => item.session.managed_workflow).map(item => <div className="form-actions" key={item.session.id}><Button variant="outline" disabled={busy} onClick={() => setCancelId(item.session.id)}>Đóng buổi dang dở #{item.session.id}</Button></div>)}</section>}
    {stage === 'setup' && <section className="panel"><h2>Thiết lập camera cho buổi tập</h2><p>Điều chỉnh ghế và hình bóng; kiểm tra đầu, vai, thân trước khi tiếp tục.</p>{session?.setup_confirmed && <div className="form-actions"><Button disabled={busy} onClick={() => void setupSaved()}>Tiếp tục</Button></div>}</section>}
    {stage === 'dashboard' && <><TrainingHistory data={data} />
      <section className="flow-section"><div className="panel-heading"><div><h2>{session ? 'Chọn bài tập tiếp theo' : 'Bài tập của bệnh nhân'}</h2><p>Hái hoa là bài tập mặc định của hệ thống. Các bài khác chỉ hiển thị khi có chỉ định đang hoạt động.</p></div>{session && !session.setup_confirmed && <Button onClick={() => setStage('setup')}>Kiểm tra lại camera</Button>}</div><ExerciseCatalog exercises={data.available_exercises} trials={currentReport?.trials} onPlay={play} disabled={!session?.setup_confirmed || busy} /></section>
      {data.transfers.some(item => item.baseline_assessment_session_id !== null) && <section className="panel"><h2>Đánh giá đầu vào</h2><p>Baseline: {data.transfers.filter(item => item.baseline_assessment_session_id !== null).map(item => `#${item.baseline_assessment_session_id}`).join(', ')}</p><Link className="text-link" to={`/reports?patient_id=${patientId}&kind=assessments`}>Xem báo cáo đánh giá đầu vào</Link></section>}
    </>}
    {stage === 'result' && result && <GameResult result={result} exercise={exercise} captures={currentReport?.captures} training busy={busy} onContinue={() => setStage('dashboard')} onReturn={() => setFinishOpen(true)} />}
    {stage === 'game' && <div className="notice">{exercise?.name} · Buổi #{session?.id}. Hoàn thành và xác nhận lưu kết quả trước khi tiếp tục.</div>}
    {session && <ClinicalWorkspace session={session} exercise={exercise} view={stage === 'setup' ? 'setup' : stage === 'game' ? 'game' : 'monitor'} onSetupSaved={() => void setupSaved()} onSetupInvalidated={setupInvalidated} onResultSaved={savedResult => void saved(savedResult)} />}
    {finishOpen && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="finish-training-title"><h2 id="finish-training-title">Kết thúc buổi luyện tập?</h2><p>Các kết quả đã lưu được giữ lại. Xác nhận để ghi thời điểm kết thúc và giải phóng camera.</p><div className="form-actions"><Button variant="outline" disabled={busy} onClick={() => setFinishOpen(false)}>Hủy</Button><Button disabled={busy} onClick={() => void finish()}>{busy ? 'Đang kết thúc…' : 'Xác nhận kết thúc'}</Button></div></section></div>}
    {cancelId && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-training-title"><h2 id="cancel-training-title">Đóng buổi dang dở #{cancelId}?</h2><p>Buổi này sẽ được đánh dấu đã hủy. Các kết quả đã lưu và lịch sử vẫn được giữ; lượt chưa xong không được ghi thành kết quả.</p><div className="form-actions"><Button variant="outline" disabled={busy} onClick={() => setCancelId(null)}>Hủy</Button><Button disabled={busy} onClick={() => void cancelUnfinished()}>Xác nhận đóng buổi dang dở</Button></div></section></div>}
  </>
}

export default function Training() {
  const { patientId } = useParams()
  if (!patientId) return <TrainingSearch />
  const id = Number(patientId)
  return Number.isInteger(id) && id > 0 ? <TrainingDashboard key={id} patientId={id} /> : <ErrorState message="Mã hồ sơ không hợp lệ." />
}

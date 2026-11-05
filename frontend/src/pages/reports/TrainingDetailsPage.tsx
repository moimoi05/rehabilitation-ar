import { useCallback } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import CaptureArtifacts from '../../components/CaptureArtifacts'
import { Empty, ErrorState, Loading } from '../../components/States'
import { useData } from '../../hooks/useData'
import CapturePreview from '../admin/CapturePreview'
import { hospitalDateTime } from '../../features/rehab/hospitalTime'
import { rehabApi } from '../../services/rehab'
import { sideLabel, statusLabel } from '../../types'
import type { Exercise, GameResult, SessionReport, Trial } from '../../types/rehab'

type TrainingData = { report: SessionReport | null; exercises: Exercise[] }

function useTrainingData(sessionId: number | null) {
  const load = useCallback(async (): Promise<TrainingData> => {
    if (!sessionId) return { report: null, exercises: [] }
    const [reports, exercises] = await Promise.all([
      rehabApi.reports('training', { session_id: sessionId }),
      rehabApi.exercises(),
    ])
    return { report: reports.find(item => item.session.id === sessionId) || null, exercises }
  }, [sessionId])
  return useData(load)
}

function exerciseName(trial: Trial, exercises: Exercise[]) {
  return exercises.find(item => item.id === trial.exercise_id || item.code === trial.exercise_code)?.name || trial.exercise_code
}

function trialStatus(trial: Trial) {
  if (trial.status === 'completed') return 'Đã hoàn thành'
  if (trial.status === 'cancelled') return 'Đã hủy'
  return trial.status ? 'Chưa hoàn thành' : 'Chưa ghi trạng thái'
}

function resultSummary(result: GameResult) {
  return result.game_key === 'free_drawing'
    ? `${result.completed_strokes} nét${result.active_drawing_seconds === undefined ? '' : ` · ${result.active_drawing_seconds.toFixed(1)} giây đang vẽ`}`
    : `${result.score} / ${result.target_count} mục tiêu`
}

function resultGameName(result: GameResult) {
  return result.game_key === 'free_drawing' ? 'Vẽ tự do' : 'Hái hoa'
}

function resultValidity(result: GameResult) {
  return result.data_valid === true ? 'Hợp lệ theo ghi nhận' : result.data_valid === false ? 'Không hợp lệ' : 'Chưa đánh giá tính hợp lệ'
}

function loadError(error: string, loading: boolean, retry: () => void) {
  if (loading) return <Loading />
  if (error) return <ErrorState message={error} retry={retry} />
  return null
}

export function TrainingSessionDetails() {
  const { sessionId: rawSessionId } = useParams()
  const parsedSessionId = Number(rawSessionId)
  const sessionId = Number.isSafeInteger(parsedSessionId) && parsedSessionId > 0 ? parsedSessionId : null
  const { data, error, loading, reload } = useTrainingData(sessionId)
  const state = loadError(error, loading, () => void reload())
  if (state) return state
  if (!sessionId) return <ErrorState message="Mã buổi luyện tập không hợp lệ." />
  const report = data?.report
  if (!report) return <Empty>Không tìm thấy buổi luyện tập này.</Empty>

  const { session, patient } = report
  const savedResultCount = new Set([
    ...report.results.map(result => result.id),
    ...report.trials.flatMap(trial => trial.results || []).map(result => result.id),
  ]).size
  return <>
    <Link className="back-link" to={`/admin/patients/${patient.id}`}><ArrowLeft size={16} /> Hồ sơ bệnh nhân</Link>
    <div className="page-heading"><div><span className="eyebrow">LUYỆN TẬP · {patient.research_code}</span><h1>Buổi luyện tập #{session.id}</h1><p>{hospitalDateTime(session.started_at || session.created_at)} · Tay tập: {sideLabel(session.affected_side)}</p></div><span className={`badge ${session.status}`}>{statusLabel[session.status]}</span></div>
    <div className="rehab-summary"><span>{report.trials.length} lượt</span><span>{Math.round(report.duration_seconds * 10) / 10} giây đã lưu</span><span>{savedResultCount} kết quả trò chơi đã lưu</span></div>
    <section className="panel rehab-section">
      <div className="panel-heading"><div><h2>Các lượt trong buổi này</h2><p>Chọn một lượt để xem riêng kết quả và dữ liệu tracking.</p></div></div>
      {!report.trials.length ? <Empty>Buổi này chưa có lượt thực hiện.</Empty> : <div className="table-wrap"><table><thead><tr><th>Lượt / bài tập</th><th>Trạng thái</th><th>Thời lượng</th><th>Kết quả trò chơi</th><th>Capture</th></tr></thead><tbody>{report.trials.map(trial => {
        const results = report.results.filter(result => result.trial_id === trial.id)
        const unparsedResults = (trial.results || []).filter(result => !results.some(parsed => parsed.id === result.id))
        const captures = report.captures?.filter(capture => capture.trial_id === trial.id) || []
        return <tr key={trial.id}>
          <td><Link className="text-link" to={`/reports/training/${session.id}/trials/${trial.id}`}><strong>Lượt {trial.trial_number || trial.id}</strong><span className="cell-sub">{exerciseName(trial, data?.exercises || [])}</span></Link></td>
          <td>{trialStatus(trial)}</td>
          <td>{results.length ? results.map(result => <div key={result.id}>{Math.round(result.duration_seconds * 10) / 10} giây</div>) : unparsedResults.length ? 'Chưa đọc được thời lượng' : 'Chưa có kết quả'}</td>
          <td>{results.length ? results.map(result => <div key={result.id}>{resultSummary(result)}</div>) : unparsedResults.length ? 'Kết quả cũ đã lưu' : 'Chưa lưu'}</td>
          <td>{captures.length ? captures.map(capture => <div key={capture.id}>{capture.status === 'complete' ? 'Đã hoàn tất' : capture.status === 'recording' ? 'Đang thu/gửi' : 'Chưa hoàn tất'}</div>) : 'Chưa có capture'}</td>
        </tr>
      })}</tbody></table></div>}
    </section>
    <p className="help rehab-section">Điểm trò chơi không phải điểm FMA-UE hay kết luận lâm sàng.</p>
  </>
}

function GameResultDetails({ result }: { result: GameResult }) {
  return <section className="panel rehab-section">
    <h2>{resultGameName(result)} · Kết quả #{result.id}</h2>
    <dl className="detail-list">
      <div><dt>Mã lượt</dt><dd>{result.round_id || 'Chưa có'}</dd></div>
      <div><dt>Thời điểm lưu</dt><dd>{hospitalDateTime(result.created_at)}</dd></div>
      <div><dt>Tay tập</dt><dd>{sideLabel(result.affected_side)}</dd></div>
      <div><dt>Thời lượng</dt><dd>{Math.round(result.duration_seconds * 10) / 10} giây</dd></div>
      {result.game_key === 'free_drawing' ? <>
        <div><dt>Số nét hoàn tất</dt><dd>{result.completed_strokes}</dd></div>
        {result.active_drawing_seconds !== undefined && <div><dt>Thời gian vẽ thực tế</dt><dd>{result.active_drawing_seconds.toFixed(1)} giây</dd></div>}
      </> : <><div><dt>Điểm trò chơi</dt><dd>{result.score}</dd></div><div><dt>Số mục tiêu</dt><dd>{result.target_count}</dd></div></>}
      <div><dt>Tính hợp lệ dữ liệu</dt><dd>{resultValidity(result)}</dd></div>
    </dl>
  </section>
}

export function TrainingTrialDetails() {
  const { sessionId: rawSessionId, trialId: rawTrialId } = useParams()
  const parsedSessionId = Number(rawSessionId)
  const sessionId = Number.isSafeInteger(parsedSessionId) && parsedSessionId > 0 ? parsedSessionId : null
  const parsedTrialId = Number(rawTrialId)
  const trialId = Number.isSafeInteger(parsedTrialId) && parsedTrialId > 0 ? parsedTrialId : null
  const { data, error, loading, reload } = useTrainingData(sessionId)
  const state = loadError(error, loading, () => void reload())
  if (state) return state
  if (!sessionId || !trialId) return <ErrorState message="Mã buổi hoặc mã lượt không hợp lệ." />
  const report = data?.report
  if (!report) return <Empty>Không tìm thấy buổi luyện tập này.</Empty>
  const trial = report.trials.find(item => item.id === trialId)
  if (!trial) return <Empty>Không tìm thấy lượt này trong buổi luyện tập.</Empty>

  const results = report.results.filter(result => result.trial_id === trial.id)
  const unparsedResults = (trial.results || []).filter(result => !results.some(parsed => parsed.id === result.id))
  const captures = report.captures?.filter(capture => capture.trial_id === trial.id)
  const exercises = data?.exercises || []
  const { patient } = report
  return <>
    <Link className="back-link" to={`/reports/training/${sessionId}`}><ArrowLeft size={16} /> Các lượt của buổi #{sessionId}</Link>
    <div className="page-heading"><div><span className="eyebrow">{patient.research_code} · BUỔI #{sessionId}</span><h1>Lượt {trial.trial_number || trial.id} · {exerciseName(trial, exercises)}</h1><p>{trial.started_at ? hospitalDateTime(trial.started_at) : hospitalDateTime(report.session.started_at || report.session.created_at)} · {trialStatus(trial)}</p></div></div>
    {!results.length && !unparsedResults.length ? <section className="panel rehab-section"><Empty>Lượt này chưa có kết quả trò chơi được lưu.</Empty></section> : <>
      {results.map(result => <GameResultDetails key={result.id} result={result} />)}
      {unparsedResults.map(result => <section className="panel rehab-section" key={result.id}><details><summary>Kết quả cũ #{result.id} · {hospitalDateTime(result.created_at)}</summary><pre>{result.result_json}</pre></details></section>)}
    </>}
    <p className="help rehab-section">Điểm trò chơi không phải điểm FMA-UE hay kết luận lâm sàng.</p>
    {captures === undefined ? <section className="panel rehab-section"><h2>Dữ liệu tracking</h2><p>Chưa kiểm tra được dữ liệu nghiên cứu của lượt này.</p></section> : !captures.length ? <section className="panel rehab-section"><h2>Dữ liệu tracking</h2><Empty>Chưa có capture nghiên cứu gắn với lượt này.</Empty></section> : <>
      <CaptureArtifacts captures={captures} />
      {captures.map(capture => <CapturePreview key={capture.id} capture={capture} />)}
    </>}
  </>
}

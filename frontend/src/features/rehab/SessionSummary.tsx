import type { Exercise, SessionReport } from '../../types/rehab'
import { statusLabel } from '../../types'
import CaptureArtifacts from '../../components/CaptureArtifacts'

function answerText(value: unknown) {
  return value === null || value === undefined || value === '' ? 'Chưa trả lời' : typeof value === 'boolean' ? value ? 'Có' : 'Không' : Array.isArray(value) ? value.join(', ') : String(value)
}
function resultValues(json: string): { score?: number; completed_strokes?: number; duration_seconds?: number; data_valid?: boolean } {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const data = parsed as Record<string, unknown>
    return {
      score: data.game_key !== 'free_drawing' && typeof data.score === 'number' && Number.isFinite(data.score) ? data.score : undefined,
      completed_strokes: data.game_key === 'free_drawing' && typeof data.completed_strokes === 'number' && Number.isInteger(data.completed_strokes) && data.completed_strokes >= 0 ? data.completed_strokes : undefined,
      duration_seconds: typeof data.duration_seconds === 'number' && Number.isFinite(data.duration_seconds) && data.duration_seconds >= 0 ? data.duration_seconds : undefined,
      data_valid: typeof data.data_valid === 'boolean' ? data.data_valid : undefined,
    }
  } catch { return {} }
}
export default function SessionSummary({ report, exercises }: { report: SessionReport; exercises: Exercise[] }) {
  return <div className="flow-summary"><section className="panel"><div className="panel-heading"><h2>Kết quả lần đánh giá</h2><span className={`badge ${report.session.status}`}>{statusLabel[report.session.status]}</span></div>
    <dl className="detail-list"><div><dt>Số lượt</dt><dd>{report.trial_count}</dd></div><div><dt>Tổng thời lượng đã lưu</dt><dd>{report.duration_seconds.toFixed(1)} giây</dd></div><div><dt>Dữ liệu trò chơi</dt><dd>{report.results.length} kết quả đã lưu</dd></div></dl>
    <div className="table-wrap"><table><thead><tr><th>Bài đánh giá</th><th>Lượt</th><th>Thời lượng</th><th>Kết quả hoạt động</th><th>Dữ liệu</th></tr></thead><tbody>{report.trials.map(trial => {
      const values = trial.results?.map(item => resultValues(item.result_json)) ?? []
      const durations = values.flatMap(value => value.duration_seconds === undefined ? [] : [value.duration_seconds])
      const quality = values.some(value => value.data_valid === false) ? 'Không hợp lệ' : values.every(value => value.data_valid === true) ? 'Đã xác nhận hợp lệ' : 'Chưa xác nhận chất lượng'
      return <tr key={trial.id}><td>{exercises.find(item => item.id === trial.exercise_id || item.code === trial.exercise_code)?.name ?? trial.exercise_code}</td><td>{trial.trial_number ?? '—'}</td><td>{durations.length ? `${durations.reduce((sum, value) => sum + value, 0).toFixed(1)} giây` : values.length ? 'Chưa ghi thời lượng' : 'Chưa có kết quả'}</td><td>{values.map(value => value.completed_strokes === undefined ? value.score ?? '—' : `${value.completed_strokes} nét`).join(', ') || '—'}</td><td>{values.length ? quality : trial.status === 'cancelled' ? 'Đã hủy' : 'Chưa hoàn tất'}</td></tr>
    })}</tbody></table></div>
    <p className="help">Điểm Hái hoa và số nét Vẽ tự do được trình bày riêng, không quy đổi thành FMA-UE. Lượt chưa hoàn tất không có kết quả giả lập.</p>
    {report.clinical_assessments.map(item => <p key={item.id} className="notice">FMA-UE: {item.fma_ue_score ?? 'Chưa nhập'}/66 · {item.clinician_confirmed ? `Đã xác nhận bởi ${item.clinician_name}` : 'Chưa được chuyên môn xác nhận'}</p>)}
    <CaptureArtifacts captures={report.captures || []}/>
  </section>
    {report.questionnaires.map(submission => <section className="panel" key={submission.id}><h2>{submission.template_snapshot.name} · phiên bản {submission.template_snapshot.version}</h2><dl className="detail-list">{submission.template_snapshot.questions.map(question => <div key={question.key}><dt>{question.label}</dt><dd>{answerText(submission.answers.find(answer => answer.question_key === question.key)?.value)}</dd></div>)}</dl></section>)}
  </div>
}

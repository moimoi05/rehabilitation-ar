import CaptureArtifacts from '../../components/CaptureArtifacts'
import { Empty } from '../../components/States'
import { sideLabel } from '../../types'
import type { SessionReport } from '../../types/rehab'
import CapturePreview from './CapturePreview'

const displayNumber = (value: number | null | undefined, unit = '') => value == null ? 'Chưa có' : `${value}${unit}`

/** Data reported by the server, grouped along the patient → session → trial chain. */
export default function PatientStoredData({ sessions }: { sessions: SessionReport[] }) {
  const sessionsWithTrials = sessions.filter(item => item.trials.length > 0)
  return <section className="panel rehab-section">
    <h2>Dữ liệu đánh giá đã lưu theo lượt</h2>
    <p className="help">Điểm trò chơi không phải điểm FMA-UE. Kết quả đã lưu không xác nhận dữ liệu nghiên cứu đã được thu đầy đủ; xem trạng thái từng capture bên dưới.</p>
    {!sessionsWithTrials.length ? <Empty>Chưa có lượt chơi nào được lưu.</Empty> : sessionsWithTrials.map(item =>
      <details key={item.session.id} className="rehab-section">
        <summary>{item.session.session_type === 'training' ? 'Buổi luyện tập' : 'Lần đánh giá'} #{item.session.id} · {new Date(item.session.created_at).toLocaleString('vi-VN')} · {item.trials.length} lượt</summary>
        {item.trials.map(trial => {
          const results = item.results.filter(result => result.trial_id === trial.id)
          const captures = item.captures?.filter(capture => capture.trial_id === trial.id)
          const unparsedResults = (trial.results ?? []).filter(result => !results.some(parsed => parsed.id === result.id))
          return <div className="rehab-section" key={trial.id}>
            <h3>Lượt #{trial.id} · {trial.exercise_code}</h3>
            {results.length === 0 && unparsedResults.length === 0 && <p>Chưa có kết quả trò chơi được lưu.</p>}
            {results.map(result => <div key={result.id}>
              <h4>{result.game_key === 'free_drawing' ? 'Vẽ tự do' : result.game_key === 'glowing_flower' ? 'Hái hoa' : 'Trò chơi khác'} · Kết quả #{result.id}</h4>
              <dl className="detail-list">
                <div><dt>Mã lượt</dt><dd>{result.round_id || 'Chưa có'}</dd></div>
                <div><dt>Thời điểm tạo</dt><dd>{new Date(result.created_at).toLocaleString('vi-VN')}</dd></div>
                <div><dt>Tay tập</dt><dd>{result.affected_side === 'left' || result.affected_side === 'right' ? sideLabel(result.affected_side) : 'Chưa có'}</dd></div>
                <div><dt>Thời lượng</dt><dd>{displayNumber(result.duration_seconds, ' giây')}</dd></div>
                {result.game_key === 'free_drawing' ? <>
                  <div><dt>Số nét hoàn tất</dt><dd>{displayNumber(result.completed_strokes)}</dd></div>
                  <div><dt>Thời gian vẽ thực tế</dt><dd>{displayNumber(result.active_drawing_seconds, ' giây')}</dd></div>
                </> : result.game_key === 'glowing_flower' ? <>
                  <div><dt>Điểm</dt><dd>{displayNumber(result.score)}</dd></div>
                  <div><dt>Số mục tiêu</dt><dd>{displayNumber(result.target_count)}</dd></div>
                </> : null}
              </dl>
            </div>)}
            {unparsedResults.map(result => <details key={result.id}><summary>Kết quả cũ #{result.id} · {new Date(result.created_at).toLocaleString('vi-VN')}</summary><pre>{result.result_json}</pre></details>)}
            {captures === undefined ? <p>Chưa kiểm tra được dữ liệu nghiên cứu của lượt này.</p> : captures.length === 0 ? <p>Chưa có capture nghiên cứu gắn với lượt này.</p> : <><CaptureArtifacts captures={captures}/>{captures.map(capture => <CapturePreview key={capture.id} capture={capture}/>)}</>}
          </div>
        })}
      </details>)}
  </section>
}

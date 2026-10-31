import { useCallback, useState } from 'react'
import { useData } from '../hooks/useData'
import { rehabApi } from '../services/rehab'
import type { RehabPatient } from '../types/rehab'
import { Empty, ErrorState, Loading } from './States'
import { Button } from './ui/button'

type Props = { patient: RehabPatient; baselineSessionId?: number; onClose: () => void; onTransferred: (patient: RehabPatient) => void }
export default function TransferDialog({ patient, baselineSessionId, onClose, onTransferred }: Props) {
  const load = useCallback(async () => { const [sessions, config] = await Promise.all([rehabApi.assessments({ patient_id: patient.id, status: 'completed' }), rehabApi.config()]); return { sessions: sessions.filter(session => session.status === 'completed'), config } }, [patient.id])
  const { data, loading, error, reload } = useData(load)
  const [baseline, setBaseline] = useState(baselineSessionId ? String(baselineSessionId) : '')
  const [reason, setReason] = useState('')
  const [exception, setException] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const admission = patient.patient_type === 'outpatient'
  const hasBaseline = Boolean(data?.sessions.some(session => String(session.id) === baseline))
  const withoutBaseline = admission && !hasBaseline
  const canTransfer = !!data && !saving && (admission ? hasBaseline || (data.config.allow_transfer_without_baseline && exception && reason.trim().length >= 10) : reason.trim().length > 0)
  async function transfer() {
    if (!canTransfer) return
    setSaving(true); setFormError('')
    try {
      const result = await rehabApi.transfer(patient.id, { to_type: admission ? 'inpatient' : 'outpatient', baseline_assessment_session_id: admission && hasBaseline ? Number(baseline) : null, reason: reason.trim() || null, ...(admission ? { admitted_at: new Date().toISOString() } : {}), ...(withoutBaseline ? { allow_without_baseline: true } : {}) })
      onTransferred(result.patient)
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : 'Không chuyển được nhóm bệnh nhân.'); setSaving(false) }
  }
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title"><div className="panel-heading"><div><span className="eyebrow">CHUYỂN NHÓM</span><h2 id="transfer-title">{admission ? 'Chuyển sang bệnh nhân điều trị' : 'Chuyển về nhóm đến khám'}</h2><p>{patient.research_code} · {patient.full_name || 'Chưa có họ tên'}</p></div><button className="close" onClick={onClose} disabled={saving} aria-label="Đóng">×</button></div>
    {loading ? <Loading/> : error ? <ErrorState message={error} retry={() => void reload()}/> : data && <div className="form">
      {admission && <><label>Đánh giá đầu vào (Baseline)<select value={baseline} onChange={event => { setBaseline(event.target.value); setException(false) }} disabled={saving}><option value="">Chọn đánh giá đã hoàn thành</option>{data.sessions.map(session => <option key={session.id} value={session.id}>Đánh giá #{session.id} · {new Date(session.created_at).toLocaleDateString('vi-VN')}</option>)}</select></label>{!data.sessions.length && <Empty>Chưa có đánh giá hoàn thành. Hãy hoàn tất đánh giá trước khi nhập viện.</Empty>}{withoutBaseline && data.config.allow_transfer_without_baseline && <div className="notice">Quy trình cho phép ngoại lệ. Cần lý do và xác nhận của nhân viên trước khi chuyển thiếu Baseline.</div>}</>}
      <label>Lý do chuyển nhóm<textarea required={!admission || withoutBaseline} rows={3} maxLength={2000} value={reason} disabled={saving} onChange={event => setReason(event.target.value)}/></label>
      {withoutBaseline && data.config.allow_transfer_without_baseline && <label className="checkbox"><input type="checkbox" checked={exception} disabled={saving} onChange={event => setException(event.target.checked)}/> Xác nhận ngoại lệ không có đánh giá đầu vào</label>}
      <p className="help">Hồ sơ và toàn bộ lịch sử đánh giá được giữ lại khi chuyển nhóm.</p>
    </div>}
    {formError && <ErrorState message={formError}/>}<div className="form-actions"><Button variant="outline" onClick={onClose} disabled={saving}>Hủy</Button><Button onClick={() => void transfer()} disabled={!canTransfer}>{saving ? 'Đang chuyển…' : 'Xác nhận chuyển nhóm'}</Button></div>
    </div></div>
}

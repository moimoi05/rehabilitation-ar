import { useState } from 'react'
import type { FormEvent } from 'react'
import { rehabApi } from '../services/rehab'
import type { RehabPatient, Sex } from '../types/rehab'
import type { Side } from '../types'
import { ErrorState } from './States'
import { Button } from './ui/button'

type Props = { patient?: RehabPatient; onClose: () => void; onSaved: (patient: RehabPatient) => void }
export default function PatientForm({ patient, onClose, onSaved }: Props) {
  const [form, setForm] = useState({ research_code: patient?.research_code ?? '', full_name: patient?.full_name ?? '', date_of_birth: patient?.date_of_birth ?? '', sex: patient?.sex ?? 'unspecified' as Sex, affected_side: patient?.affected_side ?? 'left' as Side, dominant_hand: patient?.dominant_hand ?? 'right' as Side, contact: patient?.contact ?? '', notes: patient?.notes ?? '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    const payload = { ...form, research_code: form.research_code.trim(), full_name: form.full_name.trim() || null, date_of_birth: form.date_of_birth || null, contact: form.contact.trim() || null, notes: form.notes.trim() || null }
    try { onSaved(patient ? await rehabApi.updatePatient(patient.id, payload) : await rehabApi.createPatient(payload)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không lưu được hồ sơ.'); setSaving(false) }
  }
  return <div className="modal-backdrop"><div className="modal rehab-modal" role="dialog" aria-modal="true" aria-labelledby="rehab-patient-title"><div className="panel-heading"><div><span className="eyebrow">HỒ SƠ BỆNH NHÂN</span><h2 id="rehab-patient-title">{patient ? 'Sửa hồ sơ bệnh nhân' : 'Thêm bệnh nhân đến khám'}</h2></div><button className="close" onClick={onClose} disabled={saving} aria-label="Đóng">×</button></div>
    <form className="form" onSubmit={event => void submit(event)}>
      <div className="form-grid"><label>Mã bệnh nhân<input required pattern="[A-Za-z0-9_-]+" maxLength={64} value={form.research_code} onChange={event => setForm({ ...form, research_code: event.target.value })}/></label><label>Họ tên<input maxLength={255} required={!patient} value={form.full_name} onChange={event => setForm({ ...form, full_name: event.target.value })}/></label></div>
      <div className="form-grid"><label>Ngày sinh<input type="date" max={new Date().toLocaleDateString('en-CA')} value={form.date_of_birth} onChange={event => setForm({ ...form, date_of_birth: event.target.value })}/></label><label>Giới tính<select value={form.sex} onChange={event => setForm({ ...form, sex: event.target.value as Sex })}><option value="unspecified">Chưa cung cấp</option><option value="male">Nam</option><option value="female">Nữ</option><option value="other">Khác</option></select></label></div>
      <div className="form-grid"><label>Tay bị ảnh hưởng<select value={form.affected_side} onChange={event => setForm({ ...form, affected_side: event.target.value as Side })}><option value="left">Trái</option><option value="right">Phải</option></select></label><label>Tay thuận<select value={form.dominant_hand} onChange={event => setForm({ ...form, dominant_hand: event.target.value as Side })}><option value="left">Trái</option><option value="right">Phải</option></select></label></div>
      <label>Thông tin liên hệ<input maxLength={500} value={form.contact} onChange={event => setForm({ ...form, contact: event.target.value })}/></label><label>Ghi chú<textarea maxLength={2000} rows={3} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })}/></label>
      {error && <ErrorState message={error}/>}<div className="form-actions"><Button type="button" variant="outline" onClick={onClose} disabled={saving}>Hủy</Button><Button disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu hồ sơ'}</Button></div>
    </form></div></div>
}

import { Link } from 'react-router-dom'
import { sideLabel } from '../../types'
import type { RehabPatient } from '../../types/rehab'

function ageOf(date: string | null) {
  if (!date) return 'Chưa có ngày sinh'
  const born = new Date(`${date}T00:00:00`), now = new Date()
  const years = now.getFullYear() - born.getFullYear() - (now.getMonth() < born.getMonth() || (now.getMonth() === born.getMonth() && now.getDate() < born.getDate()) ? 1 : 0)
  return Number.isFinite(years) && years >= 0 ? `${years} tuổi` : 'Chưa có ngày sinh'
}

export default function PatientBanner({ patient }: { patient: RehabPatient }) {
  return <section className="panel patient-banner" aria-label="Thông tin bệnh nhân">
    <div><span className="eyebrow">{patient.patient_type === 'inpatient' ? 'BỆNH NHÂN ĐIỀU TRỊ' : 'BỆNH NHÂN ĐẾN KHÁM'}</span><h2>{patient.research_code} · {patient.full_name || 'Chưa có họ tên'}</h2><p>{ageOf(patient.date_of_birth)} · Tay ảnh hưởng: {sideLabel(patient.affected_side)} · Tay thuận: {sideLabel(patient.dominant_hand)}</p>{patient.admitted_at && <p>Ngày nhập viện: {new Date(patient.admitted_at).toLocaleDateString('vi-VN')}</p>}</div>
    <Link className="text-link" to={`/admin/patients/${patient.id}`}>Xem hồ sơ</Link>
  </section>
}

import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { Empty, ErrorState, Loading } from '../../components/States'
import { Button } from '../../components/ui/button'
import PatientForm from '../../components/PatientForm'
import TransferDialog from '../../components/TransferDialog'
import { useData } from '../../hooks/useData'
import { rehabApi } from '../../services/rehab'
import { sideLabel } from '../../types'
import type { PatientType, RehabPatient } from '../../types/rehab'

function PatientList({ kind, search, edit, transfer }: { kind: PatientType; search: string; edit: (patient: RehabPatient) => void; transfer: (patient: RehabPatient) => void }) {
  const load = useCallback(() => rehabApi.patients({ patient_type: kind, search }), [kind, search])
  const { data, error, loading, reload } = useData(load)
  if (loading) return <Loading/>
  if (error) return <ErrorState message={error} retry={() => void reload()}/>
  if (!data?.length) return <Empty>{search ? 'Không tìm thấy hồ sơ phù hợp.' : 'Chưa có bệnh nhân trong nhóm này.'}</Empty>
  return <div className="table-wrap"><table><thead><tr><th>Mã bệnh nhân / Họ tên</th><th>Tay bị ảnh hưởng</th><th>Tay thuận</th><th>{kind === 'inpatient' ? 'Ngày nhập viện' : 'Ngày tạo'}</th><th>Thao tác</th></tr></thead><tbody>{data.map(patient => <tr key={patient.id}><td><Link className="table-primary" to={`/admin/patients/${patient.id}`}>{patient.research_code}</Link><span className="cell-sub">{patient.full_name || 'Chưa có họ tên'}</span></td><td>{sideLabel(patient.affected_side)}</td><td>{sideLabel(patient.dominant_hand)}</td><td>{patient.admitted_at && kind === 'inpatient' ? new Date(patient.admitted_at).toLocaleDateString('vi-VN') : new Date(patient.created_at).toLocaleDateString('vi-VN')}</td><td><div className="rehab-toolbar"><button className="text-link" onClick={() => edit(patient)}>Sửa</button><Link className="text-link" to={`/admin/patients/${patient.id}`}>Chi tiết</Link>{kind === 'outpatient' && <button className="text-link" onClick={() => transfer(patient)}>Chuyển sang điều trị</button>}</div></td></tr>)}</tbody></table></div>
}

export default function PatientsAdmin() {
  const [kind, setKind] = useState<PatientType>('outpatient')
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<RehabPatient | null | undefined>(undefined)
  const [transfer, setTransfer] = useState<RehabPatient | null>(null)
  const [message, setMessage] = useState('')
  function refreshed() { setVersion(value => value + 1) }
  return <>
    <div className="page-heading"><div><span className="eyebrow">QUẢN TRỊ</span><h1>Hồ sơ bệnh nhân</h1><p>Quản lý hai nhóm bệnh nhân và bảo toàn lịch sử khi chuyển nhóm.</p></div><Button onClick={() => setEditing(null)}><Plus size={18}/> Thêm bệnh nhân</Button></div>
    <div className="rehab-subnav"><Link to="/admin/questionnaires">Bộ câu hỏi lâm sàng</Link><Link to="/settings">Cài đặt thiết bị</Link><Link to="/tracking-lab">Tracking Test Lab</Link><Link to="/sessions">Phiên cũ</Link></div>
    {message && <div className="notice" role="status">{message}</div>}
    <section className="panel"><div className="rehab-tabs" role="tablist" aria-label="Nhóm bệnh nhân"><button role="tab" aria-selected={kind === 'outpatient'} onClick={() => { setKind('outpatient'); setMessage('') }}>Bệnh nhân đến khám</button><button role="tab" aria-selected={kind === 'inpatient'} onClick={() => { setKind('inpatient'); setMessage('') }}>Bệnh nhân điều trị</button></div>
      <div className="panel-heading"><div><h2>{kind === 'outpatient' ? 'Danh sách bệnh nhân đến khám' : 'Danh sách bệnh nhân điều trị'}</h2><p>Tìm theo mã bệnh nhân hoặc họ tên</p></div><form className="rehab-toolbar" onSubmit={event => { event.preventDefault(); setSearch(input.trim()) }}><label className="search"><Search size={16}/><input aria-label="Tìm mã hoặc họ tên" value={input} maxLength={255} onChange={event => setInput(event.target.value)} placeholder="Mã hoặc họ tên"/></label><Button type="submit" variant="outline">Tìm kiếm</Button></form></div>
      <PatientList key={`${kind}:${search}:${version}`} kind={kind} search={search} edit={setEditing} transfer={setTransfer}/>
    </section>
    {editing !== undefined && <PatientForm patient={editing || undefined} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refreshed(); setMessage('Đã lưu hồ sơ bệnh nhân. Hồ sơ mới thuộc nhóm đến khám.') }}/>} 
    {transfer && <TransferDialog patient={transfer} onClose={() => setTransfer(null)} onTransferred={patient => { setTransfer(null); refreshed(); setMessage(`${patient.research_code} đã chuyển sang nhóm điều trị. Lịch sử và Baseline được giữ nguyên.`) }}/>} 
  </>
}

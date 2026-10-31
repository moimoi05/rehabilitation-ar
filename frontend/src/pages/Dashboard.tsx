import { Activity, ArrowRight, CalendarClock, ClipboardPlus, HeartPulse, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { Empty, ErrorState, Loading } from '../components/States'
import { useData } from '../hooks/useData'
import { rehabApi } from '../services/rehab'
import { statusLabel, typeLabel } from '../types'

export default function Dashboard() {
  const { data, loading, error, reload } = useData(rehabApi.dashboard)
  const metrics = data ? [
    { label: 'Bệnh nhân đến khám', value: data.outpatients, icon: Users },
    { label: 'Bệnh nhân điều trị', value: data.inpatients, icon: HeartPulse },
    { label: 'Lượt đánh giá', value: data.assessments, icon: ClipboardPlus },
    { label: 'Buổi luyện tập', value: data.training_sessions, icon: CalendarClock },
  ] : []
  return <>
    <div className="page-heading"><div><span className="eyebrow">TỔNG QUAN</span><h1>Chào mừng trở lại</h1><p>Theo dõi lượt khám, đánh giá và luyện tập phục hồi chức năng chi trên.</p></div><Button asChild><Link to="/assessment"><ClipboardPlus size={18}/> Bắt đầu đánh giá</Link></Button></div>
    {loading ? <Loading/> : error ? <ErrorState message={error} retry={() => void reload()}/> : data && <>
      <div className="metrics rehab-metrics">{metrics.map(({ label, value, icon: Icon }) => <article className="metric" key={label}><span className="metric-icon"><Icon size={21}/></span><span className="metric-label">{label}</span><strong>{value}</strong><span>Dữ liệu từ hệ thống</span></article>)}</div>
      <div className="dashboard-grid"><section className="panel"><div className="panel-heading"><div><h2>Hoạt động gần đây</h2><p>Các lần đánh giá và buổi tập mới nhất</p></div><Link className="text-link" to="/reports">Xem báo cáo <ArrowRight size={15}/></Link></div>
        {!data.recent_activity.length ? <Empty>Chưa có phiên nào. Tạo phiên đầu tiên để bắt đầu.</Empty> : <div className="activity-list">{data.recent_activity.map(({ session, patient }) => <div className="activity-row" key={session.id}><div className="activity-icon"><Activity size={18}/></div><div className="grow"><strong>{typeLabel[session.session_type]} · {patient.research_code}</strong><span>{new Date(session.created_at).toLocaleString('vi-VN')}</span></div><span className={`badge ${session.status}`}>{statusLabel[session.status]}</span></div>)}</div>}
      </section><section className="panel quick-panel"><span className="eyebrow">TRUY CẬP NHANH</span><h2>Chuẩn bị lượt tiếp theo</h2><p>Chọn quy trình phù hợp với nhóm bệnh nhân.</p><Link className="quick-link" to="/assessment"><span>01</span> Tiếp nhận và đánh giá <ArrowRight size={17}/></Link><Link className="quick-link" to="/training"><span>02</span> Bắt đầu luyện tập <ArrowRight size={17}/></Link><Link className="quick-link" to="/admin"><span>03</span> Quản lý hồ sơ <ArrowRight size={17}/></Link></section></div>
    </>}
  </>
}

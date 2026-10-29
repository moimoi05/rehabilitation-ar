import { Activity, Camera, ChartNoAxesCombined, ClipboardList, HeartPulse, LayoutDashboard, Settings, Users, Video } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../services/api'
import { useData } from '../hooks/useData'
const nav = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/patients', label: 'Bệnh nhân', icon: Users },
  { to: '/sessions', label: 'Phiên tập', icon: ClipboardList },
  { to: '/workspace', label: 'Camera & hiệu chuẩn', icon: Camera },
  { to: '/results', label: 'Kết quả', icon: ChartNoAxesCombined },
  { to: '/settings', label: 'Cài đặt', icon: Settings },
]
export default function Layout() {
  const { data: health } = useData(api.health)
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><HeartPulse size={24}/></div><div><strong>Rehab AR</strong><span>Nghiên cứu phục hồi</span></div></div><div className="nav-heading">KHÔNG GIAN LÀM VIỆC</div><nav aria-label="Điều hướng chính">{nav.map(({to,label,icon:Icon,end}) => <NavLink key={to} to={to} end={end} className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}><Icon size={19}/><span>{label}</span></NavLink>)}</nav><div className="sidebar-note"><Activity size={19}/><div><strong>Môi trường nghiên cứu</strong><p>Chỉ sử dụng dữ liệu giả lập trong phiên bản MVP.</p></div></div></aside><div className="app-main"><header className="topbar"><div><span className="eyebrow">REHABILITATION LAB</span><span className="topbar-sub">Hỗ trợ phục hồi chức năng chi trên</span></div><div className="top-status"><span className={`dot ${health?.database === 'connected' ? 'online' : ''}`}/>{health?.database === 'connected' ? 'Hệ thống kết nối' : 'Chưa kết nối backend'}<span className="status-divider"/><Video size={16}/> Camera tại workspace</div></header><main className="main-content"><Outlet/></main></div></div>
}

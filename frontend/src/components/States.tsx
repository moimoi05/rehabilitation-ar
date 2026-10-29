import { AlertCircle, LoaderCircle } from 'lucide-react'
export function Loading() { return <div className="state"><LoaderCircle className="spin" size={20}/> Đang tải dữ liệu…</div> }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="state error"><AlertCircle size={19}/><span>{message}</span>{retry && <button className="text-link" onClick={retry}>Thử lại</button>}</div> }
export function Empty({ children }: { children: React.ReactNode }) { return <div className="empty">{children}</div> }

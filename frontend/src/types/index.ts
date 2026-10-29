export type Side = 'left' | 'right'
export type SessionStatus = 'draft' | 'in_progress' | 'completed' | 'cancelled'
export type SessionType = 'assessment' | 'training'
export interface Patient { id: number; research_code: string; affected_side: Side; dominant_hand: Side; notes: string | null; created_at: string }
export interface Session { id: number; patient_id: number; affected_side: Side; session_type: SessionType; status: SessionStatus; started_at: string | null; ended_at: string | null; notes: string | null; created_at: string }
export interface Health { status: string; database: string }
export interface Calibration { id:number; session_id:number; camera_label:string | null; camera_device_id:string | null; width:number | null; height:number | null; mirrored:boolean; ghost_visible:boolean; opacity:number; x:number; y:number; scale:number; affected_side:Side; confirmed:boolean; created_at:string }
export const sideLabel = (side: Side) => side === 'left' ? 'Trái' : 'Phải'
export const statusLabel: Record<SessionStatus, string> = { draft: 'Nháp', in_progress: 'Đang thực hiện', completed: 'Hoàn thành', cancelled: 'Đã hủy' }
export const typeLabel: Record<SessionType, string> = { assessment: 'Đánh giá', training: 'Luyện tập' }

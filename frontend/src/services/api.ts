import type { Calibration, Health, Patient, Session } from '../types'
const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
export class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } }) }
  catch { throw new ApiError('Không kết nối được backend. Hãy kiểm tra dịch vụ và cấu hình API.', 0) }
  if (!response.ok) {
    let detail = `Yêu cầu thất bại (${response.status})`
    try { const body = await response.json(); if (typeof body.detail === 'string') detail = body.detail } catch { /* Non-JSON error response */ }
    throw new ApiError(detail, response.status)
  }
  return response.json() as Promise<T>
}
const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) })
const patch = (value: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(value) })
export const api = {
  health: () => request<Health>('/api/health'),
  patients: () => request<Patient[]>('/api/patients'),
  patient: (id: number) => request<Patient>(`/api/patients/${id}`),
  createPatient: (data: Partial<Patient>) => request<Patient>('/api/patients', body(data)),
  updatePatient: (id: number, data: Partial<Patient>) => request<Patient>(`/api/patients/${id}`, patch(data)),
  sessions: () => request<Session[]>('/api/sessions'),
  session: (id: number) => request<Session>(`/api/sessions/${id}`),
  createSession: (data: Partial<Session>) => request<Session>('/api/sessions', body(data)),
  updateSession: (id: number, data: Partial<Session>) => request<Session>(`/api/sessions/${id}`, patch(data)),
  calibrations: (sessionId:number) => request<Calibration[]>(`/api/calibrations?session_id=${encodeURIComponent(sessionId)}`),
}

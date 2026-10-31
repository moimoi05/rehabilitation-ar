import { ApiError } from './api'
import type {
  DashboardSummary, Exercise, ExercisePrescription, PatientReport, PatientTransfer,
  PatientType, QuestionnaireAnswer, QuestionnaireInput, QuestionnaireSubmission, QuestionnaireTemplate, RehabPatient,
  RehabSession, ReportFilters, SessionReport, TransferInput, Trial,
} from '../types/rehab'

const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
export async function rehabRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } }) }
  catch { throw new ApiError('Không kết nối được backend. Hãy kiểm tra dịch vụ và cấu hình API.', 0) }
  if (!response.ok) {
    let message = `Yêu cầu thất bại (${response.status}).`
    try { const error = await response.json(); if (typeof error.detail === 'string') message = error.detail } catch { /* Keep the HTTP status if the server returned no JSON. */ }
    throw new ApiError(message, response.status)
  }
  return response.json() as Promise<T>
}
const post = (data: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(data) })
const patch = (data: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(data) })
function query(params: object = {}) {
  const values = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') values.set(key, String(value)) })
  return values.size ? `?${values}` : ''
}

export const rehabApi = {
  dashboard: () => rehabRequest<DashboardSummary>('/api/dashboard'),
  config: () => rehabRequest<{ allow_transfer_without_baseline: boolean }>('/api/workflow-config'),
  patients: (params?: { patient_type?: PatientType; search?: string; q?: string }) => rehabRequest<RehabPatient[]>(`/api/patients${query(params)}`),
  patient: (id: number) => rehabRequest<RehabPatient>(`/api/patients/${id}`),
  createPatient: (data: Partial<RehabPatient>) => rehabRequest<RehabPatient>('/api/patients', post(data)),
  updatePatient: (id: number, data: Partial<RehabPatient>) => rehabRequest<RehabPatient>(`/api/patients/${id}`, patch(data)),
  transfers: (patientId: number) => rehabRequest<PatientTransfer[]>(`/api/patients/${patientId}/transfers`),
  transfer: (patientId: number, data: TransferInput) => rehabRequest<{ patient: RehabPatient; transfer: PatientTransfer }>(`/api/patients/${patientId}/transfer`, post(data)),
  assessments: (params?: { patient_id?: number; status?: string }) => rehabRequest<RehabSession[]>(`/api/assessments${query(params)}`),
  assessment: (id: number) => rehabRequest<RehabSession>(`/api/assessments/${id}`),
  assessmentDetail: (id: number) => rehabRequest<SessionReport>(`/api/assessments/${id}/detail`),
  createAssessment: (patientId: number) => rehabRequest<RehabSession>('/api/assessments', post({ patient_id: patientId })),
  updateAssessment: (id: number, data: object) => rehabRequest<RehabSession>(`/api/assessments/${id}`, patch(data)),
  startAssessment: (id: number) => rehabRequest<RehabSession>(`/api/assessments/${id}/start`, post()),
  completeAssessment: (id: number) => rehabRequest<RehabSession>(`/api/assessments/${id}/complete`, post()),
  trainingSessions: (params?: { patient_id?: number; status?: string }) => rehabRequest<RehabSession[]>(`/api/training-sessions${query(params)}`),
  trainingDetail: (id: number) => rehabRequest<SessionReport>(`/api/training-sessions/${id}/detail`),
  createTraining: (patientId: number) => rehabRequest<RehabSession>('/api/training-sessions', post({ patient_id: patientId })),
  startTraining: (id: number) => rehabRequest<RehabSession>(`/api/training-sessions/${id}/start`, post()),
  completeTraining: (id: number) => rehabRequest<RehabSession>(`/api/training-sessions/${id}/complete`, post()),
  invalidateSetup: (sessionId: number) => rehabRequest<RehabSession>(`/api/sessions/${sessionId}/setup/invalidate`, post()),
  exercises: (mode?: 'assessment' | 'training', patientId?: number) => rehabRequest<Exercise[]>(`/api/exercises${query({ mode, patient_id: patientId })}`),
  questionnaires: (includeInactive = false) => rehabRequest<QuestionnaireTemplate[]>(`/api/questionnaires${includeInactive ? '?include_inactive=true' : ''}`),
  createQuestionnaire: (data: QuestionnaireInput) => rehabRequest<QuestionnaireTemplate>('/api/questionnaires', post(data)),
  questionnaire: (id: number) => rehabRequest<QuestionnaireTemplate>(`/api/questionnaires/${id}`),
  createSubmission: (sessionId: number, templateId: number) => rehabRequest<QuestionnaireSubmission>('/api/questionnaire-submissions', post({ session_id: sessionId, template_id: templateId })),
  saveAnswers: (id: number, answers: QuestionnaireAnswer[], complete = false) => rehabRequest<QuestionnaireSubmission>(`/api/questionnaire-submissions/${id}/answers`, post({ answers, complete })),
  submission: (id: number) => rehabRequest<QuestionnaireSubmission>(`/api/questionnaire-submissions/${id}`),
  createTrial: (sessionId: number, exerciseId: number, clientRoundId?: string) => rehabRequest<Trial>('/api/trials', post({ session_id: sessionId, exercise_id: exerciseId, ...(clientRoundId ? { client_round_id: clientRoundId } : {}) })),
  cancelTrial: (id: number) => rehabRequest<Trial>(`/api/trials/${id}/cancel`, post()),
  clinicalAssessment: (sessionId: number, data: object) => rehabRequest<RehabSession>(`/api/assessments/${sessionId}`, patch(data)),
  reports: (kind: 'assessments' | 'training', params?: ReportFilters) => rehabRequest<SessionReport[]>(`/api/reports/${kind}${query(params)}`),
  patientReport: (patientId: number) => rehabRequest<PatientReport>(`/api/reports/patients/${patientId}`),
  prescriptions: (patientId: number) => rehabRequest<ExercisePrescription[]>(`/api/patients/${patientId}/prescriptions`),
  createPrescription: (patientId: number, data: object) => rehabRequest<ExercisePrescription>(`/api/patients/${patientId}/prescriptions`, post(data)),
  updatePrescription: (id: number, data: object) => rehabRequest<ExercisePrescription>(`/api/prescriptions/${id}`, patch(data)),
}

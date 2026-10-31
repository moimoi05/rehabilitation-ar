import type { Patient, Session } from './index'

export type PatientType = 'outpatient' | 'inpatient'
export type Sex = 'male' | 'female' | 'other' | 'unspecified'
export interface RehabPatient extends Patient {
  patient_type: PatientType
  full_name: string | null
  date_of_birth: string | null
  sex: Sex | null
  contact: string | null
  admitted_at: string | null
}
export interface RehabSession extends Session { managed_workflow: boolean; setup_confirmed: boolean; setup_revision: number }
export interface PatientTransfer {
  id: number; patient_id: number; from_type: PatientType; to_type: PatientType
  baseline_assessment_session_id: number | null; admitted_at: string | null
  reason: string | null; created_at: string
}
export interface TransferInput {
  to_type: PatientType; baseline_assessment_session_id?: number | null
  admitted_at?: string | null; reason?: string | null; allow_without_baseline?: boolean
}
export interface Exercise {
  id: number; code: string; name: string; description: string; instructions: string
  exercise_type: string; usage_mode: 'assessment' | 'training' | 'both'
  active: boolean; is_default: boolean; renderer: string; default_duration_seconds: number
}
export interface ExercisePrescription {
  id: number; patient_id: number; exercise_id: number; active: boolean
  clinician_name: string; notes: string | null; starts_on: string | null; ends_on: string | null
  exercise: Exercise; created_at: string
}
export interface Trial {
  id: number; session_id: number; exercise_id: number | null; exercise_code: string
  trial_number: number | null; started_at: string | null; ended_at: string | null
  status: string | null; client_round_id?: string | null; results?: StoredResult[]
}
export interface StoredResult { id: number; trial_id: number; round_id: string | null; result_json: string; created_at: string }
export interface GameResult {
  id: number; trial_id: number; session_id: number; round_id: string; game_key: string
  affected_side: 'left' | 'right'; duration_seconds: number; score: number; target_count: number
  source: string; created_at: string; exercise_id?: number | null; exercise_code?: string; data_valid?: boolean
}
export type QuestionType = 'text' | 'number' | 'date' | 'single_choice' | 'multiple_choice' | 'boolean'
export interface QuestionnaireQuestion {
  id: number; key: string; label: string; question_type: QuestionType; required: boolean
  display_order: number; group: string | null; options: string[]
}
export interface QuestionnaireTemplate {
  id: number; code: string; name: string; version: number; active: boolean; questions: QuestionnaireQuestion[]
}
export type QuestionnaireInput = Omit<QuestionnaireTemplate, 'id' | 'questions'> & { questions: Omit<QuestionnaireQuestion, 'id'>[] }
export interface QuestionnaireAnswer { question_key: string; value: string | number | boolean | string[] | null }
export interface QuestionnaireSubmission {
  id: number; session_id: number; template_id: number; template_snapshot: QuestionnaireTemplate
  answers: QuestionnaireAnswer[]; completed: boolean; created_at: string
}
export interface ClinicalAssessment {
  id: number; session_id: number | null; patient_id: number; fma_ue_score: number | null
  clinician_name: string | null; clinician_confirmed: boolean; confirmed_at: string | null; notes: string | null
}
export interface SessionReport {
  session: RehabSession; patient: RehabPatient; questionnaires: QuestionnaireSubmission[]
  clinical_assessments: ClinicalAssessment[]; trials: Trial[]; results: GameResult[]
  duration_seconds: number; trial_count: number; is_baseline: boolean; selected_exercise_ids: number[]
  captures?: CaptureSummary[]
}
export interface CaptureSummary {
  id: string; trial_id: number; source_type: string; status: string
  record_video: boolean; record_landmarks: boolean
  artifact_summary: { video_status?: string; video_file?: string; frames_status?: string; landmarks_status?: string } | null
}
export interface PatientReport {
  patient: RehabPatient; transfers: PatientTransfer[]; assessments: SessionReport[]; training: SessionReport[]
  prescriptions: ExercisePrescription[]; available_exercises: Exercise[]
}
export interface DashboardSummary {
  outpatients: number; inpatients: number; assessments: number; training_sessions: number
  recent_activity: { session: RehabSession; patient: RehabPatient }[]
}
export interface ReportFilters {
  patient_id?: number; research_code?: string; from_date?: string; to_date?: string; exercise_id?: number; session_id?: number
}

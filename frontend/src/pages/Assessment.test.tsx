import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Assessment from './Assessment'
import { rehabApi } from '../services/rehab'
import type { Exercise, QuestionnaireSubmission, QuestionnaireTemplate, RehabPatient, RehabSession, SessionReport } from '../types/rehab'

const progress = vi.hoisted(() => ({ done: [] as number[], started: false, completed: false }))
vi.mock('../features/rehab/ClinicalWorkspace', () => ({
  default: function MockClinicalWorkspace({ session, exercise, view, onSetupSaved, onResultSaved }: { session: RehabSession; exercise: Exercise | null; view: string; onSetupSaved: (id: number) => void; onResultSaved: (result: object) => void }) {
    return <div data-testid="assessment-camera">{view === 'setup' && <button onClick={() => onSetupSaved(9)}>Mô phỏng lưu hiệu chuẩn</button>}{view === 'game' && <button onClick={() => {
      progress.done.push(exercise!.id)
      onResultSaved({ id: progress.done.length, session_id: session.id, trial_id: progress.done.length, round_id: `round-${progress.done.length}`, game_key: 'glowing_flower', score: 3, target_count: 4, duration_seconds: 10, created_at: '2026-01-01T00:00:00Z' })
    }}>Mô phỏng lưu trò chơi</button>}</div>
  },
}))
vi.mock('../components/TransferDialog', () => ({ default: function MockTransferDialog({ baselineSessionId }: { baselineSessionId: number }) { return <div role="dialog">Baseline được chọn: {baselineSessionId}</div> } }))

const patient: RehabPatient = { id: 1, research_code: 'OUT-01', affected_side: 'left', dominant_hand: 'right', notes: null, created_at: '2026-01-01T00:00:00Z', full_name: 'Hồ sơ thử', patient_type: 'outpatient', date_of_birth: null, sex: 'unspecified', contact: null, admitted_at: null }
const session: RehabSession = { id: 55, patient_id: 1, affected_side: 'left', session_type: 'assessment', status: 'draft', started_at: null, ended_at: null, notes: null, created_at: '2026-01-01T00:00:00Z', managed_workflow: true, setup_confirmed: false, setup_revision: 0 }
const flower: Exercise = { id: 1, code: 'glowing_flower', name: 'Hái hoa', description: 'Mục tiêu', instructions: 'Đưa cổ tay đến hoa', usage_mode: 'both', exercise_type: 'game', active: true, is_default: true, renderer: 'flower', default_duration_seconds: 30 }
const variant: Exercise = { ...flower, id: 2, code: 'guided_flower', name: 'Hái hoa · Luyện tầm với', is_default: false }
const template: QuestionnaireTemplate = { id: 3, code: 'clinical', name: 'Câu hỏi cơ bản', version: 1, active: true, questions: [{ id: 8, key: 'history', label: 'Tiền sử bệnh', group: 'Lâm sàng', question_type: 'text', required: true, display_order: 1, options: [] }] }
const submission: QuestionnaireSubmission = { id: 8, session_id: 55, template_id: 3, template_snapshot: template, answers: [], completed: false, created_at: '2026-01-01T00:00:00Z' }
function activeSession(): RehabSession { return { ...session, status: progress.completed ? 'completed' : progress.started ? 'in_progress' : 'draft', setup_confirmed: true } }
function currentReport(): SessionReport {
  return { session: activeSession(), patient, questionnaires: [{ ...submission, completed: true, answers: [{ question_key: 'history', value: 'Tiền sử đã lưu' }] }], clinical_assessments: [], selected_exercise_ids: [1, 2], is_baseline: false, duration_seconds: progress.done.length * 10, trial_count: progress.done.length,
    trials: progress.done.map((id, index) => ({ id: index + 1, session_id: 55, exercise_id: id, exercise_code: id === 1 ? flower.code : variant.code, trial_number: index + 1, status: 'completed', started_at: null, ended_at: null, results: [{ id: index + 1, trial_id: index + 1, round_id: `round-${index + 1}`, result_json: '{"score":3,"duration_seconds":10}', created_at: '2026-01-01T00:00:00Z' }] })),
    results: progress.done.map((id, index) => ({ id: index + 1, trial_id: index + 1, session_id: 55, round_id: `round-${index + 1}`, game_key: 'glowing_flower', affected_side: 'left', duration_seconds: 10, score: 3, target_count: 4, source: 'camera', created_at: '2026-01-01T00:00:00Z', exercise_id: id })),
  }
}
beforeEach(() => {
  progress.done = []; progress.started = false; progress.completed = false
  vi.spyOn(rehabApi, 'patient').mockResolvedValue(patient)
  vi.spyOn(rehabApi, 'questionnaires').mockResolvedValue([template])
  vi.spyOn(rehabApi, 'exercises').mockResolvedValue([flower, variant])
  vi.spyOn(rehabApi, 'assessments').mockResolvedValue([])
  vi.spyOn(rehabApi, 'createAssessment').mockResolvedValue(session)
  vi.spyOn(rehabApi, 'createSubmission').mockResolvedValue(submission)
  vi.spyOn(rehabApi, 'saveAnswers').mockResolvedValue({ ...submission, completed: true })
  vi.spyOn(rehabApi, 'updateAssessment').mockImplementation(async () => activeSession())
  vi.spyOn(rehabApi, 'startAssessment').mockImplementation(async () => { progress.started = true; return activeSession() })
  vi.spyOn(rehabApi, 'assessmentDetail').mockImplementation(async () => currentReport())
  vi.spyOn(rehabApi, 'completeAssessment').mockImplementation(async () => { progress.completed = true; return activeSession() })
})
afterEach(() => vi.restoreAllMocks())
function show() { render(<MemoryRouter initialEntries={['/assessment/1']}><Routes><Route path="/assessment/:patientId" element={<Assessment />} /></Routes></MemoryRouter>) }
async function startQuestions() {
  await userEvent.click(await screen.findByRole('button', { name: 'Bắt đầu đánh giá mới' }))
  await userEvent.type(await screen.findByLabelText(/Tiền sử bệnh/), 'Đã khám')
  await userEvent.click(screen.getByRole('button', { name: 'Lưu câu trả lời và tiếp tục' }))
}

it('lưu câu hỏi rồi chọn nhiều bài; bắt đầu sau khi chọn và giữ baseline khi hoàn tất', async () => {
  show(); await startQuestions()
  expect(rehabApi.saveAnswers).toHaveBeenCalledWith(8, [{ question_key: 'history', value: 'Đã khám' }], true)
  await userEvent.click(await screen.findByRole('button', { name: 'Mô phỏng lưu hiệu chuẩn' }))
  expect(rehabApi.startAssessment).not.toHaveBeenCalled()
  await userEvent.click(await screen.findByLabelText('Chọn Hái hoa · Luyện tầm với'))
  await userEvent.click(screen.getByRole('button', { name: 'Thực hiện Hái hoa' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Mô phỏng lưu trò chơi' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Quay lại danh sách bài' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Thực hiện Hái hoa · Luyện tầm với' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Mô phỏng lưu trò chơi' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Xem tổng kết đánh giá' }))
  expect(await screen.findByRole('heading', { name: 'Kết quả lần đánh giá' })).toBeInTheDocument()
  expect(rehabApi.updateAssessment).toHaveBeenCalledWith(55, { selected_exercise_ids: [1, 2] })
  expect(vi.mocked(rehabApi.updateAssessment).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rehabApi.startAssessment).mock.invocationCallOrder[0])
  await userEvent.type(screen.getByLabelText('Điểm FMA-UE (0–66)'), '35')
  await userEvent.type(screen.getByLabelText('Nhân viên xác nhận'), 'Chuyên viên A')
  await userEvent.click(screen.getByLabelText('Tôi xác nhận điểm từ đánh giá chuyên môn'))
  await userEvent.click(screen.getByRole('button', { name: 'Lưu điểm chuyên môn' }))
  await waitFor(() => expect(rehabApi.updateAssessment).toHaveBeenCalledWith(55, { fma_ue_score: 35, clinician_name: 'Chuyên viên A', clinician_confirmed: true }))
  await userEvent.click(await screen.findByRole('button', { name: 'Hoàn tất đánh giá' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Chuyển sang bệnh nhân điều trị' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('Baseline được chọn: 55')
  expect(rehabApi.createAssessment).toHaveBeenCalledTimes(1)
  expect(rehabApi.startAssessment).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('assessment-camera')).not.toBeInTheDocument()
})

it('giữ bước câu hỏi khi lưu lỗi và thử lại cùng lần đánh giá', async () => {
  vi.mocked(rehabApi.saveAnswers).mockRejectedValueOnce(new Error('Mất kết nối'))
  show(); await startQuestions()
  expect(await screen.findByText('Mất kết nối')).toBeInTheDocument()
  expect(screen.queryByTestId('assessment-camera')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Lưu câu trả lời và tiếp tục' }))
  expect(await screen.findByTestId('assessment-camera')).toBeInTheDocument()
  expect(rehabApi.createAssessment).toHaveBeenCalledTimes(1)
})

it('không tạo lần đánh giá mới cho bệnh nhân đã điều trị', async () => {
  vi.mocked(rehabApi.patient).mockResolvedValue({ ...patient, patient_type: 'inpatient' })
  show()
  expect(await screen.findByText(/đã thuộc nhóm điều trị/)).toBeInTheDocument()
  expect(rehabApi.createAssessment).not.toHaveBeenCalled()
})

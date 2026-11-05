import { useEffect } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Training from './Training'
import { rehabApi } from '../services/rehab'
import { api } from '../services/api'
import type { Exercise, PatientReport, RehabPatient, RehabSession, SessionReport } from '../types/rehab'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('../features/rehab/ClinicalWorkspace', () => ({
  default: function MockClinicalWorkspace({ session, view, onSetupSaved, onResultSaved }: { session: RehabSession; view: string; onSetupSaved: (id: number) => void; onResultSaved: (result: object) => void }) {
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.unmounts++ } }, [])
    return <div data-testid="camera-session" data-session={session.id}>
      {view === 'setup' && <button onClick={() => onSetupSaved(9)}>Mô phỏng lưu hiệu chuẩn</button>}
      {view === 'game' && <button onClick={() => onResultSaved({ id: 3, session_id: session.id, trial_id: 8, round_id: 'round', game_key: 'glowing_flower', score: 2, target_count: 3, duration_seconds: 20, created_at: '2026-01-01T00:00:00Z' })}>Mô phỏng lưu trò chơi</button>}
    </div>
  },
}))

const patient: RehabPatient = { id: 1, research_code: 'IN-01', affected_side: 'left', dominant_hand: 'right', notes: null, created_at: '2026-01-01T00:00:00Z', full_name: 'Hồ sơ thử', patient_type: 'inpatient', date_of_birth: '1980-01-01', sex: 'unspecified', contact: null, admitted_at: '2026-01-01T00:00:00Z' }
const session: RehabSession = { id: 22, patient_id: 1, affected_side: 'left', session_type: 'training', status: 'draft', started_at: '2026-01-01T00:00:00Z', ended_at: null, notes: null, created_at: '2026-01-01T00:00:00Z', managed_workflow: true, setup_confirmed: false, setup_revision: 0 }
const flower: Exercise = { id: 1, code: 'glowing_flower', name: 'Hái hoa', description: 'Chạm mục tiêu', instructions: 'Đưa cổ tay đến hoa', usage_mode: 'both', exercise_type: 'game', active: true, is_default: true, renderer: 'flower', default_duration_seconds: 30 }
const report: SessionReport = { session, patient, questionnaires: [], clinical_assessments: [], trials: [], results: [], duration_seconds: 0, trial_count: 0, is_baseline: false, selected_exercise_ids: [] }
const patientReport: PatientReport = { patient, transfers: [], assessments: [], training: [], prescriptions: [], available_exercises: [flower] }

beforeEach(() => { lifecycle.mounts = 0; lifecycle.unmounts = 0 })
afterEach(() => vi.restoreAllMocks())
function show(path = '/training/1') { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/training" element={<Training />} /><Route path="/training/:patientId" element={<Training />} /></Routes></MemoryRouter>) }

it('chặn bệnh nhân đến khám và hướng dẫn sang đánh giá', async () => {
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValue({ ...patientReport, patient: { ...patient, patient_type: 'outpatient' } })
  const create = vi.spyOn(rehabApi, 'createTraining')
  show()
  expect(await screen.findByText(/thuộc nhóm đến khám/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Đến Đánh giá' })).toHaveAttribute('href', '/assessment/1')
  expect(screen.queryByRole('button', { name: 'Bắt đầu buổi tập' })).not.toBeInTheDocument()
  expect(create).not.toHaveBeenCalled()
})

it('giữ cùng buổi và camera qua hai lượt; chỉ kết thúc khi xác nhận', async () => {
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValue(patientReport)
  vi.spyOn(rehabApi, 'trainingDetail').mockResolvedValue(report)
  const create = vi.spyOn(rehabApi, 'createTraining').mockResolvedValue(session)
  const start = vi.spyOn(rehabApi, 'startTraining').mockResolvedValue({ ...session, status: 'in_progress', setup_confirmed: true })
  const finish = vi.spyOn(rehabApi, 'completeTraining').mockResolvedValue({ ...session, status: 'completed', ended_at: '2026-01-01T00:02:00Z' })
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Bắt đầu buổi tập' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Mô phỏng lưu hiệu chuẩn' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(22))
  await userEvent.click(await screen.findByRole('button', { name: 'Thực hiện Hái hoa' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Mô phỏng lưu trò chơi' }))
  expect(await screen.findByRole('heading', { name: 'Kết quả trò chơi' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Thực hiện Hái hoa' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Mô phỏng lưu trò chơi' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Trở về' }))
  await userEvent.click(screen.getByRole('button', { name: 'Hủy' }))
  expect(finish).not.toHaveBeenCalled()
  expect(lifecycle.unmounts).toBe(0)
  await userEvent.click(screen.getByRole('button', { name: 'Trở về' }))
  await userEvent.click(screen.getByRole('button', { name: 'Xác nhận kết thúc' }))
  expect(await screen.findByRole('heading', { name: 'Tìm bệnh nhân luyện tập' })).toBeInTheDocument()
  expect(finish).toHaveBeenCalledWith(22)
  expect(create).toHaveBeenCalledTimes(1)
  expect(lifecycle.mounts).toBe(1)
  expect(lifecycle.unmounts).toBe(1)
})

it('tìm đúng mã thay vì tự chọn kết quả gần giống', async () => {
  vi.spyOn(rehabApi, 'patients').mockResolvedValue([{ ...patient, research_code: 'IN-012' }])
  show('/training')
  await userEvent.type(screen.getByLabelText('Mã bệnh nhân'), 'IN-01')
  await userEvent.click(screen.getByRole('button', { name: 'Tìm bệnh nhân' }))
  expect(await screen.findByText(/Không tìm thấy bệnh nhân/)).toBeInTheDocument()
})

it('không chọn nhầm hồ sơ có mã chỉ khác chữ hoa thường', async () => {
  vi.spyOn(rehabApi, 'patients').mockResolvedValue([{ ...patient, id: 2, research_code: 'in-01' }, patient])
  const load = vi.spyOn(rehabApi, 'patientReport').mockResolvedValue(patientReport)
  show('/training')
  await userEvent.type(screen.getByLabelText('Mã bệnh nhân'), 'IN-01')
  await userEvent.click(screen.getByRole('button', { name: 'Tìm bệnh nhân' }))
  await screen.findByRole('heading', { name: 'Buổi luyện tập' })
  expect(load).toHaveBeenCalledWith(1)
  expect(load).not.toHaveBeenCalledWith(2)
})

it('cho phép đóng buổi dang dở có xác nhận, giữ lịch sử đã lưu', async () => {
  const unfinished: SessionReport = { ...report, session: { ...session, id: 31, status: 'in_progress' } }
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValueOnce({ ...patientReport, training: [unfinished] }).mockResolvedValue(patientReport)
  const cancel = vi.spyOn(api, 'updateSession').mockResolvedValue({ ...session, id: 31, status: 'cancelled' })
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Đóng buổi dang dở #31' }))
  expect(cancel).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Xác nhận đóng buổi dang dở' }))
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(31, { status: 'cancelled' }))
  expect(await screen.findByRole('button', { name: 'Bắt đầu buổi tập' })).toBeEnabled()
})

it('tiếp tục đúng buổi dang dở và thiết lập lại camera trước khi chơi', async () => {
  const unfinished: SessionReport = { ...report, session: { ...session, id: 31, status: 'in_progress', setup_confirmed: true } }
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValue({ ...patientReport, training: [unfinished] })
  vi.spyOn(rehabApi, 'trainingDetail').mockResolvedValue(unfinished)
  const resume = vi.spyOn(rehabApi, 'resumeTraining').mockResolvedValue({ ...unfinished.session, setup_confirmed: false, setup_revision: 1 })
  const create = vi.spyOn(rehabApi, 'createTraining')
  const start = vi.spyOn(rehabApi, 'startTraining').mockResolvedValue({ ...unfinished.session, setup_revision: 1 })
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Tiếp tục buổi dang dở #31' }))
  expect(resume).toHaveBeenCalledWith(31)
  expect(await screen.findByTestId('camera-session')).toHaveAttribute('data-session', '31')
  expect(screen.getByRole('heading', { name: 'Thiết lập camera cho buổi tập' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Thực hiện Hái hoa' })).not.toBeInTheDocument()
  expect(create).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Mô phỏng lưu hiệu chuẩn' }))
  await waitFor(() => expect(start).toHaveBeenCalledWith(31))
  expect(await screen.findByRole('button', { name: 'Thực hiện Hái hoa' })).toBeEnabled()
})

it('không tiếp tục nếu buổi đã kết thúc hoặc thuộc bệnh nhân khác', async () => {
  const unfinished: SessionReport = { ...report, session: { ...session, id: 31, status: 'in_progress' } }
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValue({ ...patientReport, training: [unfinished] })
  vi.spyOn(rehabApi, 'trainingDetail').mockResolvedValue({ ...unfinished, session: { ...unfinished.session, patient_id: 2 } })
  const resume = vi.spyOn(rehabApi, 'resumeTraining')
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Tiếp tục buổi dang dở #31' }))
  expect(await screen.findByText(/không còn khả dụng/)).toBeInTheDocument()
  expect(resume).not.toHaveBeenCalled()
  expect(screen.queryByTestId('camera-session')).not.toBeInTheDocument()
})

it('giữ buổi đã tiếp tục nếu tải lại chi tiết thất bại, không gọi lại resume', async () => {
  const unfinished: SessionReport = { ...report, session: { ...session, id: 31, status: 'in_progress' } }
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValue({ ...patientReport, training: [unfinished] })
  vi.spyOn(rehabApi, 'trainingDetail').mockResolvedValueOnce(unfinished).mockRejectedValueOnce(new Error('offline'))
  const resume = vi.spyOn(rehabApi, 'resumeTraining').mockResolvedValue({ ...unfinished.session, setup_confirmed: false, setup_revision: 1 })
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Tiếp tục buổi dang dở #31' }))
  expect(await screen.findByText(/Đã tiếp tục buổi tập nhưng chưa tải lại/)).toBeInTheDocument()
  expect(screen.getByTestId('camera-session')).toHaveAttribute('data-session', '31')
  expect(resume).toHaveBeenCalledTimes(1)
})

it('lọc ngày theo ngày bệnh viện tại Bangkok, kể cả kết quả sau nửa đêm địa phương', async () => {
  const overnight: SessionReport = { ...report, session: { ...session, created_at: '2026-10-30T18:30:00Z', status: 'completed' } }
  vi.spyOn(rehabApi, 'patientReport').mockResolvedValue({ ...patientReport, training: [overnight] })
  show()
  await screen.findByRole('heading', { name: 'Lịch sử luyện tập' })
  fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2026-10-31' } })
  fireEvent.change(screen.getByLabelText('Đến ngày'), { target: { value: '2026-10-31' } })
  expect(screen.getByText(/31\/10\/2026/)).toBeInTheDocument()
  expect(screen.queryByText('Chưa có buổi luyện tập trong khoảng thời gian đã chọn.')).not.toBeInTheDocument()
})

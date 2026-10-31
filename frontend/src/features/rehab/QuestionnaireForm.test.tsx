import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import QuestionnaireForm from './QuestionnaireForm'
import type { QuestionnaireSubmission } from '../../types/rehab'

const submission: QuestionnaireSubmission = {
  id: 7, session_id: 2, template_id: 1, answers: [], completed: false, created_at: '2026-01-01T00:00:00Z',
  template_snapshot: { id: 1, code: 'CLINICAL', name: 'Phiếu lâm sàng', version: 2, active: true, questions: [
    { id: 1, key: 'history', label: 'Tiền sử', question_type: 'text', required: true, display_order: 1, group: 'Lâm sàng', options: [] },
    { id: 2, key: 'onset', label: 'Ngày khởi phát', question_type: 'date', required: false, display_order: 2, group: null, options: [] },
    { id: 3, key: 'duration', label: 'Số tháng', question_type: 'number', required: false, display_order: 3, group: null, options: [] },
    { id: 4, key: 'side', label: 'Bên ảnh hưởng', question_type: 'single_choice', required: true, display_order: 4, group: null, options: ['Trái', 'Phải'] },
    { id: 5, key: 'symptoms', label: 'Triệu chứng', question_type: 'multiple_choice', required: true, display_order: 5, group: null, options: ['Đau', 'Yếu'] },
    { id: 6, key: 'surgery', label: 'Đã phẫu thuật', question_type: 'boolean', required: true, display_order: 6, group: null, options: [] },
  ] },
}

it('gửi câu trả lời đúng kiểu từ snapshot phiên bản đã chọn', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<QuestionnaireForm submission={submission} onSave={save} onBack={() => undefined} busy={false} />)
  expect(screen.getByText(/Phiếu lâm sàng.*phiên bản 2/)).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText(/Tiền sử/), 'Đã khám trước đây')
  fireEvent.change(screen.getByLabelText('Ngày khởi phát'), { target: { value: '2026-01-02' } })
  await userEvent.type(screen.getByLabelText('Số tháng'), '4')
  await userEvent.selectOptions(screen.getByLabelText(/Bên ảnh hưởng/), 'Trái')
  await userEvent.click(screen.getByLabelText('Yếu'))
  await userEvent.selectOptions(screen.getByLabelText(/Đã phẫu thuật/), 'false')
  await userEvent.click(screen.getByRole('button', { name: 'Lưu câu trả lời và tiếp tục' }))
  expect(save).toHaveBeenCalledWith([
    { question_key: 'history', value: 'Đã khám trước đây' }, { question_key: 'onset', value: '2026-01-02' },
    { question_key: 'duration', value: 4 }, { question_key: 'side', value: 'Trái' },
    { question_key: 'symptoms', value: ['Yếu'] }, { question_key: 'surgery', value: false },
  ])
})

it('không bỏ qua nhóm nhiều lựa chọn bắt buộc', async () => {
  const save = vi.fn()
  render(<QuestionnaireForm submission={{ ...submission, answers: [{ question_key: 'history', value: 'Đủ' }, { question_key: 'side', value: 'Trái' }, { question_key: 'surgery', value: false }] }} onSave={save} onBack={() => undefined} busy={false} />)
  await userEvent.click(screen.getByRole('button', { name: 'Lưu câu trả lời và tiếp tục' }))
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('Triệu chứng')
})

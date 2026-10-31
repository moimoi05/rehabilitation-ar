import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import SessionSummary from './SessionSummary'
import type { SessionReport } from '../../types/rehab'

afterEach(cleanup)
function report(resultJson: string): SessionReport {
  return {
    session: { id: 7, patient_id: 3, session_type: 'assessment', status: 'completed', affected_side: 'left', started_at: null, ended_at: null, created_at: '', notes: null, managed_workflow: false, setup_confirmed: false, setup_revision: 0 },
    patient: { id: 3, research_code: 'LEGACY-3', full_name: null, patient_type: 'outpatient', affected_side: 'left', dominant_hand: 'right', date_of_birth: null, sex: null, contact: null, admitted_at: null, created_at: '', notes: null },
    questionnaires: [], clinical_assessments: [], selected_exercise_ids: [], results: [],
    trials: [{ id: 8, session_id: 7, exercise_code: 'glowing_flower', exercise_id: null, trial_number: 1, status: null, started_at: null, ended_at: null, results: [{ id: 9, trial_id: 8, round_id: null, result_json: resultJson, created_at: '' }] }],
    duration_seconds: 0, trial_count: 1, is_baseline: false,
  }
}

it('reads unknown legacy JSON without inventing duration or crashing the assessment report', () => {
  render(<SessionSummary report={report('{"duration_seconds":"unknown","score":"legacy"}')} exercises={[]}/> )
  const row = screen.getByRole('row', { name: /glowing_flower/ })
  expect(within(row).getByText('Chưa ghi thời lượng')).toBeInTheDocument()
  expect(within(row).queryByText('0.0 giây')).not.toBeInTheDocument()
  expect(within(row).getByText('Chưa xác nhận chất lượng')).toBeInTheDocument()
})

it('keeps readable historical numbers even when the new trial status was never recorded', () => {
  render(<SessionSummary report={report('{"duration_seconds":12.5,"score":3}')} exercises={[]}/> )
  const row = screen.getByRole('row', { name: /glowing_flower/ })
  expect(within(row).getByText('12.5 giây')).toBeInTheDocument()
  expect(within(row).getByText('3')).toBeInTheDocument()
  expect(within(row).queryByText('Chưa hoàn tất')).not.toBeInTheDocument()
})

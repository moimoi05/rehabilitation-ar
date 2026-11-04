import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import GameResult from './GameResult'
import ExerciseCatalog from './ExerciseCatalog'
import type { Exercise } from '../../types/rehab'

afterEach(cleanup)
const drawing: Exercise = { id: 2, code: 'free_drawing', renderer: 'free_drawing', name: 'Vẽ tự do', description: '', instructions: '', exercise_type: 'game', usage_mode: 'training', active: true, is_default: false, default_duration_seconds: 60 }
const common = { id: 3, trial_id: 8, session_id: 7, round_id: 'drawing-round', duration_seconds: 12.5, created_at: '' }
const actions = { onContinue: vi.fn(), onReturn: vi.fn() }

it('shows drawing activity without inventing game scores or targets', () => {
  render(<GameResult result={{ ...common, game_key: 'free_drawing', completed_strokes: 4, active_drawing_seconds: 8 }} exercise={drawing} {...actions}/> )
  expect(screen.getByText('Số nét đã hoàn tất')).toBeInTheDocument()
  expect(screen.getByText('4')).toBeInTheDocument()
  expect(screen.getByText('8.0 giây')).toBeInTheDocument()
  expect(screen.queryByText('Điểm trò chơi')).not.toBeInTheDocument()
  expect(screen.queryByText('Số mục tiêu')).not.toBeInTheDocument()
})

it('keeps Flower results readable with their existing score and targets', () => {
  render(<GameResult result={{ ...common, game_key: 'glowing_flower', score: 2, target_count: 3 }} exercise={null} {...actions}/> )
  expect(screen.getByText('Điểm trò chơi')).toBeInTheDocument()
  expect(screen.getByText('2')).toBeInTheDocument()
  expect(screen.getByText('Số mục tiêu')).toBeInTheDocument()
})

it('makes only the implemented training drawing renderer playable', () => {
  render(<ExerciseCatalog exercises={[drawing, { ...drawing, id: 3, name: 'Không hỗ trợ', renderer: 'unknown' }, { ...drawing, id: 4, name: 'Sai phân hệ', usage_mode: 'assessment' }]} onPlay={vi.fn()}/> )
  expect(screen.getByRole('button', { name: 'Thực hiện Vẽ tự do' })).toBeEnabled()
  expect(screen.queryByText('Không hỗ trợ')).not.toBeInTheDocument()
  expect(screen.queryByText('Sai phân hệ')).not.toBeInTheDocument()
})

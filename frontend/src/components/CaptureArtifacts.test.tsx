import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import CaptureArtifacts from './CaptureArtifacts'

afterEach(cleanup)
it('offers video only for a completed, confirmed video artifact', () => {
  render(<CaptureArtifacts captures={[
    { id: '11111111-1111-4111-8111-111111111111', trial_id: 3, status: 'complete', source_type: 'webcam', record_video: true, record_landmarks: false, artifact_summary: { video_status: 'complete' } },
    { id: '22222222-2222-4222-8222-222222222222', trial_id: 4, status: 'incomplete', source_type: 'webcam', record_video: true, record_landmarks: false, artifact_summary: { video_status: 'failed' } },
  ]}/> )
  expect(screen.getAllByRole('link', { name: 'Tải video đã lưu' })).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'Tải video đã lưu' })).toHaveAttribute('href', expect.stringContaining('/api/captures/11111111-1111-4111-8111-111111111111/artifacts/video'))
  expect(screen.getByText(/Lượt #4.*Chưa hoàn tất/)).toBeInTheDocument()
  expect(document.querySelectorAll('video')).toHaveLength(1)
})
it('explains an unavailable video while retaining the verified download reference', () => {
  render(<CaptureArtifacts captures={[{ id: 'saved', trial_id: 3, status: 'complete', source_type: 'webcam', record_video: true, record_landmarks: false, artifact_summary: { video_status: 'complete' } }]}/> )
  fireEvent.error(document.querySelector('video')!)
  expect(screen.getByRole('status')).toHaveTextContent('Chưa phát được video')
  expect(screen.getByRole('link', { name: 'Tải video đã lưu' })).toBeInTheDocument()
})
it('does not invent recordings for sessions without capture metadata', () => {
  render(<CaptureArtifacts captures={[]}/> )
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(document.querySelector('video')).toBeNull()
})

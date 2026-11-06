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

it('shows capture identity and individual artifact states when gameplay saved but capture is incomplete', () => {
  render(<CaptureArtifacts captures={[{ id: 'partial-capture', trial_id: 8, status: 'incomplete', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { video_status: 'failed', frames_status: 'complete', landmarks_status: 'complete' } }]}/> )
  expect(screen.getByText(/Capture partial-capture/)).toBeInTheDocument()
  expect(screen.getByText(/frames complete.*landmarks complete.*video failed/)).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Tải video đã lưu' })).not.toBeInTheDocument()
})

it('shows the tracking video separately only when that artifact is complete', () => {
  render(<CaptureArtifacts captures={[
    { id: 'with-overlay', trial_id: 9, status: 'complete', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { video_status: 'complete', tracking_video_status: 'complete' } },
    { id: 'failed-overlay', trial_id: 10, status: 'incomplete', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { video_status: 'complete', tracking_video_status: 'failed' } },
    { id: 'old-capture', trial_id: 11, status: 'complete', source_type: 'webcam', record_video: true, record_landmarks: false, artifact_summary: { video_status: 'complete' } },
  ]}/> )
  const trackingVideo = screen.getByRole('link', { name: 'Tải video có tracking' })
  expect(trackingVideo).toHaveAttribute('href', expect.stringContaining('/api/captures/with-overlay/artifacts/tracking_video'))
  expect(screen.getByLabelText('Video có tracking của lượt 9')).toBeInTheDocument()
  expect(screen.getByText(/video tracking failed/)).toBeInTheDocument()
  expect(screen.getByText(/video tracking không có thông tin/)).toBeInTheDocument()
  expect(screen.getAllByRole('link', { name: 'Tải video đã lưu' })).toHaveLength(3)
})

it('reports tracking playback errors without hiding the webcam video', () => {
  render(<CaptureArtifacts captures={[{ id: 'both', trial_id: 12, status: 'complete', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { video_status: 'complete', tracking_video_status: 'complete' } }]}/> )
  fireEvent.error(screen.getByLabelText('Video có tracking của lượt 12'))
  expect(screen.getByRole('status')).toHaveTextContent('Chưa phát được video có tracking')
  expect(screen.getByLabelText('Video đã lưu của lượt 12')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Tải video có tracking' })).toBeInTheDocument()
})

it('allows a partial tracking video only when the server reports an available file', () => {
  render(<CaptureArtifacts captures={[
    { id: 'partial', trial_id: 13, status: 'incomplete', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { tracking_video_status: 'incomplete', tracking_video_file: 'tracking_video.webm' } },
    { id: 'no-file', trial_id: 14, status: 'incomplete', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { tracking_video_status: 'incomplete' } },
    { id: 'still-recording', trial_id: 15, status: 'recording', source_type: 'webcam', record_video: true, record_landmarks: true, artifact_summary: { tracking_video_status: 'incomplete', tracking_video_file: 'tracking_video.webm' } },
  ]}/> )
  expect(screen.getByText('Video có tracking chưa hoàn chỉnh')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Tải video có tracking chưa hoàn chỉnh' })).toHaveAttribute('href', expect.stringContaining('/api/captures/partial/artifacts/tracking_video'))
  expect(screen.getByLabelText('Video có tracking chưa hoàn chỉnh của lượt 13')).toBeInTheDocument()
  expect(screen.queryByLabelText('Video có tracking chưa hoàn chỉnh của lượt 14')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Video có tracking chưa hoàn chỉnh của lượt 15')).not.toBeInTheDocument()
})

it('shows measured trial metrics and explicit unavailable values with verified Phase 2 links', () => {
  render(<CaptureArtifacts captures={[{
    id: 'phase-two', trial_id: 16, status: 'complete', source_type: 'webcam', record_video: false, record_landmarks: true,
    artifact_summary: {
      events_status: 'complete', interaction_samples_status: 'complete', game_metrics_status: 'complete',
      game_metrics: {
        completed_target_count: { metric_name: 'completed_target_count', value: 2, unit: 'count', algorithm_version: 'test-v1', sample_count: 2, quality_status: 'valid', unavailable_reason: null },
        mean_time_to_touch_ms: { metric_name: 'mean_time_to_touch_ms', value: null, unit: 'ms', algorithm_version: 'test-v1', sample_count: 0, quality_status: 'unavailable', unavailable_reason: 'insufficient_samples' },
        total_path_length: { metric_name: 'total_path_length', value: 120, unit: 'display_px', algorithm_version: 'test-v1', sample_count: 3, quality_status: 'partial', unavailable_reason: null },
      },
    },
  }]}/> )
  expect(screen.getByText('Số hoa hoàn thành: 2')).toBeInTheDocument()
  expect(screen.getByText('Thời gian chạm trung bình: Không đủ dữ liệu')).toBeInTheDocument()
  expect(screen.getByText('Quãng đường di chuyển: 120 display_px (dữ liệu một phần)')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Tải sự kiện game' })).toHaveAttribute('href', expect.stringContaining('/api/captures/phase-two/artifacts/events'))
  expect(screen.getByRole('link', { name: 'Tải quỹ đạo tương tác' })).toHaveAttribute('href', expect.stringContaining('/artifacts/interaction_samples'))
  expect(screen.getByRole('link', { name: 'Tải chỉ số game' })).toHaveAttribute('href', expect.stringContaining('/artifacts/game_metrics'))
})

it('does not present unverified game metrics or Phase 2 download links', () => {
  render(<CaptureArtifacts captures={[{
    id: 'phase-two-failed', trial_id: 17, status: 'incomplete', source_type: 'webcam', record_video: false, record_landmarks: true,
    artifact_summary: { events_status: 'failed', interaction_samples_status: 'pending', game_metrics_status: 'failed', game_metrics: {
      completed_stroke_count: { metric_name: 'completed_stroke_count', value: 0, unit: 'count', algorithm_version: 'test-v1', sample_count: 0, quality_status: 'valid', unavailable_reason: null },
    } },
  }]}/> )
  expect(screen.queryByText(/Số nét hoàn thành/)).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Tải sự kiện game' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Tải chỉ số game' })).not.toBeInTheDocument()
  expect(screen.getByText(/events failed.*interaction samples pending.*game metrics failed/)).toBeInTheDocument()
})

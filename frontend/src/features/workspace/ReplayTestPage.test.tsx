import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReplayTestPage from './ReplayTestPage'
import type { TrackingTestLabProps } from './TrackingTestLab'

const mock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), abort: vi.fn(), addFrame: vi.fn(), play: vi.fn(), pause: vi.fn(), active: false }))
vi.mock('./useReplayCapture', () => ({
  useReplayCapture: () => ({ start: mock.start, stop: mock.stop, abort: mock.abort, addFrame: mock.addFrame, isActive: () => mock.active, busy: false, state: 'Chưa thu dữ liệu replay', captureId: '', stats: null }),
}))
vi.mock('./TrackingTestLab', () => ({
  default: (props: TrackingTestLabProps) => {
    const video = { currentTime: 0, videoWidth: 640, videoHeight: 480, play: mock.play, pause: mock.pause } as unknown as HTMLVideoElement
    return <div>
      <button onClick={() => props.onReplaySource?.(new File(['video'], 'test.mp4', { type: 'video/mp4' }), video)}>Chọn nguồn thử</button>
      <button onClick={() => props.onReplayReady?.(video, { pose_enabled: true, hand_enabled: true })}>Model sẵn sàng</button>
      <button onClick={() => props.onReplayInterrupted?.()}>Ngắt model</button>
      <button onClick={() => props.onReplayEnded?.()}>Kết thúc video</button>
    </div>
  },
}))

describe('Video Replay Test controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.active = false
    mock.start.mockResolvedValue(undefined)
    mock.play.mockResolvedValue(undefined)
  })

  it('requires consent and valid patient/session before starting', async () => {
    render(<ReplayTestPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Chọn nguồn thử' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model sẵn sàng' }))
    const start = screen.getByRole('button', { name: 'Bắt đầu thu replay' })
    expect(start).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Tôi xác nhận quyền thu thập video và landmark cho lần kiểm thử này'))
    fireEvent.click(start)
    expect(screen.getByRole('alert')).toHaveTextContent('patient/session hợp lệ')
    expect(mock.start).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Replay patient ID'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Replay session ID'), { target: { value: '2' } })
    fireEvent.click(start)
    await waitFor(() => expect(mock.play).toHaveBeenCalledOnce())
    expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({ patientId: 1, sessionId: 2, width: 640, height: 480, modelConfig: { pose_enabled: true, hand_enabled: true } }))
  })

  it('disables capture again and aborts if tracking stops', () => {
    render(<ReplayTestPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Chọn nguồn thử' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model sẵn sàng' }))
    fireEvent.click(screen.getByLabelText('Tôi xác nhận quyền thu thập video và landmark cho lần kiểm thử này'))
    expect(screen.getByRole('button', { name: 'Bắt đầu thu replay' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Ngắt model' }))
    expect(screen.getByRole('button', { name: 'Bắt đầu thu replay' })).toBeDisabled()
    expect(mock.abort).toHaveBeenCalled()
  })

  it('does not play if capture creation fails', async () => {
    mock.start.mockRejectedValue(new Error('offline'))
    render(<ReplayTestPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Chọn nguồn thử' }))
    fireEvent.click(screen.getByRole('button', { name: 'Model sẵn sàng' }))
    fireEvent.change(screen.getByLabelText('Replay patient ID'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Replay session ID'), { target: { value: '2' } })
    fireEvent.click(screen.getByLabelText('Tôi xác nhận quyền thu thập video và landmark cho lần kiểm thử này'))
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu thu replay' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    expect(mock.play).not.toHaveBeenCalled()
  })
})

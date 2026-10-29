import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../types'
import { useFlowerGame } from './useFlowerGame'
import type { Size, VideoMapping } from './videoGeometry'

const session: Session = { id: 7, patient_id: 3, affected_side: 'left', session_type: 'training', status: 'in_progress', started_at: null, ended_at: null, notes: null, created_at: '' }
const pose = { current: { pose: Array.from({ length: 17 }, (_, i) => ({ x: i === 15 ? .35 : .5, y: .5, visibility: 1 })), hands: [] } }
const poseTime = { current: 100 }
function Harness({ currentSession = session, demo = false, mapping, displayBox }: { currentSession?: Session; demo?: boolean; mapping?: { current: VideoMapping | null }; displayBox?: { current: Size | null } }) {
  const game = useFlowerGame({ demo, session: currentSession, streamActive: !demo, tracking: !demo, mirrored: false, side: 'left', confirmed: true, size: { width: 1280, height: 720 }, pose, poseTime, mapping, displayBox })
  return <>{game.overlay}{game.panel}</>
}

describe('flower game integration', () => {
  let nextFrame: FrameRequestCallback
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { nextFrame = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    let id = 0
    vi.stubGlobal('crypto', { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` })
    poseTime.current = 100
  })
  afterEach(() => { pose.current.pose[15].x = .35; pose.current.pose[15].y = .5; pose.current.pose[15].visibility = 1; cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  const tick = (time: number) => act(() => { const clock = vi.spyOn(performance, 'now').mockReturnValue(time); try { nextFrame(time) } finally { clock.mockRestore() } })
  const playAndFinish = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    fireEvent.click(screen.getByRole('button', { name: 'Dừng và xem kết quả' }))
  }

  it('retries an uncertain save with the same round ID and locks duplicate submission', async () => {
    let resolveSave: (value: { ok: boolean }) => void = () => {}
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />); playAndFinish()
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu kết quả' }))
    const retry = await screen.findByRole('button', { name: 'Thử lưu lại' })
    fireEvent.click(retry)
    expect(screen.getByRole('button', { name: 'Đang lưu…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Lượt mới' })).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].body).toEqual(fetchMock.mock.calls[1][1].body)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ session_id: 7, source: 'camera', score: 1, target_count: 2, duration_seconds: .15 })
    await act(async () => { resolveSave({ ok: true }) })
    expect(await screen.findByRole('button', { name: 'Đã lưu kết quả' })).toBeDisabled()
  })

  it('ignores a delayed save response after switching sessions', async () => {
    let resolveSave: (value: { ok: boolean }) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveSave = resolve })))
    const view = render(<Harness />); playAndFinish()
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu kết quả' }))
    view.rerender(<Harness currentSession={{ ...session, id: 8 }} />)
    expect(await screen.findByText(/có thể đã hoàn tất/)).toBeInTheDocument()
    await act(async () => { resolveSave({ ok: true }) })
    await waitFor(() => expect(screen.queryByText('Đã lưu kết quả lượt tập vào phiên.')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })).toBeEnabled()
  })

  it('never offers result saving in demo mode', () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    render(<Harness demo />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dừng và xem kết quả' }))
    expect(screen.getByText(/kết quả này không được lưu/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Xác nhận lưu kết quả' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not score using a wrist outside its visible position after cover cropping', () => {
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: -388.8889, y: 0, width: 1777.7778, height: 1000 } } }
    render(<Harness mapping={mapping} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('0')
  })

  it('pauses scoring when source dimensions are not available', () => {
    render(<Harness mapping={{ current: null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('0')
    expect(screen.getByText('Tạm dừng · mất mốc')).toBeInTheDocument()
  })

  it('pauses scoring when the wrist visibility is missing', () => {
    Object.assign(pose.current.pose[15], { visibility: undefined })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('0')
    expect(screen.getByText('Tạm dừng · mất mốc')).toBeInTheDocument()
  })

  it('uses displayed box proportions for hit testing when canvas aspect differs', () => {
    pose.current.pose[15].x = .4
    render(<Harness displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
  })

  it('retains the release requirement when the visible region changes after a hit', () => {
    pose.current.pose[15].y = .431
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }
    tick(400)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
  })

  it('does not treat a change in crop as movement of a stationary wrist', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' }))
    tick(100); tick(250)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: -100, y: 0, width: 1200, height: 1000 } }
    poseTime.current = 400
    tick(400)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }
    poseTime.current = 550
    tick(550)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
    poseTime.current = 600; tick(600)
    pose.current.pose[15].x = .9
    poseTime.current = 700
    tick(700)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('2')
    expect(screen.queryByText(/di chuyển cổ tay sau khi đổi khung hình/)).not.toBeInTheDocument()
  })

  it('requires a new observed movement after tracking is lost and reacquired', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    poseTime.current = 0; tick(550)
    pose.current.pose[15].x = .9; poseTime.current = 700; tick(700)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
  })

  it('reanchors after video geometry disappears along with tracking', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping: { current: VideoMapping | null } = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    mapping.current = null; poseTime.current = 0; tick(550)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }
    pose.current.pose[15].x = .9; poseTime.current = 700; tick(700)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
  })

  it('allows a supervised resume without counting a stationary wrist as a hit', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    poseTime.current = 450; tick(450)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(500)
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục sau khi kiểm tra' })); clock.mockRestore()
    const sameFrame = vi.spyOn(performance, 'now').mockReturnValue(501)
    act(() => { nextFrame(499) }); sameFrame.mockRestore()
    expect(screen.getByText(/chờ quan sát mới/)).toBeInTheDocument()
    // A worker can deliver an older in-flight frame after the click.
    poseTime.current = 480
    tick(550)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/chờ quan sát mới/)).toBeInTheDocument()
    poseTime.current = 600; tick(700)
    expect(screen.queryByText(/di chuyển cổ tay sau khi đổi khung hình/)).not.toBeInTheDocument()
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
  })

  it('does not carry a supervised resume request across lost tracking', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    poseTime.current = 0; tick(550)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(550)
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục sau khi kiểm tra' })); clock.mockRestore()
    pose.current.pose[15].x = .9; poseTime.current = 700; tick(700)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
  })

  it('expires a supervised resume and reanchors after a long observation gap', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; poseTime.current = 400; tick(400)
    poseTime.current = 450; tick(450)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(500)
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục sau khi kiểm tra' })); clock.mockRestore()
    pose.current.pose[15].x = .9; poseTime.current = 2100; tick(2100)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
    expect(screen.queryByText(/chờ quan sát mới/)).not.toBeInTheDocument()
  })

  it('ignores an in-flight worker observation captured before geometry changed', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    pose.current.pose[15].x = .9; poseTime.current = 300; tick(450)
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
  })

  it('rejects stale results using callback execution time rather than an old animation timestamp', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    poseTime.current = 450; tick(450)
    const clickClock = vi.spyOn(performance, 'now').mockReturnValue(500)
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục sau khi kiểm tra' })); clickClock.mockRestore()
    poseTime.current = 550
    const lateClock = vi.spyOn(performance, 'now').mockReturnValue(1300)
    act(() => { nextFrame(560) }); lateClock.mockRestore()
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
  })

  it('cancels supervised resume after an unobserved tracking gap', () => {
    pose.current.pose[15].x = .3; pose.current.pose[15].y = .46
    const mapping = { current: { box: { width: 1000, height: 1000 }, rect: { x: 0, y: 0, width: 1000, height: 1000 } } }
    render(<Harness mapping={mapping} displayBox={{ current: { width: 1000, height: 1000 } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu trò chơi' })); tick(100); tick(250)
    mapping.current = { box: { width: 1000, height: 1000 }, rect: { x: 400, y: 0, width: 200, height: 1000 } }; tick(400)
    poseTime.current = 450; tick(450)
    const clickClock = vi.spyOn(performance, 'now').mockReturnValue(500)
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục sau khi kiểm tra' })); clickClock.mockRestore()
    pose.current.pose[15].x = .9; poseTime.current = 1100; tick(1100)
    expect(screen.getByText('Hoa đã chạm').parentElement).toHaveTextContent('1')
    expect(screen.getByText(/di chuyển cổ tay sau khi đổi khung hình/)).toBeInTheDocument()
    expect(screen.queryByText(/chờ quan sát mới/)).not.toBeInTheDocument()
  })
})

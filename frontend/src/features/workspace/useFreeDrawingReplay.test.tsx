import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { developmentReplayEnabled, useFreeDrawingReplay } from './useFreeDrawingReplay'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('development Free Drawing video source', () => {
  it('reloads a new run and ignores an old pending game start', async () => {
    const video = document.createElement('video')
    Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } })
    const load = vi.spyOn(video, 'load').mockImplementation(() => {})
    vi.spyOn(video, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(video, 'play').mockResolvedValue()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ sourcePath: 'test.mp4', videoUrl: '/__free-drawing-replay/video' }) } as Response)
    let finishOldStart!: () => void
    const start = vi.fn(() => new Promise<void>(resolve => { finishOldStart = resolve }))
    const props = { enabled: true, video: { current: video }, sourceActive: false, tracking: false, engine: null as string | null, delegate: { hand: 'GPU', pose: 'GPU' }, side: 'right' as const, mirrored: true, run: 1, setSourceReady: vi.fn(), startTracking: vi.fn(async () => {}), stopTracking: vi.fn(), game: { start, stop: vi.fn(), resetReplay: vi.fn(), phase: 'playing', getCompletedStrokes: () => 0 }, diagnostics: null }
    const { result, rerender } = renderHook(value => useFreeDrawingReplay(value), { initialProps: props })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    act(() => video.dispatchEvent(new Event('loadeddata')))
    rerender({ ...props, sourceActive: true })
    await waitFor(() => expect(props.startTracking).toHaveBeenCalledOnce())
    rerender({ ...props, sourceActive: true, tracking: true, engine: 'worker' })
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    rerender({ ...props, run: 2 })
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(1))
    expect(props.stopTracking).toHaveBeenCalledOnce()
    expect(props.game.resetReplay).toHaveBeenCalledTimes(2)
    await act(async () => { finishOldStart(); await Promise.resolve() })
    expect(play).not.toHaveBeenCalled()
    expect(result.current.state).toBe('loading')
  })

  it('does not stop a new run when the previous report finishes late', async () => {
    const video = document.createElement('video')
    Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } })
    vi.spyOn(video, 'load').mockImplementation(() => {})
    vi.spyOn(video, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(video, 'play').mockResolvedValue()
    let finishReport!: (response: Response) => void
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/report')) return new Promise<Response>(resolve => { finishReport = resolve })
      return { ok: true, json: async () => ({ sourcePath: 'test.mp4', videoUrl: '/__free-drawing-replay/video' }) } as Response
    })
    const props = { enabled: true, video: { current: video }, sourceActive: false, tracking: false, engine: null as string | null, delegate: { hand: 'GPU', pose: 'GPU' }, side: 'right' as const, mirrored: true, run: 1, setSourceReady: vi.fn(), startTracking: vi.fn(async () => {}), stopTracking: vi.fn(), game: { start: vi.fn(async () => {}), stop: vi.fn(), resetReplay: vi.fn(), phase: 'playing', getCompletedStrokes: () => 0 }, diagnostics: null }
    const { result, rerender } = renderHook(value => useFreeDrawingReplay(value), { initialProps: props })
    await waitFor(() => expect(video.src).toContain('/__free-drawing-replay/video'))
    act(() => video.dispatchEvent(new Event('loadeddata')))
    rerender({ ...props, sourceActive: true })
    await waitFor(() => expect(props.startTracking).toHaveBeenCalledOnce())
    rerender({ ...props, sourceActive: true, tracking: true, engine: 'worker' })
    await waitFor(() => expect(play).toHaveBeenCalledOnce())
    act(() => video.dispatchEvent(new Event('error')))
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/report'))).toBe(true))
    rerender({ ...props, run: 2 })
    await act(async () => { finishReport({ ok: true } as Response); await Promise.resolve() })
    expect(props.stopTracking).toHaveBeenCalledOnce()
    expect(result.current.state).toBe('loading')
  })

  it('cannot replace a clinical session or run in production', () => {
    const query = new URLSearchParams('drawingReplay=1')
    expect(developmentReplayEnabled(query, true, false)).toBe(true)
    expect(developmentReplayEnabled(query, false, false)).toBe(false)
    expect(developmentReplayEnabled(query, true, true)).toBe(false)
    expect(developmentReplayEnabled(new URLSearchParams('drawingReplay=1&sessionId=7'), true, false)).toBe(false)
  })

  it.each(['ended', 'worker-lost', 'seeking'] as const)('plays only after the pipeline is ready and reports %s truthfully', async ending => {
    const video = document.createElement('video')
    Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, duration: { value: 32.32 } })
    vi.spyOn(video, 'load').mockImplementation(() => {})
    vi.spyOn(video, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(video, 'play').mockResolvedValue()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => ({ sourcePath: 'test.mp4', videoUrl: '/__free-drawing-replay/video' }) } as Response).mockResolvedValue({ ok: true } as Response)
    const setSourceReady = vi.fn(), startTracking = vi.fn(async () => {}), stopTracking = vi.fn()
    const game = { start: vi.fn(async () => {}), stop: vi.fn(), resetReplay: vi.fn(), phase: 'playing', getCompletedStrokes: () => 2 }
    const diagnostics = { reset: vi.fn(), report: vi.fn(() => ({ counts: { handCallbacks: 10 } })) }
    const props = { enabled: true, video: { current: video }, sourceActive: false, tracking: false, engine: null as string | null, delegate: { hand: 'GPU', pose: 'GPU' }, side: 'right' as const, mirrored: true, run: 1, setSourceReady, startTracking, stopTracking, game, diagnostics: diagnostics as never }
    const { result, rerender } = renderHook(value => useFreeDrawingReplay(value), { initialProps: props })
    await waitFor(() => expect(video.src).toContain('/__free-drawing-replay/video'))
    act(() => video.dispatchEvent(new Event('loadeddata')))
    expect(setSourceReady).toHaveBeenCalledWith({ width: 1920, height: 1080 })
    expect(play).not.toHaveBeenCalled()
    rerender({ ...props, sourceActive: true })
    await waitFor(() => expect(startTracking).toHaveBeenCalledOnce())
    rerender({ ...props, sourceActive: true, tracking: true, engine: 'worker' })
    await waitFor(() => expect(play).toHaveBeenCalledOnce())
    expect(game.start).toHaveBeenCalledOnce()
    expect(diagnostics.reset).toHaveBeenCalledOnce()
    expect(diagnostics.reset.mock.invocationCallOrder[0]).toBeLessThan(play.mock.invocationCallOrder[0])
    if (ending === 'ended' || ending === 'seeking') act(() => video.dispatchEvent(new Event(ending)))
    else rerender({ ...props, sourceActive: true, tracking: false, engine: null, delegate: { hand: 'Tắt', pose: '—' } })
    await waitFor(() => expect(result.current.state).toBe(ending === 'ended' ? 'finished' : 'error'))
    expect(game.stop).toHaveBeenCalledOnce()
    expect(diagnostics.report).toHaveBeenCalledWith(expect.any(Number), 2)
    expect(fetcher).toHaveBeenLastCalledWith('/__free-drawing-replay/report', expect.objectContaining({ method: 'POST', body: expect.stringContaining('handCallbacks') }))
    const report = JSON.parse(String(fetcher.mock.lastCall?.[1]?.body))
    expect(report).toMatchObject({ engine: 'worker', delegate: { hand: 'GPU', pose: 'GPU' } })
    if (ending === 'worker-lost') expect(report.error).toEqual(expect.any(String))
    expect(stopTracking).toHaveBeenCalledOnce()
  })
})

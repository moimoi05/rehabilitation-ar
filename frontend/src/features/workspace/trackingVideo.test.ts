import { afterEach, expect, it, vi } from 'vitest'
import { createTrackingVideo } from './trackingVideo'
import { drawLandmarks } from './drawing'

vi.mock('./drawing', () => ({ drawLandmarks: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('records camera with both fresh skeletons and flags a hidden tab', () => {
  const drawImage = vi.fn(), stop = vi.fn(), error = vi.fn(), callbacks: FrameRequestCallback[] = []
  const context = { save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), drawImage }
  const captureStream = vi.fn(() => ({ getTracks: () => [{ stop }] }))
  const canvas = { width: 0, height: 0, getContext: () => context, captureStream }
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4 } as HTMLVideoElement
  const pose = [{ x: .5, y: .5 }], hand = [{ x: .6, y: .6 }]
  const tracking = createTrackingVideo(video, true, () => ({ pose, hands: [hand] }), error)
  expect([canvas.width, canvas.height]).toEqual([1280, 720])
  expect(captureStream).toHaveBeenCalledWith(15)
  callbacks.shift()!(100)
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720)
  expect(context.scale).toHaveBeenCalledWith(-1, 1)
  expect(drawLandmarks).toHaveBeenCalledWith(context, 1280, 720, pose, true)
  expect(drawLandmarks).toHaveBeenCalledWith(context, 1280, 720, hand, true, true)
  callbacks.shift()!(130)
  expect(drawImage).toHaveBeenCalledTimes(1)
  callbacks.shift()!(170)
  expect(drawImage).toHaveBeenCalledTimes(2)
  visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'))
  expect(error).toHaveBeenCalledOnce()
  tracking.close(); expect(stop).toHaveBeenCalledOnce()
})

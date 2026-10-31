import { afterEach, expect, it, vi } from 'vitest'
import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { initializeHand, initializePose } from './mediaPipeModels'

vi.mock('@mediapipe/tasks-vision', () => ({
  PoseLandmarker: { createFromOptions: vi.fn() }, HandLandmarker: { createFromOptions: vi.fn() },
}))
const files = { wasmLoaderPath: '/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm' }
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks() })

it('falls back only the failing model and preserves its GPU error', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const poseModel = { close: vi.fn() } as unknown as PoseLandmarker
  const handModel = { close: vi.fn() } as unknown as HandLandmarker
  vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValue(poseModel)
  vi.mocked(HandLandmarker.createFromOptions).mockRejectedValueOnce(new Error('WebGL context unavailable')).mockResolvedValueOnce(handModel)
  expect(await initializePose(files)).toEqual({ model: poseModel, delegate: 'GPU', gpuError: null })
  expect(await initializeHand(files)).toEqual({ model: handModel, delegate: 'CPU', gpuError: 'WebGL context unavailable' })
  expect(vi.mocked(HandLandmarker.createFromOptions).mock.calls.map(call => call[1].baseOptions?.delegate)).toEqual(['GPU', 'CPU'])
  expect(PoseLandmarker.createFromOptions).toHaveBeenCalledTimes(1)
})

it('uses explicit CPU for a baseline without trying GPU', async () => {
  vi.mocked(PoseLandmarker.createFromOptions).mockResolvedValue({} as PoseLandmarker)
  expect((await initializePose(files, false)).delegate).toBe('CPU')
  expect(PoseLandmarker.createFromOptions).toHaveBeenCalledTimes(1)
  expect(PoseLandmarker.createFromOptions).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' } }))
})

it('reports both exact initialization errors when fallback also fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(HandLandmarker.createFromOptions).mockRejectedValueOnce(new Error('GPU failure')).mockRejectedValueOnce(new Error('CPU failure'))
  await expect(initializeHand(files)).rejects.toThrow('Hand initialization failed. GPU: GPU failure. CPU: CPU failure')
})

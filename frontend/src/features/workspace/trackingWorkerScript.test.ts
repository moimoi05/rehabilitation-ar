import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual classic worker script with isolated fake models. We only
// inject models because its real initialization dynamically imports MediaPipe.
function workerHarness(pose: unknown, hand: unknown, role = 'both') {
  const messages: unknown[] = []
  const scope: { onmessage?: (event: unknown) => Promise<void>; postMessage: (value: unknown) => void } = {
    postMessage: value => { messages.push(value) },
  }
  const source = readFileSync('public/tracking-worker.js', 'utf8')
  const injected: { setModels?: (p: unknown, h: unknown) => void } = {}
  runInNewContext(`${source}\n;globalThis.setModels = (p, h, r) => { pose = p; hand = h; role = r }`, { self: scope, performance: { now: () => 10 }, globalThis: injected })
  ;(injected.setModels as (p: unknown, h: unknown, r: string) => void)(pose, hand, role)
  return { scope, messages }
}

describe('classic tracking worker', () => {
  it('attempts GPU independently and reports the exact Hand fallback error', async () => {
    const messages: unknown[] = []
    const poseCreate = vi.fn(async () => ({ close: vi.fn() }))
    const handCreate = vi.fn(async (_files, options) => {
      if (options.baseOptions.delegate === 'GPU') throw new Error('Hand WebGL unavailable')
      return { close: vi.fn() }
    })
    const scope: { onmessage?: (event: unknown) => Promise<void>; postMessage: (value: unknown) => void } = { postMessage: value => { messages.push(value) } }
    const fakeImport = async () => ({ FilesetResolver: { forVisionTasks: async () => ({}) }, PoseLandmarker: { createFromOptions: poseCreate }, HandLandmarker: { createFromOptions: handCreate } })
    const source = readFileSync('public/tracking-worker.js', 'utf8').replace('await import(data.moduleUrl)', 'await fakeImport(data.moduleUrl)')
    runInNewContext(source, { self: scope, fakeImport, Error, OffscreenCanvas: class {} })
    await scope.onmessage!({ data: { type: 'init', handEnabled: true, preferGpu: true, moduleUrl: '/vision.mjs' } })
    expect(messages[0]).toEqual({ type: 'ready', delegates: { pose: 'GPU', hand: 'CPU' }, initializationErrors: ['Hand GPU: Hand WebGL unavailable'] })
    expect(poseCreate).toHaveBeenCalledOnce()
    expect(handCreate).toHaveBeenCalledTimes(2)
  })
  it('does not infer Pose on a Hand-only scheduled frame and preserves complete raw Hand output', async () => {
    const pose = { detectForVideo: vi.fn() }, landmarks = Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: .5, z: -.1 }))
    const handedness = [[{ categoryName: 'Left', score: .9 }]], worldLandmarks = [[{ x: 1, y: 2, z: 3 }]]
    const hand = { detectForVideo: vi.fn(() => ({ landmarks: [landmarks], handedness, worldLandmarks })) }
    const { scope, messages } = workerHarness(pose, hand)
    const bitmap = { close: vi.fn() }
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap, timestamp: 10, hand: true, pose: false } })
    expect(messages[0]).toMatchObject({ type: 'result', poseProcessed: false, handProcessed: true, poseInferenceMs: null, hands: [landmarks], handedness, handWorldLandmarks: worldLandmarks })
    expect(pose.detectForVideo).not.toHaveBeenCalled()
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it.each([
    { role: 'pose', handEnabled: true, expectedPose: 1, expectedHand: 0 },
    { role: 'hand', handEnabled: false, expectedPose: 0, expectedHand: 1 },
    { role: 'both', handEnabled: true, expectedPose: 1, expectedHand: 1 },
    { role: 'both', handEnabled: false, expectedPose: 1, expectedHand: 0 },
    { role: undefined, handEnabled: false, expectedPose: 1, expectedHand: 0 },
  ])('initializes only the models selected by role $role', async ({ role, handEnabled, expectedPose, expectedHand }) => {
    const messages: unknown[] = [], poseCreate = vi.fn(async () => ({})), handCreate = vi.fn(async () => ({}))
    const scope: { onmessage?: (event: unknown) => Promise<void>; postMessage: (value: unknown) => void } = { postMessage: value => { messages.push(value) } }
    const fakeImport = async () => ({ FilesetResolver: { forVisionTasks: async () => ({}) }, PoseLandmarker: { createFromOptions: poseCreate }, HandLandmarker: { createFromOptions: handCreate } })
    const source = readFileSync('public/tracking-worker.js', 'utf8').replace('await import(data.moduleUrl)', 'await fakeImport(data.moduleUrl)')
    runInNewContext(source, { self: scope, fakeImport })
    await scope.onmessage!({ data: { type: 'init', role, handEnabled, moduleUrl: '/vision.mjs' } })
    expect(messages[0]).toMatchObject({ type: 'ready' })
    expect(poseCreate).toHaveBeenCalledTimes(expectedPose); expect(handCreate).toHaveBeenCalledTimes(expectedHand)
  })
  it('rejects an unknown worker role before initializing any model', async () => {
    const messages: unknown[] = [], fakeImport = vi.fn()
    const scope: { onmessage?: (event: unknown) => Promise<void>; postMessage: (value: unknown) => void } = { postMessage: value => { messages.push(value) } }
    const source = readFileSync('public/tracking-worker.js', 'utf8').replace('await import(data.moduleUrl)', 'await fakeImport(data.moduleUrl)')
    runInNewContext(source, { self: scope, fakeImport })
    await scope.onmessage!({ data: { type: 'init', role: 'other', handEnabled: true, moduleUrl: '/vision.mjs' } })
    expect(messages[0]).toMatchObject({ type: 'error', message: expect.stringContaining('Unknown tracking worker role') })
    expect(fakeImport).not.toHaveBeenCalled()
  })
  it('runs a hand-only frame without a Pose model and closes its bitmap', async () => {
    const hand = { detectForVideo: vi.fn(() => ({ landmarks: [[{ x: .4, y: .5 }]] })) }
    const { scope, messages } = workerHarness(null, hand, 'hand')
    const bitmap = { close: vi.fn() }
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap, timestamp: 10, hand: false } })
    expect(messages[0]).toMatchObject({ type: 'result', id: 1, pose: [], hands: [[{ x: .4, y: .5 }]] })
    expect(hand.detectForVideo).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('reports hand-only inference failure as fatal and closes its bitmap', async () => {
    const hand = { detectForVideo: vi.fn(() => { throw new Error('hand-only failed') }), close: vi.fn() }
    const { scope, messages } = workerHarness(null, hand, 'hand')
    const bitmap = { close: vi.fn() }
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap, timestamp: 10, hand: true } })
    expect(messages[0]).toMatchObject({ type: 'error', message: expect.stringContaining('hand-only failed') })
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
  it('disables a failing Hand while returning Pose and closing every frame', async () => {
    const model = { detectForVideo: vi.fn(() => ({ landmarks: [[{ x: .2, y: .3 }]] })) }
    const hand = { detectForVideo: vi.fn(() => { throw new Error('hand failed') }), close: vi.fn() }
    const { scope, messages } = workerHarness(model, hand)
    const first = { close: vi.fn() }, second = { close: vi.fn() }
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap: first, timestamp: 10, hand: true } })
    await scope.onmessage!({ data: { type: 'frame', id: 2, bitmap: second, timestamp: 20, hand: true } })
    expect(messages[0]).toMatchObject({ type: 'result', id: 1, pose: [{ x: .2, y: .3 }], hands: [], handFailed: true })
    expect(messages[1]).toMatchObject({ type: 'result', id: 2, pose: [{ x: .2, y: .3 }], hands: [], handFailed: true, handError: expect.stringContaining('hand failed'), handProcessed: false })
    expect(hand.detectForVideo).toHaveBeenCalledOnce(); expect(hand.close).toHaveBeenCalledOnce()
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce()
  })

  it('reports Pose failures as fatal and closes the bitmap', async () => {
    const model = { detectForVideo: vi.fn(() => { throw new Error('pose failed') }) }
    const { scope, messages } = workerHarness(model, null)
    const bitmap = { close: vi.fn() }
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap, timestamp: 10, hand: false } })
    expect(messages[0]).toMatchObject({ type: 'error', message: expect.stringContaining('pose failed') })
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('returns the Hand failure even if the failed model cannot be closed', async () => {
    const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[{ x: .2, y: .3 }]] })) }
    const hand = { detectForVideo: vi.fn(() => { throw new Error('hand failed') }), close: vi.fn(() => { throw new Error('close failed') }) }
    const { scope, messages } = workerHarness(pose, hand)
    const bitmap = { close: vi.fn() }
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap, timestamp: 10, hand: true } })
    expect(messages[0]).toMatchObject({ type: 'result', handFailed: true, handCleanupFailed: true, hands: [] })
    expect(hand.close).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce()
  })
})

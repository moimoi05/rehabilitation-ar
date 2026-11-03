import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual classic worker script with isolated fake models. We only
// inject models because its real initialization dynamically imports MediaPipe.
function workerHarness(pose: unknown, hand: unknown, role = 'both') {
  const messages: Record<string, unknown>[] = []
  const scope: { onmessage?: (event: { data: Record<string, unknown> }) => Promise<void>; postMessage: (value: Record<string, unknown>) => void } = {
    postMessage: value => { messages.push(value) },
  }
  const source = readFileSync('public/tracking-worker.js', 'utf8')
  const injected: { setModels?: (p: unknown, h: unknown, r: string) => void } = {}
  runInNewContext(`${source}\n;globalThis.setModels = (p, h, r) => { pose = p; hand = h; role = r }`, { self: scope, performance: { now: () => 10 }, globalThis: injected })
  ;(injected.setModels as (p: unknown, h: unknown, r: string) => void)(pose, hand, role)
  return { scope, messages }
}

describe('classic tracking worker', () => {
  it('echoes explicit source identity on Hand, Pose, and completion without duplicate landmark messages', async () => {
    const hand = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })) }
    const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })) }
    const { scope, messages } = workerHarness(pose, hand)
    const identity = { requestId: 17, sourceFrameId: 8, sourceMediaTimeMs: 266.6, sourcePerformanceMs: 400 }
    await scope.onmessage!({ data: { type: 'frame', id: 17, ...identity, bitmap: { close: vi.fn() }, timestamp: 400, hand: true } })
    expect(messages.map(message => message.type)).toEqual(['hand_result', 'pose_result', 'frame_complete'])
    for (const message of messages) expect(message).toMatchObject(identity)
    expect(messages[2]).not.toHaveProperty('hands')
    expect(messages[2]).not.toHaveProperty('pose')
  })

  it('does not acknowledge disposal until model initialization finishes', async () => {
    const messages: Record<string, unknown>[] = []
    let finishModel!: (value: { close: () => void }) => void
    let markCreating!: () => void
    const creating = new Promise<void>(resolve => { markCreating = resolve })
    const model = { close: vi.fn() }
    const poseCreate = vi.fn(() => new Promise(resolve => { finishModel = resolve; markCreating() }))
    const scope: { onmessage?: (event: unknown) => Promise<void>; postMessage: (value: Record<string, unknown>) => void } = { postMessage: value => { messages.push(value) } }
    const fakeImport = async () => ({ FilesetResolver: { forVisionTasks: async () => ({}) }, PoseLandmarker: { createFromOptions: poseCreate }, HandLandmarker: {} })
    const source = readFileSync('public/tracking-worker.js', 'utf8').replace('await import(data.moduleUrl)', 'await fakeImport(data.moduleUrl)')
    runInNewContext(source, { self: scope, fakeImport })
    const initializing = scope.onmessage!({ data: { type: 'init', handEnabled: false, moduleUrl: '/vision.mjs' } })
    await creating
    expect(poseCreate).toHaveBeenCalledOnce()
    const disposing = scope.onmessage!({ data: { type: 'dispose' } })
    await Promise.resolve()
    expect(messages.some(message => message.type === 'disposed')).toBe(false)
    finishModel(model)
    await initializing; await disposing
    expect(model.close).toHaveBeenCalledOnce()
    expect(messages.at(-1)).toMatchObject({ type: 'disposed', cleanupErrors: [] })
  })

  it('reports a previously failed Hand close again during final disposal', async () => {
    const hand = { detectForVideo: vi.fn(() => { throw new Error('hand failed') }), close: vi.fn(() => { throw new Error('Hand close failed') }) }
    const pose = { detectForVideo: vi.fn(() => ({ landmarks: [[]] })), close: vi.fn() }
    const { scope, messages } = workerHarness(pose, hand)
    await scope.onmessage!({ data: { type: 'frame', id: 1, bitmap: { close: vi.fn() }, timestamp: 10, hand: true } })
    await scope.onmessage!({ data: { type: 'dispose' } })
    expect(messages.at(-1)).toMatchObject({ type: 'disposed', cleanupErrors: [expect.stringContaining('Hand close failed')] })
  })
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
    const handMsg = messages.find(m => m.type === 'hand_result')
    expect(handMsg).toMatchObject({ type: 'hand_result', handProcessed: true, hands: [landmarks], handedness, handWorldLandmarks: worldLandmarks })
    const frameCompleteMsg = messages.find(m => m.type === 'frame_complete')
    expect(frameCompleteMsg).toMatchObject({ type: 'frame_complete', poseProcessed: false, handProcessed: true, poseInferenceMs: null })
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
    const handMsg = messages.find(m => m.type === 'hand_result')
    expect(handMsg).toMatchObject({ type: 'hand_result', id: 1, hands: [[{ x: .4, y: .5 }]] })
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
    const handResults = messages.filter(m => m.type === 'hand_result')
    expect(handResults[0]).toMatchObject({ type: 'hand_result', id: 1, hands: [], handFailed: true })
    expect(handResults[1]).toMatchObject({ type: 'hand_result', id: 2, hands: [], handFailed: true, handError: expect.stringContaining('hand failed'), handProcessed: false })
    const poseResults = messages.filter(m => m.type === 'pose_result')
    expect(poseResults[0]).toMatchObject({ type: 'pose_result', id: 1, pose: [{ x: .2, y: .3 }] })
    expect(poseResults[1]).toMatchObject({ type: 'pose_result', id: 2, pose: [{ x: .2, y: .3 }] })
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
    const handMsg = messages.find(m => m.type === 'hand_result')
    expect(handMsg).toMatchObject({ type: 'hand_result', handFailed: true, handCleanupFailed: true, hands: [] })
    expect(hand.close).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce()
  })
})

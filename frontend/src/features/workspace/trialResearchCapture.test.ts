import { expect, it, vi } from 'vitest'
import { createTrialResearchCapture } from './trialResearchCapture'

it('continues gameplay when research cannot start and reports the capture failure', async () => {
  const failure = vi.fn(), stop = vi.fn()
  const lifecycle = createTrialResearchCapture({ getScope: () => null, gameStarted: vi.fn(), stop }, {
    prepare: async () => { throw new Error('network unavailable') }, beforeStop: vi.fn(), unavailable: failure,
  })
  await expect(lifecycle.prepare(42, 'glowing_flower')).resolves.toBeUndefined()
  lifecycle.started(100); lifecycle.stopped('completed', 200)
  expect(failure).toHaveBeenCalledWith('network unavailable')
  expect(stop).not.toHaveBeenCalled()
})

it('flushes once before stopping and never lets an old round stop the next capture', async () => {
  let scope = 'first'
  const order: string[] = []
  const port = { getScope: () => scope, gameStarted: vi.fn(), stop: vi.fn(async (_reason: string, _timestamp: number, settle?: () => Promise<void>) => { await settle?.(); order.push('stop') }) }
  const lifecycle = createTrialResearchCapture(port, { prepare: async () => 'first', beforeStop: () => order.push('flush'), unavailable: vi.fn() })
  await lifecycle.prepare(42, 'free_drawing')
  lifecycle.started(100)
  expect(port.gameStarted).toHaveBeenCalledWith(100)
  lifecycle.stopped('cancelled', 150); lifecycle.stopped('unmounted', 160)
  await vi.waitFor(() => expect(order).toEqual(['flush', 'stop']))
  expect(order).toEqual(['flush', 'stop'])
  scope = 'second'; lifecycle.started(200)
  expect(port.gameStarted).toHaveBeenCalledOnce()
})

it('closes only its own capture when preparation finishes after cancellation', async () => {
  let ready!: (id: string) => void
  const port = { getScope: () => 'late', gameStarted: vi.fn(), stop: vi.fn(async () => {}) }
  const lifecycle = createTrialResearchCapture(port, { prepare: () => new Promise(resolve => { ready = resolve }), beforeStop: vi.fn(), unavailable: vi.fn() })
  const pending = lifecycle.prepare(42, 'free_drawing')
  lifecycle.stopped('context_changed', 100)
  ready('late'); await pending
  expect(port.stop).toHaveBeenCalledWith('context_changed', 100, expect.any(Function))
  lifecycle.started(200)
  expect(port.gameStarted).not.toHaveBeenCalled()
})

it('forwards the task snapshot selected by the game at preparation time', async () => {
  const prepare = vi.fn(async () => null)
  const lifecycle = createTrialResearchCapture({ getScope: () => null, gameStarted: vi.fn(), stop: vi.fn() }, { prepare, beforeStop: vi.fn(), unavailable: vi.fn() })
  await lifecycle.prepare(42, 'free_drawing', { mode: 'assisted', cursor_source: 'wrist' })
  expect(prepare).toHaveBeenCalledWith(42, 'free_drawing', { mode: 'assisted', cursor_source: 'wrist' })
})

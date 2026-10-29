import { expect, test } from '@playwright/test'

// Uses synthetic bitmaps and fake models; does not access cameras, video or the database.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('classic Worker keeps Pose running when optional Hand inference fails', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: {} }))
  await page.route('**/__worker_fixture__', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Worker test</title>' }))
  await page.route('**/__fake_mediapipe__.mjs', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `
      const originalClose = ImageBitmap.prototype.close;
      ImageBitmap.prototype.close = function () { originalClose.call(this); self.postMessage({ type: 'bitmap-closed' }); };
      let poseCalls = 0, handCalls = 0;
      export const FilesetResolver = { forVisionTasks: async () => ({}) };
      export const PoseLandmarker = { createFromOptions: async () => ({
        detectForVideo() { if (++poseCalls === 4) throw new Error('synthetic pose failure'); return { landmarks: [[{x: poseCalls, y: 0.5}]] }; }
      }) };
      export const HandLandmarker = { createFromOptions: async () => ({
        detectForVideo() { self.postMessage({ type: 'hand-call', count: ++handCalls }); if (handCalls === 2) throw new Error('synthetic hand failure'); return { landmarks: [[{x: 0.5, y: 0.5}]] }; },
        close() { self.postMessage({ type: 'hand-closed' }); }
      }) };
    `,
  }))
  await page.goto('/__worker_fixture__')
  const observed = await page.evaluate(async () => {
    const worker = new Worker('/tracking-worker.js')
    const events: Array<Record<string, unknown>> = []
    let wake: (() => void) | undefined
    worker.onmessage = event => { events.push(event.data); wake?.(); wake = undefined }
    const waitFor = async (predicate: (event: Record<string, unknown>) => boolean) => {
      const deadline = Date.now() + 10_000
      while (!events.some(predicate)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`Worker response timeout; events: ${JSON.stringify(events)}`)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { wake = undefined; reject(new Error('Worker response timed out')) }, remaining)
          wake = () => { clearTimeout(timeout); resolve() }
        })
      }
    }
    try {
      worker.postMessage({ type: 'init', moduleUrl: `${location.origin}/__fake_mediapipe__.mjs`, handEnabled: true })
      await waitFor(event => event.type === 'ready' || event.type === 'error')
      for (let id = 1; id <= 4; id++) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4
        const bitmap = await createImageBitmap(canvas)
        worker.postMessage({ type: 'frame', id, timestamp: id * 33, hand: true, bitmap }, [bitmap])
        await waitFor(event => (event.type === 'result' && event.id === id) || event.type === 'error')
        await waitFor(() => events.filter(event => event.type === 'bitmap-closed').length >= id)
      }
      return events
    } finally { worker.terminate() }
  })

  const results = observed.filter(event => event.type === 'result')
  expect(results).toHaveLength(3)
  expect(results[0]).toMatchObject({ id: 1, pose: [{ x: 1 }], hands: [[{ x: 0.5 }]] })
  expect(results[1]).toMatchObject({ id: 2, pose: [{ x: 2 }], hands: [], handFailed: true })
  expect(results[2]).toMatchObject({ id: 3, pose: [{ x: 3 }], hands: null })
  expect(results.filter(event => event.handFailed === true)).toHaveLength(1)
  expect(observed.filter(event => event.type === 'hand-call')).toHaveLength(2)
  expect(observed.filter(event => event.type === 'hand-closed')).toHaveLength(1)
  expect(observed.filter(event => event.type === 'bitmap-closed')).toHaveLength(4)
  expect(observed.filter(event => event.type === 'error')).toHaveLength(1)
  expect(observed.find(event => event.type === 'error')).toMatchObject({ message: expect.stringContaining('synthetic pose failure') })
})

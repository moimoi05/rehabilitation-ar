import { expect, test } from '@playwright/test'

// Uses Chromium's fake camera and records no frames, screenshots, or landmarks.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('Workspace Auto runs two independent Workers and releases them', async ({ page }) => {
  test.setTimeout(120_000)
  const base = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('This test requires a localhost origin')
  await page.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(`${base.origin}/api/`)) return route.fulfill({ status: 200, json: [] })
    if (url.startsWith(`${base.origin}/`) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue()
    return route.abort()
  })
  await page.addInitScript(() => {
    localStorage.removeItem('rehab.settings')
    localStorage.removeItem('rehab.workerTracking')
    const events: Array<{ role: string; type: string }> = []
    Object.assign(window, { autoWorkspaceEvents: events })
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      private role = ''
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', event => events.push({ role: this.role, type: String(event.data.type) }))
      }
      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'init' && 'role' in message) this.role = String(message.role)
        super.postMessage(message, transferOrOptions as Transferable[])
      }
    }
  })
  let closed = 0
  page.on('worker', worker => worker.on('close', () => { closed++ }))
  await page.goto('/workspace')
  await page.getByLabel('Theo dõi 21 mốc bàn tay').check()
  await page.getByLabel('Sử dụng hai Worker CPU (thử nghiệm)').check()
  const auto = page.getByLabel('Tự điều chỉnh nhịp hai Worker (thử nghiệm)')
  await expect(auto).toBeChecked()
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await expect(auto).toBeDisabled()
  await expect(page.getByText(/Giới hạn tự điều chỉnh Pose/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { autoWorkspaceEvents: Array<{ role: string; type: string }> }).autoWorkspaceEvents), { timeout: 30_000 }).toEqual(expect.arrayContaining([
    { role: 'pose', type: 'ready' }, { role: 'hand', type: 'ready' }, { role: 'pose', type: 'result' }, { role: 'hand', type: 'result' },
  ]))
  await page.getByRole('button', { name: 'Tắt camera' }).click()
  await expect.poll(() => page.workers().length).toBe(0)
  await expect.poll(() => closed).toBe(2)
})

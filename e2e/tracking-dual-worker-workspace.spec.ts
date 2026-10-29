import { expect, test } from '@playwright/test'

// This test uses Chromium's fake camera. Never save camera frames or landmarks.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('Workspace runs separate Pose and Hand Workers and preserves the ghost', async ({ page }) => {
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
    Object.assign(window, { dualWorkspaceEvents: events })
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      private role = ''
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', event => events.push({ role: this.role, type: String(event.data.type) }))
        this.addEventListener('error', () => events.push({ role: this.role, type: 'error' }))
      }
      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'init' && 'role' in message) this.role = String(message.role)
        super.postMessage(message, transferOrOptions as Transferable[])
      }
    }
  })
  let created = 0, closed = 0
  page.on('worker', worker => { created++; worker.on('close', () => { closed++ }) })
  await page.goto('/workspace')
  const dual = page.getByLabel('Sử dụng hai Worker CPU (thử nghiệm)')
  await expect(dual).toBeDisabled()
  await page.getByLabel('Theo dõi 21 mốc bàn tay').check()
  await expect(dual).toBeEnabled()
  await dual.check()
  await page.getByLabel('Hiển thị mốc vận động').uncheck()
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeEnabled()
  await page.locator('.workspace-image video').evaluate(video => {
    Object.assign(window, { dualCameraTrack: (video as HTMLVideoElement).srcObject instanceof MediaStream ? (video as HTMLVideoElement).srcObject!.getVideoTracks()[0] : null })
  })
  const overlay = page.getByLabel('Lớp phủ hiệu chuẩn và mốc vận động')
  const centerAlpha = () => overlay.evaluate(canvas => {
    const element = canvas as HTMLCanvasElement
    return element.getContext('2d')!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data[3]
  })
  await expect.poll(centerAlpha).toBeGreaterThan(0)
  await page.getByLabel('Hiển thị hình bóng').uncheck()
  await expect.poll(centerAlpha).toBe(0)
  await page.getByLabel('Hiển thị hình bóng').check()
  await expect.poll(centerAlpha).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('CPU · hai Worker', { exact: true })).toBeVisible()
  await expect(dual).toBeDisabled()
  await expect.poll(() => page.workers().length).toBe(2)
  await expect.poll(() => page.evaluate(() => (window as unknown as { dualWorkspaceEvents: Array<{ role: string; type: string }> }).dualWorkspaceEvents), { timeout: 30_000 }).toEqual(expect.arrayContaining([
    { role: 'pose', type: 'ready' }, { role: 'hand', type: 'ready' }, { role: 'pose', type: 'result' }, { role: 'hand', type: 'result' },
  ]))
  await expect.poll(centerAlpha).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Tắt camera' }).click()
  await expect.poll(() => page.workers().length).toBe(0)
  await expect.poll(() => closed).toBe(2)
  expect(created).toBe(2)
  await expect.poll(() => page.evaluate(() => (window as unknown as { dualCameraTrack: MediaStreamTrack | null }).dualCameraTrack?.readyState)).toBe('ended')
  await expect(page.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
  await expect.poll(centerAlpha).toBeGreaterThan(0)
})

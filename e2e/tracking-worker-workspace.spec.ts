import { expect, test } from '@playwright/test'

// Fake camera; do not capture images or patient records in test artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: [] }))
  await page.addInitScript(() => {
    localStorage.setItem('rehab.workerTracking', 'enabled')
    const events: string[] = []
    Object.assign(window, { workerProbeEvents: events })
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', event => events.push(event.data.type))
        this.addEventListener('error', () => events.push('error'))
      }
    }
  })
})

test('production worker processes camera frames and is stopped with the camera', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/workspace')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  const start = page.getByRole('button', { name: 'Bắt đầu nhận diện' })
  await expect(start).toBeEnabled()
  await start.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { workerProbeEvents: string[] }).workerProbeEvents), { timeout: 60_000 }).toContain('ready')
  await expect.poll(() => page.evaluate(() => (window as unknown as { workerProbeEvents: string[] }).workerProbeEvents), { timeout: 30_000 }).toContain('result')
  await page.getByRole('button', { name: 'Toàn màn hình', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  const videoBox = await page.locator('.workspace-image video').boundingBox()
  const overlayBox = await page.getByLabel('Lớp phủ hiệu chuẩn và mốc vận động').boundingBox()
  expect(videoBox).not.toBeNull(); expect(overlayBox).not.toBeNull()
  expect(overlayBox!.x).toBeCloseTo(videoBox!.x, 0); expect(overlayBox!.y).toBeCloseTo(videoBox!.y, 0)
  expect(overlayBox!.width).toBeCloseTo(videoBox!.width, 0); expect(overlayBox!.height).toBeCloseTo(videoBox!.height, 0)
  await page.getByRole('button', { name: 'Thoát toàn màn hình' }).click()
  await page.getByRole('button', { name: 'Tắt camera' }).click()
  await expect(page.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeDisabled()
})

test('falls back to the main thread if the worker script is blocked', async ({ page }) => {
  test.setTimeout(90_000)
  await page.route('**/tracking-worker.js', route => route.abort('blockedbyclient'))
  await page.goto('/workspace')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  const start = page.getByRole('button', { name: 'Bắt đầu nhận diện' })
  await expect(start).toBeEnabled(); await start.click()
  await expect(page.getByRole('status').filter({ hasText: /Worker không khả dụng/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 60_000 })
})

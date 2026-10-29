import { existsSync } from 'node:fs'
import { test, expect } from '@playwright/test'

// The selected video remains local and no test media or landmarks are saved.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('runs Pose and Hand in two bounded Workers and releases both', async ({ page }) => {
  const videoPath = process.env.TRACKING_VIDEO_PATH
  test.skip(!videoPath || !existsSync(videoPath), 'Set TRACKING_VIDEO_PATH to an accessible local video')
  test.setTimeout(120_000)
  const baseURL = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseURL.hostname)) throw new Error('This privacy-sensitive test requires a localhost origin')
  const origin = baseURL.origin
  await page.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
    if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = value => {
      if (value instanceof Blob && value.type === 'application/json') {
        void value.text().then(text => { Object.assign(window, { dualBenchmarkExport: text }) })
      }
      return create(value)
    }
    HTMLAnchorElement.prototype.click = function () {
      if (this.download === 'tracking-benchmark.json') return
      return click.call(this)
    }
  })
  const events = { created: 0, closed: 0 }
  page.on('worker', worker => { events.created++; worker.on('close', () => events.closed++) })

  await page.goto('/tracking-lab')
  const dual = page.getByLabel('Hai Worker CPU (thử nghiệm)')
  await expect(dual).toBeDisabled()
  await page.getByLabel('Hand (21 mốc)').check()
  await expect(dual).toBeEnabled()
  await dual.check()
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
  await video.evaluate(element => element.pause())
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await expect(dual).toBeDisabled()
  await expect.poll(() => page.workers().length).toBe(2)
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await video.evaluate(element => element.play())
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
    return page.evaluate(() => {
      const text = (window as unknown as { dualBenchmarkExport?: string }).dualBenchmarkExport
      if (!text) return false
      const report = JSON.parse(text)
      return report.engine === 'parallel' && report.dualPose?.inferenceFps > 0 && report.dualHand?.inferenceFps > 0
    })
  }, { timeout: 30_000, intervals: [1000] }).toBe(true)

  await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
  await expect.poll(() => page.workers().length).toBe(0)
  await expect.poll(() => events.closed).toBe(2)
  expect(events.created).toBe(2)
  await expect(page.getByRole('button', { name: 'Bắt đầu đo' })).toBeDisabled()
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  await expect(video).not.toHaveAttribute('src')
})

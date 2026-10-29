import { existsSync } from 'node:fs'
import { test, expect } from '@playwright/test'

// The video stays local. Opt in explicitly and never capture frames in test artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('processes a local video and releases it on restart and close', async ({ page }) => {
  const videoPath = process.env.TRACKING_VIDEO_PATH
  test.skip(!videoPath || !existsSync(videoPath), 'Set TRACKING_VIDEO_PATH to an accessible local video')
  test.setTimeout(120_000)

  // The lab should not need the backend; intercept every API request to guarantee
  // that this test cannot read or write a real patient database.
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: {} }))
  await page.addInitScript(() => {
    const state = { created: 0, revoked: 0 }
    Object.assign(window, { trackingObjectUrls: state })
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = object => { state.created++; return create(object) }
    URL.revokeObjectURL = value => { state.revoked++; revoke(value) }
  })

  await page.goto('/tracking-lab')
  await expect(page.getByRole('heading', { name: 'Tracking Test Lab' })).toBeVisible()
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
  await video.evaluate(element => element.pause())
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await video.evaluate(element => element.play())
  const inferenceFps = page.locator('.tracking-stats div').filter({ has: page.getByText('FPS suy luận', { exact: true }) }).locator('dd')
  await expect.poll(async () => Number(await inferenceFps.textContent()), { timeout: 30_000 }).toBeGreaterThan(0)

  await video.evaluate(element => { element.currentTime = 0 })
  await expect(page.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bắt đầu đo' })).toBeVisible()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Phát lại từ đầu' }).click()
  await expect(page.getByRole('button', { name: 'Bắt đầu nhận diện' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bắt đầu đo' })).toBeVisible()
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { trackingObjectUrls: { revoked: number } }).trackingObjectUrls.revoked)).toBeGreaterThanOrEqual(1)
  await expect(video).not.toHaveAttribute('src')
  // Selecting the same local file again must work without manually clearing the input.
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  await expect.poll(() => page.evaluate(() => (window as unknown as { trackingObjectUrls: { created: number } }).trackingObjectUrls.created)).toBeGreaterThanOrEqual(2)
  await expect(video).toHaveAttribute('src', /^blob:/)
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { trackingObjectUrls: { revoked: number } }).trackingObjectUrls.revoked)).toBeGreaterThanOrEqual(2)
})

test('keeps the landmark aligned for contain, cover and mirroring in a square preview', async ({ page }) => {
  const videoPath = process.env.TRACKING_VIDEO_PATH
  test.skip(!videoPath || !existsSync(videoPath), 'Set TRACKING_VIDEO_PATH to an accessible local video')
  test.setTimeout(120_000)
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: {} }))
  await page.addInitScript(() => {
    const state: { point: { x: number; y: number } | null } = { point: null }
    Object.assign(window, { overlayProbe: state })
    const clear = CanvasRenderingContext2D.prototype.clearRect
    const arc = CanvasRenderingContext2D.prototype.arc
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'Landmark overlay') state.point = null
      return clear.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'Landmark overlay' && !state.point) state.point = { x: args[0], y: args[1] }
      return arc.apply(this, args)
    }
  })
  await page.goto('/tracking-lab')
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { overlayProbe: { point: unknown } }).overlayProbe.point), { timeout: 30_000 }).not.toBeNull()
  const observed = await page.evaluate(async () => {
    const v = document.querySelector('video')!
    const stage = v.parentElement!
    const state = (window as unknown as { overlayProbe: { point: { x: number; y: number } | null } }).overlayProbe
    const frames = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) }
    v.pause()
    stage.style.width = '400px'; stage.style.height = '400px'; stage.style.aspectRatio = '1'
    v.style.objectFit = 'fill'; await frames()
    const before = state.point && { ...state.point }
    v.style.objectFit = 'contain'; await frames()
    const after = state.point && { ...state.point }
    v.style.objectFit = 'cover'; await frames()
    const covered = state.point && { ...state.point }
    const mirrorLabel = Array.from(document.querySelectorAll('label')).find(label => label.textContent?.includes('Lật ảnh ngang'))!
    mirrorLabel.querySelector('input')!.click(); await frames()
    const mirrored = state.point && { ...state.point }
    const box = v.getBoundingClientRect()
    return { before, after, covered, mirrored, width: box.width, height: box.height, sourceWidth: v.videoWidth, sourceHeight: v.videoHeight }
  })
  expect(observed.before).not.toBeNull(); expect(observed.after).not.toBeNull()
  const scale = Math.min(observed.width / observed.sourceWidth, observed.height / observed.sourceHeight)
  const imageHeight = observed.sourceHeight * scale
  const imageWidth = observed.sourceWidth * scale
  expect(observed.after!.x).toBeCloseTo((observed.width - imageWidth) / 2 + observed.before!.x * imageWidth / observed.width, 0)
  expect(observed.after!.y).toBeCloseTo((observed.height - imageHeight) / 2 + observed.before!.y * imageHeight / observed.height, 0)
  expect(observed.covered).not.toBeNull(); expect(observed.mirrored).not.toBeNull()
  const coverScale = Math.max(observed.width / observed.sourceWidth, observed.height / observed.sourceHeight)
  const coverWidth = observed.sourceWidth * coverScale, coverHeight = observed.sourceHeight * coverScale
  expect(observed.covered!.x).toBeCloseTo((observed.width - coverWidth) / 2 + observed.before!.x * coverWidth / observed.width, 0)
  expect(observed.covered!.y).toBeCloseTo((observed.height - coverHeight) / 2 + observed.before!.y * coverHeight / observed.height, 0)
  expect(observed.mirrored!.x).toBeCloseTo(observed.width - observed.covered!.x, 0)
  expect(observed.mirrored!.y).toBeCloseTo(observed.covered!.y, 0)
})

test('runs the local video through the experimental Worker and measures it', async ({ page }) => {
  const videoPath = process.env.TRACKING_VIDEO_PATH
  test.skip(!videoPath || !existsSync(videoPath), 'Set TRACKING_VIDEO_PATH to an accessible local video')
  test.setTimeout(120_000)
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: {} }))
  await page.goto('/tracking-lab')
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
  await video.evaluate(element => element.pause())
  await page.getByLabel('Worker CPU (thử nghiệm)').check()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.tracking-stats').getByText(/Pose CPU · Worker/)).toBeVisible()
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await video.evaluate(element => element.play())
  const inferenceFps = page.locator('.tracking-stats div').filter({ has: page.getByText('FPS suy luận', { exact: true }) }).locator('dd')
  await expect.poll(async () => Number(await inferenceFps.textContent()), { timeout: 30_000 }).toBeGreaterThan(0)
  const modelTime = page.locator('.tracking-stats div').filter({ has: page.getByText('Suy luận p50 / p95', { exact: true }) }).locator('dd')
  await expect(modelTime).not.toContainText('—')
  await expect(page.getByText('Worker callback đến kết quả p50 / p95', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Bắt đầu đo' })).toBeDisabled()
})

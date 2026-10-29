import { existsSync } from 'node:fs'
import { test, expect } from '@playwright/test'

// The private video remains local. Do not record test media or save landmark positions.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('draws real Hand Landmarker output in the local-video Lab', async ({ page }) => {
  const videoPath = process.env.TRACKING_VIDEO_PATH
  test.skip(!videoPath || !existsSync(videoPath), 'Set TRACKING_VIDEO_PATH to an accessible local video')
  test.setTimeout(120_000)
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: {} }))
  await page.addInitScript(() => {
    const state = { arcs: 0, currentFrameArcs: 0, maxFrameArcs: 0 }
    Object.assign(window, { handOverlayProbe: state })
    const arc = CanvasRenderingContext2D.prototype.arc
    const clearRect = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'Landmark overlay') state.currentFrameArcs = 0
      return clearRect.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'Landmark overlay') {
        state.arcs++
        state.currentFrameArcs++
        state.maxFrameArcs = Math.max(state.maxFrameArcs, state.currentFrameArcs)
      }
      return arc.apply(this, args)
    }
  })
  await page.goto('/tracking-lab')
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  const video = page.locator('video')
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2)
  await video.evaluate(element => element.pause())
  await page.getByLabel('Pose', { exact: true }).uncheck()
  await page.getByLabel('Hand (21 mốc)').check()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await video.evaluate(element => element.play())
  await expect.poll(() => page.evaluate(() => (window as unknown as { handOverlayProbe: { maxFrameArcs: number } }).handOverlayProbe.maxFrameArcs), { timeout: 30_000 }).toBeGreaterThanOrEqual(21)
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
})

import { expect, test } from '@playwright/test'

// Fake camera and instrumented canvas draw calls; no image artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('keeps Ghost registered across fit changes and requires reconfirmation', async ({ page }) => {
  let saved: Record<string, unknown> | null = null
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }] })
    if (path === '/api/calibrations' && request.method() === 'POST') { saved = request.postDataJSON(); return route.fulfill({ status: 200, json: { id: 1 } }) }
    return route.fulfill({ status: 200, json: [] })
  })
  await page.addInitScript(() => {
    const nativeTranslate = CanvasRenderingContext2D.prototype.translate
    CanvasRenderingContext2D.prototype.translate = function (x: number, y: number) {
      if (this.canvas.getAttribute('aria-label') === 'Lớp phủ hiệu chuẩn và mốc vận động') {
        Object.assign(window, { ghostProbeTranslation: { x, y } })
      }
      return nativeTranslate.call(this, x, y)
    }
  })
  await page.goto('/workspace?sessionId=7')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.getByLabel('Vị trí dọc').fill('0.3')

  const geometry = await page.evaluate(async () => {
    const image = document.querySelector<HTMLElement>('.workspace-image')!
    const video = image.querySelector('video')!
    image.style.width = '800px'; image.style.height = '800px'; image.style.aspectRatio = 'auto'
    const read = async (fit: 'contain' | 'cover') => {
      video.style.objectFit = fit
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const box = video.getBoundingClientRect()
      const scale = (fit === 'contain' ? Math.min : Math.max)(box.width / video.videoWidth, box.height / video.videoHeight)
      const imageHeight = video.videoHeight * scale
      const imageY = (box.height - imageHeight) / 2
      const position = (window as unknown as { ghostProbeTranslation: { x: number; y: number } }).ghostProbeTranslation
      return { boxHeight: box.height, imageHeight, imageY, ghostY: position.y, rawY: (position.y - imageY) / imageHeight }
    }
    return { contain: await read('contain'), cover: await read('cover') }
  })
  const expectedCoverY = geometry.cover.imageY + geometry.contain.rawY * geometry.cover.imageHeight
  console.log(JSON.stringify({ ...geometry, expectedCoverY, driftPixels: geometry.cover.ghostY - expectedCoverY }))
  // The same image point must remain registered after the fit mode changes.
  expect(Math.abs(geometry.cover.ghostY - expectedCoverY)).toBeLessThan(2)
  // A geometry change clears confirmation, so an operator must check again.
  const confirm = page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh')
  await confirm.check()
  await expect(page.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeEnabled()
  await page.getByRole('button', { name: 'Lưu hiệu chuẩn' }).click()
  await expect.poll(() => saved).not.toBeNull()
  expect(Number(saved!.y)).toBeCloseTo(geometry.cover.ghostY / geometry.cover.boxHeight, 3)
  // Mirroring reflects the video point and Ghost together, not just the video.
  await page.getByLabel('Vị trí ngang').fill('0.65')
  await page.getByLabel('Lật ảnh ngang').uncheck()
  await expect.poll(() => page.evaluate(() => (window as unknown as { ghostProbeTranslation: { x: number } }).ghostProbeTranslation.x)).toBeCloseTo(280, 0)
  await expect(confirm).not.toBeChecked()
  await page.getByLabel('Lật ảnh ngang').check()
  await expect.poll(() => page.evaluate(() => (window as unknown as { ghostProbeTranslation: { x: number } }).ghostProbeTranslation.x)).toBeCloseTo(520, 0)
  await confirm.check()
  await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'contain' })
  await expect(confirm).not.toBeChecked()
  // The controls operate on the current displayed geometry, then re-anchor it.
  await page.getByLabel('Vị trí dọc').fill('0.3')
  await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'cover' })
  await expect.poll(() => page.evaluate(() => (window as unknown as { ghostProbeTranslation: { y: number } }).ghostProbeTranslation.y)).toBeLessThan(120)
  // A cropped position is not silently clamped or allowed to be confirmed.
  await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'contain' })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.getByLabel('Vị trí dọc').fill('0.01')
  await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'cover' })
  await expect(page.getByRole('alert')).toContainText('ngoài phạm vi hiệu chuẩn')
  await expect(confirm).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeDisabled()
  await page.getByRole('button', { name: 'Tắt camera' }).click()
})

test('restores legacy box coordinates in their saved mirror state without reflecting twice', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }] })
    if (path === '/api/calibrations') return route.fulfill({ status: 200, json: [{ ghost_visible: true, opacity: .5, x: .2, y: .5, scale: 1, affected_side: 'left', confirmed: true, mirrored: false }] })
    return route.fulfill({ status: 200, json: [] })
  })
  await page.goto('/workspace?sessionId=7')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.getByRole('button', { name: 'Khôi phục cấu hình' }).click()
  await expect(page.getByLabel('Lật ảnh ngang')).not.toBeChecked()
  await expect(page.getByLabel('Vị trí ngang')).toHaveValue('0.2')
  await expect(page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh')).not.toBeChecked()
  await page.getByLabel('Lật ảnh ngang').check()
  await expect(page.getByLabel('Vị trí ngang')).toHaveValue('0.8')
  await page.getByRole('button', { name: 'Tắt camera' }).click()
})

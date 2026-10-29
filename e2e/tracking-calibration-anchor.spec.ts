import { expect, test } from '@playwright/test'

// Fake camera and mocked API; no trace, media artifacts or real database writes.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('restores a versioned image anchor after reload with a different layout', async ({ page }) => {
  const base = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('localhost required')
  let saved: Record<string, unknown> | null = null
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }] })
    if (url.pathname === '/api/capabilities') return route.fulfill({ status: 200, json: { imageAnchorV1: true, status: 'ok' } })
    if (url.pathname === '/api/calibrations' && request.method() === 'POST') { saved = request.postDataJSON(); return route.fulfill({ status: 201, json: { id: 1, ...saved } }) }
    if (url.pathname === '/api/calibrations') return route.fulfill({ status: 200, json: saved ? [{ id: 1, ...saved }] : [] })
    if (url.origin === base.origin || request.url().startsWith('blob:')) return route.continue()
    return route.abort()
  })
  await page.goto('/workspace?sessionId=7')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.locator('.workspace-image').evaluate(element => { const e = element as HTMLElement; e.style.width = '800px'; e.style.height = '800px'; e.style.aspectRatio = 'auto' })
  await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'contain' })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.getByLabel('Vị trí ngang').fill('0.6')
  await page.getByLabel('Vị trí dọc').fill('0.4')
  await page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh').check()
  await page.getByRole('button', { name: 'Lưu hiệu chuẩn' }).click()
  await expect.poll(() => saved).not.toBeNull()
  expect(saved!.image_anchor).toEqual(expect.objectContaining({ version: 1, x: expect.any(Number), y: expect.any(Number), scale: expect.any(Number) }))
  const anchor = saved!.image_anchor as { x: number; y: number; scale: number }
  expect(saved!.camera_device_id).toBeTruthy()

  await page.reload()
  await page.locator('.workspace-image').evaluate(element => { const e = element as HTMLElement; e.style.width = '800px'; e.style.height = '800px'; e.style.aspectRatio = 'auto' })
  await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'cover' })
  // Restoring before camera startup must wait for its actual metadata.
  await page.getByRole('button', { name: 'Khôi phục cấu hình' }).click()
  await expect(page.getByText(/Đã tải thông số/)).toBeVisible()
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await expect(page.getByText(/Đã khôi phục vị trí theo ảnh/)).toBeVisible()
  const expected = await page.locator('.workspace-image video').evaluate((video: HTMLVideoElement, stored) => {
    const box = video.getBoundingClientRect(), scale = Math.max(box.width / video.videoWidth, box.height / video.videoHeight)
    const width = video.videoWidth * scale, height = video.videoHeight * scale
    return { x: ((box.width - width) / 2 + (1 - stored.x) * width) / box.width, y: ((box.height - height) / 2 + stored.y * height) / box.height }
  }, anchor)
  expect(Number(await page.getByLabel('Vị trí ngang').inputValue())).toBeCloseTo(expected.x, 2)
  expect(Number(await page.getByLabel('Vị trí dọc').inputValue())).toBeCloseTo(expected.y, 2)
  await expect(page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh')).not.toBeChecked()
  await page.getByRole('button', { name: 'Tắt camera' }).click()
})

test('saves a legacy calibration once if the backend does not support image anchors', async ({ page }) => {
  const base = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('localhost required')
  const posts: Record<string, unknown>[] = []
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }] })
    if (url.pathname === '/api/capabilities') return route.fulfill({ status: 404 })
    if (url.pathname === '/api/calibrations' && request.method() === 'POST') {
      const body = request.postDataJSON(); posts.push(body)
      return Object.hasOwn(body, 'image_anchor') ? route.fulfill({ status: 422 }) : route.fulfill({ status: 201, json: { id: 1, ...body } })
    }
    if (url.origin === base.origin || request.url().startsWith('blob:')) return route.continue()
    return route.abort()
  })
  await page.goto('/workspace?sessionId=7')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.waitForFunction(() => { const video = document.querySelector('video'); return !!video && video.videoWidth > 0 })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.getByRole('button', { name: 'Lưu hiệu chuẩn' }).click()
  await expect(page.getByRole('status')).toContainText('Không xác nhận được vị trí theo ảnh')
  expect(posts).toHaveLength(1)
  expect(posts[0]).not.toHaveProperty('image_anchor')
  await page.getByRole('button', { name: 'Tắt camera' }).click()
})

test('does not send a stale calibration after the camera changes during capability lookup', async ({ page }) => {
  const base = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('localhost required')
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let capabilityRequests = 0, posts = 0
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }] })
    if (url.pathname === '/api/capabilities') { capabilityRequests++; await pending; return route.fulfill({ status: 200, json: { status: 'ok', imageAnchorV1: true } }) }
    if (url.pathname === '/api/calibrations' && request.method() === 'POST') { posts++; return route.fulfill({ status: 201, json: { id: 1 } }) }
    if (url.origin === base.origin || request.url().startsWith('blob:')) return route.continue()
    return route.abort()
  })
  await page.goto('/workspace?sessionId=7')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.waitForFunction(() => { const video = document.querySelector('video'); return !!video && video.videoWidth > 0 })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.getByRole('button', { name: 'Lưu hiệu chuẩn' }).click()
  await expect.poll(() => capabilityRequests).toBe(1)
  await page.getByRole('button', { name: 'Tắt camera' }).click()
  release()
  await expect(page.getByRole('status')).toContainText('Camera hoặc hiệu chuẩn đã thay đổi')
  expect(posts).toBe(0)
})

for (const change of ['session', 'ghost', 'layout'] as const) {
  test(`does not send stale calibration after ${change} changes during capability lookup`, async ({ page }) => {
    const base = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('localhost required')
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let capabilityRequests = 0, posts = 0
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.pathname === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }, { id: 8, patient_id: 8, affected_side: 'right', status: 'draft' }] })
      if (url.pathname === '/api/capabilities') { capabilityRequests++; await pending; return route.fulfill({ status: 200, json: { status: 'ok', imageAnchorV1: true } }) }
      if (url.pathname === '/api/calibrations' && request.method() === 'POST') { posts++; return route.fulfill({ status: 201, json: { id: 1 } }) }
      if (url.origin === base.origin || request.url().startsWith('blob:')) return route.continue()
      return route.abort()
    })
    await page.goto('/workspace?sessionId=7')
    await page.getByRole('button', { name: 'Bật camera' }).click()
    await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
    await page.waitForFunction(() => { const video = document.querySelector('video'); return !!video && video.videoWidth > 0 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.getByRole('button', { name: 'Lưu hiệu chuẩn' }).click()
    await expect.poll(() => capabilityRequests).toBe(1)
    if (change === 'session') await page.getByLabel('Phiên tập').selectOption('8')
    if (change === 'ghost') await page.getByLabel('Vị trí ngang').fill('0.7')
    if (change === 'layout') {
      await page.locator('.workspace-image').evaluate(element => { const e = element as HTMLElement; e.style.width = '800px'; e.style.height = '800px'; e.style.aspectRatio = 'auto' })
      await page.locator('.workspace-image video').evaluate(video => { (video as HTMLVideoElement).style.objectFit = 'contain' })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    }
    release()
    await expect(page.getByRole('status')).toContainText('Camera hoặc hiệu chuẩn đã thay đổi')
    expect(posts).toBe(0)
    await page.getByRole('button', { name: 'Tắt camera' }).click()
  })
}

test('does not apply image anchors to a different camera', async ({ page }) => {
  const base = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:5173')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('localhost required')
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/sessions') return route.fulfill({ status: 200, json: [{ id: 7, patient_id: 8, affected_side: 'left', status: 'in_progress' }] })
    if (url.pathname === '/api/calibrations') return route.fulfill({ status: 200, json: [{ x: .3, y: .5, scale: 1, ghost_visible: true, opacity: .5, affected_side: 'left', mirrored: true, confirmed: true, camera_device_id: 'another-camera', width: 1280, height: 720, image_anchor: { version: 1, x: .9, y: .2, scale: 1 } }] })
    if (url.origin === base.origin) return route.continue()
    return route.abort()
  })
  await page.goto('/workspace?sessionId=7')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await page.getByRole('button', { name: 'Khôi phục cấu hình' }).click()
  await expect(page.getByText(/Camera hoặc kích thước khác/)).toBeVisible()
  await expect(page.getByLabel('Vị trí ngang')).toHaveValue('0.3')
  await expect(page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh')).not.toBeChecked()
  await page.getByRole('button', { name: 'Tắt camera' }).click()
})

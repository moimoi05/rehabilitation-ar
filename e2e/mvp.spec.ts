import { test, expect } from '@playwright/test'

const api = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8001'

test('hiển thị workspace demo khi không cần camera', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/workspace')
  await page.getByRole('button', { name: 'Chạy demo' }).click()
  await expect(page.getByText('DEMO — KHÔNG PHẢI DỮ LIỆU BỆNH NHÂN')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workspace-demo.png'), fullPage: true })
})

test('tạo hồ sơ và phiên giả lập, hiệu chuẩn camera mô phỏng và khôi phục', async ({ page, request }, testInfo) => {
  const health = await request.get(`${api}/api/health`)
  expect(health.ok()).toBeTruthy()
  expect((await health.json()).database).toBe('connected')

  const code = `E2E-${Date.now()}-${Math.floor(Math.random() * 10000)}`
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Chào mừng trở lại' })).toBeVisible()
  await expect(page.getByText('Hệ thống kết nối')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true })
  await page.goto('/patients')
  await page.getByRole('button', { name: 'Thêm bệnh nhân' }).click()
  const patientForm = page.getByRole('dialog')
  await patientForm.getByLabel('Mã nghiên cứu').fill(code)
  await patientForm.getByLabel('Tay ảnh hưởng').selectOption('right')
  await patientForm.getByRole('button', { name: 'Lưu hồ sơ' }).click()
  await expect(page.getByRole('link', { name: code })).toBeVisible()

  await page.goto('/sessions')
  await page.getByRole('button', { name: 'Tạo phiên mới' }).click()
  const sessionForm = page.getByRole('dialog')
  await sessionForm.getByLabel('Bệnh nhân').selectOption({ label: code })
  await sessionForm.getByLabel('Loại phiên').selectOption('assessment')
  const sessionResponse = page.waitForResponse(response => response.url().endsWith('/api/sessions') && response.request().method() === 'POST')
  await sessionForm.getByRole('button', { name: 'Tạo phiên', exact: true }).click()
  const createdSession = await sessionResponse
  expect(createdSession.ok()).toBeTruthy()
  const session = await createdSession.json()
  await expect(page.getByRole('row').filter({ hasText: code })).toBeVisible()
  await page.getByRole('row').filter({ hasText: code }).getByRole('link', { name: 'Hiệu chuẩn' }).click()

  await expect(page.getByRole('heading', { name: 'Camera & hiệu chuẩn' })).toBeVisible()
  await page.getByRole('button', { name: 'Chạy demo' }).click()
  await expect(page.getByText('DEMO — KHÔNG PHẢI DỮ LIỆU BỆNH NHÂN')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workspace-demo.png'), fullPage: true })
  await expect(page.getByRole('button', { name: 'Lưu hiệu chuẩn' })).toBeDisabled()
  expect((await (await request.get(`${api}/api/calibrations?session_id=${session.id}`)).json())).toHaveLength(0)

  await page.getByRole('button', { name: 'Thoát demo' }).click()
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.getByLabel('Vị trí ngang').fill('0.62')
  await page.getByLabel('Tỷ lệ').fill('1.15')
  await page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh').check()
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/calibrations') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Lưu hiệu chuẩn' }).click()
  const saved = await savedResponse
  expect(saved.ok()).toBeTruthy()
  await expect(page.getByRole('status', { name: 'Thông báo camera và hiệu chuẩn' })).toContainText('Đã lưu cấu hình')
  const records = await (await request.get(`${api}/api/calibrations?session_id=${session.id}`)).json()
  expect(records).toHaveLength(1)
  expect(records[0].x).toBeCloseTo(0.62)
  expect(records[0].scale).toBeCloseTo(1.15)
  expect(records[0].confirmed).toBe(true)

  await page.getByLabel('Vị trí ngang').fill('0.31')
  await page.getByRole('button', { name: 'Khôi phục cấu hình' }).click()
  await expect(page.getByLabel('Vị trí ngang')).toHaveValue('0.62')
  await expect(page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh')).not.toBeChecked()
  await page.getByRole('button', { name: 'Tắt camera' }).click()

  await page.goto('/results')
  await page.getByRole('row').filter({ hasText: code }).getByRole('button', { name: 'Xem hiệu chuẩn' }).click()
  const details = page.getByRole('dialog', { name: 'Hiệu chuẩn đã lưu' })
  await expect(details.getByText('0.62 / 0.50')).toBeVisible()
  await expect(details.getByText('1.15', { exact: true })).toBeVisible()
  await expect(details.getByText('Đã xác nhận', { exact: true })).toBeVisible()
  await details.getByRole('button', { name: 'Đóng' }).click()

  // Terminal states must not be reachable by skipping the active state.
  const invalid = await request.patch(`${api}/api/sessions/${session.id}`, { data: { status: 'completed' } })
  expect(invalid.status()).toBe(409)
  await page.goto('/sessions')
  const status = page.getByLabel(`Trạng thái phiên ${session.id}`)
  await expect(status).toHaveValue('draft')
  const startedResponse = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${session.id}`) && response.request().method() === 'PATCH')
  await status.selectOption('in_progress')
  const started = await startedResponse
  expect(started.ok()).toBeTruthy()
  expect((await started.json()).started_at).toBeTruthy()
  await expect(status).toHaveValue('in_progress')
  const finishedResponse = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${session.id}`) && response.request().method() === 'PATCH')
  await status.selectOption('completed')
  const finished = await finishedResponse
  expect(finished.ok()).toBeTruthy()
  expect((await finished.json()).ended_at).toBeTruthy()
  await expect(status).toBeDisabled()
})

test('khởi tạo Pose và Hand MediaPipe với thiết bị camera mô phỏng', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/workspace')
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.getByLabel('Theo dõi 21 mốc bàn tay').check()
  const poseModel = page.waitForResponse(response => response.url().includes('/models/pose_landmarker_lite.task'))
  const handModel = page.waitForResponse(response => response.url().includes('/models/hand_landmarker.task'))
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  expect((await poseModel).ok()).toBeTruthy()
  expect((await handModel).ok()).toBeTruthy()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 45_000 })
  await expect(page.getByText('Không tải được mô hình bàn tay', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
  await page.getByRole('button', { name: 'Tắt camera' }).click()
})

test('thông báo rõ khi backend không kết nối được', async ({ page }) => {
  await page.route(`${api}/**`, route => route.abort('connectionfailed'))
  await page.goto('/')
  await expect(page.getByText('Không kết nối được backend.', { exact: false })).toBeVisible()
})

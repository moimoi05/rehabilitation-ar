import { test, expect } from '@playwright/test'

const api = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8001'

test('demo chạm hoa và không ghi kết quả', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let writes = 0
  await page.route(`${api}/api/exercise-results`, async route => {
    if (route.request().method() === 'POST') writes += 1
    await route.continue()
  })
  await page.goto('/workspace')
  await page.getByRole('button', { name: 'Chạy demo' }).click()
  await page.getByRole('button', { name: 'Bắt đầu trò chơi' }).click()
  const overlay = page.getByLabel('Vùng chơi demo bằng chuột hoặc chạm')
  await overlay.scrollIntoViewIfNeeded()
  const box = await overlay.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * .35, box!.y + box!.height * .5)
  await expect(page.locator('.flower-score').getByText('1', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('flower-game.png'), fullPage: true })
  await page.getByRole('button', { name: 'Dừng và xem kết quả' }).click()
  await expect(page.getByText('DEMO — kết quả này không được lưu.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Xác nhận lưu kết quả' })).toHaveCount(0)
  expect(writes).toBe(0)
})

test('camera mô phỏng với mốc giả lưu kết quả lượt tập qua PostgreSQL', async ({ page, request }) => {
  test.setTimeout(60_000)
  // Fake model is injected at the browser boundary; no hardware or pose accuracy is claimed.
  await page.route('**/@mediapipe_tasks-vision.js*', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `export const FilesetResolver = { forVisionTasks: async () => ({}) };
      export class PoseLandmarker { static async createFromOptions() { return new PoseLandmarker() }
        detectForVideo() { const landmarks = Array.from({length: 33}, () => ({x: .5, y: .5, visibility: 0}));
          landmarks[15] = {x: .65, y: .5, visibility: 1}; return {landmarks: [landmarks]}; }
        close() {} }
      export class HandLandmarker { static async createFromOptions() { return new HandLandmarker() }
        detectForVideo() { return {landmarks: []} } close() {} }`,
  }))
  const code = `GAME-E2E-${Date.now()}-${Math.floor(Math.random() * 10000)}`
  const patientResponse = await request.post(`${api}/api/patients`, { data: { research_code: code, affected_side: 'left', dominant_hand: 'right' } })
  expect(patientResponse.ok()).toBeTruthy()
  const patient = await patientResponse.json()
  const sessionResponse = await request.post(`${api}/api/sessions`, { data: { patient_id: patient.id, affected_side: 'left', session_type: 'training' } })
  expect(sessionResponse.ok()).toBeTruthy()
  const session = await sessionResponse.json()
  expect((await request.patch(`${api}/api/sessions/${session.id}`, { data: { status: 'in_progress' } })).ok()).toBeTruthy()
  await page.goto(`/workspace?session=${session.id}`)
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh').check()
  await page.getByRole('button', { name: 'Bắt đầu trò chơi' }).click()
  await expect(page.locator('.flower-score').getByText('1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dừng và xem kết quả' }).click()
  const saved = page.waitForResponse(response => response.url().endsWith('/api/exercise-results') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Xác nhận lưu kết quả' }).click()
  expect((await saved).ok()).toBeTruthy()
  await expect(page.getByText('Đã lưu kết quả lượt tập vào phiên.')).toBeVisible()
  const recordsResponse = await request.get(`${api}/api/exercise-results?session_id=${session.id}`)
  expect(recordsResponse.ok()).toBeTruthy()
  const records = await recordsResponse.json()
  expect(records).toHaveLength(1)
  expect(records[0].score).toBe(1)
  expect(records[0].source).toBe('camera')
  expect(records[0].affected_side).toBe('left')
  await page.goto('/results')
  await page.getByRole('row').filter({ hasText: code }).getByRole('button', { name: 'Xem trò chơi' }).click()
  const dialog = page.getByRole('dialog', { name: 'Kết quả trò chơi' })
  await expect(dialog.getByText('1 / 2', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Điểm trò chơi không phải điểm FMA-UE', { exact: false })).toBeVisible()
})

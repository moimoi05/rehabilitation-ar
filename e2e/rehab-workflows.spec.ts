import { randomUUID } from 'node:crypto'
import { test, expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'

const api = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8001'
type Patient = { id: number; research_code: string; patient_type: string; affected_side: string }
type Exercise = { id: number; code: string; name: string; renderer: string; is_default: boolean }
type Visit = { id: number; setup_revision: number; created_at: string; status: string }
type Question = { key: string; label: string; question_type: string; required: boolean; options: string[] }
type Template = { id: number; name: string; questions: Question[] }
type Result = { id: number; trial_id: number; session_id: number; duration_seconds: number; score: number }

declare global {
  interface Window { __rehabWorkflowMedia: { opens: number; stops: number; modelCloses: number } }
}

const uniqueCode = () => `WF-E2E-${Date.now()}-${randomUUID().slice(0, 6)}`
async function json<T>(response: APIResponse): Promise<T> {
  const body = await response.json()
  expect(response.ok(), JSON.stringify(body)).toBeTruthy()
  return body as T
}
const answer = (question: Question) => question.question_type === 'number' ? 3
  : question.question_type === 'date' ? '2025-01-01'
    : question.question_type === 'boolean' ? false
      : question.question_type === 'multiple_choice' ? [question.options[0]]
        : question.question_type === 'single_choice' ? question.options[0] : 'Thông tin giả lập E2E'

async function createPatient(request: APIRequestContext, code = uniqueCode()) {
  return json<Patient>(await request.post(`${api}/api/patients`, { data: {
    research_code: code, full_name: 'Hồ sơ thử nghiệm E2E', date_of_birth: '1980-01-01',
    sex: 'unspecified', affected_side: 'left', dominant_hand: 'right', notes: 'Dữ liệu E2E giả lập',
  } }))
}

/** Real API fixtures, including a completed assessment; no domain responses are mocked. */
async function completeAssessment(request: APIRequestContext, patient: Patient) {
  const session = await json<Visit>(await request.post(`${api}/api/assessments`, { data: { patient_id: patient.id } }))
  const templates = await json<Template[]>(await request.get(`${api}/api/questionnaires`))
  const template = templates[0]
  const submission = await json<{ id: number }>(await request.post(`${api}/api/questionnaire-submissions`, { data: { session_id: session.id, template_id: template.id } }))
  await json(await request.post(`${api}/api/questionnaire-submissions/${submission.id}/answers`, { data: {
    answers: template.questions.map(question => ({ question_key: question.key, value: answer(question) })), complete: true,
  } }))
  const exercises = await json<Exercise[]>(await request.get(`${api}/api/exercises?mode=assessment`))
  const exercise = exercises.find(item => item.is_default)!
  await json(await request.patch(`${api}/api/assessments/${session.id}`, { data: { selected_exercise_ids: [exercise.id] } }))
  await json(await request.post(`${api}/api/calibrations`, { data: {
    session_id: session.id, setup_revision: session.setup_revision, affected_side: patient.affected_side,
    camera_device_id: 'e2e-fixture', camera_label: 'E2E fixture only', width: 1280, height: 720,
    confirmed: true, ghost_visible: true,
  } }))
  await json(await request.post(`${api}/api/assessments/${session.id}/start`))
  const round = randomUUID()
  const trial = await json<{ id: number }>(await request.post(`${api}/api/trials`, { data: { session_id: session.id, exercise_id: exercise.id, client_round_id: round } }))
  await json(await request.post(`${api}/api/exercise-results`, { data: {
    session_id: session.id, trial_id: trial.id, round_id: round, game_key: 'glowing_flower', source: 'camera',
    affected_side: patient.affected_side, duration_seconds: 1.5, score: 1, target_count: 2,
  } }))
  return json<Visit>(await request.post(`${api}/api/assessments/${session.id}/complete`))
}

async function fakeTracking(page: Page) {
  await page.addInitScript(() => {
    window.__rehabWorkflowMedia = { opens: 0, stops: 0, modelCloses: 0 }
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__rehabWorkflowMedia.opens += 1
      const stream = await getUserMedia(constraints)
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track)
        track.stop = () => { window.__rehabWorkflowMedia.stops += 1; stop() }
      }
      return stream
    }
  })
  // Only the model boundary is replaced. Camera, React flows, API and PostgreSQL
  // are real. This tests lifecycle/integration and makes no pose-accuracy claim.
  await page.route('**/@mediapipe_tasks-vision.js*', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: `
      export const FilesetResolver = { forVisionTasks: async () => ({}) };
      export class PoseLandmarker {
        static async createFromOptions() { return new PoseLandmarker() }
        detectForVideo() {
          const landmarks = Array.from({length: 33}, () => ({x: .5, y: .5, visibility: 1}));
          landmarks[15] = {x: .65, y: .5, visibility: 1};
          return {landmarks: [landmarks], worldLandmarks: []};
        }
        close() { window.__rehabWorkflowMedia.modelCloses += 1 }
      }
      export class HandLandmarker {
        static async createFromOptions() { return new HandLandmarker() }
        detectForVideo() { return {landmarks: []} }
        close() { window.__rehabWorkflowMedia.modelCloses += 1 }
      }`,
  }))
}

async function setupCamera(page: Page) {
  await page.getByRole('button', { name: 'Bật camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Tôi đã kiểm tra vị trí và tư thế người bệnh').check()
  const saved = page.waitForResponse(response => response.url().endsWith('/api/calibrations') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Lưu hiệu chuẩn', exact: true }).click()
  expect((await saved).ok()).toBeTruthy()
}

async function runGame(page: Page, exercise: Exercise) {
  await page.getByRole('button', { name: `Thực hiện ${exercise.name}`, exact: true }).click()
  await page.getByRole('button', { name: 'Bắt đầu trò chơi', exact: true }).click()
  await expect(page.locator('.flower-score').getByText('1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dừng và xem kết quả', exact: true }).click()
  const saved = page.waitForResponse(response => response.url().endsWith('/api/exercise-results') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Xác nhận lưu kết quả', exact: true }).click()
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  const result: Result = await response.json()
  await expect(page.getByRole('heading', { name: 'Kết quả trò chơi', exact: true })).toBeVisible()
  expect(result.duration_seconds).toBeGreaterThan(0)
  return result
}

test('Quản trị: tạo, tìm, sửa, chặn trùng mã và chuyển nhóm bằng Baseline', async ({ page, request }) => {
  test.setTimeout(90_000)
  const code = uniqueCode()
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Thêm bệnh nhân', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Thêm bệnh nhân đến khám' })
  await form.getByLabel('Mã bệnh nhân', { exact: true }).fill(code)
  await form.getByLabel('Họ tên', { exact: true }).fill('Người thử E2E ban đầu')
  await form.getByLabel('Ngày sinh', { exact: true }).fill('1980-01-01')
  const created = page.waitForResponse(response => response.url().endsWith('/api/patients') && response.request().method() === 'POST')
  await form.getByRole('button', { name: 'Lưu hồ sơ' }).click()
  const patient: Patient = await (await created).json()
  expect(patient.patient_type).toBe('outpatient')
  await page.getByLabel('Tìm mã hoặc họ tên').fill(code)
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click()
  const row = page.getByRole('row').filter({ hasText: code })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'Sửa', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Sửa hồ sơ bệnh nhân' })
  await editor.getByLabel('Họ tên', { exact: true }).fill('Người thử E2E đã cập nhật')
  await editor.getByRole('button', { name: 'Lưu hồ sơ' }).click()
  await expect(row).toContainText('Người thử E2E đã cập nhật')
  await page.getByRole('button', { name: 'Thêm bệnh nhân', exact: true }).click()
  await form.getByLabel('Mã bệnh nhân', { exact: true }).fill(code)
  await form.getByLabel('Họ tên', { exact: true }).fill('Hồ sơ trùng không được tạo')
  const duplicate = page.waitForResponse(response => response.url().endsWith('/api/patients') && response.request().method() === 'POST')
  await form.getByRole('button', { name: 'Lưu hồ sơ' }).click()
  expect((await duplicate).status()).toBe(409)
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Hủy', exact: true }).click()

  const baseline = await completeAssessment(request, patient)
  await row.getByRole('button', { name: 'Chuyển sang điều trị', exact: true }).click()
  const transfer = page.getByRole('dialog', { name: 'Chuyển sang bệnh nhân điều trị', exact: true })
  await transfer.getByRole('combobox', { name: 'Đánh giá đầu vào (Baseline)', exact: true }).selectOption(String(baseline.id))
  await transfer.getByLabel('Lý do chuyển nhóm').fill('Nhập viện thử nghiệm E2E có Baseline')
  await transfer.getByRole('button', { name: 'Xác nhận chuyển nhóm', exact: true }).click()
  await expect(row).toHaveCount(0)
  await page.getByRole('tab', { name: 'Bệnh nhân điều trị', exact: true }).click()
  await expect(row).toHaveCount(1)
  const transfers = await json<{ baseline_assessment_session_id: number }[]>(await request.get(`${api}/api/patients/${patient.id}/transfers`))
  expect(transfers).toHaveLength(1)
  expect(transfers[0].baseline_assessment_session_id).toBe(baseline.id)
  const duplicateTransfer = await request.post(`${api}/api/patients/${patient.id}/transfer`, { data: { to_type: 'inpatient', baseline_assessment_session_id: baseline.id } })
  expect(duplicateTransfer.status()).toBe(409)
  expect(await json<unknown[]>(await request.get(`${api}/api/patients/${patient.id}/transfers`))).toHaveLength(1)
  await page.goto(`/reports?patient_id=${patient.id}&session_id=${baseline.id}`)
  await expect(page.getByText('Baseline đầu vào', { exact: true })).toBeVisible()
  await expect(page.locator('.rehab-report-card')).toHaveCount(1)
})

test('Đánh giá nhiều bài → nhập viện → luyện tập nhiều game trong cùng buổi → báo cáo', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await fakeTracking(page)
  const code = uniqueCode()
  const templates = await json<Template[]>(await request.get(`${api}/api/questionnaires`))
  const exercises = (await json<Exercise[]>(await request.get(`${api}/api/exercises?mode=assessment`))).filter(item => item.renderer === 'flower')
  const flower = exercises.find(item => item.is_default)!
  const prescribed = exercises.find(item => !item.is_default)!
  expect(flower).toBeDefined(); expect(prescribed).toBeDefined()

  await page.goto('/assessment')
  await page.getByRole('button', { name: 'Tạo hồ sơ đến khám', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Thêm bệnh nhân đến khám' })
  await form.getByLabel('Mã bệnh nhân', { exact: true }).fill(code)
  await form.getByLabel('Họ tên', { exact: true }).fill('Bệnh nhân quy trình E2E giả lập')
  const createdPatient = page.waitForResponse(response => response.url().endsWith('/api/patients') && response.request().method() === 'POST')
  await form.getByRole('button', { name: 'Lưu hồ sơ' }).click()
  const patient: Patient = await (await createdPatient).json()
  await expect(page).toHaveURL(new RegExp(`/assessment/${patient.id}$`))
  const createdVisit = page.waitForResponse(response => response.url().endsWith('/api/assessments') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Bắt đầu đánh giá mới', exact: true }).click()
  const visit: Visit = await (await createdVisit).json()
  await expect(page.getByRole('heading', { name: 'Câu hỏi lâm sàng', exact: true })).toBeVisible()
  for (const question of templates[0].questions) {
    if (question.question_type === 'multiple_choice') {
      await page.getByRole('group', { name: `${question.label}${question.required ? ' *' : ''}`, exact: true }).getByLabel(question.options[0], { exact: true }).check()
    } else if (question.question_type === 'single_choice' || question.question_type === 'boolean') {
      await page.getByRole('combobox', { name: `${question.label}${question.required ? ' *' : ''}`, exact: true }).selectOption(String(answer(question)))
    } else {
      await page.getByLabel(`${question.label}${question.required ? ' *' : ''}`, { exact: true }).fill(String(answer(question)))
    }
  }
  await page.getByRole('button', { name: 'Lưu câu trả lời và tiếp tục', exact: true }).click()
  await setupCamera(page)
  await expect(page.getByRole('heading', { name: 'Danh sách bài đánh giá', exact: true })).toBeVisible()
  await page.getByLabel(`Chọn ${prescribed.name}`, { exact: true }).check()
  const firstAssessment = await runGame(page, flower)
  await page.getByRole('button', { name: 'Quay lại danh sách bài', exact: true }).click()
  const secondAssessment = await runGame(page, prescribed)
  expect(firstAssessment.session_id).toBe(visit.id)
  expect(secondAssessment.session_id).toBe(visit.id)
  expect(firstAssessment.trial_id).not.toBe(secondAssessment.trial_id)
  await page.getByRole('button', { name: 'Xem tổng kết đánh giá', exact: true }).click()
  await page.getByLabel('Điểm FMA-UE (0–66)', { exact: true }).fill('28')
  await page.getByLabel('Nhân viên xác nhận', { exact: true }).fill('Nhân viên thử E2E')
  await page.getByLabel('Tôi xác nhận điểm từ đánh giá chuyên môn', { exact: true }).check()
  await page.getByRole('button', { name: 'Lưu điểm chuyên môn', exact: true }).click()
  await expect(page.getByText('FMA-UE: 28/66 · Đã xác nhận bởi Nhân viên thử E2E', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Hoàn tất đánh giá', exact: true }).click()
  await expect(page.getByText('Đánh giá đã hoàn tất', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Chuyển sang bệnh nhân điều trị', exact: true }).click()
  const transfer = page.getByRole('dialog', { name: 'Chuyển sang bệnh nhân điều trị', exact: true })
  await expect(transfer.getByRole('combobox', { name: 'Đánh giá đầu vào (Baseline)', exact: true })).toHaveValue(String(visit.id))
  await transfer.getByRole('button', { name: 'Xác nhận chuyển nhóm', exact: true }).click()
  await expect(transfer).toHaveCount(0)
  const baseline = await json<{ is_baseline: boolean; results: Result[]; questionnaires: { completed: boolean }[] }>(await request.get(`${api}/api/assessments/${visit.id}/detail`))
  expect(baseline.is_baseline).toBe(true)
  expect(baseline.results).toHaveLength(2)
  expect(baseline.questionnaires[0].completed).toBe(true)
  expect(await json<Patient[]>(await request.get(`${api}/api/patients?patient_type=outpatient&search=${code}`))).toHaveLength(0)
  expect((await json<Patient[]>(await request.get(`${api}/api/patients?patient_type=inpatient&search=${code}`)))[0].id).toBe(patient.id)

  await page.goto('/training')
  await page.getByLabel('Mã bệnh nhân', { exact: true }).fill(code)
  await page.getByRole('button', { name: 'Tìm bệnh nhân', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/training/${patient.id}$`))
  await expect(page.getByRole('button', { name: `Thực hiện ${flower.name}`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Thực hiện ${prescribed.name}`, exact: true })).toHaveCount(0)
  await json(await request.post(`${api}/api/patients/${patient.id}/prescriptions`, { data: { exercise_id: prescribed.id, clinician_name: 'Bác sĩ thử E2E', notes: 'Chỉ định giả lập phục vụ kiểm thử' } }))
  await page.reload()
  await expect(page.getByRole('button', { name: `Thực hiện ${prescribed.name}`, exact: true })).toBeVisible()
  let trainingCreates = 0
  page.on('request', request => { if (request.url().endsWith('/api/training-sessions') && request.method() === 'POST') trainingCreates += 1 })
  const createdTraining = page.waitForResponse(response => response.url().endsWith('/api/training-sessions') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Bắt đầu buổi tập', exact: true }).click()
  const training: Visit = await (await createdTraining).json()
  await setupCamera(page)
  await expect(page.getByRole('heading', { name: 'Chọn bài tập tiếp theo', exact: true })).toBeVisible()
  const firstTraining = await runGame(page, flower)
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Thời lượng luyện tập theo ngày và bài tập', exact: true })).toBeVisible()
  await expect(page.locator('.duration-chart rect')).toHaveCount(1)
  const secondTraining = await runGame(page, prescribed)
  expect(firstTraining.session_id).toBe(training.id)
  expect(secondTraining.session_id).toBe(training.id)
  expect(firstTraining.trial_id).not.toBe(secondTraining.trial_id)
  expect(trainingCreates).toBe(1)
  expect(await page.evaluate(() => window.__rehabWorkflowMedia.opens)).toBe(1)
  expect(await page.evaluate(() => window.__rehabWorkflowMedia.stops)).toBe(0)
  expect(await json<unknown[]>(await request.get(`${api}/api/calibrations?session_id=${training.id}`))).toHaveLength(1)
  await page.getByRole('button', { name: 'Trở về', exact: true }).click()
  const finish = page.getByRole('dialog', { name: 'Kết thúc buổi luyện tập?', exact: true })
  await finish.getByRole('button', { name: 'Hủy', exact: true }).click()
  await expect(finish).toHaveCount(0)
  expect((await json<Visit>(await request.get(`${api}/api/training-sessions/${training.id}`))).status).toBe('in_progress')
  expect(await page.evaluate(() => window.__rehabWorkflowMedia.stops)).toBe(0)
  await page.getByRole('button', { name: 'Trở về', exact: true }).click()
  await finish.getByRole('button', { name: 'Xác nhận kết thúc', exact: true }).click()
  await expect(page).toHaveURL(/\/training$/)
  await expect.poll(() => page.evaluate(() => window.__rehabWorkflowMedia.stops)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__rehabWorkflowMedia.modelCloses)).toBe(1)
  const completed = await json<{ status: string; ended_at: string | null }>(await request.get(`${api}/api/training-sessions/${training.id}`))
  expect(completed.status).toBe('completed'); expect(completed.ended_at).not.toBeNull()
  const detail = await json<{ trial_count: number; results: Result[] }>(await request.get(`${api}/api/training-sessions/${training.id}/detail`))
  expect(detail.trial_count).toBe(2); expect(detail.results).toHaveLength(2)

  await page.goto(`/reports?patient_id=${patient.id}`)
  await expect(page.getByText('Baseline đầu vào', { exact: true })).toBeVisible()
  await page.getByText('Câu hỏi và câu trả lời đã lưu', { exact: true }).click()
  await expect(page.getByText('Thông tin giả lập E2E', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('28 / 66', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Báo cáo luyện tập', exact: true }).click()
  await expect(page.locator('.duration-chart rect')).toHaveCount(2)
  await page.getByLabel('Mã bệnh nhân', { exact: true }).fill(code)
  await page.getByLabel('Từ ngày', { exact: true }).fill('2000-01-01')
  await page.getByLabel('Đến ngày', { exact: true }).fill('2099-12-31')
  await page.getByRole('combobox', { name: 'Bài tập', exact: true }).selectOption(String(prescribed.id))
  await page.getByLabel('Mã buổi / lần đánh giá', { exact: true }).fill(String(training.id))
  const filtered = page.waitForResponse(response => response.url().includes('/api/reports/training?') && response.url().includes(`exercise_id=${prescribed.id}`))
  await page.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).click()
  expect((await filtered).ok()).toBeTruthy()
  await expect(page.locator('.rehab-report-card')).toHaveCount(1)
  await expect(page.locator('.rehab-report-card tbody tr')).toHaveCount(1)
  await expect(page.locator('.rehab-report-card tbody tr')).toContainText(prescribed.name)
  await expect(page.locator('.duration-chart rect')).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('completed-rehabilitation-workflow.png'), fullPage: true })
})

test('Luyện tập từ chối outpatient và giữ nguyên kết quả buổi dang dở khi tải lại', async ({ page, request }) => {
  test.setTimeout(60_000)
  const patient = await createPatient(request)
  await page.goto('/training')
  await page.getByLabel('Mã bệnh nhân', { exact: true }).fill(patient.research_code)
  await page.getByRole('button', { name: 'Tìm bệnh nhân', exact: true }).click()
  await expect(page.getByText('Bệnh nhân thuộc nhóm đến khám. Hãy hoàn tất đánh giá và chuyển nhóm trước khi luyện tập.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Đến Đánh giá', exact: true })).toHaveAttribute('href', `/assessment/${patient.id}`)
  expect((await request.post(`${api}/api/training-sessions`, { data: { patient_id: patient.id } })).status()).toBe(409)
  const baseline = await completeAssessment(request, patient)
  await json(await request.post(`${api}/api/patients/${patient.id}/transfer`, { data: { to_type: 'inpatient', baseline_assessment_session_id: baseline.id } }))
  const session = await json<Visit>(await request.post(`${api}/api/training-sessions`, { data: { patient_id: patient.id } }))
  const catalog = await json<Exercise[]>(await request.get(`${api}/api/exercises?mode=training&patient_id=${patient.id}`))
  const exercise = catalog.find(item => item.is_default)!
  await json(await request.post(`${api}/api/calibrations`, { data: {
    session_id: session.id, setup_revision: session.setup_revision, affected_side: patient.affected_side,
    camera_device_id: 'e2e-interruption-fixture', width: 1280, height: 720, confirmed: true, ghost_visible: true,
  } }))
  await json(await request.post(`${api}/api/training-sessions/${session.id}/start`))
  const round = randomUUID()
  const completedTrial = await json<{ id: number }>(await request.post(`${api}/api/trials`, { data: { session_id: session.id, exercise_id: exercise.id, client_round_id: round } }))
  const saved = await json<Result>(await request.post(`${api}/api/exercise-results`, { data: {
    session_id: session.id, trial_id: completedTrial.id, round_id: round, game_key: 'glowing_flower', source: 'camera',
    affected_side: patient.affected_side, duration_seconds: 1.5, score: 1, target_count: 2,
  } }))
  const unfinishedTrial = await json<{ id: number }>(await request.post(`${api}/api/trials`, { data: { session_id: session.id, exercise_id: exercise.id, client_round_id: randomUUID() } }))
  await page.goto(`/training/${patient.id}`)
  await expect(page.getByText(new RegExp(`Còn 1 buổi dang dở: #${session.id}`))).toBeVisible()
  await page.reload()
  await expect(page.getByText(new RegExp(`Còn 1 buổi dang dở: #${session.id}`))).toBeVisible()
  expect((await json<Visit>(await request.get(`${api}/api/training-sessions/${session.id}`))).status).toBe('in_progress')
  const detail = await json<{ trial_count: number; results: Result[]; trials: { id: number; status: string; results: unknown[] }[] }>(await request.get(`${api}/api/training-sessions/${session.id}/detail`))
  expect(detail.trial_count).toBe(2); expect(detail.results).toHaveLength(1)
  expect(detail.results[0].id).toBe(saved.id)
  expect(detail.trials.find(trial => trial.id === unfinishedTrial.id)).toMatchObject({ status: 'in_progress', results: [] })
  await expect(page.locator('.duration-chart rect')).toHaveCount(1)
})

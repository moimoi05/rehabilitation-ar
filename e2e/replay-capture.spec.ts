import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'

// This test writes synthetic patient/session metadata and private research artifacts
// to the explicitly configured local test server. Never retain browser artifacts.
test.use({ permissions: [], trace: 'off', screenshot: 'off', video: 'off' })

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const block of createReadStream(path)) hash.update(block)
  return hash.digest('hex')
}

test('replays a local video through MediaPipe and verifies the saved artifacts', async ({ page, request }) => {
  const videoPath = process.env.TRACKING_VIDEO_PATH
  const api = process.env.REPLAY_TEST_API_URL
  test.skip(!videoPath || !existsSync(videoPath), 'TRACKING_VIDEO_PATH must name an accessible local video')
  test.skip(!api || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api), 'REPLAY_TEST_API_URL must be an explicitly configured local test server')
  test.setTimeout(180_000)
  const originalSha = await sha256(videoPath!)
  const patientResponse = await request.post(`${api}/api/patients`, { data: { research_code: `REPLAY-${randomUUID()}`, affected_side: 'left', dominant_hand: 'right' } })
  expect(patientResponse.status()).toBe(201)
  const patient = await patientResponse.json()
  const sessionResponse = await request.post(`${api}/api/sessions`, { data: { patient_id: patient.id, affected_side: 'left', session_type: 'assessment' } })
  expect(sessionResponse.status()).toBe(201)
  const session = await sessionResponse.json()

  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.protocol === 'blob:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue()
    else await route.abort()
  })
  await page.addInitScript(() => {
    const state = { cameraCalls: 0, recorderCalls: 0 }
    Object.assign(window, { replayPrivacyProbe: state })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => { state.cameraCalls++; throw new Error('Unexpected camera access') } })
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: class { constructor() { state.recorderCalls++; throw new Error('Unexpected MediaRecorder') } } })
  })
  await page.goto('/tracking-lab')
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath!)
  await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2)
  await page.getByLabel('Hand (21 mốc)').check()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  await page.getByLabel('Replay patient ID').fill(String(patient.id))
  await page.getByLabel('Replay session ID').fill(String(session.id))
  await page.getByLabel('Tôi xác nhận quyền thu thập video và landmark cho lần kiểm thử này').check()
  const created = page.waitForResponse(response => response.url() === `${api}/api/captures` && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Bắt đầu thu replay' }).click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(201)
  const capture = await createdResponse.json()
  await expect(page.getByText('Đã hoàn tất và xác minh capture replay')).toBeVisible({ timeout: 120_000 })
  expect(await page.evaluate(() => (window as unknown as { replayPrivacyProbe: { cameraCalls: number; recorderCalls: number } }).replayPrivacyProbe)).toEqual({ cameraCalls: 0, recorderCalls: 0 })

  const metadataResponse = await request.get(`${api}/api/captures/${capture.id}`)
  expect(metadataResponse.ok()).toBeTruthy()
  const metadata = await metadataResponse.json()
  expect(metadata.status).toBe('complete')
  expect(metadata.source_type).toBe('pre_recorded_video')
  expect(metadata.model_config_info.timestamp).toBe('capture_relative_monotonic_callback')
  expect(metadata.model_config_info.video_timestamp).toBe('video_media_time')
  expect(metadata.patient_id).toBe(patient.id)
  expect(metadata.session_id).toBe(session.id)
  expect(metadata.trial_id).toBeGreaterThan(0)
  expect(metadata.artifact_summary.frame_count).toBeGreaterThan(0)
  expect(metadata.artifact_summary.inferred_count).toBeGreaterThan(0)
  expect(metadata.artifact_summary.landmark_count).toBeGreaterThan(0)
  expect(metadata.artifact_summary.video_sha256).toBe(originalSha)
  const savedVideo = await request.get(`${api}/api/captures/${capture.id}/artifacts/video`)
  expect(savedVideo.ok()).toBeTruthy()
  expect(createHash('sha256').update(await savedVideo.body()).digest('hex')).toBe(originalSha)
  const parquet: Record<string, Buffer> = {}
  for (const artifact of ['frames', 'landmarks']) {
    const response = await request.get(`${api}/api/captures/${capture.id}/artifacts/${artifact}`)
    expect(response.ok()).toBeTruthy()
    const bytes = await response.body()
    expect(bytes.length).toBeGreaterThan(12)
    expect(bytes.subarray(0, 4).toString()).toBe('PAR1')
    expect(bytes.subarray(-4).toString()).toBe('PAR1')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.artifact_summary[`${artifact}_sha256`])
    parquet[artifact] = bytes
  }
  // Parse the real downloaded files in memory. Only aggregate counts leave the
  // verifier; no video or landmark data is written into Playwright artifacts.
  const python = process.env.REPLAY_TEST_PYTHON || resolve(__dirname, process.platform === 'win32' ? '../backend/.venv/Scripts/python.exe' : '../backend/.venv/bin/python')
  expect(existsSync(python), 'Set REPLAY_TEST_PYTHON to a Python interpreter with pyarrow').toBeTruthy()
  const verified = spawnSync(python, [resolve(__dirname, 'verify-replay-parquet.py')], {
    input: JSON.stringify({ metadata, frames: parquet.frames.toString('base64'), landmarks: parquet.landmarks.toString('base64') }),
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000,
  })
  expect(verified.error?.message || verified.stderr, 'Parquet content validation').toBe('')
  expect(verified.status, 'Parquet verifier exit status').toBe(0)
  expect(JSON.parse(verified.stdout)).toMatchObject({ frames: metadata.artifact_summary.frame_count, landmarks: metadata.artifact_summary.landmark_count })
  const manifest = await request.get(`${api}/api/sessions/${session.id}/video-manifest`)
  expect(manifest.ok()).toBeTruthy()
  expect(await manifest.text()).toContain(capture.id)
  expect(await sha256(videoPath!)).toBe(originalSha)
})

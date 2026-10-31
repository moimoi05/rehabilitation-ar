import { createHash, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

// Requires the Playwright config's fake camera and a dedicated localhost test DB.
// Do not retain browser media or screenshots in test artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('records the synthetic camera stream without overlays and includes its final chunk', async ({ page, request }) => {
  const api = process.env.REPLAY_TEST_API_URL
  test.skip(!api || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api), 'REPLAY_TEST_API_URL must point to a dedicated localhost test backend')
  test.setTimeout(180_000)
  const patientResponse = await request.post(`${api}/api/patients`, { data: { research_code: `FAKE-CAM-${randomUUID()}`, affected_side: 'left', dominant_hand: 'right' } })
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
    const state = { stream: null as MediaStream | null, recorderUsesSource: false, audioTracks: -1, canvasCalls: 0, chunks: [] as Blob[], stopEvents: 0 }
    Object.assign(window, { cameraCaptureProbe: state })
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getMedia(constraints)
      state.stream = stream
      return stream
    }
    HTMLCanvasElement.prototype.captureStream = () => { state.canvasCalls++; throw new Error('Recording must not use the UI canvas') }
    const OriginalRecorder = window.MediaRecorder
    class InspectingRecorder extends OriginalRecorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options)
        state.recorderUsesSource = stream === state.stream
        state.audioTracks = stream.getAudioTracks().length
        this.addEventListener('dataavailable', event => { if (event.data.size) state.chunks.push(event.data) })
        this.addEventListener('stop', () => { state.stopEvents++ })
      }
    }
    window.MediaRecorder = InspectingRecorder
  })

  await page.goto(`/workspace?sessionId=${session.id}`)
  await expect(page.getByLabel('Phiên tập')).toHaveValue(String(session.id))
  await page.getByRole('button', { name: 'Bật camera' }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera' })).toBeVisible()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await expect(page.getByRole('button', { name: 'Dừng nhận diện' })).toBeVisible({ timeout: 90_000 })
  const videoChoice = page.getByLabel('Ghi video nguồn từ camera, không có overlay')
  await videoChoice.check()
  const start = page.getByRole('button', { name: 'Bắt đầu thu dữ liệu' })
  await expect(start).toBeDisabled()
  await page.getByLabel('Xác nhận quyền ghi video').check()
  await page.getByLabel('Xác nhận quyền thu landmark').check()
  const created = page.waitForResponse(response => response.url() === `${api}/api/captures` && response.request().method() === 'POST')
  await start.click()
  const captureResponse = await created
  expect(captureResponse.status()).toBe(201)
  const capture = await captureResponse.json()
  await expect(page.getByRole('button', { name: 'Dừng và lưu' })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { cameraCaptureProbe: { chunks: Blob[] } }).cameraCaptureProbe.chunks.length), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
  await page.getByRole('button', { name: 'Dừng và lưu' }).click()
  await expect(page.getByText('Đã hoàn tất và xác minh capture', { exact: false })).toBeVisible({ timeout: 90_000 })
  const observed = await page.evaluate(async () => {
    const state = (window as unknown as { cameraCaptureProbe: { recorderUsesSource: boolean; audioTracks: number; canvasCalls: number; chunks: Blob[]; stopEvents: number } }).cameraCaptureProbe
    const bytes = await new Blob(state.chunks).arrayBuffer()
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    return { recorderUsesSource: state.recorderUsesSource, audioTracks: state.audioTracks, canvasCalls: state.canvasCalls, chunks: state.chunks.length, stopEvents: state.stopEvents, bytes: bytes.byteLength, hash }
  })
  expect(observed.recorderUsesSource).toBe(true)
  expect(observed.audioTracks).toBe(0)
  expect(observed.canvasCalls).toBe(0)
  expect(observed.stopEvents).toBe(1)
  expect(observed.chunks).toBeGreaterThanOrEqual(2)
  const metadata = await (await request.get(`${api}/api/captures/${capture.id}`)).json()
  expect(metadata.status).toBe('complete')
  expect(metadata.source_type).toBe('webcam')
  expect(metadata.artifact_summary.video_chunk_count).toBe(observed.chunks)
  expect(metadata.artifact_summary.video_size_bytes).toBe(observed.bytes)
  expect(metadata.artifact_summary.video_sha256).toBe(observed.hash)
  expect(metadata.model_config_info.recorder_start).toBeTruthy()
  const downloaded = await request.get(`${api}/api/captures/${capture.id}/artifacts/video`)
  expect(downloaded.ok()).toBeTruthy()
  expect(createHash('sha256').update(await downloaded.body()).digest('hex')).toBe(observed.hash)
})

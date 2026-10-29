// Local-only Lab comparison: Pose alone versus Pose and Hand.
// Usage: node tracking-pose-hand-benchmark.cjs <local-video> [repetitions 1..4]
// Only aggregate metrics are printed; no video, frame, landmark or trace is saved.
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function measure(context, videoPath, handEnabled) {
  const page = await context.newPage()
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'application/json') blob.text().then(text => { window.poseHandBenchmarkExport = text })
      return create(blob)
    }
    HTMLAnchorElement.prototype.click = function () {
      if (this.download === 'tracking-benchmark.json') return
      return click.call(this)
    }
  })
  await page.goto('/tracking-lab')
  await page.getByLabel('Chọn video MP4').setInputFiles(videoPath)
  const video = page.locator('video')
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 12 })
  await video.evaluate(async v => {
    v.pause()
    if (v.currentTime > .01) { v.currentTime = 0; await new Promise(resolve => v.addEventListener('seeked', resolve, { once: true })) }
  })
  await page.getByLabel('Cấu hình hiệu năng').selectOption('balanced')
  if (handEnabled) await page.getByLabel('Hand (21 mốc)').check()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
  await video.evaluate(v => v.play())
  await page.waitForFunction(() => document.querySelector('video').currentTime >= 3, { timeout: 60000 })
  const start = await video.evaluate(v => ({ mediaTime: v.currentTime, rate: v.playbackRate }))
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await page.waitForTimeout(8000)
  const end = await video.evaluate(v => ({ mediaTime: v.currentTime, ended: v.ended, width: v.videoWidth, height: v.videoHeight, duration: v.duration }))
  await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
  await page.waitForFunction(() => typeof window.poseHandBenchmarkExport === 'string', { timeout: 10000 })
  const report = await page.evaluate(() => JSON.parse(window.poseHandBenchmarkExport))
  if (report.profile !== 'balanced' || report.engine !== 'main' || report.handEnabled !== handEnabled || !report.poseEnabled || !report.inferenceTimingSamples) throw new Error('Unexpected measurement configuration')
  if (!report.delegate.includes('Pose CPU') || (handEnabled && !report.delegate.includes('Hand CPU'))) throw new Error(`Unexpected delegate: ${report.delegate}`)
  if (start.rate !== 1 || end.ended) throw new Error('Playback rate changed or video ended during measurement')
  await page.getByRole('button', { name: 'Dừng đo' }).click()
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  return { start, end, report }
}

;(async () => {
  const videoPath = process.argv[2], repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 4) throw new Error('Usage: node tracking-pose-hand-benchmark.cjs <local-video> [1..4]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4221'
  const parsed = new URL(baseURL), origin = parsed.origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Only a localhost origin is allowed')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const runs = []
    for (let i = 0; i < repetitions; i++) {
      const order = i % 2 === 0 ? [false, true] : [true, false]
      for (const handEnabled of order) {
        console.error(`Measuring ${handEnabled ? 'Pose+Hand' : 'Pose'} run ${i + 1}/${repetitions}`)
        const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
        await context.route('**/*', route => {
          const url = route.request().url()
          if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
          if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
          return route.abort()
        })
        try { runs.push({ handEnabled, repetition: i + 1, ...(await measure(context, videoPath, handEnabled)) }) }
        finally { await context.close() }
      }
    }
    console.log(JSON.stringify({ browser: browser.version(), warmupSeconds: 3, requestedMeasurementSeconds: 8, runs,
      limitations: 'Inference duration is total of models run on a callback; hand-only inference rate is not measured. Video callbacks observed are not all decoded frames; no accuracy or clinical conclusion follows from visibility. Workload includes the overlay and differs when Hand is enabled.' }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

// Local-only comparison of Lab performance profiles using the same source video.
// Usage: node tracking-profiles-benchmark.cjs <local-video> [repetitions 1..4]
// No frames, landmarks, or recordings are written. Only aggregate metrics are printed.
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function measure(context, videoPath, profile) {
  const page = await context.newPage()
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'application/json') blob.text().then(text => { window.profileBenchmarkExport = text })
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
  await page.getByLabel('Cấu hình hiệu năng').selectOption(profile)
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
  await video.evaluate(v => v.play())
  await page.waitForFunction(() => document.querySelector('video').currentTime >= 3, { timeout: 60000 })
  const start = await video.evaluate(v => ({ mediaTime: v.currentTime, rate: v.playbackRate }))
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await page.waitForTimeout(8000)
  const end = await video.evaluate(v => ({ mediaTime: v.currentTime, ended: v.ended, width: v.videoWidth, height: v.videoHeight, duration: v.duration }))
  await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
  await page.waitForFunction(() => typeof window.profileBenchmarkExport === 'string', { timeout: 10000 })
  const report = await page.evaluate(() => JSON.parse(window.profileBenchmarkExport))
  if (report.profile !== profile || report.engine !== 'main' || report.handEnabled || !report.poseEnabled || !report.inferenceTimingSamples) throw new Error(`Unexpected measurement configuration for ${profile}`)
  if (start.rate !== 1 || end.ended) throw new Error('Playback rate changed or video ended during measurement')
  await page.getByRole('button', { name: 'Dừng đo' }).click()
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  return { start, end, report }
}

;(async () => {
  const videoPath = process.argv[2], repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 4) throw new Error('Usage: node tracking-profiles-benchmark.cjs <local-video> [1..4]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4212'
  const origin = new URL(baseURL).origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only a localhost origin is allowed')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const runs = []
    for (let i = 0; i < repetitions; i++) {
      const order = i % 2 === 0 ? ['economy', 'balanced', 'quality'] : ['quality', 'balanced', 'economy']
      for (const profile of order) {
        console.error(`Measuring ${profile} run ${i + 1}/${repetitions}`)
        const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
        await context.route('**/*', route => {
          const url = route.request().url()
          if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
          if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
          return route.abort()
        })
        try { runs.push({ profile, repetition: i + 1, ...(await measure(context, videoPath, profile)) }) }
        finally { await context.close() }
      }
    }
    console.log(JSON.stringify({ browser: browser.version(), warmupSeconds: 3, requestedMeasurementSeconds: 8, runs,
      limitations: 'File source stays at its native resolution in all profiles; callback count is not total decoded frames; render loop rate is not display refresh; visibility is not accuracy.' }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

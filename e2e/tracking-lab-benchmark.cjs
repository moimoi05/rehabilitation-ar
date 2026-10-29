// Local-only comparison of the actual Lab's main-thread CPU and Worker CPU paths.
// Usage: node tracking-lab-benchmark.cjs <local-video> [repetitions-per-engine]
// Prints aggregate JSON only: it does not copy the video or export landmarks.
const { chromium } = require('playwright')

async function run(page, videoPath, engine) {
  await page.route('**/api/**', route => route.fulfill({ status: 200, json: [] }))
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'application/json') blob.text().then(text => { window.labBenchmarkExport = text })
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
  if (engine === 'worker') await page.getByLabel('Worker CPU (thử nghiệm)').check()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
  await video.evaluate(v => v.play())
  await page.waitForFunction(() => document.querySelector('video').currentTime >= 3, { timeout: 60000 })
  const start = await video.evaluate(v => ({ mediaTime: v.currentTime, rate: v.playbackRate }))
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await page.waitForTimeout(8000)
  const end = await video.evaluate(v => ({ mediaTime: v.currentTime, ended: v.ended, width: v.videoWidth, height: v.videoHeight, duration: v.duration }))
  await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
  await page.waitForFunction(() => typeof window.labBenchmarkExport === 'string', { timeout: 10000 })
  const report = await page.evaluate(() => JSON.parse(window.labBenchmarkExport))
  if (report.engine !== engine || !report.inferenceTimingSamples) throw new Error(`Expected ${engine} with timed samples; got ${report.engine} and ${report.inferenceTimingSamples} samples`)
  if (start.rate !== 1 || end.ended) throw new Error('Playback rate changed or video ended during measurement')
  await page.getByRole('button', { name: 'Dừng đo' }).click()
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  return { start, end, report }
}

;(async () => {
  const videoPath = process.argv[2]
  const repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Usage: node tracking-lab-benchmark.cjs <local-video> [1..10]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173'
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const runs = []
    for (let i = 0; i < repetitions; i++) for (const engine of ['main', 'worker']) {
      const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, recordVideo: undefined })
      try { runs.push({ engine, repetition: i + 1, ...(await run(await context.newPage(), videoPath, engine)) }) }
      finally { await context.close() }
    }
    console.log(JSON.stringify({ browser: browser.version(), warmupSeconds: 3, requestedMeasurementSeconds: 8, runs }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

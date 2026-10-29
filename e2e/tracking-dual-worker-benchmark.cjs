// Local-only, repeatable comparison of the actual Lab's serial and parallel CPU Workers.
// Usage: node tracking-dual-worker-benchmark.cjs <local-video> [repetitions 1..4]
// The selected video is never copied, uploaded, recorded, or written to test artifacts.
// Only whitelisted aggregate metrics are printed; raw landmarks and frames are excluded.
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const metrics = value => value && typeof value === 'object' ? Object.fromEntries([
  'inferenceFps', 'inferenceP50Ms', 'inferenceP95Ms', 'workerRoundTripP50Ms',
  'workerRoundTripP95Ms', 'busyFrames', 'throttledFrames', 'resultAgeMs',
].map(key => [key, numberOrNull(value[key])])) : null

async function measure(context, videoPath, mode) {
  const page = await context.newPage()
  const workers = { created: 0, closed: 0 }
  page.on('worker', worker => { workers.created++; worker.on('close', () => workers.closed++) })
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL)
    const click = HTMLAnchorElement.prototype.click
    URL.createObjectURL = value => {
      if (value instanceof Blob && value.type === 'application/json') value.text().then(text => { window.dualLabBenchmarkExport = text })
      return create(value)
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
  await page.getByLabel('Hand (21 mốc)').check()
  await page.getByLabel(mode === 'parallel' ? 'Hai Worker CPU (thử nghiệm)' : 'Worker CPU (thử nghiệm)', { exact: true }).check()
  await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
  await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
  await video.evaluate(v => v.play())
  await page.waitForFunction(() => document.querySelector('video').currentTime >= 3, { timeout: 60000 })
  const start = await video.evaluate(v => ({ mediaTime: v.currentTime, rate: v.playbackRate }))
  await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
  await page.waitForTimeout(8000)
  const end = await video.evaluate(v => ({ mediaTime: v.currentTime, ended: v.ended, width: v.videoWidth, height: v.videoHeight, duration: v.duration }))
  if (start.rate !== 1 || end.ended || end.mediaTime <= start.mediaTime) throw new Error('Playback changed or ended during measurement')
  await page.getByRole('button', { name: 'Dừng đo' }).click()
  await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
  await page.waitForFunction(() => typeof window.dualLabBenchmarkExport === 'string', { timeout: 10000 })
  const report = await page.evaluate(() => JSON.parse(window.dualLabBenchmarkExport))
  const expectedEngine = mode === 'parallel' ? 'parallel' : 'worker'
  if (report.engine !== expectedEngine || !report.poseEnabled || !report.handEnabled || report.profile !== 'balanced') throw new Error(`Unexpected configuration in ${mode} measurement`)
  if (mode === 'parallel' && (!(report.dualPose?.inferenceFps > 0) || !(report.dualHand?.inferenceFps > 0))) throw new Error('Parallel measurement did not collect both model streams')
  if (mode === 'serial' && !(report.inferenceTimingSamples > 0)) throw new Error('Serial measurement did not collect model samples')
  const summary = {
    engine: report.engine, delegate: report.delegate, profile: report.profile,
    elapsedSeconds: numberOrNull(report.elapsedSeconds), observedVideoFps: numberOrNull(report.observedVideoFps),
    renderFps: numberOrNull(report.renderFps), inferenceFps: numberOrNull(report.inferenceFps),
    inferenceP50Ms: numberOrNull(report.inferenceP50Ms), inferenceP95Ms: numberOrNull(report.inferenceP95Ms),
    workerRoundTripP50Ms: numberOrNull(report.workerRoundTripP50Ms), workerRoundTripP95Ms: numberOrNull(report.workerRoundTripP95Ms),
    throttledFrames: numberOrNull(report.throttledFrames), workerBusyFrames: numberOrNull(report.workerBusyFrames),
    validFraction: numberOrNull(report.validFraction), leftUpperLimbVisibleFraction: numberOrNull(report.leftUpperLimbVisibleFraction),
    rightUpperLimbVisibleFraction: numberOrNull(report.rightUpperLimbVisibleFraction),
    dualPose: metrics(report.dualPose), dualHand: metrics(report.dualHand),
  }
  await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
  await page.waitForFunction(() => document.querySelector('button') !== null)
  const deadline = Date.now() + 10000
  while (page.workers().length && Date.now() < deadline) await page.waitForTimeout(100)
  if (page.workers().length) throw new Error('Worker cleanup timed out')
  await page.getByRole('button', { name: 'Đóng nguồn' }).click()
  return { start, end, summary, workers }
}

;(async () => {
  const videoPath = process.argv[2], repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 4) {
    throw new Error('Usage: node tracking-dual-worker-benchmark.cjs <local-video> [1..4]')
  }
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4242'
  const parsed = new URL(baseURL), origin = parsed.origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Only localhost is allowed')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const runs = []
    for (let i = 0; i < repetitions; i++) {
      for (const mode of (i % 2 ? ['parallel', 'serial'] : ['serial', 'parallel'])) {
        console.error(`Measuring ${mode} run ${i + 1}/${repetitions}`)
        const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
        await context.route('**/*', route => {
          const url = route.request().url()
          if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
          if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
          return route.abort()
        })
        try { runs.push({ mode, repetition: i + 1, ...(await measure(context, videoPath, mode)) }) }
        finally { await context.close() }
      }
    }
    console.log(JSON.stringify({ browser: browser.version(), warmupSeconds: 3, requestedMeasurementSeconds: 8, runs,
      limitations: 'One local file, headless and short runs; frames/times differ per mode, separate captures need not match. Callback-to-result is not sensor-to-display latency. Render loops are not screen refresh. No accuracy, clinical or total CPU/GPU/WASM-memory claims.' }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

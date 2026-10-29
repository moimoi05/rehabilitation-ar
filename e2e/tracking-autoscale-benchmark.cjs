// Actual production Lab A/B: two independent CPU Workers, fixed vs adaptive.
// Usage: node tracking-autoscale-benchmark.cjs <local-video> [rounds 1..4]
// Video and landmarks are never copied, uploaded, or emitted; stdout contains aggregates only.
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const stream = value => value ? Object.fromEntries(['inferenceFps', 'inferenceP50Ms', 'inferenceP95Ms', 'workerRoundTripP50Ms', 'workerRoundTripP95Ms', 'busyFrames', 'throttledFrames'].map(key => [key, finite(value[key])])) : null

async function cpuSnapshot(session) {
  const before = performance.now()
  const result = await session.send('SystemInfo.getProcessInfo')
  const after = performance.now()
  return { at: (before + after) / 2, processes: result.processInfo.map(p => ({ id: p.id, cpu: p.cpuTime })) }
}
function cpuSummary(before, after) {
  const old = new Map(before.processes.map(p => [p.id, p.cpu]))
  const sameProcessSet = old.size === after.processes.length && after.processes.every(p => old.has(p.id))
  const seconds = (after.at - before.at) / 1000
  const cpuSeconds = sameProcessSet ? after.processes.reduce((sum, p) => sum + p.cpu - old.get(p.id), 0) : null
  return { seconds, processCount: old.size, sameProcessSet, cpuPercentOneCore: cpuSeconds === null ? null : 100 * cpuSeconds / seconds }
}

async function measure(videoPath, adaptive, baseURL) {
  const origin = new URL(baseURL).origin
  const browser = await chromium.launch({ channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const cdp = await browser.newBrowserCDPSession()
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
      if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    const page = await context.newPage()
    const workers = { created: 0, closed: 0 }
    page.on('worker', worker => { workers.created++; worker.on('close', () => workers.closed++) })
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL), click = HTMLAnchorElement.prototype.click
      URL.createObjectURL = value => { if (value instanceof Blob && value.type === 'application/json') void value.text().then(text => { window.autoBenchmarkExport = text }); return create(value) }
      HTMLAnchorElement.prototype.click = function () { if (this.download !== 'tracking-benchmark.json') return click.call(this) }
      window.autoLongTasks = { count: 0, durationMs: 0, start: 0, active: false, supported: false }
      try {
        const observer = new PerformanceObserver(list => {
          for (const item of list.getEntries()) if (window.autoLongTasks.active && item.startTime >= window.autoLongTasks.start) { window.autoLongTasks.count++; window.autoLongTasks.durationMs += item.duration }
        })
        observer.observe({ type: 'longtask', buffered: true }); window.autoLongTasks.supported = true; window.autoLongObserver = observer
      } catch { /* unsupported; report as unavailable */ }
    })
    await page.goto('/tracking-lab')
    await page.getByLabel('Chọn video MP4').setInputFiles(videoPath)
    const video = page.locator('video')
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 12 })
    await video.evaluate(async v => { v.pause(); if (v.currentTime > .01) { v.currentTime = 0; await new Promise(resolve => v.addEventListener('seeked', resolve, { once: true })) } })
    await page.getByLabel('Cấu hình hiệu năng').selectOption('balanced')
    await page.getByLabel('Hand (21 mốc)').check()
    await page.getByLabel('Hai Worker CPU (thử nghiệm)', { exact: true }).check()
    const checkbox = page.getByLabel('Tự điều chỉnh nhịp Worker')
    if (adaptive) await checkbox.check(); else await checkbox.uncheck()
    if (await checkbox.isChecked() !== adaptive) throw new Error('Unexpected adaptive selection')
    await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
    await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
    await video.evaluate(v => v.play())
    await page.waitForFunction(() => document.querySelector('video').currentTime >= 3, { timeout: 60000 })
    const start = await video.evaluate(v => ({ mediaTime: v.currentTime, rate: v.playbackRate }))
    await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
    await page.evaluate(() => { const s = window.autoLongTasks; s.count = 0; s.durationMs = 0; s.start = performance.now(); s.active = true })
    const before = await cpuSnapshot(cdp)
    await page.waitForTimeout(8000)
    const after = await cpuSnapshot(cdp)
    const end = await video.evaluate(v => ({ mediaTime: v.currentTime, ended: v.ended, width: v.videoWidth, height: v.videoHeight }))
    if (start.rate !== 1 || end.ended || end.mediaTime <= start.mediaTime) throw new Error('Video playback ended or changed')
    const longTasks = await page.evaluate(() => { const s = window.autoLongTasks; if (window.autoLongObserver) for (const item of window.autoLongObserver.takeRecords()) if (item.startTime >= s.start) { s.count++; s.durationMs += item.duration }; s.active = false; return { supported: s.supported, count: s.supported ? s.count : null, durationMs: s.supported ? s.durationMs : null } })
    await page.getByRole('button', { name: 'Dừng đo' }).click()
    await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
    await page.waitForFunction(() => typeof window.autoBenchmarkExport === 'string')
    const report = await page.evaluate(() => JSON.parse(window.autoBenchmarkExport))
    if (report.engine !== 'parallel' || report.profile !== 'balanced' || !report.poseEnabled || !report.handEnabled || !!report.adaptiveWorkerBudget !== adaptive || !(report.dualPose?.inferenceFps > 0) || !(report.dualHand?.inferenceFps > 0)) throw new Error('Unexpected measurement configuration or no stream results')
    const summary = { engine: report.engine, profile: report.profile, delegate: report.delegate, elapsedSeconds: finite(report.elapsedSeconds), observedVideoFps: finite(report.observedVideoFps), renderFps: finite(report.renderFps), overlayP95Ms: finite(report.overlayP95Ms), dualPose: stream(report.dualPose), dualHand: stream(report.dualHand), adaptiveWorkerBudget: report.adaptiveWorkerBudget, leftUpperLimbVisibleFraction: finite(report.leftUpperLimbVisibleFraction), rightUpperLimbVisibleFraction: finite(report.rightUpperLimbVisibleFraction) }
    await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
    const deadline = Date.now() + 10000
    while (page.workers().length && Date.now() < deadline) await page.waitForTimeout(100)
    if (page.workers().length) throw new Error('Worker cleanup timed out')
    await page.getByRole('button', { name: 'Đóng nguồn' }).click()
    await context.close()
    return { adaptive, start, end, summary, longTasks, cpu: cpuSummary(before, after), workers, browser: browser.version() }
  } finally { await browser.close() }
}

;(async () => {
  const videoPath = process.argv[2], rounds = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(rounds) || rounds < 1 || rounds > 4) throw new Error('Usage: node tracking-autoscale-benchmark.cjs <local-video> [1..4]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4266'
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only localhost is allowed')
  const runs = []
  for (let i = 0; i < rounds; i++) for (const adaptive of (i % 2 ? [true, false] : [false, true])) {
    console.error(`Measuring ${adaptive ? 'adaptive' : 'fixed'} run ${i + 1}/${rounds}`)
    runs.push(await measure(videoPath, adaptive, baseURL))
  }
  console.log(JSON.stringify({ warmupSeconds: 3, requestedMeasurementSeconds: 8, runs, limitations: 'Short headless runs; different frames and background load. CPU is all Chrome processes observed at both endpoints, 100% is one logical core, not total machine CPU or physical GPU. CDP may miss short-lived processes. rAF counts loops, not display refresh; callback-to-result is not sensor-to-display latency. Long tasks may be reported late. No accuracy or clinical claim.' }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })

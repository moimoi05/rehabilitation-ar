// Local-only continuous dual-Worker soak using a looping file-backed fake camera.
// Usage: node tracking-autoscale-soak.cjs <local-video> [duration-seconds 60..600] [interval-seconds 15..60]
// The video and landmarks stay in browser memory; only aggregate metrics are printed.
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)

async function resources(session) {
  const begin = performance.now()
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  const end = performance.now()
  const ids = processInfo.map(p => p.id)
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid Chrome process list')
  const command = `$ids=@(${ids.join(',')}); @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 })
  const parsed = JSON.parse(stdout || '[]'), processes = Array.isArray(parsed) ? parsed : [parsed]
  const memory = new Map(processes.map(p => [p.Id, p]))
  return { at: (begin + end) / 2, processes: processInfo.map(p => ({ id: p.id, cpu: p.cpuTime })), memoryComplete: ids.every(id => memory.has(id)),
    privateMiB: ids.reduce((sum, id) => sum + (memory.get(id)?.PrivateMemorySize64 || 0), 0) / 1048576,
    workingMiB: ids.reduce((sum, id) => sum + (memory.get(id)?.WorkingSet64 || 0), 0) / 1048576 }
}

function cpuBetween(a, b) {
  const previous = new Map(a.processes.map(p => [p.id, p.cpu]))
  const sameProcessSet = previous.size === b.processes.length && b.processes.every(p => previous.has(p.id))
  const seconds = (b.at - a.at) / 1000
  return { seconds, sameProcessSet, cpuPercentOneCore: sameProcessSet && seconds > 0 ? 100 * b.processes.reduce((n, p) => n + p.cpu - previous.get(p.id), 0) / seconds : null }
}

;(async () => {
  const videoPath = process.argv[2], duration = Number(process.argv[3] || 150), interval = Number(process.argv[4] || 30)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(duration) || duration < 60 || duration > 600 || !Number.isInteger(interval) || interval < 15 || interval > 60 || duration % interval !== 0) throw new Error('Usage: node tracking-autoscale-soak.cjs <video> [duration 60..600] [interval 15..60], duration divisible by interval')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4270'
  const url = new URL(baseURL)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only localhost is allowed')
  const browser = await chromium.launch({ channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const browserSession = await browser.newBrowserCDPSession()
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
    await context.route('**/*', route => {
      const request = route.request().url()
      if (request.startsWith(`${url.origin}/api/`)) return route.fulfill({ status: 200, json: {} })
      if (request.startsWith(`${url.origin}/`) || request.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    const page = await context.newPage(), events = { created: 0, closed: 0 }
    page.on('worker', worker => { events.created++; worker.on('close', () => events.closed++) })
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL), click = HTMLAnchorElement.prototype.click
      URL.createObjectURL = value => { if (value instanceof Blob && value.type === 'application/json') void value.text().then(text => { window.soakExport = text }); return create(value) }
      HTMLAnchorElement.prototype.click = function () { if (this.download !== 'tracking-benchmark.json') return click.call(this) }
    })
    await page.goto('/tracking-lab')
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'soak-source-file'; document.body.append(input) })
    await page.locator('#soak-source-file').setInputFiles(videoPath)
    const source = await page.evaluate(async () => {
      const input = document.querySelector('#soak-source-file'), file = input.files?.[0]
      if (!file) throw new Error('Local source unavailable')
      const video = document.createElement('video'), objectURL = URL.createObjectURL(file)
      video.src = objectURL; video.muted = true; video.playsInline = true; video.loop = true
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'
      document.body.append(video)
      await video.play()
      if (typeof video.captureStream !== 'function') throw new Error('captureStream unavailable')
      const capture = video.captureStream(), tracks = capture.getVideoTracks()
      if (tracks.length !== 1) throw new Error('Unexpected capture tracks')
      const camera = new MediaStream(tracks)
      let loops = 0; video.addEventListener('seeked', () => { loops++ })
      window.soakSource = { video, objectURL, capture, camera, info: () => ({ loops, mediaTime: video.currentTime, duration: video.duration, rate: video.playbackRate, paused: video.paused, trackState: tracks[0].readyState }) }
      navigator.mediaDevices.getUserMedia = async () => camera
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, trackCount: tracks.length }
    })
    await page.getByLabel('Hand (21 mốc)').check()
    await page.getByLabel('Hai Worker CPU (thử nghiệm)', { exact: true }).check()
    await page.getByLabel('Tự điều chỉnh nhịp Worker').check()
    await page.getByRole('button', { name: 'Bật camera' }).click()
    await page.waitForFunction(() => { const v = document.querySelector('.workspace-image video'); return v && v.srcObject && v.readyState >= 2 })
    await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
    await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
    if (page.workers().length !== 2) throw new Error('Expected two workers after startup')
    await page.waitForTimeout(3000)
    await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
    let previous = await resources(browserSession)
    const initial = { processCount: previous.processes.length, privateMiB: previous.privateMiB, workingMiB: previous.workingMiB, memoryComplete: previous.memoryComplete }
    const windows = []
    for (let i = 1; i <= duration / interval; i++) {
      console.error(`Soak interval ${i}/${duration / interval}`)
      await page.waitForTimeout(interval * 1000)
      if (page.workers().length !== 2 || !await page.getByRole('button', { name: 'Dừng nhận diện' }).isVisible() || !await page.getByRole('button', { name: 'Dừng đo' }).isVisible()) throw new Error('Tracking, measurement, or a Worker stopped unexpectedly')
      const current = await resources(browserSession)
      await page.evaluate(() => { window.soakExport = null })
      await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
      await page.waitForFunction(() => typeof window.soakExport === 'string')
      const sample = await page.evaluate(() => {
        const r = JSON.parse(window.soakExport)
        if (r.engine !== 'parallel' || !r.adaptiveWorkerBudget?.enabled || r.source !== 'camera') throw new Error('Unexpected measurement configuration')
        const s = value => ({ inferenceFps: value?.inferenceFps, inferenceP95Ms: value?.inferenceP95Ms, workerRoundTripP95Ms: value?.workerRoundTripP95Ms, busyFrames: value?.busyFrames, throttledFrames: value?.throttledFrames })
        return { elapsedSeconds: r.elapsedSeconds, videoFps: r.observedVideoFps, renderFps: r.renderFps, pose: s(r.dualPose), hand: s(r.dualHand), budget: r.adaptiveWorkerBudget, source: window.soakSource.info() }
      })
      if (sample.source.rate !== 1 || sample.source.paused || sample.source.trackState !== 'live' || !(sample.pose.inferenceFps > 0) || !(sample.hand.inferenceFps > 0)) throw new Error('Source or inference stopped during soak')
      windows.push({ interval: i, ...sample, resources: { ...cpuBetween(previous, current), processCount: current.processes.length, memoryComplete: current.memoryComplete, privateMiB: current.privateMiB, workingMiB: current.workingMiB } })
      await page.getByRole('button', { name: 'Đặt lại benchmark' }).click()
      previous = current
    }
    await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
    const deadline = Date.now() + 10000
    while (page.workers().length && Date.now() < deadline) await page.waitForTimeout(100)
    if (page.workers().length) throw new Error('Worker cleanup timed out')
    await page.getByRole('button', { name: 'Đóng nguồn' }).click()
    const cleanup = await page.evaluate(() => { const s = window.soakSource; const trackState = s.capture.getVideoTracks()[0]?.readyState; s.video.pause(); s.capture.getTracks().forEach(track => track.stop()); s.video.removeAttribute('src'); s.video.remove(); URL.revokeObjectURL(s.objectURL); document.querySelector('#soak-source-file')?.remove(); return { trackState } })
    await context.close()
    console.log(JSON.stringify({ browser: browser.version(), durationSeconds: duration, intervalSeconds: interval, source, initial, windows, events, cleanup,
      limitations: 'File-backed fake camera via captureStream, video repeats at 1x and introduces discontinuities at loops; not a physical camera or clinical accuracy test. Window samples reset Lab measurement, so in-flight frames may be omitted at boundaries. CPU is Chrome process CPU per logical core, 100% = one core; stable endpoint PIDs cannot rule out short-lived processes. Windows private commit and working set are snapshots, not peaks or GPU memory; working sets may count shared pages. Vite and other system processes excluded. Short soak cannot establish absence of leaks or behavior on other hardware.' }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

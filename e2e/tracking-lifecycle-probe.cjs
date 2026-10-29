// Local-only repeated lifecycle probe. Prints aggregate diagnostics; never writes video or landmarks.
// Usage: node tracking-lifecycle-probe.cjs <local-video> [cycles-per-engine] [active-ms]
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function waitForWorkers(page, expected) {
  const deadline = Date.now() + 10000
  while (page.workers().length !== expected && Date.now() < deadline) await page.waitForTimeout(100)
  if (page.workers().length !== expected) throw new Error(`Expected ${expected} live workers, found ${page.workers().length}`)
}

async function sampleHeap(cdp) {
  // Chromium's V8 heap is only a subset of browser, WASM, and GPU memory.
  await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  const { nodes, jsEventListeners } = await cdp.send('Memory.getDOMCounters')
  return { jsHeapBytes: usedSize, domNodes: nodes, jsEventListeners }
}

;(async () => {
  const videoPath = process.argv[2]
  const cycles = Number(process.argv[3] || 5)
  const activeMs = Number(process.argv[4] || 2000)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(cycles) || cycles < 1 || cycles > 50 || !Number.isInteger(activeMs) || activeMs < 1000 || activeMs > 60000) {
    throw new Error('Usage: node tracking-lifecycle-probe.cjs <local-video> [1..50 cycles] [1000..60000 active-ms]')
  }
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173'
  const origin = new URL(baseURL).origin
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
    const page = await context.newPage()
    // The lab is isolated from the backend and all external origins.
    await page.route('**/*', route => {
      const requestUrl = route.request().url()
      if (requestUrl.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
      if (requestUrl.startsWith(`${origin}/`) || requestUrl.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    await page.addInitScript(() => {
      const state = { createdUrls: 0, revokedUrls: 0, videoCallbacks: new Set(), rafCallbacks: new Set(), intervals: new Set() }
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = value => { state.createdUrls++; return create(value) }
      URL.revokeObjectURL = value => { state.revokedUrls++; return revoke(value) }
      const raf = window.requestAnimationFrame.bind(window), cancelRaf = window.cancelAnimationFrame.bind(window)
      window.requestAnimationFrame = callback => { let id; id = raf(time => { state.rafCallbacks.delete(id); callback(time) }); state.rafCallbacks.add(id); return id }
      window.cancelAnimationFrame = id => { state.rafCallbacks.delete(id); cancelRaf(id) }
      const interval = window.setInterval.bind(window), clearIntervalNative = window.clearInterval.bind(window)
      window.setInterval = (...args) => { const id = interval(...args); state.intervals.add(id); return id }
      window.clearInterval = id => { state.intervals.delete(id); clearIntervalNative(id) }
      const proto = HTMLVideoElement.prototype
      if (typeof proto.requestVideoFrameCallback === 'function') {
        const request = proto.requestVideoFrameCallback, cancel = proto.cancelVideoFrameCallback
        proto.requestVideoFrameCallback = function (callback) {
          let id
          id = request.call(this, (now, metadata) => { state.videoCallbacks.delete(id); callback(now, metadata) })
          state.videoCallbacks.add(id)
          return id
        }
        proto.cancelVideoFrameCallback = function (id) { state.videoCallbacks.delete(id); return cancel.call(this, id) }
      }
      window.lifecycleProbe = () => ({ createdUrls: state.createdUrls, revokedUrls: state.revokedUrls, videoCallbacks: state.videoCallbacks.size, rafCallbacks: state.rafCallbacks.size, intervals: state.intervals.size })
    })
    const workerEvents = { created: 0, closed: 0 }
    page.on('worker', worker => { workerEvents.created++; worker.on('close', () => workerEvents.closed++) })
    await page.goto('/tracking-lab')
    const cdp = await context.newCDPSession(page)
    const baseline = await sampleHeap(cdp)
    const runs = []
    for (const engine of ['main', 'worker']) {
      await page.getByLabel('Worker CPU (thử nghiệm)').setChecked(engine === 'worker')
      for (let cycle = 1; cycle <= cycles; cycle++) {
        console.error(`Testing ${engine} lifecycle ${cycle}/${cycles}`)
        await page.getByLabel('Chọn video MP4').setInputFiles(videoPath)
        const video = page.locator('video')
        await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
        await video.evaluate(v => v.pause())
        await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
        await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
        if (engine === 'worker') await waitForWorkers(page, 1)
        await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
        await video.evaluate(v => v.play())
        await page.waitForFunction(() => {
          const stat = [...document.querySelectorAll('.tracking-stats div')].find(el => el.querySelector('dt')?.textContent === 'FPS suy luận')
          return Number(stat?.querySelector('dd')?.textContent) > 0
        }, null, { timeout: 30000 }).catch(async error => {
          const diagnostic = await page.evaluate(() => ({ fps: [...document.querySelectorAll('.tracking-stats div')].find(el => el.querySelector('dt')?.textContent === 'FPS suy luận')?.querySelector('dd')?.textContent, state: document.querySelector('[role="status"]')?.textContent, video: { paused: document.querySelector('video')?.paused, readyState: document.querySelector('video')?.readyState }, handles: window.lifecycleProbe() }))
          throw new Error(`Inference did not start: ${JSON.stringify(diagnostic)}; ${error.message}`)
        })
        await page.waitForTimeout(activeMs)
        await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
        await waitForWorkers(page, 0)
        await page.getByRole('button', { name: 'Đóng nguồn' }).click()
        // Reset the input so selecting the same file in the next cycle emits change.
        await page.getByLabel('Chọn video MP4').setInputFiles([])
        await page.waitForTimeout(200)
        const handles = await page.evaluate(() => window.lifecycleProbe())
        if (handles.videoCallbacks !== 0 || handles.createdUrls !== handles.revokedUrls) throw new Error(`Cleanup mismatch after ${engine} cycle ${cycle}: ${JSON.stringify(handles)}`)
        runs.push({ engine, cycle, handles, ...(await sampleHeap(cdp)) })
      }
    }
    // Exercise React unmount within the same document so instrumentation survives.
    await page.evaluate(() => { history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) })
    await page.waitForTimeout(500)
    const afterUnmount = { handles: await page.evaluate(() => window.lifecycleProbe()), liveWorkers: page.workers().length, ...(await sampleHeap(cdp)) }
    console.log(JSON.stringify({ browser: browser.version(), cyclesPerEngine: cycles, activeMs, baseline, workerEvents, runs, afterUnmount,
      limitations: 'V8 used heap after forced GC is not total CPU/GPU/WASM memory. Counts are observed through browser APIs and do not prove absence of leaks.' }, null, 2))
    await context.close()
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

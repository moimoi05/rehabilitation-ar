// Local-only exploratory cadence comparison; no video/frame/landmark is saved.
// Run Vite in frontend, then: node tracking-cadence-probe.cjs <local-video> [repetitions 1..4]
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function measure(page, videoPath, mode) {
  await page.goto('/__cadence_probe__')
  await page.locator('input').setInputFiles(videoPath)
  return page.evaluate(async policy => {
    const video = document.querySelector('video')
    const url = URL.createObjectURL(document.querySelector('input').files[0])
    video.src = url
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
    if (video.duration < 12) throw new Error('Video must be at least 12 seconds')
    const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
    const { startVideoFrameScheduler } = await import('/src/features/workspace/videoFrameScheduler.ts')
    const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
    const durations = [], times = [], longTasks = []
    let rafCount = 0, skipped = 0, duplicate = 0, output = 0, active = true, raf = 0, measuredStart = 0, measuredEnd = 0
    const inWindow = () => video.currentTime >= 3 && video.currentTime < 11
    let observer
    try { observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))); observer.observe({ entryTypes: ['longtask'] }) } catch {}
    const draw = () => {
      if (!active) return
      if (inWindow()) { if (!measuredStart) measuredStart = performance.now(); rafCount++ }
      else if (measuredStart && !measuredEnd) measuredEnd = performance.now()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    const infer = ({ now, inferenceTimestamp }) => {
      const record = inWindow()
      const start = performance.now()
      const result = pose.detectForVideo(video, inferenceTimestamp)
      const duration = performance.now() - start
      if (record) { times.push(now); durations.push(duration); if (result.landmarks[0]?.length) output++ }
    }
    const onSkip = reason => { if (inWindow()) { if (reason === 'duplicate') duplicate++; else skipped++ } }
    const startPhase = () => {
      let stopped = false, req = null, lastFrame = null, lastMedia = null, lastRun = -Infinity, lastTimestamp = -Infinity, cost = 0, deadline = null
      const reset = () => { lastFrame = null; lastMedia = null; lastRun = -Infinity; cost = 0; deadline = null }
      video.addEventListener('seeking', reset); video.addEventListener('emptied', reset)
      const loop = (now, metadata) => {
        if (stopped) return
        const id = Number.isSafeInteger(metadata.presentedFrames) && metadata.presentedFrames > 0 ? metadata.presentedFrames : null
        const media = metadata.mediaTime
        if (!video.paused && !video.seeking && video.readyState >= 2 && Number.isFinite(media)) {
          if ((lastMedia !== null && media < lastMedia) || (id !== null && lastFrame !== null && id < lastFrame)) reset()
          if (id !== null ? id === lastFrame : lastMedia === media) onSkip('duplicate')
          else {
            lastFrame = id; lastMedia = media
            const period = 1000 / 24, slack = cost + Math.min(50, cost * .2)
            if ((deadline !== null && now + 0.0001 < deadline) || now - lastRun < slack) onSkip('throttled')
            else {
              deadline = deadline === null || now - deadline >= period ? now + period : deadline + period
              lastRun = now; lastTimestamp = Math.max(now, lastTimestamp + .001)
              const started = performance.now(); infer({ now, mediaTime: media, inferenceTimestamp: lastTimestamp })
              const elapsed = Math.max(0, performance.now() - started); cost = cost ? cost * .75 + elapsed * .25 : elapsed
            }
          }
        }
        req = video.requestVideoFrameCallback(loop)
      }
      req = video.requestVideoFrameCallback(loop)
      return () => { stopped = true; video.removeEventListener('seeking', reset); video.removeEventListener('emptied', reset); if (req !== null) video.cancelVideoFrameCallback(req) }
    }
    await video.play()
    if (!video.requestVideoFrameCallback) throw new Error('Probe requires requestVideoFrameCallback')
    const stop = policy === 'current' ? startVideoFrameScheduler(video, infer, { maxFps: 24, onSkip }) : startPhase()
    await new Promise(resolve => { const check = () => video.ended || video.currentTime >= 11.2 ? resolve() : requestAnimationFrame(check); requestAnimationFrame(check) })
    active = false; cancelAnimationFrame(raf); stop(); video.pause(); observer?.disconnect(); pose.close(); URL.revokeObjectURL(url)
    const sorted = values => [...values].sort((a, b) => a - b)
    const p95 = values => values.length ? sorted(values)[Math.ceil(values.length * .95) - 1] : null
    const gaps = times.slice(1).map((t, i) => t - times[i])
    const wallSeconds = (measuredEnd - measuredStart) / 1000
    const measuredTasks = longTasks.filter(e => e.start >= measuredStart && e.start < measuredEnd)
    return { policy, videoSize: [video.videoWidth, video.videoHeight], playbackRate: video.playbackRate, wallSeconds, calls: times.length, fps: times.length / wallSeconds, p95InferenceMs: p95(durations), meanInferenceMs: durations.reduce((a, b) => a + b, 0) / durations.length, p95GapMs: p95(gaps), rafFps: rafCount / wallSeconds, longTasks: measuredTasks.length, longTaskP95Ms: p95(measuredTasks.map(e => e.duration)), output, skipped, duplicate }
  }, mode)
}

function simulate() {
  const result = {}
  for (const policy of ['current', 'phase']) {
    let last = -Infinity, deadline = null, count = 0
    for (let frame = 0; frame <= 300; frame++) {
      const now = frame * 1000 / 30, period = 1000 / 24
      if (policy === 'current' ? now - last + .0001 < period : deadline !== null && now + .0001 < deadline) continue
      last = now; count++
      if (policy === 'phase') deadline = deadline === null || now - deadline >= period ? now + period : deadline + period
    }
    result[policy] = count
  }
  return result
}

;(async () => {
  const videoPath = process.argv[2], repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 4) throw new Error('Usage: node tracking-cadence-probe.cjs <local-video> [1..4]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4251'
  const origin = new URL(baseURL).origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only localhost is allowed')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const runs = []
    for (let i = 0; i < repetitions; i++) for (const mode of i % 2 ? ['phase', 'current'] : ['current', 'phase']) {
      console.error(`Measuring ${mode}, repetition ${i + 1}/${repetitions}`)
      const context = await browser.newContext({ baseURL })
      try {
        await context.route('**/*', route => {
          const req = route.request().url()
          if (req === `${origin}/__cadence_probe__`) return route.fulfill({ contentType: 'text/html', body: '<input type="file"><video muted playsinline></video>' })
          return req.startsWith(`${origin}/`) || req.startsWith('blob:') ? route.continue() : route.abort()
        })
        runs.push({ repetition: i + 1, ...(await measure(await context.newPage(), videoPath, mode)) })
      } finally { await context.close() }
    }
    console.log(JSON.stringify({ browser: browser.version(), synthetic30FpsOver10SecondsIncludingInitialFrame: simulate(), warmupMediaSeconds: 3, windowMediaSeconds: 8, runs, limitations: 'Independent phase prototype, not application code; CPU Pose Lite, no UI/overlay. Different sampled frames; long-task delivery may lag. No ground truth, CPU/GPU/memory, or camera-to-display latency. Headless and load dependent.' }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

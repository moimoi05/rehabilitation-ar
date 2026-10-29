// Local-only exploratory scheduler benchmark. Prints aggregate metrics only.
// Usage: node tracking-hand-rate-probe.cjs <local-video> [repetitions 1..4]
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function measure(page, videoPath, handRate) {
  await page.goto('/__hand_rate_probe__')
  await page.locator('input').setInputFiles(videoPath)
  return page.evaluate(async rate => {
    const video = document.querySelector('video')
    const url = URL.createObjectURL(document.querySelector('input').files[0])
    video.src = url
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
    if (video.duration < 12) throw new Error('Video must be at least 12 seconds')
    const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
    const { startVideoFrameScheduler } = await import('/src/features/workspace/videoFrameScheduler.ts')
    const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
    const hand = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2 })
    const results = { poseDurations: [], handDurations: [], combinedDurations: [], poseTimes: [], handTimes: [], eligibleLeft: 0, eligibleRight: 0, poseOutput: 0, handOutput: 0, skipped: 0, duplicate: 0, raf: 0 }
    const eligible = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && Number.isFinite(p.visibility) && p.visibility >= .4
    let lastHand = -Infinity, inWindow = false, done = false, raf = 0
    const draw = () => { if (done) return; if (inWindow) results.raf++; raf = requestAnimationFrame(draw) }
    raf = requestAnimationFrame(draw)
    const startWall = performance.now()
    await video.play()
    const stop = startVideoFrameScheduler(video, ({ now, mediaTime, inferenceTimestamp }) => {
      inWindow = mediaTime >= 3 && mediaTime < 11
      const started = performance.now()
      const output = pose.detectForVideo(video, inferenceTimestamp).landmarks[0] || []
      const poseDuration = performance.now() - started
      const doHand = rate > 0 && now - lastHand >= 1000 / rate
      let handDuration = 0, handFound = false
      if (doHand) {
        const before = performance.now()
        handFound = hand.detectForVideo(video, inferenceTimestamp).landmarks.length > 0
        handDuration = performance.now() - before
        lastHand = now
      }
      if (!inWindow) return
      results.poseTimes.push(now); results.poseDurations.push(poseDuration)
      results.combinedDurations.push(performance.now() - started)
      if (output.length) results.poseOutput++
      if ([11, 13, 15].every(i => eligible(output[i]))) results.eligibleLeft++
      if ([12, 14, 16].every(i => eligible(output[i]))) results.eligibleRight++
      if (doHand) { results.handTimes.push(now); results.handDurations.push(handDuration); if (handFound) results.handOutput++ }
    }, { maxFps: 24, onSkip: reason => { if (inWindow) { if (reason === 'duplicate') results.duplicate++; else results.skipped++ } } })
    await new Promise(resolve => { const check = () => video.ended || video.currentTime >= 11.2 ? resolve() : requestAnimationFrame(check); requestAnimationFrame(check) })
    done = true; cancelAnimationFrame(raf); stop(); video.pause(); pose.close(); hand.close(); URL.revokeObjectURL(url)
    const stats = values => {
      const sorted = [...values].sort((a, b) => a - b)
      return { n: sorted.length, mean: sorted.length ? sorted.reduce((sum, n) => sum + n, 0) / sorted.length : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null }
    }
    const gaps = values => stats(values.slice(1).map((n, i) => n - values[i]))
    const { poseTimes, handTimes, poseDurations, handDurations, combinedDurations, ...counts } = results
    return { rate, durationMedia: video.duration, videoSize: [video.videoWidth, video.videoHeight], playbackRate: video.playbackRate, measuredWindowSeconds: 8,
      wallSecondsToStop: (performance.now() - startWall) / 1000, poseFps: poseTimes.length / 8, handFps: handTimes.length / 8,
      poseMs: stats(poseDurations), handMs: stats(handDurations), combinedMs: stats(combinedDurations), poseGapMs: gaps(poseTimes), handGapMs: gaps(handTimes), counts }
  }, handRate)
}

;(async () => {
  const videoPath = process.argv[2], repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 4) throw new Error('Usage: node tracking-hand-rate-probe.cjs <local-video> [1..4]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4231'
  const parsed = new URL(baseURL), origin = parsed.origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Only a localhost origin is allowed')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const runs = []
    for (let i = 0; i < repetitions; i++) {
      const order = i % 2 ? [12, 5, 2, 0] : [0, 2, 5, 12]
      for (const rate of order) {
        console.error(`Measuring Hand target ${rate} Hz, repetition ${i + 1}/${repetitions}`)
        const context = await browser.newContext({ baseURL })
        try {
          await context.route('**/*', route => {
            const url = route.request().url()
            if (url === `${origin}/__hand_rate_probe__`) return route.fulfill({ contentType: 'text/html', body: '<input type="file"><video muted playsinline></video>' })
            if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
            return route.abort()
          })
          runs.push({ repetition: i + 1, ...(await measure(await context.newPage(), videoPath, rate)) })
        } finally { await context.close() }
      }
    }
    console.log(JSON.stringify({ browser: browser.version(), warmupMediaSeconds: 3, windowMediaSeconds: 8, runs,
      limitations: 'Prototype imports the production scheduler but bypasses application UI/overlay. Media-time windows represent 8 s at 1x; per-rate samples differ. Output and visibility counts do not measure accuracy. CPU/GPU/native memory and end-to-end latency are not measured; headless results are device- and load-dependent.' }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

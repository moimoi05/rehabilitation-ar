// Reproducible, local-only filter comparison on predeclared windows. Never writes frames or landmarks.
// Usage: node tracking-filter-fixed-windows.cjs <local-video>
const { chromium } = require('playwright')

;(async () => {
  const videoPath = process.argv[2]
  if (!videoPath) throw new Error('Usage: node tracking-filter-fixed-windows.cjs <local-video>')
  const base = new URL(process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4191')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('A local origin is required')
  const origin = base.origin
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => {
      const url = route.request().url()
      if (url === `${origin}/__fixed_filter__`) return route.fulfill({ contentType: 'text/html', body: '<input type="file"><video muted playsinline></video>' })
      if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    await page.goto(`${origin}/__fixed_filter__`)
    await page.locator('input').setInputFiles(videoPath)
    const result = await page.evaluate(async () => {
      const video = document.querySelector('video')
      const url = URL.createObjectURL(document.querySelector('input').files[0])
      video.src = url
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
      if (video.duration < 11.2) throw new Error('Video must be at least 11.2 seconds')
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      const { LandmarkSmoother, DEFAULT_SMOOTHING_CONFIG, POSE_SMOOTHING_POLICY, SMOOTHING_VERSION } = await import('/src/features/workspace/landmarkSmoothing.ts')
      const { startVideoFrameScheduler } = await import('/src/features/workspace/videoFrameScheduler.ts')
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
      const smoother = new LandmarkSmoother()
      const indices = { leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16 }
      const samples = Object.fromEntries(Object.keys(indices).map(name => [name, []]))
      const ema = new Map(), tau = 100
      let inferences = 0
      await video.play()
      const stop = startVideoFrameScheduler(video, ({ now, mediaTime, inferenceTimestamp }) => {
        const raw = pose.detectForVideo(video, inferenceTimestamp).landmarks[0] || []
        const euro = smoother.filter('pose', raw, now, POSE_SMOOTHING_POLICY)
        inferences++
        for (const [name, index] of Object.entries(indices)) {
          const p = raw[index], q = euro[index]
          if (!p || !q || !Number.isFinite(p.visibility) || p.visibility < .4 || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) { ema.delete(name); continue }
          const prior = ema.get(name), elapsed = prior ? now - prior.time : 0
          const alpha = elapsed > 0 && elapsed <= 500 ? 1 - Math.exp(-elapsed / tau) : 1
          const point = { x: prior && alpha < 1 ? prior.x + alpha * (p.x - prior.x) : p.x, y: prior && alpha < 1 ? prior.y + alpha * (p.y - prior.y) : p.y, time: now }
          ema.set(name, point)
          samples[name].push({ time: now, mediaTime, raw: { x: p.x, y: p.y }, ema: point, euro: { x: q.x, y: q.y } })
        }
      }, { maxFps: 24 })
      await new Promise(resolve => { const tick = () => video.ended || video.currentTime >= 11.2 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick) })
      stop(); pose.close(); video.pause(); URL.revokeObjectURL(url)
      // x is scaled by aspect ratio so distances are in image-height units.
      const aspect = video.videoWidth / video.videoHeight
      const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y)
      const windows = [[3, 5], [5, 7], [7, 9], [9, 11]]
      const results = Object.fromEntries(Object.entries(samples).map(([name, all]) => [name, windows.map(([start, end]) => {
        const points = all.filter(p => p.mediaTime >= start && p.mediaTime < end)
        if (points.length < 10 || points.at(-1).mediaTime - points[0].mediaTime < 1.5 || points.some((p, i) => i && p.time - points[i - 1].time > 500)) return { start, end, valid: false, observations: points.length }
        const path = key => points.slice(1).reduce((sum, p, i) => sum + distance(p[key], points[i][key]), 0)
        const rawPath = path('raw')
        const meanOffset = key => Math.sqrt(points.reduce((sum, p) => sum + distance(p.raw, p[key]) ** 2, 0) / points.length)
        const base = points.filter(p => p.time <= points.at(-1).time - 500)
        const lag = key => {
          const scores = []
          for (let shift = 0; shift <= 500; shift += 10) {
            const squared = base.map(p => {
              const target = p.time + shift, index = points.findIndex(q => q.time >= target)
              if (index < 0) return NaN
              if (!index) return distance(p.raw, points[0][key]) ** 2
              const a = points[index - 1], b = points[index], f = (target - a.time) / (b.time - a.time)
              return distance(p.raw, { x: a[key].x + f * (b[key].x - a[key].x), y: a[key].y + f * (b[key].y - a[key].y) }) ** 2
            })
            if (squared.length >= 5 && squared.every(Number.isFinite)) scores.push({ shift, error: squared.reduce((a, b) => a + b, 0) / squared.length })
          }
          return scores.length ? scores.reduce((best, current) => current.error < best.error ? current : best).shift : null
        }
        return { start, end, valid: true, observations: points.length, rawPathHeightUnits: rawPath,
          emaPathRatio: rawPath ? path('ema') / rawPath : null, euroPathRatio: rawPath ? path('euro') / rawPath : null,
          emaRmsOffset: meanOffset('ema'), euroRmsOffset: meanOffset('euro'), emaBestShiftMs: lag('ema'), euroBestShiftMs: lag('euro') }
      })]))
      return { video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration }, inferences, version: SMOOTHING_VERSION, config: DEFAULT_SMOOTHING_CONFIG, emaTauMs: tau, results,
        method: 'Fixed 2s media-time windows [3,5), [5,7), [7,9), [9,11); >=10 eligible points, >=1.5s covered, no >500ms callback gap. Distance uses image-height units.',
        limitations: 'Path and alignment compare filter to raw model outputs; neither is ground truth, physical jitter, nor motion-to-photon delay. Windows can contain genuine motion and tracking errors.' }
    })
    console.log(JSON.stringify(result, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

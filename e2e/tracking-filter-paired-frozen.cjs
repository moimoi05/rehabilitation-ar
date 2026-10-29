// Paired fixed-image comparison: candidates receive identical model observations.
// Local-only; no frame or landmark is saved or transmitted.
// Usage: node tracking-filter-paired-frozen.cjs <local-video>
// Synthetic 30 Hz timestamps do NOT represent actual motion or physical latency.
const { chromium } = require('playwright')

;(async () => {
  const videoPath = process.argv[2]
  if (!videoPath) throw new Error('Provide the local video path')
  const base = new URL(process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4211')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('A local origin is required')
  const origin = base.origin
  const browser = await chromium.launch({ channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => {
      const requestUrl = route.request().url()
      if (requestUrl === `${origin}/__frozen_filter__`) return route.fulfill({ contentType: 'text/html', body: '<input type="file"><video muted playsinline></video><canvas></canvas>' })
      if (requestUrl.startsWith(`${origin}/`) || requestUrl.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    await page.goto(`${origin}/__frozen_filter__`)
    await page.locator('input').setInputFiles(videoPath)
    const data = await page.evaluate(async () => {
      const video = document.querySelector('video'), canvas = document.querySelector('canvas')
      const url = URL.createObjectURL(document.querySelector('input').files[0])
      video.src = url
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
      if (!Number.isFinite(video.duration) || video.duration < 11.5) throw new Error('Video must be at least 11.5 seconds')
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      const { LandmarkSmoother, SMOOTHING_VERSION, DEFAULT_SMOOTHING_CONFIG, POSE_SMOOTHING_POLICY } = await import('/src/features/workspace/landmarkSmoothing.ts')
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const joints = { leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16 }
      const aspect = canvas.width / canvas.height
      const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y)
      const results = []
      try {
        for (const mediaTime of [3, 5, 7, 9, 11]) {
          await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; video.currentTime = mediaTime })
          context.drawImage(video, 0, 0)
          const model = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
          const candidates = { current: {}, responsive: { beta: 2 }, light: { minCutoff: 2 }, lightResponsive: { minCutoff: 2, beta: 2 } }
      const smoothers = Object.fromEntries(Object.entries(candidates).map(([name, config]) => [name, new LandmarkSmoother(config)]))
          const emaState = new Map()
          const samples = Object.fromEntries(Object.keys(joints).map(name => [name, []]))
          let poseFrames = 0
          try {
            for (let index = 0; index < 75; index++) {
              const time = index * 1000 / 30
              const raw = model.detectForVideo(canvas, time).landmarks[0] || []
              if (raw.length) poseFrames++
              const filtered = Object.fromEntries(Object.entries(smoothers).map(([name, smoother]) => [name, smoother.filter('pose', raw, time, POSE_SMOOTHING_POLICY)]))
              for (const [name, joint] of Object.entries(joints)) {
                const point = raw[joint]
                const valid = point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.visibility) && point.visibility >= .4 && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
                if (!valid) { emaState.delete(name); continue }
                const previous = emaState.get(name), alpha = 1 - Math.exp(-(1000 / 30) / 100)
                const ema = previous ? { x: previous.x + alpha * (point.x - previous.x), y: previous.y + alpha * (point.y - previous.y) } : { x: point.x, y: point.y }
                emaState.set(name, ema)
                if (index >= 15) samples[name].push({ raw: { x: point.x, y: point.y }, ema, ...Object.fromEntries(Object.keys(candidates).map(key => [key, { x: filtered[key][joint].x, y: filtered[key][joint].y }])) })
              }
            }
          } finally { model.close() }
          const summary = Object.fromEntries(Object.entries(samples).map(([name, observations]) => {
            if (observations.length < 40) return [name, { eligible: observations.length, sufficient: false }]
            const rms = key => {
              const avg = { x: observations.reduce((sum, p) => sum + p[key].x, 0) / observations.length, y: observations.reduce((sum, p) => sum + p[key].y, 0) / observations.length }
              return Math.sqrt(observations.reduce((sum, p) => sum + distance(p[key], avg) ** 2, 0) / observations.length)
            }
            const offset = key => Math.sqrt(observations.reduce((sum, p) => sum + distance(p.raw, p[key]) ** 2, 0) / observations.length)
            return [name, { eligible: observations.length, sufficient: true, rawRms: rms('raw'), filters: Object.fromEntries(['ema', ...Object.keys(candidates)].map(key => [key, { rms: rms(key), offset: offset(key) }])) }]
          }))
          results.push({ mediaTime, poseFrames, joints: summary })
        }
      } finally { URL.revokeObjectURL(url) }
      return { video: { width: canvas.width, height: canvas.height, duration: video.duration }, timestampFps: 30, repetitions: 75, warmup: 15, version: SMOOTHING_VERSION, config: DEFAULT_SMOOTHING_CONFIG, candidates: { current: {}, responsive: { beta: 2 }, light: { minCutoff: 2 }, lightResponsive: { minCutoff: 2, beta: 2 } }, emaTauMs: 100, results,
        limitations: 'Each still is a real video frame but repeated with synthetic timestamps; outputs are not actual motion, true stationary jitter, accuracy or physical latency. Distances use image-height units.' }
    })
    console.log(JSON.stringify(data, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

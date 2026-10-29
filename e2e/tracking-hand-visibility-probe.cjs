// Local-only Hand Landmarker visibility probe. Outputs counts, never pixels or landmarks.
// Usage: node tracking-hand-visibility-probe.cjs <local-video>
const { chromium } = require('playwright')

;(async () => {
  const videoPath = process.argv[2]
  if (!videoPath) throw new Error('Provide a local video path')
  const origin = new URL(process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4215').origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Localhost required')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => {
      const url = route.request().url()
      if (url === `${origin}/__hand_probe__`) return route.fulfill({ contentType: 'text/html', body: '<input type="file"><video muted playsinline></video>' })
      return url.startsWith(`${origin}/`) || url.startsWith('blob:') ? route.continue() : route.abort()
    })
    await page.goto(`${origin}/__hand_probe__`)
    await page.locator('input').setInputFiles(videoPath)
    const result = await page.evaluate(async () => {
      const video = document.querySelector('video')
      const objectUrl = URL.createObjectURL(document.querySelector('input').files[0])
      video.src = objectUrl
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
      const { FilesetResolver, HandLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const model = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2 })
      let frames = 0, framesWithHands = 0, hands = 0, landmarks = 0, missing = 0, zero = 0, belowThreshold = 0, finiteCoordinates = 0, inFrame = 0
      try {
        for (let time = .25; time < video.duration - .1; time += .25) {
          const seek = new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject })
          video.currentTime = time; await seek
          const result = model.detectForVideo(video, time * 1000)
          frames++
          if (result.landmarks.length) framesWithHands++
          for (const hand of result.landmarks) {
            hands++
            for (const point of hand) {
              landmarks++
              if (point.visibility === undefined) missing++
              if (point.visibility === 0) zero++
              if (typeof point.visibility === 'number' && point.visibility < .4) belowThreshold++
              if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
                finiteCoordinates++
                if (point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1) inFrame++
              }
            }
          }
        }
      } finally { model.close(); URL.revokeObjectURL(objectUrl) }
      return { frames, framesWithHands, hands, landmarks, missingVisibility: missing, zeroVisibility: zero, belowVisibility04: belowThreshold, finiteCoordinates, inFrame }
    })
    console.log(JSON.stringify({ browser: browser.version(), sampleIntervalSeconds: .25, result }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

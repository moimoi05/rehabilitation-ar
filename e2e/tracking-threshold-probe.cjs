// Local-only paired Pose threshold probe. It outputs aggregates, never frames or landmarks.
// Usage: node tracking-threshold-probe.cjs <local-video>
const { chromium } = require('playwright')

;(async () => {
  const videoPath = process.argv[2]
  if (!videoPath) throw new Error('Provide a local video path.')
  const baseUrl = (process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' })
  try {
    const page = await browser.newPage()
    // Restrict requests to local Vite. The video is chosen through the browser file input.
    await page.route('**/*', route => {
      const url = route.request().url()
      if (url === `${baseUrl}/__threshold_fixture__`) {
        return route.fulfill({ contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' })
      }
      if (url.startsWith(`${baseUrl}/`) || url.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    await page.goto(`${baseUrl}/__threshold_fixture__`)
    await page.locator('#file').setInputFiles(videoPath)
    const result = await page.evaluate(async () => {
      const video = document.querySelector('#v')
      const objectUrl = URL.createObjectURL(document.querySelector('#file').files[0])
      video.src = objectUrl
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      // The second default tracker estimates differences unrelated to threshold.
      const thresholds = { low: 0.3, default: 0.5, control: 0.5, high: 0.7 }
      const names = Object.keys(thresholds)
      const models = {}
      try {
        for (const name of names) {
          const threshold = thresholds[name]
          models[name] = await PoseLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' },
            runningMode: 'VIDEO', numPoses: 1,
            minPoseDetectionConfidence: threshold,
            minPosePresenceConfidence: threshold,
            minTrackingConfidence: threshold,
          })
        }
        const joints = [['shoulderL', 11], ['shoulderR', 12], ['elbowL', 13], ['elbowR', 14], ['wristL', 15], ['wristR', 16]]
        const eligible = point => point && Number.isFinite(point.x) && Number.isFinite(point.y)
          && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
          && Number.isFinite(point.visibility) && point.visibility >= 0.4
        const measurements = Object.fromEntries(names.map(name => [name, {
          poses: 0, leftLimb: 0, rightLimb: 0, joints: Object.fromEntries(joints.map(([label]) => [label, 0])), times: [],
        }]))
        const comparisons = Object.fromEntries(['low', 'control', 'high'].map(name => [name, Object.fromEntries(joints.map(([label]) => [label, { both: 0, distances: [] }]))]))
        let samples = 0, ordinal = 0
        for (let time = .5; time < video.duration - .25; time += .5) {
          const seek = new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject })
          video.currentTime = time
          await seek
          const output = {}
          // Rotate order to avoid systematically favoring the same configuration.
          const offset = ordinal++ % names.length
          for (const name of [...names.slice(offset), ...names.slice(0, offset)]) {
            const before = performance.now()
            output[name] = models[name].detectForVideo(video, time * 1000).landmarks[0]
            if (time >= 3) measurements[name].times.push(performance.now() - before)
          }
          if (time < 3) continue
          samples++
          for (const name of names) {
            const points = output[name], m = measurements[name]
            if (points?.length) m.poses++
            if ([11, 13, 15].every(index => eligible(points?.[index]))) m.leftLimb++
            if ([12, 14, 16].every(index => eligible(points?.[index]))) m.rightLimb++
            for (const [label, index] of joints) if (eligible(points?.[index])) m.joints[label]++
          }
          for (const name of ['low', 'control', 'high']) for (const [label, index] of joints) {
            const a = output.default?.[index], b = output[name]?.[index], comparison = comparisons[name][label]
            if (eligible(a) && eligible(b)) { comparison.both++; comparison.distances.push(Math.hypot(a.x - b.x, a.y - b.y)) }
          }
        }
        const stats = values => {
          const sorted = [...values].sort((a, b) => a - b)
          return { mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
            p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null }
        }
        return {
          video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration },
          thresholds, samples,
          measurements: Object.fromEntries(names.map(name => {
            const { times, ...other } = measurements[name]
            return [name, { ...other, timingMs: stats(times) }]
          })),
          comparisons: Object.fromEntries(Object.entries(comparisons).map(([name, labels]) => [name,
            Object.fromEntries(Object.entries(labels).map(([label, { both, distances }]) => [label, { both, distance: stats(distances) }]))])),
          userAgent: navigator.userAgent,
        }
      } finally {
        for (const model of Object.values(models)) model.close()
        URL.revokeObjectURL(objectUrl)
      }
    })
    console.log(JSON.stringify(result, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

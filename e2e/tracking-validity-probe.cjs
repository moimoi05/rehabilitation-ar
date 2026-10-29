// Local-only landmark validity diagnostic. Prints counts, never video frames or landmark coordinates.
// Usage: node tracking-validity-probe.cjs <local-video> [maxFps]
const { chromium } = require('playwright')
;(async () => {
  const videoPath = process.argv[2], maxFps = Number(process.argv[3] || 24)
  if (!videoPath || !Number.isFinite(maxFps) || maxFps < 1 || maxFps > 60) throw new Error('Expected video path and max FPS 1–60')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173'
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await browser.newPage()
    await page.route(`${baseURL}/__validity_fixture__`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="file" id="file"><video id="v" muted playsinline></video>' }))
    await page.goto(`${baseURL}/__validity_fixture__`)
    await page.locator('#file').setInputFiles(videoPath)
    const result = await page.evaluate(async maxFps => {
      const video = document.querySelector('#v'), url = URL.createObjectURL(document.querySelector('#file').files[0])
      video.src = url
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
      if (!Number.isFinite(video.duration) || video.duration < 11) throw new Error('video too short')
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      const { startVideoFrameScheduler } = await import('/src/features/workspace/videoFrameScheduler.ts')
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const pose = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
      const indices = { leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16 }
      const emptyJoint = () => ({ missing: 0, invalid: 0, lowVisibility: 0, outsideX: 0, outsideY: 0, above: 0, below: 0, outside: 0, eligible: 0 })
      const bins = Array.from({ length: 4 }, (_, index) => ({ mediaFrom: 3 + 2 * index, mediaTo: 5 + 2 * index, count: 0, pose: 0, left: 0, right: 0, joints: Object.fromEntries(Object.keys(indices).map(name => [name, emptyJoint()])) }))
      await video.play()
      const stop = startVideoFrameScheduler(video, ({ mediaTime, inferenceTimestamp }) => {
        const points = pose.detectForVideo(video, inferenceTimestamp).landmarks[0] || []
        const bin = bins.find(value => mediaTime >= value.mediaFrom && mediaTime < value.mediaTo)
        if (!bin) return
        bin.count++; if (points.length) bin.pose++
        const good = {}
        for (const [name, index] of Object.entries(indices)) {
          const item = bin.joints[name], point = points[index]
          if (!point) { item.missing++; good[name] = false; continue }
          const finite = Number.isFinite(point.x) && Number.isFinite(point.y)
          const visibility = Number.isFinite(point.visibility) && point.visibility >= .4
          const outsideX = finite && (point.x < 0 || point.x > 1), outsideY = finite && (point.y < 0 || point.y > 1)
          if (!finite) item.invalid++
          if (!visibility) item.lowVisibility++
          if (outsideX) item.outsideX++
          if (outsideY) { item.outsideY++; if (point.y < 0) item.above++; else item.below++ }
          if (outsideX || outsideY) item.outside++
          good[name] = finite && visibility && !outsideX && !outsideY
          if (good[name]) item.eligible++
        }
        if (good.leftShoulder && good.leftElbow && good.leftWrist) bin.left++
        if (good.rightShoulder && good.rightElbow && good.rightWrist) bin.right++
      }, { maxFps })
      await new Promise(resolve => { const tick = () => { if (video.ended || video.currentTime >= 11.5) resolve(); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
      stop(); pose.close(); video.pause(); URL.revokeObjectURL(url)
      return { maxFps, duration: video.duration, bins, note: 'Counts may overlap; inside-image and visibility are separate predicates. Aggregate counts are model output, not ground truth.' }
    }, maxFps)
    console.log(JSON.stringify(result, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

// Browser integration check for MediaPipe loader ownership. No video is used.
// Run the Vite dev server first, then: node tracking-loader-probe.cjs
const { chromium } = require('playwright')

;(async () => {
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:5173'
  const origin = new URL(baseURL).origin
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort())
    await page.goto(baseURL)
    const result = await page.evaluate(async () => {
      const { withOwnedMediaPipeLoader } = await import('/src/features/workspace/mediaPipeLoader.ts')
      const { FilesetResolver, PoseLandmarker } = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const unrelated = document.createElement('script')
      unrelated.src = files.wasmLoaderPath
      await new Promise((resolve, reject) => { unrelated.onload = resolve; unrelated.onerror = reject; document.body.appendChild(unrelated) })
      const options = { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 }
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480
      const runs = []
      for (let i = 0; i < 3; i++) {
        const model = await withOwnedMediaPipeLoader(files, isolated => PoseLandmarker.createFromOptions(isolated, options))
        const output = model.detectForVideo(canvas, 100)
        model.close()
        runs.push({ outputIsLandmarkArray: Array.isArray(output.landmarks), unrelatedConnected: unrelated.isConnected, markedScripts: document.querySelectorAll('script[src*="rehab-loader-"]').length })
      }
      let release
      const gate = new Promise(resolve => { release = resolve })
      const pending = withOwnedMediaPipeLoader(files, async isolated => { await gate; return PoseLandmarker.createFromOptions(isolated, options) })
      let failed = false
      try {
        await withOwnedMediaPipeLoader(files, isolated => PoseLandmarker.createFromOptions(isolated, { ...options, baseOptions: { ...options.baseOptions, modelAssetPath: '/models/missing.task' } }))
      } catch { failed = true }
      release()
      const resumed = await pending
      const resumedOutput = resumed.detectForVideo(canvas, 100)
      resumed.close()
      const summary = { runs, failed, resumedOutputIsLandmarkArray: Array.isArray(resumedOutput.landmarks), unrelatedConnected: unrelated.isConnected, markedScripts: document.querySelectorAll('script[src*="rehab-loader-"]').length }
      unrelated.remove()
      return summary
    })
    if (!result.failed || !result.resumedOutputIsLandmarkArray || !result.unrelatedConnected || result.markedScripts !== 0 || result.runs.some(run => !run.outputIsLandmarkArray || !run.unrelatedConnected || run.markedScripts !== 0)) {
      throw new Error(`Loader ownership check failed: ${JSON.stringify(result)}`)
    }
    console.log(JSON.stringify({ browser: browser.version(), ...result }, null, 2))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

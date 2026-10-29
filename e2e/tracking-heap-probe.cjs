// Local-only, synthetic-input model lifecycle probe; no private video is read.
// Usage: node tracking-heap-probe.cjs [cycles, 1..50] [owned|owned-no-inference|raw|script-fixed|script-fragment|large-fixed|large-fragment]
const { chromium } = require('playwright')

;(async () => {
  const cycles = Number(process.argv[2] || 25)
  const mode = process.argv[3] || 'owned'
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 50 || !['owned', 'owned-no-inference', 'raw', 'script-fixed', 'script-fragment', 'large-fixed', 'large-fragment'].includes(mode)) throw new Error('Usage: node tracking-heap-probe.cjs [1..50] [owned|owned-no-inference|raw|script-fixed|script-fragment|large-fixed|large-fragment]')
  const baseURL = (process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4192').replace(/\/$/, '')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' })
  try {
    const context = await browser.newContext({ baseURL })
    const page = await context.newPage()
    await page.route('**/*', route => {
      const url = route.request().url()
      if (url === `${baseURL}/__heap_probe__`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Model heap probe</title>' })
      if (url === `${baseURL}/__large_probe__.js`) return route.fulfill({ contentType: 'application/javascript', body: 'globalThis.heapDummy = 1;/*' + 'x'.repeat(322000) + '*/' })
      return url.startsWith(`${baseURL}/`) ? route.continue() : route.abort()
    })
    await page.goto('/__heap_probe__')
    await page.evaluate(async () => {
      window.heapProbeVision = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      window.heapProbeHelper = await import('/src/features/workspace/mediaPipeLoader.ts')
      window.heapProbeFiles = await window.heapProbeVision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
      window.heapProbeCanvas = document.createElement('canvas')
      window.heapProbeCanvas.width = 320; window.heapProbeCanvas.height = 240
      window.heapProbeRefs = []
    })
    const cdp = await context.newCDPSession(page)
    const sample = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      await page.waitForTimeout(100)
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      const dom = await cdp.send('Memory.getDOMCounters')
      const live = await page.evaluate(() => ({ liveModels: window.heapProbeRefs.filter(ref => ref.deref()).length, loaderScripts: [...document.scripts].filter(s => s.src.includes('vision_wasm_internal.js')).length }))
      return { usedBytes: heap.usedSize, backingStorageBytes: heap.backingStorageSize ?? null, domNodes: dom.nodes, listeners: dom.jsEventListeners, ...live }
    }
    const baseline = await sample(), samples = []
    for (let i = 0; i < cycles; i++) {
      await page.evaluate(async ({ modeName, ordinal }) => {
        if (modeName.startsWith('script-') || modeName.startsWith('large-')) {
          const script = document.createElement('script')
          const path = modeName.startsWith('large-') ? '/__large_probe__.js' : '/mediapipe/wasm/vision_wasm_internal.js'
          script.src = `${path}${modeName.endsWith('-fragment') ? `#probe-${ordinal}` : ''}`
          await new Promise((resolve, reject) => { script.addEventListener('load', resolve, { once: true }); script.addEventListener('error', reject, { once: true }); document.body.appendChild(script) })
          script.remove()
          delete window.ModuleFactory
          delete window.Module
          return
        }
        const { PoseLandmarker } = window.heapProbeVision
        const create = files => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
        const model = modeName.startsWith('owned') ? await window.heapProbeHelper.withOwnedMediaPipeLoader(window.heapProbeFiles, create) : await create(window.heapProbeFiles)
        if (modeName !== 'owned-no-inference') model.detectForVideo(window.heapProbeCanvas, 0)
        window.heapProbeRefs.push(new WeakRef(model))
        model.close()
      }, { modeName: mode, ordinal: i })
      samples.push(await sample())
      console.error(`Completed ${mode} model ${i + 1}/${cycles}`)
    }
    console.log(JSON.stringify({ browser: browser.version(), mode, cycles, baseline, samples, limitations: 'Synthetic canvas only; V8 used heap and backing storage do not cover all native/WASM/GPU resources. WeakRef liveness is observational, not proof of ownership or leak freedom.' }, null, 2))
    await context.close()
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

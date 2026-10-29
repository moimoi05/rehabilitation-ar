// Local synthetic-only Worker lifecycle probe. No private video or image is used.
// Start Vite, then: node tracking-worker-memory-probe.cjs [cycles] [worker|main]
const { chromium } = require('playwright')

;(async () => {
  const cycles = Number(process.argv[2] || 12)
  const engine = process.argv[3] || 'worker'
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 50 || !['main', 'worker'].includes(engine)) throw new Error('Usage: node tracking-worker-memory-probe.cjs [1..50] [worker|main]')
  const baseURL = (process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4203').replace(/\/$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('A localhost URL is required')
  const browser = await chromium.launch({ channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', headless: true })
  try {
    const context = await browser.newContext({ baseURL })
    const page = await context.newPage()
    await page.route('**/*', route => {
      const url = route.request().url()
      if (url === `${baseURL}/__worker_memory__`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Worker memory probe</title>' })
      return url.startsWith(`${baseURL}/`) ? route.continue() : route.abort()
    })
    await page.goto('/__worker_memory__')
    if (engine === 'main') await page.evaluate(async () => {
      window.probeVision = await import('/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
      window.probeHelper = await import('/src/features/workspace/mediaPipeLoader.ts')
      window.probeFiles = await window.probeVision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
    })
    const pageCdp = await context.newCDPSession(page)
    const mainHeap = async () => {
      await pageCdp.send('HeapProfiler.collectGarbage')
      await page.waitForTimeout(100)
      await pageCdp.send('HeapProfiler.collectGarbage')
      const heap = await pageCdp.send('Runtime.getHeapUsage')
      const dom = await pageCdp.send('Memory.getDOMCounters')
      return { usedBytes: heap.usedSize, backingStorageBytes: heap.backingStorageSize ?? null, domNodes: dom.nodes, listeners: dom.jsEventListeners }
    }
    const baseline = await mainHeap()
    const samples = []
    for (let i = 0; i < cycles; i++) {
      const cycle = await page.evaluate(async engineName => {
        const started = performance.now()
        if (engineName === 'main') {
          const model = await window.probeHelper.withOwnedMediaPipeLoader(window.probeFiles, files => window.probeVision.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 }))
          try {
            const readyMs = performance.now() - started
            const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240
            const inferenceStart = performance.now()
            model.detectForVideo(canvas, 1)
            return { readyMs, inferenceMs: performance.now() - inferenceStart }
          } finally { model.close() }
        }
        const worker = new Worker('/tracking-worker.js')
        window.probeWorker = worker
        const request = message => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker timed out')), 60000)
          worker.onmessage = e => { clearTimeout(timer); e.data.type === 'error' ? reject(new Error(e.data.message)) : resolve(e.data) }
          worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)) }
          worker.postMessage(message)
        })
        try {
          await request({ type: 'init', moduleUrl: `${location.origin}/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs`, handEnabled: false })
          const readyMs = performance.now() - started
          const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240
          const bitmap = await createImageBitmap(canvas)
          const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker inference timed out')), 30000)
            worker.onmessage = e => { clearTimeout(timer); e.data.type === 'error' ? reject(new Error(e.data.message)) : resolve(e.data) }
            worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)) }
            worker.postMessage({ type: 'frame', id: 1, bitmap, timestamp: 1, hand: false }, [bitmap])
          })
          if (result.type !== 'result') throw new Error('Unexpected Worker response')
          return { readyMs, inferenceMs: result.inferenceMs }
        } finally { worker.terminate(); delete window.probeWorker }
      }, engine)
      // Wait for termination event before taking a main-isolate heap sample.
      await page.waitForFunction(() => !window.probeWorker)
      const deadline = Date.now() + 5000
      while (page.workers().length && Date.now() < deadline) await page.waitForTimeout(50)
      if (page.workers().length) throw new Error('Worker did not terminate')
      samples.push({ cycle: i + 1, ...cycle, ...(await mainHeap()) })
      console.error(`Completed ${engine} ${i + 1}/${cycles}`)
    }
    console.log(JSON.stringify({ browser: browser.version(), engine, baseline, samples, limitations: 'Synthetic canvas only. Main V8 isolate statistics exclude Worker heap, renderer native/WASM memory and GPU memory; termination and bounded samples do not prove absence of leaks. Baselines and load order differ between engines.' }, null, 2))
    await context.close()
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

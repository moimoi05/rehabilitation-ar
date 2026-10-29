// Isolate MediaPipe model construction/close; no video, frames, or patient data.
// Usage: node tracking-model-lifecycle-probe.cjs [cycles]
const { chromium } = require('playwright')
const { readdirSync } = require('node:fs')
const path = require('node:path')

;(async () => {
  const cycles = Number(process.argv[2] || 8)
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 50) throw new Error('Provide 1..50 cycles')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4188'
  const moduleName = readdirSync(path.join(__dirname, '../frontend/dist/assets')).find(name => /^vision_bundle-.*\.mjs$/.test(name))
  if (!moduleName) throw new Error('Build the frontend before running this probe')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' })
  try {
    const context = await browser.newContext({ baseURL })
    const page = await context.newPage()
    await page.route('**/*', route => {
      const requestUrl = route.request().url()
      if (requestUrl === `${baseURL}/__model_lifecycle__`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Model lifecycle probe</title>' })
      if (requestUrl.startsWith(`${baseURL}/`) || requestUrl.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    await page.addInitScript(() => {
      const refs = [], scripts = [], counts = { canvasesCreated: 0, canvasListenersAdded: 0, canvasListenersRemoved: 0, scriptsCreated: 0, scriptListenersAdded: 0, scriptListenersRemoved: 0 }
      const create = document.createElement.bind(document)
      document.createElement = function (name, ...args) {
        const element = create(name, ...args)
        if (name.toLowerCase() === 'canvas') { counts.canvasesCreated++; refs.push(new WeakRef(element)) }
        if (name.toLowerCase() === 'script') { counts.scriptsCreated++; scripts.push(new WeakRef(element)) }
        return element
      }
      const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
      EventTarget.prototype.addEventListener = function (...args) { if (this instanceof HTMLCanvasElement) counts.canvasListenersAdded++; if (this instanceof HTMLScriptElement) counts.scriptListenersAdded++; return add.apply(this, args) }
      EventTarget.prototype.removeEventListener = function (...args) { if (this instanceof HTMLCanvasElement) counts.canvasListenersRemoved++; if (this instanceof HTMLScriptElement) counts.scriptListenersRemoved++; return remove.apply(this, args) }
      window.modelProbe = () => ({ ...counts, canvasesStillReachable: refs.filter(ref => ref.deref()).length, scriptsStillReachable: scripts.filter(ref => ref.deref()).length, connectedScripts: [...document.scripts].map(script => new URL(script.src, location.href).pathname) })
    })
    await page.goto('/__model_lifecycle__')
    const cdp = await context.newCDPSession(page)
    const sample = async () => { await cdp.send('HeapProfiler.collectGarbage'); const dom = await cdp.send('Memory.getDOMCounters'); const heap = await cdp.send('Runtime.getHeapUsage'); return { nodes: dom.nodes, jsEventListeners: dom.jsEventListeners, jsHeapBytes: heap.usedSize, canvas: await page.evaluate(() => window.modelProbe()) } }
    const baseline = await sample()
    const control = []
    for (let i = 0; i < cycles; i++) {
      await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.addEventListener('example', () => {}); canvas.addEventListener('example2', () => {}) })
      control.push(await sample())
    }
    const models = []
    for (let i = 0; i < cycles; i++) {
      await page.evaluate(async moduleUrl => {
        const { FilesetResolver, PoseLandmarker } = await import(moduleUrl)
        const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
        const model = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 1 })
        model.close()
      }, `/assets/${moduleName}`)
      models.push(await sample())
    }
    console.log(JSON.stringify({ browser: browser.version(), cycles, baseline, control, models, limitations: 'Heap and DOM counts are browser diagnostics; WeakRef observations and event-listener counts do not establish retained-byte ownership or leak-free behavior.' }, null, 2))
    await context.close()
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

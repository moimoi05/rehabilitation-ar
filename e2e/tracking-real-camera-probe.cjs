// Optional real-camera smoke test. Uses an ephemeral context and only prints aggregate data.
// It never records video, audio, screenshots, traces, frames, or landmarks.
// Run locally: TRACKING_BENCH_URL=http://127.0.0.1:4198 node tracking-real-camera-probe.cjs
const { chromium } = require('playwright')

;(async () => {
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4198'
  const origin = new URL(baseURL).origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('The probe requires a localhost origin.')
  const browser = await chromium.launch({ headless: true, channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome' })
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, permissions: ['camera'] })
    try {
      const page = await context.newPage()
      await page.route('**/*', route => {
        const url = route.request().url()
        if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
        if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
        return route.abort()
      })
      await page.goto('/tracking-lab')
      const device = await page.evaluate(async () => {
        const list = await navigator.mediaDevices.enumerateDevices()
        const cameras = list.filter(item => item.kind === 'videoinput')
        const camera = cameras.find(item => /^LGE Camera(?:\s*\([^)]*\))?$/i.test(item.label.trim()))
        return { camera: camera ? { id: camera.deviceId, label: camera.label } : null, visibleLabels: cameras.map(item => item.label) }
      })
      if (!device.camera) { console.log(JSON.stringify({ opened: false, reason: 'LGE Camera not visible to the browser; no alternate camera was opened.', visibleLabels: device.visibleLabels })); return }
      await page.evaluate(({ id }) => {
        const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        const state = { streams: [], watchdog: null }
        window.realCameraProbe = state
        navigator.mediaDevices.getUserMedia = async constraints => {
          const video = typeof constraints.video === 'object' ? constraints.video : {}
          const stream = await getMedia({ ...constraints, video: { ...video, deviceId: { exact: id } }, audio: false })
          state.streams.push(stream)
          // A failed or interrupted test must not leave the camera running.
          state.watchdog = window.setTimeout(() => stream.getTracks().forEach(track => track.stop()), 60000)
          return stream
        }
      }, device.camera)
      try {
        await page.getByRole('button', { name: 'Bật camera' }).click()
        await page.waitForFunction(() => window.realCameraProbe.streams.length > 0 || Boolean(document.querySelector('[role="status"]')?.textContent), null, { timeout: 20000 })
        const opened = await page.evaluate(() => {
          const stream = window.realCameraProbe.streams[0]
          const track = stream?.getVideoTracks()[0]
          const settings = track?.getSettings()
          return { opened: track?.readyState === 'live', status: document.querySelector('[role="status"]')?.textContent || null,
            settings: settings ? { width: settings.width, height: settings.height, frameRate: settings.frameRate } : null }
        })
        if (!opened.opened) { console.log(JSON.stringify({ ...opened, device: device.camera.label })); return }
        await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
        await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 45000 })
        await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
        await page.waitForTimeout(5000)
        const metrics = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.tracking-stats div')].map(div => [div.querySelector('dt')?.textContent, div.querySelector('dd')?.textContent])))
        await page.getByRole('button', { name: 'Đóng nguồn' }).click()
        const closed = await page.evaluate(() => window.realCameraProbe.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))
        console.log(JSON.stringify({ device: device.camera.label, ...opened, closed, metrics: {
          observedVideoFps: metrics['FPS video quan sát'], inferenceFps: metrics['FPS suy luận'], renderFps: metrics['FPS render'],
          inferenceP50P95: metrics['Suy luận p50 / p95'], trackingStatus: metrics['Trạng thái tracking'], model: metrics['Delegate / model'],
        } }, null, 2))
      } finally {
        await page.evaluate(() => {
          const state = window.realCameraProbe
          if (state?.watchdog !== null) clearTimeout(state.watchdog)
          state?.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()))
        }).catch(() => {})
      }
    } finally { await context.close() }
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

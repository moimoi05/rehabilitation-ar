// Exercises the real Lab controller with a synthetic main-thread stall and a fake
// camera or a local file selected in-browser. This is a functional stress test,
// not a system CPU headroom measure. Usage: node tracking-autoscale-stress.cjs [local-video]
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function run() {
  const videoPath = process.argv[2]
  if (videoPath && !existsSync(videoPath)) throw new Error('Local video does not exist')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4267'
  const parsed = new URL(baseURL)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Only localhost is allowed')
  const origin = parsed.origin
  const browser = await chromium.launch({ channel: process.env.TRACKING_BENCH_CHANNEL || 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, permissions: ['camera'] })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
      if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    const page = await context.newPage()
    const workers = { created: 0, closed: 0 }
    page.on('worker', worker => { workers.created++; worker.on('close', () => workers.closed++) })
    await page.addInitScript(() => {
      const state = { count: 0, maxMs: 0, totalMs: 0, interval: 0 }
      window.stressControl = {
        start() {
          if (state.interval) throw new Error('Stress already started')
          state.interval = window.setInterval(() => {
            const start = performance.now()
            while (performance.now() - start < 160) { /* controlled synthetic main-thread work */ }
            const elapsed = performance.now() - start
            state.count++; state.maxMs = Math.max(state.maxMs, elapsed); state.totalMs += elapsed
          }, 200)
        },
        stop() { clearInterval(state.interval); state.interval = 0 },
        snapshot() { return { count: state.count, maxMs: state.maxMs, totalMs: state.totalMs } },
      }
    })
    await page.goto('/tracking-lab')
    await page.getByLabel('Hand (21 mốc)').check()
    await page.getByLabel('Hai Worker CPU (thử nghiệm)', { exact: true }).check()
    await page.getByLabel('Tự điều chỉnh nhịp Worker').check()
    const video = page.locator('video')
    if (videoPath) {
      await page.getByLabel('Chọn video MP4').setInputFiles(videoPath)
      await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration >= 12 })
      await video.evaluate(async v => { v.pause(); if (v.currentTime > .01) { v.currentTime = 0; await new Promise(resolve => v.addEventListener('seeked', resolve, { once: true })) } })
    } else await page.getByRole('button', { name: 'Bật camera' }).click()
    await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
    await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
    const monitor = page.getByText('Ngân sách Worker hiện tại:', { exact: false })
    await monitor.waitFor({ timeout: 10000 })
    if (videoPath) await video.evaluate(v => v.play())
    await page.waitForTimeout(videoPath ? 2000 : 3000)
    const sample = async phase => {
      const raw = await monitor.innerText()
      const match = raw.match(/Pose tối đa ([\d.]+) FPS · Hand tối đa ([\d.]+) FPS · (bình thường|đã giảm)/)
      if (!match) throw new Error(`Unexpected budget status: ${raw}`)
      return { phase, at: await page.evaluate(() => performance.now()), poseCap: Number(match[1]), handCap: Number(match[2]), state: match[3] }
    }
    const samples = [await sample('baseline')]
    await page.evaluate(() => window.stressControl.start())
    const begin = Date.now()
    while (Date.now() - begin < 9000) { await page.waitForTimeout(700); samples.push(await sample('stress')) }
    const stress = await page.evaluate(() => { window.stressControl.stop(); return window.stressControl.snapshot() })
    if (!videoPath) {
      const recovery = Date.now()
      while (Date.now() - recovery < 15000) { await page.waitForTimeout(700); samples.push(await sample('recovery')) }
    }
    const reduced = samples.filter(s => s.phase === 'stress').some(s => s.poseCap === 30 && s.handCap < 20)
    const stressedMinimum = Math.min(...samples.filter(s => s.phase === 'stress').map(s => s.handCap))
    const recovered = videoPath ? null : samples.filter(s => s.phase === 'recovery').some(s => s.handCap > stressedMinimum)
    const playback = videoPath ? await video.evaluate(v => ({ rate: v.playbackRate, ended: v.ended, duration: v.duration, currentTime: v.currentTime, width: v.videoWidth, height: v.videoHeight })) : null
    if (playback && (playback.rate !== 1 || playback.ended || playback.currentTime <= 0)) throw new Error(`Invalid playback: ${JSON.stringify(playback)}`)
    if (!reduced || (!videoPath && !recovered)) throw new Error(`Observed budget did not reduce Hand first or recover: ${JSON.stringify({ samples, stress, playback })}`)
    await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
    await page.getByRole('button', { name: 'Đóng nguồn' }).click()
    const deadline = Date.now() + 10000
    while (page.workers().length && Date.now() < deadline) await page.waitForTimeout(100)
    if (page.workers().length) throw new Error('Workers did not close')
    await context.close()
    return { browser: browser.version(), source: videoPath ? 'local video file' : 'Chromium fake camera', playback, samples, stress, reducedHandBeforePose: reduced, recoveryObserved: recovered, workers }
  } finally { await browser.close() }
}

run().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })

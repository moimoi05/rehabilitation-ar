// Aggregate Chrome process CPU and Windows process memory for the local Lab.
// Usage: node tracking-dual-resource-benchmark.cjs <local-video> [rounds 1..3]
// The file is selected in the browser, never copied or uploaded. Only aggregates are printed.
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)

async function snapshot(session) {
  const time = performance.now()
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  const pids = processInfo.map(p => p.id)
  // Numeric Chrome-provided IDs are the only values interpolated into the command.
  if (!pids.length || pids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid process list')
  const command = `$ids=@(${pids.join(',')}); @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 })
  const values = JSON.parse(stdout || '[]')
  const processes = Array.isArray(values) ? values : [values]
  const memory = new Map(processes.map(p => [p.Id, p]))
  return {
    time, processes: processInfo.map(p => ({ id: p.id, type: p.type, cpu: p.cpuTime })),
    memoryComplete: pids.every(id => memory.has(id)),
    workingSetBytes: pids.reduce((n, id) => n + (memory.get(id)?.WorkingSet64 || 0), 0),
    privateBytes: pids.reduce((n, id) => n + (memory.get(id)?.PrivateMemorySize64 || 0), 0),
  }
}

function summarize(before, after) {
  const old = new Map(before.processes.map(p => [p.id, p]))
  const latest = new Map(after.processes.map(p => [p.id, p]))
  const stable = old.size === latest.size && [...old.keys()].every(id => latest.has(id))
  const durationSeconds = (after.time - before.time) / 1000
  const delta = stable ? after.processes.reduce((n, p) => n + p.cpu - old.get(p.id).cpu, 0) : null
  return {
    durationSeconds, processCount: before.processes.length, sameProcessSet: stable,
    cpuSeconds: delta, cpuPercentOneCore: delta === null ? null : 100 * delta / durationSeconds,
    memoryComplete: before.memoryComplete && after.memoryComplete,
    workingSetMiB: [before.workingSetBytes / 1048576, after.workingSetBytes / 1048576],
    privateMiB: [before.privateBytes / 1048576, after.privateBytes / 1048576],
    processTypes: before.processes.map(p => p.type).sort(),
  }
}

async function run(videoPath, mode, baseURL) {
  const origin = new URL(baseURL).origin
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const session = await browser.newBrowserCDPSession()
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 200, json: {} })
      if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
      return route.abort()
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL), click = HTMLAnchorElement.prototype.click
      URL.createObjectURL = value => { if (value instanceof Blob && value.type === 'application/json') value.text().then(text => { window.resourceLabExport = text }); return create(value) }
      HTMLAnchorElement.prototype.click = function () { if (this.download !== 'tracking-benchmark.json') return click.call(this) }
    })
    await page.goto('/tracking-lab')
    await page.getByLabel('Chọn video MP4').setInputFiles(videoPath)
    const video = page.locator('video')
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 12 })
    await video.evaluate(async v => { v.pause(); if (v.currentTime > .01) { v.currentTime = 0; await new Promise(resolve => v.addEventListener('seeked', resolve, { once: true })) } })
    if (mode !== 'preview') {
      await page.getByLabel('Cấu hình hiệu năng').selectOption('balanced')
      await page.getByLabel('Hand (21 mốc)').check()
      await page.getByLabel(mode === 'parallel' ? 'Hai Worker CPU (thử nghiệm)' : 'Worker CPU (thử nghiệm)', { exact: true }).check()
      await page.getByRole('button', { name: 'Bắt đầu nhận diện' }).click()
      await page.getByRole('button', { name: 'Dừng nhận diện' }).waitFor({ timeout: 90000 })
    }
    await video.evaluate(v => v.play())
    await page.waitForFunction(() => document.querySelector('video').currentTime >= 3, { timeout: 60000 })
    if (mode !== 'preview') await page.getByRole('button', { name: 'Bắt đầu đo' }).click()
    const before = await snapshot(session)
    await page.waitForTimeout(6000)
    const after = await snapshot(session)
    const playback = await video.evaluate(v => ({ time: v.currentTime, rate: v.playbackRate, ended: v.ended, width: v.videoWidth, height: v.videoHeight }))
    if (playback.rate !== 1 || playback.ended) throw new Error('Invalid playback during sampling')
    let tracking = null
    if (mode !== 'preview') {
      await page.getByRole('button', { name: 'Dừng đo' }).click()
      await page.getByRole('button', { name: 'Xuất benchmark JSON' }).click()
      await page.waitForFunction(() => typeof window.resourceLabExport === 'string')
      tracking = await page.evaluate(() => { const r = JSON.parse(window.resourceLabExport); return { engine: r.engine, poseFps: r.inferenceFps, poseCallbackP95: r.workerRoundTripP95Ms, handFps: r.dualHand?.inferenceFps ?? null } })
      if (tracking.engine !== (mode === 'parallel' ? 'parallel' : 'worker')) throw new Error('Unexpected engine')
      await page.getByRole('button', { name: 'Dừng nhận diện' }).click()
    }
    await page.getByRole('button', { name: 'Đóng nguồn' }).click()
    return { mode, playback, resources: summarize(before, after), tracking }
  } finally { await browser.close() }
}

;(async () => {
  const videoPath = process.argv[2], rounds = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error('Usage: node tracking-dual-resource-benchmark.cjs <video> [1..3]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4242'
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only localhost is allowed')
  const runs = []
  for (let i = 0; i < rounds; i++) for (const mode of (i % 2 ? ['parallel', 'serial', 'preview'] : ['preview', 'serial', 'parallel'])) {
    console.error(`Measuring ${mode} ${i + 1}/${rounds}`)
    runs.push(await run(videoPath, mode, baseURL))
  }
  console.log(JSON.stringify({ runs, limitations: 'Short headless samples. CDP reports Chrome process IDs and CPU times; Windows memory is sum across those IDs at two snapshots. Working sets can include shared pages, private bytes are committed private memory, neither is peak nor GPU memory. CPU percent is per one logical core, not total system CPU; browser/renderer/GPU-process CPU included. Other processes such as Vite are excluded. Different frames and background load; no clinical accuracy claim.' }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })

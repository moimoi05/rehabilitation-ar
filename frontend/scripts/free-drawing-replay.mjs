import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repository = path.dirname(frontend)
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return args[index + 1]
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function inspectVideo(video) {
  // Metadata only; inference always stays in the application's existing Worker.
  const script = 'import cv2,json,sys; c=cv2.VideoCapture(sys.argv[1]); fps=c.get(cv2.CAP_PROP_FPS); n=c.get(cv2.CAP_PROP_FRAME_COUNT); fourcc=int(c.get(cv2.CAP_PROP_FOURCC)); print(json.dumps({"frameRate":fps,"frameCount":int(n),"videoTrackDurationSeconds":n/fps if fps else None,"width":int(c.get(cv2.CAP_PROP_FRAME_WIDTH)),"height":int(c.get(cv2.CAP_PROP_FRAME_HEIGHT)),"codecFourcc":"".join(chr((fourcc >> (8*i)) & 255) for i in range(4))})); c.release()'
  const inspected = spawnSync('python', ['-c', script, video], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
  try { return inspected.status === 0 ? JSON.parse(inspected.stdout) : { limitation: 'Optional Python/OpenCV metadata reader unavailable; see browser video metadata.' } }
  catch { return { limitation: 'Optional source metadata could not be read; see browser video metadata.' } }
}
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
})

async function poll(operation, timeout, label, ensureRunning = () => {}) {
  const deadline = Date.now() + timeout
  let lastError = ''
  while (Date.now() < deadline) {
    ensureRunning()
    try { const result = await operation(); if (result) return result }
    catch (error) { lastError = error.message }
    await delay(300)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ''}`)
}

async function cdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')) }, 15000)
    socket.onopen = () => { clearTimeout(timeout); resolve() }
    socket.onerror = () => { clearTimeout(timeout); reject(new Error('CDP connection failed')) }
  })
  let nextId = 0
  const pending = new Map()
  const errors = []
  socket.onclose = () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('CDP connection closed')) }
    pending.clear()
  }
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timeout)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      errors.push(details.exception?.description || details.text)
      if (errors.length > 20) errors.shift()
    }
  }
  return {
    errors,
    send(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP is closed: ${method}`))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 15000)
        pending.set(id, { resolve, reject, timeout })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() { socket.close() },
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  await Promise.race([exited, delay(3000)])
}

async function main() {
  if (args.includes('--help')) {
    console.log([
      'Run from frontend (Node 22+, existing node_modules and installed Edge/Chrome):',
      'npm run replay:free-drawing -- --video "D:\\path\\recording.mp4" --runs 3 --side right',
      'Optional: --browser "C:\\path\\msedge.exe"',
      'Defaults: video_test/WIN_20261103_22_45_01_Pro.mp4, 3 runs, right affected hand.',
      'Each run reloads the application, plays the full MP4 at 1x through its existing MediaPipe Worker,',
      'and writes reports/free-drawing-replay-{run}.json plus reports/free-drawing-replay.json.',
      'No webcam permission or clinical result is used. Replay timing does not prove live-camera latency.',
      'Python/OpenCV is optional for source metadata only; inference remains in the browser.',
    ].join('\n'))
    return
  }
  const acceptedOptions = new Set(['--video', '--runs', '--side', '--browser'])
  for (let index = 0; index < args.length; index += 2) {
    if (!acceptedOptions.has(args[index])) throw new Error(`Unknown option: ${args[index]}; use --help`)
    option(args[index])
  }
  const video = path.resolve(option('--video', path.join(repository, 'video_test/WIN_20261103_22_45_01_Pro.mp4')))
  const runs = Number(option('--runs', '3'))
  const side = option('--side', 'right')
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be 1..20')
  if (!['left', 'right'].includes(side)) throw new Error('--side must be left or right')
  await access(video)
  if (!(await stat(video)).isFile() || path.extname(video).toLowerCase() !== '.mp4') throw new Error('--video must name a readable MP4 file')
  const sourceMetadata = inspectVideo(video)
  const requestedBrowser = option('--browser', process.env.REHAB_REPLAY_BROWSER)
  if (requestedBrowser && !existsSync(requestedBrowser)) throw new Error(`Requested browser does not exist: ${requestedBrowser}`)
  const candidates = [requestedBrowser, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)
  const binary = candidates.find(existsSync)
  if (!binary) throw new Error('No installed Edge/Chrome found; supply --browser. No browser will be installed.')
  const port = await freePort(), debugPort = await freePort()
  const base = `http://127.0.0.1:${port}`
  const profile = await mkdtemp(path.join(os.tmpdir(), 'rehab-drawing-replay-'))
  let server, browser, connection
  let serverLog = '', startupError = null, interrupted = false, version = null, gpu = null
  const results = []
  const destination = path.join(repository, 'reports/free-drawing-replay.json')
  const limitations = ['Prerecorded replay at normal speed measures this browser pipeline; it does not prove live-camera latency or robustness.', 'Grab/release functionality requires controller tests when the recording lacks the complete interaction.']
  const ensureRunning = () => {
    if (interrupted) throw new Error('Replay interrupted; owned browser and Vite will be stopped')
    if (startupError) throw startupError
    for (const [child, name] of [[server, 'Vite'], [browser, 'Browser']]) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`${name} exited before replay completed (code ${child.exitCode}, signal ${child.signalCode})`)
    }
  }
  const interrupt = () => { interrupted = true }
  const saveSummary = async error => {
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, `${JSON.stringify({ sourcePath: video, sourceMetadata, playbackRate: 1, affectedSide: side, browser: version?.product ?? null, gpu, outcome: error ? 'error' : 'finished', error: error?.message, runs: results, limitations }, null, 2)}\n`, 'utf8')
  }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  try {
    server = spawn(process.execPath, [path.join(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: frontend, env: { ...process.env, REHAB_DRAWING_REPLAY_VIDEO: video }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = chunk => { serverLog = (serverLog + chunk.toString()).slice(-12000) }
    server.stdout.on('data', log); server.stderr.on('data', log)
    server.on('error', error => { startupError = error; serverLog += error.message })
    await poll(async () => { const response = await fetch(`${base}/__free-drawing-replay/config`); return response.ok }, 30000, 'Vite replay server', ensureRunning)
    browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { windowsHide: true, stdio: 'ignore' })
    browser.on('error', error => { startupError = error; serverLog += error.message })
    const target = await poll(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl)
    }, 20000, 'Installed browser CDP', ensureRunning)
    connection = await cdp(target.webSocketDebuggerUrl)
    await connection.send('Page.enable'); await connection.send('Runtime.enable')
    version = await connection.send('Browser.getVersion')
    gpu = await (async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      const browserTarget = await response.json()
      const browserConnection = await cdp(browserTarget.webSocketDebuggerUrl)
      try { return (await browserConnection.send('SystemInfo.getInfo')).gpu }
      finally { browserConnection.close() }
    })().catch(error => ({ error: error.message }))
    console.log(`Video: ${video}\nBrowser: ${version.product}\nPlayback: 1x, ${runs} runs, affected hand ${side}`)
    for (let run = 1; run <= runs; run++) {
      await connection.send('Page.navigate', { url: `${base}/workspace?drawingReplay=1&trackingDebug=1&side=${side}&replayRun=${run}` })
      await connection.send('Page.bringToFront')
      const status = await poll(async () => {
        const response = await fetch(`${base}/__free-drawing-replay/status?run=${run}`)
        if (!response.ok) throw new Error(`Report endpoint HTTP ${response.status}`)
        const value = await response.json()
        return value.done ? value : null
      }, Math.max(180000, (Number.isFinite(sourceMetadata.videoTrackDurationSeconds) ? sourceMetadata.videoTrackDurationSeconds * 1000 : 0) + 90000), `Replay ${run}`, ensureRunning)
      results.push(status.report)
      console.log(`Run ${run} saved: reports/free-drawing-replay-${run}.json`)
      if (status.report.error) throw new Error(`Replay ${run} failed: ${status.report.error}`)
      if (status.report.outcome !== 'finished' || status.report.engine !== 'worker' || !status.report.diagnostics?.counts?.handResultsReceived || Math.abs(status.report.video.processedUntilSeconds - status.report.video.durationSeconds) > .25) throw new Error(`Replay ${run} did not finish the actual Worker pipeline`)
    }
    await saveSummary()
    console.log(`Combined report: ${destination}`)
  } catch (error) {
    if (connection?.errors.length) console.error(connection.errors.join('\n'))
    if (!connection) console.error(serverLog)
    await saveSummary(error).catch(reportError => console.error(`Could not write failure report: ${reportError.message}`))
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    if (connection) {
      try { await connection.send('Browser.close') } catch { /* process shutdown may close CDP first */ }
      connection.close()
    }
    await stop(browser); await stop(server)
    // This is the exact temporary directory created above, never the user's browser profile.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('rehab-drawing-replay-')) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

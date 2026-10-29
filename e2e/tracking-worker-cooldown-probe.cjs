// Local-only cooldown comparison. Video/landmarks remain in the browser; only aggregates print.
// Usage: node tracking-worker-cooldown-probe.cjs <local-video> [repetitions 1..3]
const { chromium } = require('playwright')
const { existsSync } = require('node:fs')

async function measure(page, videoPath, config) {
  await page.goto('/__parallel_worker_fixture__')
  await page.locator('input').setInputFiles(videoPath)
  return page.evaluate(async config => {
    const video = document.querySelector('video')
    const videoUrl = URL.createObjectURL(document.querySelector('input').files[0])
    video.src = videoUrl
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject })
    if (video.duration < 11.5 || !video.requestVideoFrameCallback) throw new Error('Need a >=11.5s video and requestVideoFrameCallback')
    const workerCode = `
      let pose, hand, kind;
      self.onmessage = async ({data}) => {
        if (data.type === 'init') {
          try {
            kind = data.kind;
            const {FilesetResolver, PoseLandmarker, HandLandmarker} = await import(data.moduleUrl);
            const files = await FilesetResolver.forVisionTasks(data.origin+'/mediapipe/wasm');
            if (kind !== 'hand') pose = await PoseLandmarker.createFromOptions(files, {baseOptions:{modelAssetPath:data.origin+'/models/pose_landmarker_lite.task',delegate:'CPU'},runningMode:'VIDEO',numPoses:1});
            if (kind !== 'pose') hand = await HandLandmarker.createFromOptions(files, {baseOptions:{modelAssetPath:data.origin+'/models/hand_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numHands:2});
            self.postMessage({type:'ready'});
          } catch (error) { self.postMessage({type:'error',message:String(error)}); }
        } else if (data.type === 'frame') {
          try {
            let poseMs=null, handMs=null, poseCount=0, handCount=0;
            if (pose) { let t=performance.now(); poseCount=pose.detectForVideo(data.bitmap,data.timestamp).landmarks.length; poseMs=performance.now()-t; }
            if (hand && (kind==='hand'||data.doHand)) { let t=performance.now(); handCount=hand.detectForVideo(data.bitmap,data.timestamp).landmarks.length; handMs=performance.now()-t; }
            self.postMessage({type:'result',id:data.id,poseMs,handMs,poseCount,handCount});
          } catch (error) { self.postMessage({type:'error',message:String(error)}); }
          finally { data.bitmap.close(); }
        } else if (data.type === 'close') { pose?.close(); hand?.close(); self.close(); }
      };`
    const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }))
    const kinds = config.mode === 'parallel' ? ['pose', 'hand'] : ['serial']
    const workers = kinds.map(kind => ({ kind, worker: new Worker(workerUrl), busy: false, last: -Infinity, lastHand: -Infinity, sequence: 0, pending: null,
      poseTimes: [], handTimes: [], poseArrivals: [], handArrivals: [], poseDurations: [], handDurations: [], resultAges: [], copyDurations: [], busySkips: 0, throttled: 0, cooldownSkips: 0, validPose: 0, validHand: 0,
      costEwma: null, cooldownUntil: -Infinity }))
    let failure = null, active = true, callbackCount = 0, renders = 0, started = 0, ended = 0, request = null, raf = null
    let snapshotStart = null, snapshotEnd = null
    const moduleUrl = `${location.origin}/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs`
    const initialize = entry => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${entry.kind} initialization timed out`)), 45000)
      entry.worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'worker error')) }
      entry.worker.onmessage = ({data}) => {
        if (data.type === 'error') { clearTimeout(timer); reject(new Error(data.message)); return }
        if (data.type === 'ready') { clearTimeout(timer); resolve() }
      }
      entry.worker.postMessage({type:'init',kind:entry.kind,moduleUrl,origin:location.origin})
    })
    const percentile = (values, p) => { const v = [...values].sort((a,b) => a-b); return v.length ? v[Math.ceil(v.length*p)-1] : null }
    const summarize = values => ({ n: values.length, mean: values.length ? values.reduce((a,b) => a+b,0)/values.length : null, p95: percentile(values,.95) })
    const gaps = values => summarize(values.slice(1).map((value,index) => value-values[index]))
    try {
      // Start concurrently in parallel mode; initialization is not part of the measurement.
      await Promise.all(workers.map(initialize))
      for (const entry of workers) {
        entry.worker.onerror = event => { failure = `${entry.kind}: ${event.message}`; active = false }
        entry.worker.onmessage = ({data}) => {
          if (data.type === 'error') { failure = `${entry.kind}: ${data.message}`; active = false; entry.busy = false; return }
          if (data.type !== 'result' || !entry.pending || data.id !== entry.pending.id) return
          const pending = entry.pending, arrival = performance.now(); entry.pending = null; entry.busy = false
          const cost = (data.poseMs ?? 0) + (data.handMs ?? 0)
          if (config.policy === 'cooldown' && Number.isFinite(cost) && cost >= 0) {
            entry.costEwma = entry.costEwma === null ? cost : 0.75 * entry.costEwma + 0.25 * cost
            entry.cooldownUntil = arrival + Math.min(50, 0.2 * entry.costEwma)
          }
          if (!pending.measured) return
          entry.resultAges.push(arrival-pending.now); entry.copyDurations.push(pending.copyMs)
          if (data.poseMs !== null) { entry.poseDurations.push(data.poseMs); entry.poseTimes.push(pending.now); entry.poseArrivals.push(arrival); if (data.poseCount) entry.validPose++ }
          if (data.handMs !== null) { entry.handDurations.push(data.handMs); entry.handTimes.push(pending.now); entry.handArrivals.push(arrival); if (data.handCount) entry.validHand++ }
        }
      }
      const submit = (entry, now, mediaTime) => {
        const measured = mediaTime >= 3 && mediaTime < 11
        if (entry.busy) { if (measured) entry.busySkips++; return }
        if (now < entry.cooldownUntil) { if (measured) entry.cooldownSkips++; return }
        const cap = entry.kind === 'hand' ? 12 : 24
        if (now-entry.last < 1000/cap) { if (measured) entry.throttled++; return }
        const doHand = entry.kind === 'serial' && now-entry.lastHand >= 1000/12
        entry.last = now; if (doHand) entry.lastHand = now
        entry.busy = true
        const id = ++entry.sequence, copyStart = performance.now()
        createImageBitmap(video).then(bitmap => {
          if (!active) { bitmap.close(); entry.busy = false; return }
          entry.pending = {id, now, measured, copyMs:performance.now()-copyStart}
          try { entry.worker.postMessage({type:'frame',id,bitmap,timestamp:now,doHand},[bitmap]) }
          catch (error) { bitmap.close(); entry.busy = false; failure = String(error); active = false }
        }).catch(error => { entry.busy = false; failure = String(error); active = false })
      }
      const onFrame = (now, metadata) => {
        if (!active) return
        if (metadata.mediaTime >= 3 && !snapshotStart) snapshotStart = window.probeCpu('start')
        if (metadata.mediaTime >= 11 && !snapshotEnd) snapshotEnd = window.probeCpu('end')
        if (metadata.mediaTime >= 3 && metadata.mediaTime < 11) callbackCount++
        for (const entry of workers) submit(entry,now,metadata.mediaTime)
        request = video.requestVideoFrameCallback(onFrame)
      }
      const draw = () => { if (!active) return; if (video.currentTime >= 3 && video.currentTime < 11) renders++; raf = requestAnimationFrame(draw) }
      await video.play(); started = performance.now()
      request = video.requestVideoFrameCallback(onFrame); raf = requestAnimationFrame(draw)
      await new Promise((resolve,reject) => {
        const check = () => {
          if (failure) { reject(new Error(failure)); return }
          if (video.ended || video.currentTime >= 11.15) { resolve(); return }
          if (performance.now()-started > 60000) { reject(new Error('Playback timed out')); return }
          setTimeout(check,50)
        }; check()
      })
      // Stop acquisition, but allow the final in-flight worker result to settle.
      if (request !== null) video.cancelVideoFrameCallback(request); request = null
      if (raf !== null) cancelAnimationFrame(raf); raf = null
      const deadline = performance.now()+5000
      while (workers.some(entry => entry.busy) && !failure && performance.now()<deadline) await new Promise(resolve => setTimeout(resolve,20))
      if (failure || workers.some(entry => entry.busy)) throw new Error(failure || 'Worker drain timed out')
      if (!snapshotStart || !snapshotEnd) throw new Error('CPU snapshots were not obtained')
      await Promise.all([snapshotStart, snapshotEnd])
      ended = performance.now(); active = false
      return { ...config, video:{width:video.videoWidth,height:video.videoHeight,duration:video.duration,rate:video.playbackRate}, windowMediaSeconds:8,
        wallSeconds:(ended-started)/1000, observedVideoCallbacks:callbackCount, renderLoops:renders,
        streams:workers.map(entry => ({ kind:entry.kind, poseFps:entry.poseTimes.length/8, handFps:entry.handTimes.length/8,
          poseInferenceMs:summarize(entry.poseDurations), handInferenceMs:summarize(entry.handDurations), callbackToResultMs:summarize(entry.resultAges),
          bitmapCreateMs:summarize(entry.copyDurations), poseResultGapMs:gaps(entry.poseArrivals), handResultGapMs:gaps(entry.handArrivals),
          busySkips:entry.busySkips, throttled:entry.throttled, cooldownSkips:entry.cooldownSkips, validPose:entry.validPose, validHand:entry.validHand })) }
    } finally {
      active = false
      if (request !== null) video.cancelVideoFrameCallback(request)
      if (raf !== null) cancelAnimationFrame(raf)
      video.pause()
      for (const entry of workers) { try { entry.worker.postMessage({type:'close'}) } catch {} entry.worker.terminate() }
      URL.revokeObjectURL(workerUrl); URL.revokeObjectURL(videoUrl)
    }
  }, config)
}

;(async () => {
  const videoPath = process.argv[2], repetitions = Number(process.argv[3] || 2)
  if (!videoPath || !existsSync(videoPath) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Usage: node tracking-worker-cooldown-probe.cjs <local-video> [1..3]')
  const baseURL = process.env.TRACKING_BENCH_URL || 'http://127.0.0.1:4264', origin = new URL(baseURL).origin
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only localhost is allowed')
  const runs=[]
  const forward = [
    {mode:'serial',policy:'baseline'}, {mode:'serial',policy:'cooldown'},
    {mode:'parallel',policy:'baseline'}, {mode:'parallel',policy:'cooldown'},
  ]
  let browserVersion = null
  for (let i=0;i<repetitions;i++) {
    for (const config of (i%2 ? [...forward].reverse() : forward)) {
      console.error(`Measuring ${config.mode} ${config.policy}, repetition ${i+1}/${repetitions}`)
      const browser = await chromium.launch({headless:true,channel:process.env.TRACKING_BENCH_CHANNEL || 'chrome',args:['--autoplay-policy=no-user-gesture-required']})
      browserVersion = browser.version()
      try {
        const context = await browser.newContext({baseURL})
        const session = await browser.newBrowserCDPSession()
        const cpu = {}
        const page = await context.newPage()
        await page.exposeBinding('probeCpu', async (_, phase) => {
          const time = performance.now()
          const { processInfo } = await session.send('SystemInfo.getProcessInfo')
          cpu[phase] = { time, processes: processInfo.map(({id,cpuTime,type}) => ({id,cpuTime,type})) }
        })
        await context.route('**/*', route => {
          const url=route.request().url()
          if (url === `${origin}/__parallel_worker_fixture__`) return route.fulfill({contentType:'text/html',body:'<input type="file"><video muted playsinline></video>'})
          if (url.startsWith(`${origin}/`) || url.startsWith('blob:')) return route.continue()
          return route.abort()
        })
        const result = await measure(page,videoPath,config)
        const first = new Map(cpu.start.processes.map(p => [p.id,p]))
        const last = new Map(cpu.end.processes.map(p => [p.id,p]))
        const stable = first.size === last.size && [...first.keys()].every(id => last.has(id))
        const seconds = (cpu.end.time - cpu.start.time)/1000
        const cpuSeconds = stable ? [...last.values()].reduce((sum,p) => sum+p.cpuTime-first.get(p.id).cpuTime,0) : null
        runs.push({repetition:i+1,...result,cpu:{processCount:first.size,sameProcessSet:stable,seconds,cpuSeconds,cpuPercentOneCore:cpuSeconds === null ? null : 100*cpuSeconds/seconds}})
      } finally { await browser.close() }
    }
  }
  console.log(JSON.stringify({browser:browserVersion,runs,limitations:'Prototype uses rVFC and bounded per-worker capture, not production scheduler/UI. The two workers capture separately and frames may differ. Callback-to-result is not sensor-to-display latency. CDP CPU is total Chromium including video and UI, per one logical core; PID equality at snapshots does not exclude short-lived processes. GPU use, memory, accuracy and clinical utility are not measured; headless results are device- and load-dependent.'},null,2))
})().catch(error => { console.error(error); process.exitCode=1 })

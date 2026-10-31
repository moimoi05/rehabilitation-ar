import { BenchmarkArtifacts, benchmarkRequest, BENCHMARK_API, latencySummary } from './benchmarkArtifacts'
import { createBenchmarkEngine } from './benchmarkEngine'
import type { BenchmarkConfig, BenchmarkEngine, Observation } from './benchmarkEngine'
import { BenchmarkQuality, validHand, validPose } from './benchmarkQuality'
import { drawLandmarks } from './drawing'
import type { Point } from './drawing'
import { startVideoFrameScheduler } from './videoFrameScheduler'

export type SourceInfo = { source_path: string; width: number; height: number; duration: number; fps: number | null; hardware: Record<string, unknown> }
export type RunResult = { run_id: string; status: string; directory: string; errors: string[]; summary: Record<string, unknown> }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const fpsHeader = 'timestamp_ms,source_fps,pose_fps,hand_fps,render_fps,pose_latency_ms,hand_latency_ms,pose_result_age_ms,hand_result_age_ms,skipped_frames,pose_tracking_valid,hand_tracking_valid\n'

export function benchmarkSuite(): BenchmarkConfig[] {
  const base = { hands: true, poseFps: 20, handFps: 12, filter: 'standard' as const, schedule: 'independent' as const }
  const runs: BenchmarkConfig[] = []
  for (let repeat = 1; repeat <= 3; repeat++) {
    runs.push({ ...base, name: 'A CPU main original schedule', gpu: false, engine: 'main', schedule: 'legacy', poseFps: 24, repeat })
    runs.push({ ...base, name: 'CPU main matched schedule', gpu: false, engine: 'main', repeat })
    runs.push({ ...base, name: 'B/F GPU main Pose + Hand', gpu: true, engine: 'main', repeat })
  }
  runs.push({ ...base, name: 'C CPU worker', gpu: false, engine: 'worker', repeat: 1 })
  runs.push({ ...base, name: 'D GPU worker requested', gpu: true, engine: 'worker', repeat: 1 })
  runs.push({ ...base, name: 'E GPU Pose only', gpu: true, engine: 'main', hands: false, repeat: 1 })
  runs.push({ ...base, name: 'GPU main raw display', gpu: true, engine: 'main', filter: 'raw', repeat: 1 })
  runs.push({ ...base, name: 'GPU main responsive display', gpu: true, engine: 'main', filter: 'responsive', repeat: 1 })
  runs.push({ ...base, name: 'GPU main Hand 15 FPS', gpu: true, engine: 'main', handFps: 15, repeat: 1 })
  return runs
}

async function loadSource(video: HTMLVideoElement) {
  video.pause(); video.crossOrigin = 'anonymous'; video.muted = true; video.loop = false; video.playbackRate = 1
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { video.removeEventListener('loadeddata', ready); video.removeEventListener('error', failed) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Source video load timed out')) }, 30000)
    const ready = () => { clearTimeout(timer); cleanup(); resolve() }
    const failed = () => { clearTimeout(timer); cleanup(); reject(new Error(`Source video: ${video.error?.message || 'decode/load failed'}`)) }
    video.addEventListener('loadeddata', ready); video.addEventListener('error', failed)
    video.src = `${BENCHMARK_API}/source`; video.load()
  })
}

export async function runBenchmark(config: BenchmarkConfig, video: HTMLVideoElement, canvas: HTMLCanvasElement, source: SourceInfo, signal: AbortSignal, status: (text: string) => void): Promise<RunResult> {
  const created = await benchmarkRequest<{ run_id: string; directory: string }>('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configuration: config, source_metadata: source, browser: navigator.userAgent }) })
  const errors: string[] = [], quality = new BenchmarkQuality()
  let fatal: Error | null = null, engine: BenchmarkEngine | null = null, recorder: MediaRecorder | null = null, stream: MediaStream | null = null
  let stopScheduler: (() => void) | null = null, renderRequest = 0, measuring = false, start = 0, end = 0
  let pose: Point[] = [], hands: Point[][] = [], labels: string[] = [], poseTime = 0, handTime = 0, poseValid = false, handValid = false
  let frameId = 0, poseCount = 0, handCount = 0, renderCount = 0, sourceCount = 0, sourceSkipped = 0, poseSkipped = 0, handSkipped = 0, busySkipped = 0
  let poseInvalid = 0, handInvalid = 0, bothHands = 0, leftCount = 0, rightCount = 0
  let leftTime: number | null = null, rightTime: number | null = null, poseLatency: number | null = null, handLatency: number | null = null
  const poseLatencies: number[] = [], handLatencies: number[] = []
  let jsonl = '', csv = fpsHeader, lastSample = 0, lastUi = 0, previousCounts = { pose: 0, hand: 0, render: 0, source: 0 }
  let rates = { pose: 0, hand: 0, render: 0, source: 0 }, recordedDuration = 0
  const fail = (error: Error) => { if (!fatal) { fatal = error; errors.push(error.message) } }
  const artifacts = new BenchmarkArtifacts(created.run_id, fail)
  const flushRows = () => { if (jsonl) { artifacts.append('landmarks.jsonl', jsonl); jsonl = '' }; if (csv) { artifacts.append('fps.csv', csv); csv = '' } }
  const observe = (observation: Observation) => {
    if (!measuring) return
    const { frame } = observation, timestamp = frame.inferenceTimestamp
    const nextPose = observation.pose === null ? null : quality.filter('pose', observation.pose, timestamp, config.filter)
    const nextHands = observation.hands === null ? null : observation.hands.map((points, index) => {
      const category = observation.handedness?.[index]?.[0]
      const identity = category && category.score >= .5 ? category.categoryName : `unknown-${index}`
      if (identity.startsWith('unknown')) quality.reset(identity)
      return quality.filter(identity, points, timestamp, config.filter)
    })
    if (observation.pose !== null) { poseCount++; pose = nextPose ?? []; poseTime = timestamp; poseValid = validPose(observation.pose); if (!poseValid) poseInvalid++; poseLatency = observation.poseMs; if (poseLatency !== null) poseLatencies.push(poseLatency) }
    if (observation.hands !== null) {
      handCount++; hands = nextHands ?? []; handTime = timestamp; handValid = observation.hands.some(validHand); if (!handValid) handInvalid++
      labels = observation.handedness?.map(categories => categories[0]?.categoryName || 'Unknown') ?? []
      const left = labels.some((label, index) => label === 'Left' && validHand(observation.hands![index]))
      const right = labels.some((label, index) => label === 'Right' && validHand(observation.hands![index]))
      if (left) { leftCount++; leftTime = timestamp } else { leftTime = null; quality.reset('Left') }
      if (right) { rightCount++; rightTime = timestamp } else { rightTime = null; quality.reset('Right') }
      if (left && right) bothHands++
      handLatency = observation.handMs; if (handLatency !== null) handLatencies.push(handLatency)
    }
    jsonl += JSON.stringify({ run_id: created.run_id, frame_id: ++frameId, source_timestamp_ms: frame.mediaTime * 1000, source_frame_id: frame.sourceFrameId ?? null,
      pose_timestamp_ms: observation.pose === null ? null : timestamp, hand_timestamp_ms: observation.hands === null ? null : timestamp,
      raw_pose_landmarks: observation.pose, filtered_pose_landmarks: nextPose, raw_hand_landmarks: observation.hands, filtered_hand_landmarks: nextHands,
      handedness: observation.handedness, world_landmarks: { pose: observation.poseWorld, hands: observation.handWorld },
      pose_valid: observation.pose === null ? null : poseValid, hand_valid: observation.hands === null ? null : handValid,
      pose_inference_ms: observation.poseMs, hand_inference_ms: observation.handMs, pose_delegate: engine?.delegates.pose, hand_delegate: engine?.delegates.hand,
      skipped_frames: sourceSkipped + busySkipped, left_hand_timestamp_ms: observation.hands === null ? null : leftTime, right_hand_timestamp_ms: observation.hands === null ? null : rightTime,
      tracking_status: { pose: observation.pose === null ? 'not_observed' : poseValid ? 'valid' : 'missing_or_invalid', hand: observation.hands === null ? 'not_observed' : handValid ? 'valid' : 'missing_or_invalid' } }) + '\n'
    if (jsonl.length >= 256 * 1024) flushRows()
  }
  const sample = (now: number) => {
    const elapsed = (now - lastSample) / 1000
    if (elapsed < 1) return
    rates = { pose: (poseCount - previousCounts.pose) / elapsed, hand: (handCount - previousCounts.hand) / elapsed, render: (renderCount - previousCounts.render) / elapsed, source: (sourceCount - previousCounts.source) / elapsed }
    previousCounts = { pose: poseCount, hand: handCount, render: renderCount, source: sourceCount }; lastSample = now
    csv += [now - start, rates.source, rates.pose, rates.hand, rates.render, poseLatency ?? '', handLatency ?? '', poseTime ? now - poseTime : '', handTime ? now - handTime : '', sourceSkipped + busySkipped, Number(poseValid && now - poseTime <= 500), Number(handValid && now - handTime <= 500)].join(',') + '\n'
    flushRows()
  }
  const draw = () => {
    const now = performance.now(), ctx = canvas.getContext('2d')
    if (ctx && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (poseTime && now - poseTime <= 500) drawLandmarks(ctx, canvas.width, canvas.height, pose, false)
      if (handTime && now - handTime <= 500) hands.forEach((points, index) => {
        drawLandmarks(ctx, canvas.width, canvas.height, points, false, true)
        const wrist = points[0]
        if (wrist) { ctx.fillStyle = labels[index] === 'Left' ? '#67e8f9' : '#f9a8d4'; ctx.font = 'bold 22px sans-serif'; ctx.fillText(labels[index] ?? 'Unknown', wrist.x * canvas.width, wrist.y * canvas.height - 12) }
      })
      ctx.fillStyle = '#000b'; ctx.fillRect(0, 0, canvas.width, 120); ctx.fillStyle = '#fff'; ctx.font = `${Math.max(16, canvas.width / 70)}px monospace`
      const lines = [`${config.name} | Pose: ${engine?.delegates.pose ?? '—'} | Hand: ${engine?.delegates.hand ?? 'OFF'}`,
        `Pose ${rates.pose.toFixed(1)} FPS / ${poseLatency?.toFixed(1) ?? '—'} ms | Hand ${rates.hand.toFixed(1)} FPS / ${handLatency?.toFixed(1) ?? '—'} ms | Render ${rates.render.toFixed(1)} FPS`,
        `Pose ${poseValid && now - poseTime <= 500 ? 'VALID' : 'LOST'} | Hands ${handValid && now - handTime <= 500 ? 'VALID' : 'LOST'} | Skips ${sourceSkipped + busySkipped} | Source ${video.currentTime.toFixed(2)}s | ${config.filter}`]
      lines.forEach((line, index) => ctx.fillText(line, 14, 28 + index * 30))
    }
    if (measuring) { renderCount++; sample(now); if (now - lastUi > 1000) { lastUi = now; status(`${config.name} #${config.repeat} — ${video.currentTime.toFixed(1)}/${video.duration.toFixed(1)} s | Pose ${rates.pose.toFixed(1)} / Hand ${rates.hand.toFixed(1)} / Render ${rates.render.toFixed(1)} FPS`) } }
    renderRequest = requestAnimationFrame(draw)
  }
  try {
    status(`${config.name}: tải video và model…`)
    await loadSource(video)
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    engine = await createBenchmarkEngine(config, video, observe, fail)
    errors.push(...engine.errors)
    status(`${config.name}: warm-up 3 giây trên khung đầu video…`)
    const warmup = performance.now()
    while (performance.now() - warmup < 3000) {
      if (signal.aborted) throw new Error('Benchmark cancelled')
      if (fatal) throw fatal
      const now = performance.now()
      engine.submit({ now, inferenceTimestamp: now, mediaTime: 0, sourceFrameId: null }, true, config.hands)
      await delay(100)
    }
    while (!engine.idle()) { if (fatal) throw fatal; await delay(10) }
    const mime = ['video/mp4;codecs=avc1.42001E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(value => MediaRecorder.isTypeSupported(value))
    if (!mime) throw new Error('No supported local video recording codec')
    stream = canvas.captureStream(30)
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 })
    recorder.ondataavailable = event => { if (event.data.size) artifacts.append(mime.startsWith('video/mp4') ? 'annotated.mp4' : 'annotated.webm', event.data) }
    recorder.onerror = event => fail(new Error(`MediaRecorder failed: ${event.type}`))
    let nextPose = -Infinity, nextHand = -Infinity, lastHand = -Infinity
    start = performance.now(); lastSample = start; measuring = true
    draw(); recorder.start(1000)
    stopScheduler = startVideoFrameScheduler(video, frame => {
      if (!measuring || fatal) return
      sourceCount++; sourceSkipped += frame.skippedSourceFrames ?? 0
      const doPose = config.schedule === 'legacy' || frame.now >= nextPose
      const doHand = config.hands && (config.schedule === 'legacy' ? frame.now - lastHand >= 1000 / config.handFps : frame.now >= nextHand)
      if (!doPose) poseSkipped++; if (config.hands && !doHand) handSkipped++
      if (!doPose && !doHand) return
      if (engine!.submit(frame, doPose, doHand)) {
        if (doPose) nextPose = nextPose === -Infinity || frame.now - nextPose > 1000 / config.poseFps ? frame.now + 1000 / config.poseFps : nextPose + 1000 / config.poseFps
        if (doHand) { lastHand = frame.now; nextHand = nextHand === -Infinity || frame.now - nextHand > 1000 / config.handFps ? frame.now + 1000 / config.handFps : nextHand + 1000 / config.handFps }
      } else busySkipped++
    }, { maxFps: config.schedule === 'legacy' ? config.poseFps : 120, onReset: () => fail(new Error('Unexpected video seek/replay during measured run')), onSkippedFrame: frame => { sourceCount++; sourceSkipped += frame.skippedSourceFrames ?? 0; poseSkipped++; if (config.hands) handSkipped++ } })
    await video.play()
    while (!video.ended) {
      if (signal.aborted) throw new Error('Benchmark cancelled')
      if (fatal) throw fatal
      if (document.hidden) throw new Error('Benchmark tab became hidden; measurement is not comparable')
      if (video.error) throw new Error(video.error.message)
      if (performance.now() - start > (video.duration + 30) * 1000) throw new Error('Video playback stalled')
      await delay(100)
    }
    recordedDuration = video.currentTime
    end = performance.now(); stopScheduler(); stopScheduler = null
    const drainStart = performance.now()
    while (!engine.idle() && performance.now() - drainStart < 8000) { if (fatal) throw fatal; await delay(10) }
    if (!engine.idle()) throw new Error('Pending worker result did not complete')
  } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  finally {
    end ||= performance.now(); measuring = false; stopScheduler?.(); video.pause(); cancelAnimationFrame(renderRequest)
    if (recorder && recorder.state !== 'inactive') {
      try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Recording stop timed out')), 15000); recorder!.addEventListener('stop', () => { clearTimeout(timer); resolve() }, { once: true }); recorder!.stop() }) } catch (error) { fail(new Error(errorText(error))) }
    }
    stream?.getTracks().forEach(track => track.stop())
    try { engine?.close() } catch (error) { fail(new Error(`Model cleanup: ${errorText(error)}`)) }
    flushRows()
  }
  const seconds = start ? (end - start) / 1000 : 0
  const summary = { run_id: created.run_id, date_time: new Date().toISOString(), configuration: config, source_video_path: source.source_path, source_video_metadata: source,
    browser: navigator.userAgent, hardware: source.hardware, mediapipe_version: '0.10.35', pose_model: 'pose_landmarker_lite.task', hand_model: config.hands ? 'hand_landmarker.task' : null,
    actual_delegates: engine?.delegates ?? { pose: null, hand: null }, pose_delegate: engine?.delegates.pose ?? null, hand_delegate: engine?.delegates.hand ?? null,
    resolution: { width: video.videoWidth, height: video.videoHeight }, playback_rate: 1, requested_fps: { pose: config.poseFps, hand: config.hands ? config.handFps : 0 },
    actual_fps: { pose: seconds ? poseCount / seconds : 0, hand: seconds ? handCount / seconds : 0, render: seconds ? renderCount / seconds : 0 },
    pose_latency: latencySummary(poseLatencies), hand_latency: latencySummary(handLatencies), render_fps: seconds ? renderCount / seconds : 0,
    processed_frames: { pose: poseCount, hand: handCount, observations: frameId, rendered: renderCount, source_presented: sourceCount },
    skipped_frames: { source_unpresented: sourceSkipped, worker_busy: busySkipped, pose_not_scheduled: poseSkipped, hand_not_scheduled: handSkipped },
    tracking_loss: { pose_invalid: poseInvalid, hand_invalid: handInvalid, both_hands_valid: bothHands, left_hand_valid: leftCount, right_hand_valid: rightCount },
    benchmark_duration_seconds: seconds, source_measured_duration_seconds: recordedDuration, filter_quality: quality.summary(),
    warmup: { seconds: 3, protocol: 'Repeated inference on actual paused first video frame, then complete playback at 1x without seek; compute warmup, not motion warmup.' },
    recording: { fps: 30, mime_type: recorder?.mimeType ?? null, note: 'Canvas render FPS is measured separately from the 30 FPS recording.' },
    artifact_generation_status: fatal ? 'INCOMPLETE' : 'PENDING_VERIFICATION', errors,
    limitations: ['No ground-truth landmark accuracy or clinical score.', 'No CPU/GPU utilization measured by browser.', 'Filter distance and step metrics are proxies; temporal lag in milliseconds is not inferred.', 'Rendering and recording share the main thread.'] }
  artifacts.append('summary.json', JSON.stringify(summary, null, 2))
  try { await artifacts.flush() } catch (error) { fail(new Error(errorText(error))) }
  status(`${config.name}: xác minh và lưu artifact…`)
  return benchmarkRequest<RunResult>(`/runs/${created.run_id}/finalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fatal ? { error: errorText(fatal), summary } : {}) })
}

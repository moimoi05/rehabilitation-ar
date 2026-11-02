import { BenchmarkArtifacts, benchmarkRequest, BENCHMARK_API, latencySummary } from './benchmarkArtifacts'
import { createBenchmarkEngine } from './benchmarkEngine'
import type { BenchmarkConfig, BenchmarkEngine, Observation } from './benchmarkEngine'
import { BenchmarkQuality, validHand, validPose } from './benchmarkQuality'
import { drawLandmarks } from './drawing'
import type { Point } from './drawing'
import { usableTrackingPoint } from './trackingLandmark'
import { startVideoFrameScheduler } from './videoFrameScheduler'

export type SourceInfo = { source_path: string; width: number; height: number; duration: number; fps: number | null; hardware: Record<string, unknown> }
export type RunResult = { run_id: string; status: string; directory: string; errors: string[]; summary: Record<string, unknown> }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const fpsHeader = 'timestamp_ms,source_fps,pose_fps,hand_fps,render_fps,pose_latency_ms,hand_latency_ms,pose_result_age_ms,hand_result_age_ms,skipped_frames,pose_tracking_valid,hand_tracking_valid\n'

export function comparisonSuite(roi?: BenchmarkConfig['roi']): BenchmarkConfig[] {
  const base = { gpu: true, hands: true, poseFps: 30, handFps: 30, filter: 'raw' as const, schedule: 'independent' as const, repeat: 1, comparison: true }
  return [{ ...base, name: 'A MediaPipe GPU Pose + Hand', engine: 'main' }, { ...base, name: 'B RTMPose-m GPU — operator ROI', engine: 'rtmpose', roi }, { ...base, name: 'B detector + RTMPose-m GPU', engine: 'rtmpose', personDetection: true }]
}

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
  const wholebody = config.engine === 'rtmpose'
  let longTaskCount = 0, longTaskMs = 0, longTaskObserver: PerformanceObserver | null = null
  let fatal: Error | null = null, engine: BenchmarkEngine | null = null, recorder: MediaRecorder | null = null, stream: MediaStream | null = null
  let stopScheduler: (() => void) | null = null, renderRequest = 0, measuring = false, start = 0, end = 0
  let pose: Point[] = [], hands: Point[][] = [], labels: string[] = [], poseTime = 0, handTime = 0, poseValid = false, handValid = false
  let frameId = 0, poseCount = 0, handCount = 0, renderCount = 0, sourceCount = 0, sourceSkipped = 0, poseSkipped = 0, handSkipped = 0, busySkipped = 0
  let poseInvalid = 0, handInvalid = 0, bothHands = 0, leftCount = 0, rightCount = 0
  let leftTime: number | null = null, rightTime: number | null = null, poseLatency: number | null = null, handLatency: number | null = null
  const pipelineLatencies: number[] = []
  const stageLatencies: Record<string, number[]> = {}
  const poseLatencies: number[] = [], handLatencies: number[] = [], deliveryAges: number[] = [], displayAges: number[] = [], frameTimes: number[] = []
  const jointAvailability = [0, 0, 0, 0, 0, 0], handCompleteness = { left: 0, right: 0 }
  let lastRender = 0, latestObservation = 0, observedRender = 0, sourcePresentation = 0
  let pendingRows: Record<string, unknown>[] = []
  const flushObservations = (renderAt?: number) => {
    pendingRows.forEach((row, index) => { const displayed = renderAt !== undefined && index === pendingRows.length - 1; jsonl += JSON.stringify({ ...row, render_timestamp_ms: displayed ? renderAt : null, source_to_display_age_ms: displayed ? renderAt - Number(row.source_presented_at_ms) : null, rendered: displayed }) + '\n' }); pendingRows = []
  }
  let jsonl = '', csv = fpsHeader, lastSample = 0, lastUi = 0, previousCounts = { pose: 0, hand: 0, render: 0, source: 0 }
  let rates = { pose: 0, hand: 0, render: 0, source: 0 }, recordedDuration = 0
  const fail = (error: Error) => { if (!fatal) { fatal = error; errors.push(error.message) } }
  const artifacts = new BenchmarkArtifacts(created.run_id, fail)
  const flushRows = () => { if (jsonl) { artifacts.append('landmarks.jsonl', jsonl); jsonl = '' }; if (csv) { artifacts.append('fps.csv', csv); csv = '' } }
  const observe = (observation: Observation) => {
    if (!measuring) return
    const { frame } = observation, timestamp = frame.inferenceTimestamp
    const deliveredAt = performance.now()
    latestObservation++; sourcePresentation = frame.now
    deliveryAges.push(deliveredAt - frame.now)
    pipelineLatencies.push(observation.pipelineMs ?? deliveredAt - timestamp)
    Object.entries(observation.timings ?? {}).forEach(([stage, duration]) => { if (Number.isFinite(duration) && duration >= 0) stageLatencies[stage] = [...(stageLatencies[stage] ?? []), duration] })
    if (observation.pose) [11, 12, 13, 14, 15, 16].forEach((index, joint) => { if (usableTrackingPoint(observation.pose![index])) jointAvailability[joint]++ })
    const nextPose = observation.pose === null ? null : quality.filter('pose', observation.pose, timestamp, config.filter)
    const nextHands = observation.hands === null ? null : observation.hands.map((points, index) => {
      const category = observation.handedness?.[index]?.[0]
      const identity = category && category.score >= .5 ? category.categoryName : `unknown-${index}`
      if (identity.startsWith('unknown')) quality.reset(identity)
      return quality.filter(identity, points, timestamp, config.filter)
    })
    if (observation.pose !== null) { poseCount++; pose = nextPose ?? []; poseTime = timestamp; poseValid = wholebody ? [11, 12, 13, 14, 15, 16].every(index => usableTrackingPoint(observation.pose![index])) : validPose(observation.pose); if (!poseValid) poseInvalid++; poseLatency = observation.poseMs; if (poseLatency !== null) poseLatencies.push(poseLatency) }
    if (observation.hands !== null) {
      handCount++; hands = nextHands ?? []; handTime = timestamp; handValid = observation.hands.some(points => validHand(points) && points.every(point => usableTrackingPoint(point, true))); if (!handValid) handInvalid++
      labels = observation.handedness?.map(categories => categories[0]?.categoryName || 'Unknown') ?? []
      const left = labels.some((label, index) => label === 'Left' && validHand(observation.hands![index]) && observation.hands![index].every(point => usableTrackingPoint(point, true)))
      const right = labels.some((label, index) => label === 'Right' && validHand(observation.hands![index]) && observation.hands![index].every(point => usableTrackingPoint(point, true)))
      if (left) { leftCount++; leftTime = timestamp } else { leftTime = null; quality.reset('Left') }
      if (right) { rightCount++; rightTime = timestamp } else { rightTime = null; quality.reset('Right') }
      if (left && right) bothHands++
      observation.hands.forEach((points, index) => { const side = labels[index] === 'Left' ? 'left' : labels[index] === 'Right' ? 'right' : null; if (side) handCompleteness[side] += points.filter(point => usableTrackingPoint(point, true)).length })
      handLatency = observation.handMs; if (handLatency !== null) handLatencies.push(handLatency)
    }
    pendingRows.push({ run_id: created.run_id, frame_id: ++frameId, source_timestamp_ms: frame.mediaTime * 1000, source_frame_id: frame.sourceFrameId ?? null,
      model: wholebody ? 'RTMPose-m WholeBody c8b76419' : 'MediaPipe Pose Lite + Hand', runtime_info: engine?.runtimeInfo ?? null,
      person_region_strategy: wholebody ? config.personDetection ? 'detector' : 'operator_roi' : 'mediapipe_internal', tracking_region: observation.trackingRegion ?? null,
      coordinate_system: config.engine === 'rtmpose' ? 'canonical normalized source-image 2D; raw WholeBody model-input crop pixels (192x256), before inverse affine' : 'MediaPipe normalized source-image coordinates; optional model-relative z and world coordinates retain MediaPipe semantics', raw_wholebody_keypoints: observation.rawKeypoints ?? null,
      source_presented_at_ms: frame.now, inference_started_at_ms: config.engine === 'rtmpose' ? null : timestamp, inference_completed_at_ms: config.engine === 'rtmpose' ? null : observation.completedAt ?? deliveredAt, pipeline_started_at_ms: timestamp, result_delivery_at_ms: deliveredAt, runtime_timings: observation.timings ?? null, runtime_service_timestamps_ms: observation.runtimeTimestamps ?? null, runtime_clock_note: config.engine === 'rtmpose' ? 'Service time.perf_counter host-call timestamps/durations; browser and service clocks are not synchronized. Native GPU kernel timestamps unavailable.' : null, pipeline_ms: observation.pipelineMs ?? deliveredAt - timestamp,
      pose_timestamp_ms: observation.pose === null ? null : timestamp, hand_timestamp_ms: observation.hands === null ? null : timestamp,
      raw_pose_landmarks: observation.pose, filtered_pose_landmarks: nextPose, raw_hand_landmarks: observation.hands, filtered_hand_landmarks: nextHands,
      handedness: observation.handedness, world_landmarks: { pose: observation.poseWorld, hands: observation.handWorld },
      pose_valid: observation.pose === null ? null : poseValid, hand_valid: observation.hands === null ? null : handValid,
      pose_inference_ms: observation.poseMs, hand_inference_ms: observation.handMs, pose_delegate: engine?.delegates.pose, hand_delegate: engine?.delegates.hand,
      skipped_frames: sourceSkipped + busySkipped, left_hand_timestamp_ms: observation.hands === null ? null : leftTime, right_hand_timestamp_ms: observation.hands === null ? null : rightTime,
      tracking_status: { pose: observation.pose === null ? 'not_observed' : poseValid ? 'valid' : 'missing_or_invalid', hand: observation.hands === null ? 'not_observed' : handValid ? 'valid' : 'missing_or_invalid' } })
    if (jsonl.length >= 256 * 1024) flushRows()
  }
  const sample = (now: number) => {
    const elapsed = (now - lastSample) / 1000
    if (elapsed < 1) return
    rates = { pose: (poseCount - previousCounts.pose) / elapsed, hand: (handCount - previousCounts.hand) / elapsed, render: (renderCount - previousCounts.render) / elapsed, source: (sourceCount - previousCounts.source) / elapsed }
    previousCounts = { pose: poseCount, hand: handCount, render: renderCount, source: sourceCount }; lastSample = now
    csv += [now - start, rates.source, rates.pose, wholebody ? '' : rates.hand, rates.render, poseLatency ?? '', handLatency ?? '', poseTime ? now - poseTime : '', handTime ? now - handTime : '', sourceSkipped + busySkipped, Number(poseValid && now - poseTime <= 500), Number(handValid && now - handTime <= 500)].join(',') + '\n'
    flushRows()
  }
  const draw = () => {
    const now = performance.now(), ctx = canvas.getContext('2d')
    if (measuring) {
      if (lastRender) frameTimes.push(now - lastRender)
      lastRender = now
      if (latestObservation !== observedRender) {
        observedRender = latestObservation; displayAges.push(now - sourcePresentation)
        flushObservations(now)
      }
    }
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
        `Pose ${rates.pose.toFixed(1)} FPS / ${poseLatency?.toFixed(1) ?? '—'} ms | Hand ${wholebody ? 'N/A (joint)' : rates.hand.toFixed(1)} FPS / ${handLatency?.toFixed(1) ?? '—'} ms | Render ${rates.render.toFixed(1)} FPS`,
        `Pose ${poseValid && now - poseTime <= 500 ? 'VALID' : 'LOST'} | Hands ${handValid && now - handTime <= 500 ? 'VALID' : 'LOST'} | Skips ${sourceSkipped + busySkipped} | Source ${video.currentTime.toFixed(2)}s | ${config.filter}`]
      lines.forEach((line, index) => ctx.fillText(line, 14, 28 + index * 30))
    }
    if (measuring) { renderCount++; sample(now); if (now - lastUi > 1000) { lastUi = now; status(`${config.name} #${config.repeat} — ${video.currentTime.toFixed(1)}/${video.duration.toFixed(1)} s | Pose ${rates.pose.toFixed(1)} / Hand ${wholebody ? 'N/A (joint)' : rates.hand.toFixed(1)} / Render ${rates.render.toFixed(1)} FPS`) } }
    renderRequest = requestAnimationFrame(draw)
  }
  try {
    status(`${config.name}: tải video và model…`)
    await loadSource(video)
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    engine = await createBenchmarkEngine(config, video, observe, fail)
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      longTaskObserver = new PerformanceObserver(list => { if (measuring) for (const entry of list.getEntries()) { longTaskCount++; longTaskMs += entry.duration } })
      longTaskObserver.observe({ type: 'longtask' })
    }
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
      if (wholebody && !doPose) return
      if (engine!.submit(frame, doPose, doHand)) {
        if (doPose) nextPose = nextPose === -Infinity || frame.now - nextPose > 1000 / config.poseFps ? frame.now + 1000 / config.poseFps : nextPose + 1000 / config.poseFps
        if (doHand) { lastHand = frame.now; nextHand = nextHand === -Infinity || frame.now - nextHand > 1000 / config.handFps ? frame.now + 1000 / config.handFps : nextHand + 1000 / config.handFps }
      } else busySkipped++
    }, { maxFps: config.schedule === 'legacy' ? config.poseFps : 120, onReset: () => fail(new Error('Unexpected video seek/replay during measured run')), onSkippedFrame: frame => { sourceCount++; sourceSkipped += frame.skippedSourceFrames ?? 0; poseSkipped++; if (config.hands) handSkipped++ } })
    await video.play()
    while (!video.ended) {
      if (signal.aborted) throw new Error('Benchmark cancelled')
      if (fatal) throw fatal
      if (document.hidden && !(window as unknown as { __BENCHMARK_IGNORE_HIDDEN__?: boolean }).__BENCHMARK_IGNORE_HIDDEN__) throw new Error('Benchmark tab became hidden; measurement is not comparable')
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
    end ||= performance.now(); measuring = false; longTaskObserver?.disconnect(); stopScheduler?.(); video.pause(); cancelAnimationFrame(renderRequest)
    if (recorder && recorder.state !== 'inactive') {
      try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Recording stop timed out')), 15000); recorder!.addEventListener('stop', () => { clearTimeout(timer); resolve() }, { once: true }); recorder!.stop() }) } catch (error) { fail(new Error(errorText(error))) }
    }
    stream?.getTracks().forEach(track => track.stop())
    try { engine?.close() } catch (error) { fail(new Error(`Model cleanup: ${errorText(error)}`)) }
    flushObservations(); flushRows()
  }
  const seconds = start ? (end - start) / 1000 : 0
  const summary = { run_id: created.run_id, date_time: new Date().toISOString(), configuration: config, source_video_path: source.source_path, source_video_metadata: source,
    browser: navigator.userAgent, hardware: source.hardware, runtime_info: engine?.runtimeInfo ?? null, mediapipe_version: wholebody ? null : '0.10.35', pose_model: wholebody ? 'RTMPose-m WholeBody c8b76419' : 'pose_landmarker_lite.task', hand_model: wholebody ? null : config.hands ? 'hand_landmarker.task' : null,
    actual_delegates: engine?.delegates ?? { pose: null, hand: null }, pose_delegate: engine?.delegates.pose ?? null, hand_delegate: engine?.delegates.hand ?? null,
    resolution: { width: video.videoWidth, height: video.videoHeight }, playback_rate: 1, requested_fps: { pose: config.poseFps, hand: config.hands ? config.handFps : 0 },
    actual_fps: { pose: seconds ? poseCount / seconds : 0, hand: wholebody ? null : seconds ? handCount / seconds : 0, wholebody_result: wholebody && seconds ? poseCount / seconds : null, render: seconds ? renderCount / seconds : 0 },
    pose_latency: latencySummary(poseLatencies), hand_latency: wholebody ? null : latencySummary(handLatencies), render_fps: seconds ? renderCount / seconds : 0,
    processed_frames: { pose: poseCount, hand: handCount, observations: frameId, rendered: renderCount, source_presented: sourceCount },
    skipped_frames: { source_unpresented: sourceSkipped, worker_busy: busySkipped, pose_not_scheduled: poseSkipped, hand_not_scheduled: handSkipped },
    landmark_availability: { joints: Object.fromEntries(['left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist'].map((name, index) => [name, poseCount ? jointAvailability[index] / poseCount : null])), left_hand_rate: handCount ? leftCount / handCount : null, right_hand_rate: handCount ? rightCount / handCount : null, both_hands_rate: handCount ? bothHands / handCount : null, left_hand_21_point_completeness: handCount ? handCompleteness.left / (21 * handCount) : null, right_hand_21_point_completeness: handCount ? handCompleteness.right / (21 * handCount) : null },
    pipeline_latency: latencySummary(pipelineLatencies), runtime_stage_latency: Object.fromEntries(Object.entries(stageLatencies).map(([stage, durations]) => [stage, latencySummary(durations)])), person_region_strategy: wholebody ? config.personDetection ? 'detector' : 'operator_roi' : 'mediapipe_internal', end_to_end_delivery_age: latencySummary(deliveryAges), source_presented_to_first_display_age: latencySummary(displayAges), render_frame_time: latencySummary(frameTimes), long_tasks: { supported: PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false, count: longTaskCount, duration_ms: longTaskMs },
    gpu_telemetry: { utilization: null, memory: null, engine: null, temperature: null, power_state: null, note: 'Not measured by browser; no GPU utilization inferred from rendering.' },
    tracking_loss: { pose_invalid: poseInvalid, hand_invalid: handInvalid, both_hands_valid: bothHands, left_hand_valid: leftCount, right_hand_valid: rightCount },
    benchmark_duration_seconds: seconds, source_measured_duration_seconds: recordedDuration, filter_quality: quality.summary(),
    warmup: { seconds: 3, protocol: 'Repeated inference on actual paused first video frame, then complete playback at 1x without seek; compute warmup, not motion warmup.' },
    recording: { fps: 30, mime_type: recorder?.mimeType ?? null, note: 'Canvas render FPS is measured separately from the 30 FPS recording.' },
    artifact_generation_status: fatal ? 'INCOMPLETE' : 'PENDING_VERIFICATION', errors,
    limitations: ['No ground-truth landmark accuracy or clinical score.', 'No CPU/GPU utilization measured by browser.', 'Filter distance and step metrics are proxies; temporal lag in milliseconds is not inferred.', 'Rendering and recording share the main thread.', 'Source-to-display age starts at source frame browser presentation, not camera capture or original video encoding time.', 'RTMPose hand inference is joint WholeBody; independent Hand FPS/P95 are N/A.'] }
  artifacts.append('summary.json', JSON.stringify(summary, null, 2))
  try { await artifacts.flush() } catch (error) { fail(new Error(errorText(error))) }
  status(`${config.name}: xác minh và lưu artifact…`)
  return benchmarkRequest<RunResult>(`/runs/${created.run_id}/finalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fatal ? { error: errorText(fatal), summary } : {}) })
}

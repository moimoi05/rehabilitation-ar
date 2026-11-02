/** Isolated compatibility probe, intentionally separate from clinical tracking. */
import * as ort from 'onnxruntime-web/webgpu'
import { adaptRTMPoseWholeBody, createRtmposeCropTransform } from './rtmposeAdapter'
import { drawLandmarks } from './drawing'
import { createRTMPoseEngine } from './rtmposeEngine'
import type { RTMPoseEngine, RTMPoseResult } from './rtmposeEngine'

type Adapter = { isFallbackAdapter?: boolean; info?: { vendor?: string; architecture?: string; device?: string; description?: string } }
type GpuNavigator = Navigator & { gpu?: { requestAdapter(options: { powerPreference: 'high-performance' }): Promise<Adapter | null> } }
const button = document.querySelector<HTMLButtonElement>('#run')!
const output = document.querySelector<HTMLElement>('#result')!
const videoButton = document.querySelector<HTMLButtonElement>('#video-run')!
const ovButton = document.querySelector<HTMLButtonElement>('#ov-run')!
const detectorButton = document.querySelector<HTMLButtonElement>('#detector-run')!
const setBusy = (busy: boolean) => { [button, videoButton, ovButton, detectorButton].forEach(value => { value.disabled = busy }) }
const publishDecision = (evidence: Record<string, unknown>, name: string) => {
  const serialized = JSON.stringify(evidence, null, 2)
  document.querySelector<HTMLElement>('#decision-result')!.textContent = serialized
  const link = document.querySelector<HTMLAnchorElement>('#diagnostic-download')!
  if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href)
  link.href = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }))
  link.download = name; link.hidden = false
}
const glCanvas = document.createElement('canvas')
const gl = glCanvas.getContext('webgl2') ?? glCanvas.getContext('webgl')
const webglDiagnosticContext = (() => {
  if (!gl) return null
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const info = {
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    note: 'Separate diagnostic canvas on this browser. This does not prove the actual MediaPipe Tasks context device.',
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return info
})()
document.querySelector<HTMLElement>('#webgl')!.textContent = JSON.stringify(webglDiagnosticContext, null, 2)

button.onclick = async () => {
  setBusy(true)
  const evidence: Record<string, unknown> = {
    probe: 'RTMPose-m WholeBody ONNX WebGPU compatibility, synthetic input only',
    model: 'rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728',
    browser: navigator.userAgent, timestamp: new Date().toISOString(), status: 'INCOMPLETE',
    cpuFallbackAllowed: false, graphCaptureRequired: false, fullGpuGraphRequired: true,
    freeDimensionOverrides: { batch: 1 },
    webglDiagnosticContext,
  }
  let session: ort.InferenceSession | null = null
  const show = () => { output.textContent = JSON.stringify(evidence, null, 2) }
  try {
    const gpu = (navigator as GpuNavigator).gpu
    if (!gpu) throw new Error('navigator.gpu is unavailable')
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('WebGPU requestAdapter returned null; no GPU adapter available under current Edge/driver policy')
    evidence.adapter = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null
    evidence.fallbackAdapter = adapter.isFallbackAdapter ?? null
    if (adapter.isFallbackAdapter) throw new Error('Software/fallback GPU adapter rejected')
    // Bind the inspected adapter so reported hardware matches the inference device.
    ort.env.webgpu.adapter = adapter as typeof ort.env.webgpu.adapter
    show()
    // Keep all runtime artifacts local. Vite serves package assets in this probe.
    ort.env.wasm.numThreads = 1
    ort.env.logLevel = 'verbose'
    ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/'
    const started = performance.now()
    session = await ort.InferenceSession.create('/rtmpose/medium.onnx', {
      executionProviders: ['webgpu'], enableGraphCapture: false,
      freeDimensionOverrides: { batch: 1 },
      logSeverityLevel: 0, logVerbosityLevel: 1,
      extra: { session: { disable_cpu_ep_fallback: '1' } },
    })
    evidence.initializationMs = performance.now() - started
    const tensor = new ort.Tensor('float32', new Float32Array(3 * 256 * 192), [1, 3, 256, 192])
    const timings: number[] = []
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      const result = await session.run({ input: tensor })
      timings.push(performance.now() - start)
      evidence.outputs = Object.fromEntries(Object.entries(result).map(([name, value]) => [name, {
        dims: value.dims, finite: Array.from(value.data as Float32Array).every(Number.isFinite),
      }]))
      Object.values(result).forEach(value => value.dispose())
    }
    tensor.dispose()
    evidence.roundTripMs = timings
    evidence.status = 'GRAPH_GPU_COMPATIBLE_SYNTHETIC_ONLY'
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    evidence.status = 'GPU_PROBE_FAILED'
  } finally {
    try { if (session) await session.release() }
    catch (error) { evidence.cleanupError = error instanceof Error ? error.message : String(error) }
    show(); setBusy(false)
  }
}

const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }
}

videoButton.onclick = async () => {
  setBusy(true)
  const resultElement = document.querySelector<HTMLElement>('#video-result')!
  const canvas = document.querySelector<HTMLCanvasElement>('#video-overlay')!
  const evidence: Record<string, unknown> = {
    status: 'INCOMPLETE', timestamp: new Date().toISOString(), browser: navigator.userAgent,
    runtime: 'ONNX Runtime Web 1.31.1 WebGPU', cpuFallbackAllowed: false,
    model: 'rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728',
    source: 'http://127.0.0.1:8001/api/benchmarks/source', sourceTimestampSeconds: 5,
    protocol: 'Paused source frame5s; 1 cold/warm + 10 measured repeats. Not a 1x playback benchmark.',
    webglDiagnosticContext,
  }
  const show = () => { resultElement.textContent = JSON.stringify(evidence, null, 2) }
  let session: ort.InferenceSession | null = null
  const video = document.createElement('video')
  try {
    show()
    const gpu = (navigator as GpuNavigator).gpu
    if (!gpu) throw new Error('navigator.gpu unavailable')
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter || adapter.isFallbackAdapter) throw new Error('No hardware WebGPU adapter available')
    evidence.adapter = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null
    ort.env.webgpu.adapter = adapter as typeof ort.env.webgpu.adapter
    ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/'
    ort.env.logLevel = 'warning'
    const init = performance.now()
    session = await ort.InferenceSession.create('/rtmpose/medium.onnx', {
      executionProviders: ['webgpu'], freeDimensionOverrides: { batch: 1 },
      extra: { session: { disable_cpu_ep_fallback: '1' } },
    })
    evidence.initializationMs = performance.now() - init
    video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'auto'
    const loading = performance.now()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source video load timed out')), 15000)
      video.onloadeddata = () => { clearTimeout(timer); resolve() }
      video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message ?? 'Video decode failed')) }
      video.src = 'http://127.0.0.1:8001/api/benchmarks/source'; video.load()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source seek timed out')), 15000)
      video.onseeked = () => { clearTimeout(timer); resolve() }; video.currentTime = 5
    })
    video.pause(); evidence.loadAndSeekMs = performance.now() - loading
    const options = { imageWidth: video.videoWidth, imageHeight: video.videoHeight, inputWidth: 192, inputHeight: 256,
      roi: { x: 0, y: 0, width: 1, height: 1 }, scoreThreshold: .3 }
    const crop = createRtmposeCropTransform(options)
    evidence.imageDimensions = [video.videoWidth, video.videoHeight]; evidence.crop = crop
    const inputCanvas = document.createElement('canvas'); inputCanvas.width = 192; inputCanvas.height = 256
    const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true })!
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const context = canvas.getContext('2d')!
    const stages: Record<string, number[]> = { capturePreprocessMs: [], gpuCallReadbackMs: [], decodeMs: [], renderMs: [], endToEndMs: [] }
    for (let iteration = 0; iteration < 11; iteration++) {
      const begin = performance.now()
      inputContext.fillStyle = '#000'; inputContext.fillRect(0, 0, 192, 256)
      inputContext.drawImage(video, -crop.x / crop.width * 192, -crop.y / crop.height * 256,
        video.videoWidth / crop.width * 192, video.videoHeight / crop.height * 256)
      const rgba = inputContext.getImageData(0, 0, 192, 256).data
      const input = new Float32Array(3 * 192 * 256), plane = 192 * 256
      const mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375]
      for (let pixel = 0; pixel < plane; pixel++) for (let channel = 0; channel < 3; channel++) input[channel * plane + pixel] = (rgba[pixel * 4 + channel] - mean[channel]) / std[channel]
      const tensor = new ort.Tensor('float32', input, [1, 3, 256, 192])
      const preprocessed = performance.now()
      const outputs = await session.run({ input: tensor })
      const inferred = performance.now()
      const sx = outputs.simcc_x, sy = outputs.simcc_y
      if (sx.dims.join(',') !== '1,133,384' || sy.dims.join(',') !== '1,133,512') throw new Error('Unexpected SimCC output dimensions')
      const xValues = sx.data as Float32Array, yValues = sy.data as Float32Array
      const keypoints = Array.from({ length: 133 }, (_, keypoint) => {
        let maxX = -Infinity, maxY = -Infinity, x = -1, y = -1
        for (let i = 0; i < 384; i++) if (xValues[keypoint * 384 + i] > maxX) { maxX = xValues[keypoint * 384 + i]; x = i }
        for (let i = 0; i < 512; i++) if (yValues[keypoint * 512 + i] > maxY) { maxY = yValues[keypoint * 512 + i]; y = i }
        const score = Math.min(maxX, maxY)
        return { x: Number.isFinite(score) && score > 0 ? x / 2 : NaN, y: Number.isFinite(score) && score > 0 ? y / 2 : NaN, score }
      })
      const canonical = adaptRTMPoseWholeBody(keypoints, { ...options, crop })
      const decoded = performance.now()
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      drawLandmarks(context, canvas.width, canvas.height, canonical.pose, false)
      canonical.hands.forEach(hand => drawLandmarks(context, canvas.width, canvas.height, hand, false, true))
      context.fillStyle = '#000b'; context.fillRect(0, 0, canvas.width, 55)
      context.fillStyle = 'white'; context.font = '24px sans-serif'
      context.fillText(`WebGPU strict · frame5s · iteration ${iteration} · FULL FRAME ROI`, 15, 35)
      const rendered = performance.now()
      const sample = { capturePreprocessMs: preprocessed - begin, gpuCallReadbackMs: inferred - preprocessed,
        decodeMs: decoded - inferred, renderMs: rendered - decoded, endToEndMs: rendered - begin }
      if (iteration === 0) evidence.coldWarmIterationMs = sample
      else Object.keys(stages).forEach(stage => stages[stage].push(sample[stage as keyof typeof sample]))
      evidence.lastRawKeypointsModelInputPixels = keypoints
      evidence.lastCanonicalLandmarks = canonical
      evidence.completedIterations = iteration + 1
      Object.values(outputs).forEach(value => value.dispose()); tensor.dispose()
    }
    evidence.measuredIterations = 10; evidence.stageMs = Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, summarize(values)]))
    evidence.samplesMs = stages; evidence.status = 'ACTUAL_FRAME_GPU_DIAGNOSTIC_COMPLETE'
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error); evidence.status = 'ACTUAL_FRAME_GPU_DIAGNOSTIC_FAILED'
  } finally {
    video.pause(); video.removeAttribute('src'); video.load()
    try { await session?.release() } catch (error) { evidence.cleanupError = String(error) }
    show(); setBusy(false)
  }
}

ovButton.onclick = async () => {
  setBusy(true)
  const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), status: 'INCOMPLETE',
    diagnostic: 'OpenVINO GPU actual frame5s; same fullframe ROI and canvas overlay as WebGPU diagnostic',
    protocol: 'Paused video frame5s, 1 warm +10 measured client capture/JPEG/HTTP/adapter/render iterations; not playback FPS',
    source: 'http://127.0.0.1:8001/api/benchmarks/source', sourceTimestampSeconds: 5,
    browser: navigator.userAgent, cpuFallbackAllowed: false }
  const video = document.createElement('video')
  let engine: RTMPoseEngine | null = null
  let waiting: { resolve: (value: RTMPoseResult) => void; reject: (error: Error) => void } | null = null
  try {
    publishDecision(evidence, 'openvino-frame5s-diagnostic.json')
    const init = performance.now()
    engine = await createRTMPoseEngine({ roi: { x: 0, y: 0, width: 1, height: 1 }, personDetection: false,
      onResult: result => { const pending = waiting; waiting = null; pending?.resolve(result) },
      onError: error => { const pending = waiting; waiting = null; pending?.reject(error) } })
    evidence.initializationMs = performance.now() - init; evidence.runtimeInfo = engine.runtimeInfo
    video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source load timed out')), 15000)
      video.onloadeddata = () => { clearTimeout(timer); resolve() }
      video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message ?? 'Source load failed')) }
      video.src = 'http://127.0.0.1:8001/api/benchmarks/source'; video.load()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source seek timed out')), 15000)
      video.onseeked = () => { clearTimeout(timer); resolve() }; video.currentTime = 5
    })
    video.pause()
    const canvas = document.querySelector<HTMLCanvasElement>('#video-overlay')!
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const context = canvas.getContext('2d')!
    const samples: Record<string, number[]> = {}
    for (let iteration = 0; iteration < 11; iteration++) {
      const begin = performance.now()
      const result = await new Promise<RTMPoseResult>((resolve, reject) => {
        const timer = setTimeout(() => { waiting = null; reject(new Error('OpenVINO frame timed out')) }, 15000)
        waiting = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
        if (!engine!.submit(video, begin)) { waiting = null; clearTimeout(timer); reject(new Error('OpenVINO engine refused frame')) }
      })
      const delivered = performance.now()
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      drawLandmarks(context, canvas.width, canvas.height, result.pose, false)
      result.hands.forEach(hand => drawLandmarks(context, canvas.width, canvas.height, hand, false, true))
      context.fillStyle = '#000b'; context.fillRect(0, 0, canvas.width, 55)
      context.fillStyle = 'white'; context.font = '24px sans-serif'
      context.fillText(`OpenVINO GPU · frame5s · iteration ${iteration} · FULL FRAME ROI`, 15, 35)
      const rendered = performance.now()
      const sample = { clientCaptureJpegHttpAdaptMs: delivered - begin, renderMs: rendered - delivered,
        endToEndMs: rendered - begin, clientOverheadOutsideServerMs: delivered - begin - (result.timings.totalMs ?? 0),
        ...Object.fromEntries(Object.entries(result.timings).map(([name, value]) => [`service_${name}`, value])) }
      if (iteration === 0) evidence.warmIterationMs = sample
      else for (const [name, value] of Object.entries(sample)) { (samples[name] ??= []).push(value) }
      evidence.lastResult = result; evidence.completedIterations = iteration + 1
    }
    evidence.samplesMs = samples; evidence.stageMs = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)]))
    evidence.measuredIterations = 10; evidence.status = 'OPENVINO_ACTUAL_FRAME_DIAGNOSTIC_COMPLETE'
    evidence.limitations = ['Canvas draw submission, not display scanout.', 'JPEG input differs from direct WebGPU RGBA path; transfer/compression included.', 'Repeated paused frame, no temporal quality/FPS claims.']
  } catch (error) { evidence.status = 'OPENVINO_ACTUAL_FRAME_DIAGNOSTIC_FAILED'; evidence.error = error instanceof Error ? error.message : String(error) }
  finally { engine?.close(); video.pause(); video.removeAttribute('src'); video.load(); publishDecision(evidence, 'openvino-frame5s-diagnostic.json'); setBusy(false) }
}

detectorButton.onclick = async () => {
  setBusy(true)
  const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), status: 'INCOMPLETE',
    diagnostic: 'Official RTMDet-nano person detector strict all-graph WebGPU synthetic compatibility only',
    model: 'rtmdet_nano_8xb32-300e_coco-person_in1kpretrain-96154d0b',
    sha256: 'b8585adb6d1352796f6e86337e09c3459b830645a7e7192d9381670bea2facbd',
    cpuFallbackAllowed: false, browser: navigator.userAgent, freeDimensionOverrides: { batch: 1 } }
  let session: ort.InferenceSession | null = null
  try {
    publishDecision(evidence, 'webgpu-person-detector-compatibility.json')
    const adapter = await (navigator as GpuNavigator).gpu?.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter || adapter.isFallbackAdapter) throw new Error('No hardware WebGPU adapter')
    evidence.adapter = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null
    ort.env.webgpu.adapter = adapter as typeof ort.env.webgpu.adapter
    ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/'; ort.env.logLevel = 'verbose'
    const init = performance.now()
    session = await ort.InferenceSession.create('/rtmpose/detector.onnx', { executionProviders: ['webgpu'],
      freeDimensionOverrides: { batch: 1 }, logSeverityLevel: 0, logVerbosityLevel: 1,
      extra: { session: { disable_cpu_ep_fallback: '1' } } })
    evidence.initializationMs = performance.now() - init
    const tensor = new ort.Tensor('float32', new Float32Array(3 * 320 * 320), [1, 3, 320, 320])
    const start = performance.now(), result = await session.run({ [session.inputNames[0]]: tensor })
    evidence.roundTripMs = performance.now() - start
    evidence.outputs = Object.fromEntries(Object.entries(result).map(([name, value]) => [name, { dims: value.dims, type: value.type }]))
    Object.values(result).forEach(value => value.dispose()); tensor.dispose()
    evidence.status = 'DETECTOR_FULL_GRAPH_GPU_COMPATIBLE_SYNTHETIC_ONLY'
  } catch (error) { evidence.status = 'DETECTOR_GPU_COMPATIBILITY_FAILED'; evidence.error = error instanceof Error ? error.message : String(error) }
  finally { try { await session?.release() } catch (error) { evidence.cleanupError = String(error) }; publishDecision(evidence, 'webgpu-person-detector-compatibility.json'); setBusy(false) }
}

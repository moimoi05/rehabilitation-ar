import { durableCaptureQueue, MemoryCaptureQueueStore } from './captureQueueStore'
import { acquireCaptureOwnership } from './captureOwnership'
import type { CaptureFinalizePayload, CaptureQueuePart, CaptureQueueState, CaptureQueueStore } from './captureQueueStore'
export type { CaptureQueueState, CaptureQueueStore } from './captureQueueStore'

export type CaptureLandmark = { landmark_source: 'pose' | 'hand'; landmark_index: number; landmark_name: string; x: number | null; y: number | null; z: number | null; coordinate_space: 'normalized_image' | 'world'; is_valid: boolean; invalid_reason?: string; visibility?: number; presence?: number; handedness?: string; handedness_score?: number; hand_observation_index?: number; representation?: 'raw' | 'display' }
export type InferenceStatus = 'not_run' | 'detected' | 'not_detected' | 'error' | 'missing_result'
export type CaptureFrame = { frame_id: number; source_frame_id?: number | null; source_observation_id?: number | null; timestamp_ms: number; video_media_time_ms: number | null; utc_time: string; inference_performed: boolean; pose_detected: boolean | null; hand_detected: boolean | null; inference_ms: number | null; skipped_frames: number; landmarks: CaptureLandmark[]; pose_inference_performed?: boolean | null; hand_inference_performed?: boolean | null; pose_inference_status?: InferenceStatus; hand_inference_status?: InferenceStatus; pose_inference_ms?: number | null; hand_inference_ms?: number | null; pose_error?: string | null; hand_error?: string | null }
export type CaptureStats = { frames: number; landmarks: number; uploadedBatches: number; pending: number; videoBytes: number; videoChunks: number; error: string; pendingBytes?: number; interrupted?: boolean; knownDataGaps?: string[] }
type Send = (path: string, body?: unknown, blob?: Blob) => Promise<unknown>
const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
export class CaptureHttpError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'CaptureHttpError' }
}
/** The server may still complete finalize after the client loses its response. */
export class FinalizeOutcomeUnknown extends Error {
  constructor() { super('Không xác định được kết quả finalize; hãy kiểm tra trạng thái capture.'); this.name = 'FinalizeOutcomeUnknown' }
}
export async function captureRequest(path: string, body?: unknown, blob?: Blob): Promise<unknown> {
  const headers: Record<string, string> = {}
  if (blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    headers['X-Chunk-SHA256'] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    headers['Content-Type'] = blob.type || 'application/octet-stream'
  } else headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  let response: Response
  try { response = await fetch(`${base}${path}`, { method: blob ? 'PUT' : 'POST', headers, body: blob || JSON.stringify(body), signal: controller.signal }) }
  finally { clearTimeout(timeout) }
  if (!response.ok) { let detail = `HTTP ${response.status}`; try { const json = await response.json(); if (typeof json.detail === 'string') detail = json.detail } catch { /* preserve HTTP status */ }; throw new CaptureHttpError(detail, response.status) }
  return response.json()
}

export type CaptureUploaderOptions = {
  durable?: boolean; store?: CaptureQueueStore; maxBytes?: number; maxParts?: number; maxVolatileBytes?: number
  retryDelaysMs?: number[]; recoverExisting?: boolean
}
export type FinalizeMetadata = Pick<CaptureFinalizePayload, 'game_started_at_ms' | 'game_ended_at_ms' | 'termination_reason' | 'known_data_gaps' | 'tracking_video_complete'> & { ended_at_utc?: string }
const retryable = (error: unknown) => !(error instanceof CaptureHttpError) || error.status === 408 || error.status === 429 || error.status >= 500
const asError = (error: unknown) => error instanceof Error ? error : new Error('Không gửi được dữ liệu nghiên cứu.')

/** Persist before sending. Network failures suspend uploads, never collection or gameplay. */
export class CaptureUploader {
  private buffer: CaptureFrame[] = []
  private ingress: Promise<void> = Promise.resolve()
  private pump: Promise<void> | null = null
  private ready: Promise<void> | null = null
  private uploadError: Error | null = null
  private interrupted = false
  private volatileBytes = 0
  private knownDataGaps: string[] = []
  private stopped = false
  private store: CaptureQueueStore
  private state: CaptureQueueState
  private stats: CaptureStats = { frames: 0, landmarks: 0, uploadedBatches: 0, pending: 0, videoBytes: 0, videoChunks: 0, error: '' }
  constructor(private id: string, private send: Send, private report: (stats: CaptureStats) => void, private options: CaptureUploaderOptions = {}) {
    this.store = options.store || (options.durable ? durableCaptureQueue : new MemoryCaptureQueueStore())
    this.state = { captureId: id, sequence: 0, batches: 0, chunks: 0, frames: 0, landmarks: 0, videoBytes: 0, createdAt: new Date().toISOString(), knownDataGaps: [] }
  }
  private update(update: Partial<CaptureStats>) { this.stats = { ...this.stats, ...update }; this.report({ ...this.stats }) }
  prepare() {
    if (!this.ready) this.ready = (async () => {
      const existing = await this.store.getState(this.id)
      if (existing) {
        if (!this.options.recoverExisting) throw new Error('Capture đã có dữ liệu local; cần phục hồi thay vì bắt đầu recorder mới.')
        this.state = existing; this.knownDataGaps = [...existing.knownDataGaps]
        this.stopped = !!existing.stopped
        this.update({ frames: existing.frames, landmarks: existing.landmarks, videoBytes: existing.videoBytes, videoChunks: existing.chunks })
      } else await this.store.saveState(this.state)
    })()
    return this.ready
  }
  markIncomplete(reason: string) {
    const message = reason.slice(0, 256)
    if (!this.knownDataGaps.includes(message)) this.knownDataGaps = [...this.knownDataGaps.slice(0, 31), message]
    this.interrupted = true
    this.update({ interrupted: true, knownDataGaps: [...this.knownDataGaps], error: message })
    // Merge only the gap field transactionally so pending writes cannot lose counters.
    void this.prepare().then(() => this.store.markIncomplete(this.id, message)).catch(error => {
      this.update({ error: `${message} Không thể lưu trạng thái local: ${asError(error).message}` })
    })
  }
  /** Persist a partial-artifact warning without stopping the other streams. */
  noteGap(reason: string) {
    const message = reason.slice(0, 256)
    if (!this.knownDataGaps.includes(message)) this.knownDataGaps = [...this.knownDataGaps.slice(0, 31), message]
    this.update({ knownDataGaps: [...this.knownDataGaps] })
    void this.prepare().then(() => this.store.markIncomplete(this.id, message)).catch(error => {
      this.markIncomplete(`Không thể lưu trạng thái lỗi video tracking: ${asError(error).message}`)
    })
  }
  private enqueue(kind: CaptureQueuePart['kind'], bytes: number, value: { frames?: CaptureFrame[]; blob?: Blob; path?: string; body?: unknown }) {
    if (this.interrupted) return
    if (bytes + this.volatileBytes > (this.options.maxVolatileBytes ?? 8 * 1024 * 1024)) { this.markIncomplete('Bộ đệm ghi local vượt giới hạn; có phần dữ liệu chưa được lưu.'); return }
    this.volatileBytes += bytes
    this.ingress = this.ingress.then(async () => {
      await this.prepare()
      const batches = this.state.batches, chunks = this.state.chunks, trackingChunks = this.state.trackingChunks || 0
      const next = { ...this.state, sequence: this.state.sequence + 1, batches: batches + Number(kind === 'batch'), chunks: chunks + Number(kind === 'video'), trackingChunks: trackingChunks + Number(kind === 'tracking_video'), frames: this.state.frames + (value.frames?.length || 0), landmarks: this.state.landmarks + (value.frames?.reduce((sum, frame) => sum + frame.landmarks.length, 0) || 0), videoBytes: this.state.videoBytes + (kind === 'video' ? value.blob?.size || 0 : 0), knownDataGaps: [...this.knownDataGaps] }
      const path = kind === 'batch' ? `/api/captures/${this.id}/landmark-batches` : kind === 'video' ? `/api/captures/${this.id}/video-chunks/${chunks}` : kind === 'tracking_video' ? `/api/captures/${this.id}/tracking-video-chunks/${trackingChunks}` : value.path!
      const body = kind === 'batch' ? { batch_index: batches, frames: value.frames } : value.body
      const part: CaptureQueuePart = { key: `${this.id}:${this.state.sequence}`, captureId: this.id, sequence: this.state.sequence, kind, path, bytes, ...(body === undefined ? {} : { body }), ...(value.blob ? { blob: value.blob } : {}) }
      await this.store.putPart(part, next, { maxBytes: this.options.maxBytes ?? 128 * 1024 * 1024, maxParts: this.options.maxParts ?? 512 })
      this.state = next
      this.update({ pending: this.stats.pending + 1, pendingBytes: (this.stats.pendingBytes || 0) + bytes })
    }).catch(error => { this.markIncomplete(asError(error).message) }).finally(() => { this.volatileBytes -= bytes })
    void this.ingress.then(() => this.kick())
  }
  private async sendRetry(path: string, body?: unknown, blob?: Blob) {
    const delays = this.options.retryDelaysMs || [250, 1000]
    for (let attempt = 0; ; attempt++) {
      try { return await this.send(path, body, blob) }
      catch (error) {
        if (!retryable(error) || attempt >= delays.length) throw error
        await new Promise(resolve => setTimeout(resolve, delays[attempt]))
      }
    }
  }
  private kick() {
    if (this.pump || this.uploadError) return
    this.pump = (async () => {
      try {
        await this.prepare()
        for (;;) {
          const part = await this.store.firstPart(this.id)
          if (!part) break
          await this.sendRetry(part.path, part.body, part.blob)
          await this.store.acknowledge(part.key)
          this.update({ pending: Math.max(0, this.stats.pending - 1), pendingBytes: Math.max(0, (this.stats.pendingBytes || 0) - part.bytes), uploadedBatches: this.stats.uploadedBatches + Number(part.kind === 'batch'), error: this.interrupted ? this.knownDataGaps[0] : '' })
        }
      } catch (error) { this.uploadError = asError(error); this.update({ error: this.uploadError.message }) }
    })().finally(() => { this.pump = null })
  }
  addFrame(frame: CaptureFrame) {
    if (this.interrupted || this.stopped) return
    this.buffer = [...this.buffer, frame]
    this.update({ frames: this.stats.frames + 1, landmarks: this.stats.landmarks + frame.landmarks.length })
    if (this.buffer.length >= 15) this.flush()
  }
  flush() {
    if (!this.buffer.length || this.interrupted) return
    const frames = this.buffer; this.buffer = []
    // Detach from caller-owned objects once; every retry sends the same payload.
    const immutableFrames = JSON.parse(JSON.stringify(frames)) as CaptureFrame[]
    this.enqueue('batch', new TextEncoder().encode(JSON.stringify(immutableFrames)).byteLength, { frames: immutableFrames })
  }
  addVideoChunk(blob: Blob) {
    if (!blob.size || this.interrupted || this.stopped) return
    this.update({ videoBytes: this.stats.videoBytes + blob.size, videoChunks: this.stats.videoChunks + 1 })
    this.enqueue('video', blob.size, { blob })
  }
  addTrackingVideoChunk(blob: Blob) {
    if (!blob.size || this.interrupted || this.stopped) return
    this.enqueue('tracking_video', blob.size, { blob })
  }
  addMetadata(path: string, body: unknown) {
    if (!path.startsWith(`/api/captures/${this.id}/`)) throw new Error('Metadata thuộc capture khác.')
    const immutable = JSON.parse(JSON.stringify(body)) as unknown
    this.enqueue('metadata', new TextEncoder().encode(JSON.stringify(immutable)).byteLength, { path, body: immutable })
  }
  async drain() {
    await this.ingress; this.kick(); await this.pump
    if (this.uploadError) throw this.uploadError
  }
  async resume() {
    if (this.uploadError && !retryable(this.uploadError)) throw this.uploadError
    this.uploadError = null
    await this.drain()
  }
  async finish(duration: number, beforeFinalize?: () => Promise<void>, extra: FinalizeMetadata = {}) {
    const ended_at_utc = new Date().toISOString()
    this.flush(); this.stopped = true; await this.ingress; await this.prepare()
    const gaps = [...new Set([...this.knownDataGaps, ...(extra.known_data_gaps || [])])]
    const payload: CaptureFinalizePayload = this.state.stopped || { expected_batches: this.state.batches, expected_video_chunks: this.state.chunks, ...(this.state.trackingChunks ? { expected_tracking_video_chunks: this.state.trackingChunks } : {}), ended_at_utc, duration_ms: duration, ...extra, ...(gaps.length ? { known_data_gaps: gaps } : {}) }
    this.state = { ...this.state, knownDataGaps: gaps, stopped: payload }
    await this.store.saveState(this.state)
    await this.drain()
    await beforeFinalize?.()
    let result: unknown
    try { result = await this.sendRetry(`/api/captures/${this.id}/finalize`, payload) }
    catch (error) { if (!retryable(error)) throw error; throw new FinalizeOutcomeUnknown() }
    const status = (result as { status?: string })?.status
    if (status === 'complete' || status === 'incomplete') await this.store.removeState(this.id)
    return result
  }
}

export const pendingCaptureUploads = (store: CaptureQueueStore = durableCaptureQueue) => store.listStates()
export type RecoverableCaptureStatus = { status: string; lease_expires_at?: string | null }
/** Refresh cannot recover an un-emitted recorder chunk. Only a persisted stop declaration permits finalize. */
export async function recoverCaptureUpload(id: string, send: Send, getServerStatus: (id: string) => Promise<RecoverableCaptureStatus>, store: CaptureQueueStore = durableCaptureQueue) {
  const releaseOwnership = await acquireCaptureOwnership(id)
  try {
  const state = await store.getState(id)
  if (!state) throw new Error('Không có dữ liệu local của capture này.')
  const server = await getServerStatus(id)
  if (server.status === 'complete' && !await store.firstPart(id)) {
    await store.removeState(id)
    return server
  }
  const lease = server.lease_expires_at ? Date.parse(server.lease_expires_at) : NaN
  if (server.status !== 'recording' || !Number.isFinite(lease) || lease <= Date.now()) {
    throw new Error('Capture đã đóng hoặc hết lease; giữ nguyên phần local chưa được xác nhận.')
  }
  const uploader = new CaptureUploader(id, send, () => {}, { store, recoverExisting: true })
  await uploader.prepare(); await uploader.resume()
  if (!state.stopped) {
    // Flush acknowledged parts, but never infer that an interrupted recording was complete.
    const reason = 'Refresh trước khi có khai báo dừng; video có thể thiếu chunk cuối.'
    return await send(`/api/captures/${id}/incomplete`, { reason, known_data_gaps: [reason] })
  }
  return await uploader.finish(state.stopped.duration_ms)
  } finally { releaseOwnership() }
}

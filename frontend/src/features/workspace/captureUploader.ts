export type CaptureLandmark = { landmark_source: 'pose' | 'hand'; landmark_index: number; landmark_name: string; x: number | null; y: number | null; z: number | null; coordinate_space: 'normalized_image' | 'world'; is_valid: boolean; invalid_reason?: string; visibility?: number; presence?: number; handedness?: string; representation?: 'raw' | 'display' }
export type CaptureFrame = { frame_id: number; source_frame_id?: number | null; timestamp_ms: number; video_media_time_ms: number | null; utc_time: string; inference_performed: boolean; pose_detected: boolean | null; hand_detected: boolean | null; inference_ms: number | null; skipped_frames: number; landmarks: CaptureLandmark[] }
export type CaptureStats = { frames: number; landmarks: number; uploadedBatches: number; pending: number; videoBytes: number; videoChunks: number; error: string }
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

/** A serial, bounded upload queue. A failure prevents finalization and is never silently ignored. */
export class CaptureUploader {
  private buffer: CaptureFrame[] = []
  private queue: Promise<void> = Promise.resolve()
  private failure: Error | null = null
  private batches = 0
  private chunks = 0
  private pendingBytes = 0
  private stats: CaptureStats = { frames: 0, landmarks: 0, uploadedBatches: 0, pending: 0, videoBytes: 0, videoChunks: 0, error: '' }
  constructor(private id: string, private send: Send, private report: (stats: CaptureStats) => void) {}
  private update(update: Partial<CaptureStats>) { this.stats = { ...this.stats, ...update }; this.report({ ...this.stats }) }
  private enqueue(path: string, body: unknown, blob: Blob | undefined, bytes: number, success: () => void) {
    if (this.failure) return
    this.pendingBytes += bytes
    if (this.pendingBytes > 32 * 1024 * 1024) { this.failure = new Error('Hàng đợi upload vượt 32 MB; capture không hoàn chỉnh.'); this.update({ error: this.failure.message }); return }
    this.update({ pending: this.stats.pending + 1 })
    this.queue = this.queue.then(async () => {
      if (this.failure) return
      let last: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await this.send(path, body, blob); success(); this.pendingBytes -= bytes; this.update({ pending: this.stats.pending - 1 }); return }
        catch (error) { last = error }
      }
      this.failure = last instanceof Error ? last : new Error('Upload thất bại')
      this.update({ error: this.failure.message })
    })
  }
  addFrame(frame: CaptureFrame) {
    if (this.failure) return
    this.buffer.push(frame)
    this.update({ frames: this.stats.frames + 1, landmarks: this.stats.landmarks + frame.landmarks.length })
    if (this.buffer.length >= 15) this.flush()
  }
  flush() {
    if (!this.buffer.length || this.failure) return
    const frames = this.buffer; this.buffer = []
    const batch_index = this.batches++
    const body = { batch_index, frames }
    this.enqueue(`/api/captures/${this.id}/landmark-batches`, body, undefined, JSON.stringify(body).length * 2, () => this.update({ uploadedBatches: this.stats.uploadedBatches + 1 }))
  }
  addVideoChunk(blob: Blob) {
    if (!blob.size || this.failure) return
    const index = this.chunks++
    this.update({ videoBytes: this.stats.videoBytes + blob.size, videoChunks: this.chunks })
    this.enqueue(`/api/captures/${this.id}/video-chunks/${index}`, undefined, blob, blob.size, () => {})
  }
  async drain() {
    await this.queue
    if (this.failure) throw this.failure
  }
  async finish(duration: number, beforeFinalize?: () => Promise<void>) {
    this.flush(); await this.drain()
    await beforeFinalize?.()
    const payload = { expected_batches: this.batches, expected_video_chunks: this.chunks, ended_at_utc: new Date().toISOString(), duration_ms: duration }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.send(`/api/captures/${this.id}/finalize`, payload) }
      catch (error) {
        if (error instanceof CaptureHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) throw error
      }
    }
    throw new FinalizeOutcomeUnknown()
  }
}

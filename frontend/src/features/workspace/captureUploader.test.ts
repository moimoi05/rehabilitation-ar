import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireCaptureOwnership } from './captureOwnership'
vi.mock('./captureOwnership', () => ({ acquireCaptureOwnership: vi.fn(async () => vi.fn()) }))
beforeEach(() => vi.mocked(acquireCaptureOwnership).mockReset().mockResolvedValue(vi.fn()))
import { CaptureHttpError, CaptureUploader, pendingCaptureUploads, recoverCaptureUpload } from './captureUploader'
import { MemoryCaptureQueueStore } from './captureQueueStore'

describe('CaptureUploader', () => {
  it('retains independent tracking video chunks and finalizes both video streams', async () => {
    const store = new MemoryCaptureQueueStore()
    const send = vi.fn(async (_path: string, _body?: unknown, _blob?: Blob) => ({ status: 'complete' }))
    const uploader = new CaptureUploader('both', send, () => {}, { store })
    uploader.addVideoChunk(new Blob(['source']))
    uploader.addTrackingVideoChunk(new Blob(['tracking-a']))
    uploader.addVideoChunk(new Blob(['source-b']))
    uploader.addTrackingVideoChunk(new Blob(['tracking-b']))
    await uploader.finish(10)
    expect(send.mock.calls.map(call => call[0])).toEqual(['/api/captures/both/video-chunks/0', '/api/captures/both/tracking-video-chunks/0', '/api/captures/both/video-chunks/1', '/api/captures/both/tracking-video-chunks/1', '/api/captures/both/finalize'])
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ expected_video_chunks: 2, expected_tracking_video_chunks: 2 })
  })
  it('persists a tracking failure while continuing to queue camera data', async () => {
    const store = new MemoryCaptureQueueStore()
    const send = vi.fn(async (_path: string, _body?: unknown) => ({ status: 'incomplete' }))
    const uploader = new CaptureUploader('partial', send, () => {}, { store })
    await uploader.prepare()
    uploader.noteGap('tracking failed')
    await vi.waitFor(async () => expect((await store.getState('partial'))?.knownDataGaps).toContain('tracking failed'))
    uploader.addVideoChunk(new Blob(['source']))
    await uploader.finish(10, undefined, { tracking_video_complete: false })
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ expected_video_chunks: 1, tracking_video_complete: false, known_data_gaps: ['tracking failed'] })
  })
  it('retries a failed batch and finalizes only after uploads', async () => {
    let attempts = 0
    const send = vi.fn(async (path: string, _body?: unknown) => {
      void _body
      if (path.includes('landmark-batches') && attempts++ === 0) throw new Error('offline')
      return { status: 'complete' }
    })
    const uploader = new CaptureUploader('capture', send, () => {})
    uploader.addFrame({ frame_id: 0, timestamp_ms: 12, video_media_time_ms: 1, utc_time: new Date().toISOString(), inference_performed: true, pose_detected: false, hand_detected: false, inference_ms: 4, skipped_frames: 0, landmarks: [] })
    await uploader.finish(15)
    expect(send.mock.calls.map(call => call[0])).toEqual(['/api/captures/capture/landmark-batches', '/api/captures/capture/landmark-batches', '/api/captures/capture/finalize'])
    expect(send.mock.calls[2][1]).toMatchObject({ expected_batches: 1, expected_video_chunks: 0 })
  })
  it('never finalizes when upload fails', async () => {
    const send = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; throw new Error('offline') })
    const uploader = new CaptureUploader('capture', send, () => {})
    uploader.addFrame({ frame_id: 0, timestamp_ms: 0, video_media_time_ms: 0, utc_time: new Date().toISOString(), inference_performed: true, pose_detected: false, hand_detected: false, inference_ms: 1, skipped_frames: 0, landmarks: [] })
    await expect(uploader.finish(1)).rejects.toThrow('offline')
    expect(send.mock.calls.every(call => !call[0].includes('finalize'))).toBe(true)
  })
  it('retries a lost finalize response with the same immutable payload', async () => {
    let attempts = 0
    const send = vi.fn(async (path: string, body?: unknown) => {
      void body
      if (path.endsWith('/finalize') && attempts++ === 0) throw new TypeError('network')
      return { status: 'complete' }
    })
    const uploader = new CaptureUploader('capture', send, () => {})
    expect(await uploader.finish(42)).toEqual({ status: 'complete' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][1]).toEqual(send.mock.calls[1][1])
  })
  it('reports an unknown outcome when every finalize response is lost', async () => {
    const send = vi.fn(async () => { throw new TypeError('network') })
    const uploader = new CaptureUploader('capture', send, () => {})
    await expect(uploader.finish(10)).rejects.toMatchObject({ name: 'FinalizeOutcomeUnknown' })
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('propagates a definitive client rejection without retrying', async () => {
    const send = vi.fn(async () => { throw new CaptureHttpError('incomplete', 409) })
    const uploader = new CaptureUploader('capture', send, () => {})
    await expect(uploader.finish(10)).rejects.toMatchObject({ status: 409 })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

const sampleFrame = { frame_id: 0, timestamp_ms: 0, video_media_time_ms: 0, utc_time: '2026-01-01T00:00:00Z', inference_performed: true, pose_detected: false, hand_detected: false, inference_ms: 1, skipped_frames: 0, landmarks: [] }

it('does not retry schema errors and keeps the part for explicit recovery', async () => {
  const send = vi.fn(async () => { throw new CaptureHttpError('schema rejected', 422) })
  const uploader = new CaptureUploader('schema', send, () => {})
  uploader.addFrame(sampleFrame)
  await expect(uploader.finish(10)).rejects.toThrow('schema rejected')
  expect(send).toHaveBeenCalledTimes(1)
})

it('continues accepting bounded parts after a transient upload outage', async () => {
  let offline = true
  const send = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; if (offline) throw new TypeError('offline'); return { status: 'complete' } })
  const reports: { error: string; frames: number }[] = []
  const uploader = new CaptureUploader('resume', send, state => reports.push(state), { retryDelaysMs: [0, 0] })
  uploader.addFrame(sampleFrame); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow('offline')
  uploader.addFrame({ ...sampleFrame, frame_id: 1, timestamp_ms: 1 }); uploader.flush()
  offline = false
  await uploader.resume()
  await uploader.finish(10)
  const batches = send.mock.calls.filter(call => call[0].includes('landmark-batches'))
  expect(batches.slice(-2).map(call => (call[1] as { batch_index: number }).batch_index)).toEqual([0, 1])
  expect(reports.at(-1)?.frames).toBe(2)
})

it('requires durable storage before collection and never silently falls back to RAM', async () => {
  const send = vi.fn(async () => ({}))
  const uploader = new CaptureUploader('no-idb', send, () => {}, { durable: true })
  await expect(uploader.prepare()).rejects.toThrow('IndexedDB')
  expect(send).not.toHaveBeenCalled()
})

it('retains unacknowledged parts when full, then finalizes partial data as incomplete', async () => {
  const store = new MemoryCaptureQueueStore()
  let offline = true
  const send = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; if (offline) throw new TypeError('offline'); return { status: 'incomplete' } })
  const uploader = new CaptureUploader('bounded', send, () => {}, { store, maxParts: 1, retryDelaysMs: [0, 0] })
  uploader.addFrame(sampleFrame); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow('offline')
  const retained = await store.firstPart('bounded')
  uploader.addFrame({ ...sampleFrame, frame_id: 1 }); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow('offline')
  expect(await store.firstPart('bounded')).toEqual(retained)
  offline = false
  await uploader.resume()
  expect(await uploader.finish(20)).toEqual({ status: 'incomplete' })
  const finalize = send.mock.calls.find(call => call[0].endsWith('/finalize'))
  expect(finalize?.[1]).toMatchObject({ expected_batches: 1, known_data_gaps: [expect.stringContaining('đã đầy')] })
  expect(await pendingCaptureUploads(store)).toEqual([])
})

it('recovers exact queued indices and the persisted stop declaration after refresh', async () => {
  const store = new MemoryCaptureQueueStore()
  const failed = vi.fn(async () => { throw new TypeError('offline') })
  const uploader = new CaptureUploader('restart', failed, () => {}, { store, retryDelaysMs: [0, 0] })
  uploader.addFrame(sampleFrame)
  await expect(uploader.finish(25, undefined, { game_started_at_ms: 2, game_ended_at_ms: 24, termination_reason: 'completed' })).rejects.toThrow('offline')
  const stop = (await store.getState('restart'))?.stopped
  const sent = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; return { status: 'complete' } })
  await recoverCaptureUpload('restart', sent, async () => ({ status: 'recording', lease_expires_at: new Date(Date.now() + 60000).toISOString() }), store)
  expect(sent.mock.calls.map(call => call[0])).toEqual(['/api/captures/restart/landmark-batches', '/api/captures/restart/finalize'])
  expect(sent.mock.calls[0][1]).toMatchObject({ batch_index: 0, frames: [sampleFrame] })
  expect(sent.mock.calls[1][1]).toEqual(stop)
  expect(await pendingCaptureUploads(store)).toEqual([])
})

it('never infers recording completeness from queued chunks without a stop declaration', async () => {
  const store = new MemoryCaptureQueueStore()
  const uploader = new CaptureUploader('interrupted', async () => { throw new TypeError('offline') }, () => {}, { store, retryDelaysMs: [0, 0] })
  uploader.addFrame(sampleFrame); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow('offline')
  const sent = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; return { status: 'incomplete' } })
  await recoverCaptureUpload('interrupted', sent, async () => ({ status: 'recording', lease_expires_at: new Date(Date.now() + 60000).toISOString() }), store)
  expect(sent.mock.calls.map(call => call[0])).toEqual(['/api/captures/interrupted/landmark-batches', '/api/captures/interrupted/incomplete'])
  expect(await store.getState('interrupted')).toBeDefined()
})

it('does not reopen a closed or expired capture and preserves its local parts', async () => {
  const store = new MemoryCaptureQueueStore()
  const uploader = new CaptureUploader('expired', async () => { throw new TypeError('offline') }, () => {}, { store, retryDelaysMs: [0, 0] })
  uploader.addFrame(sampleFrame); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow('offline')
  const sent = vi.fn(async () => ({}))
  await expect(recoverCaptureUpload('expired', sent, async () => ({ status: 'recording', lease_expires_at: '2020-01-01T00:00:00Z' }), store)).rejects.toThrow('hết lease')
  await expect(recoverCaptureUpload('expired', sent, async () => ({ status: 'incomplete' }), store)).rejects.toThrow('đã đóng')
  expect(sent).not.toHaveBeenCalled()
  expect(await store.firstPart('expired')).toBeDefined()
})

it('does not recover or terminate a capture owned by another live tab', async () => {
  const store = new MemoryCaptureQueueStore()
  const uploader = new CaptureUploader('live', async () => { throw new TypeError('offline') }, () => {}, { store, retryDelaysMs: [] })
  uploader.addFrame(sampleFrame); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow('offline')
  vi.mocked(acquireCaptureOwnership).mockRejectedValueOnce(new Error('Capture đang được thu hoặc khôi phục trong tab khác.'))
  const send = vi.fn(), getServerStatus = vi.fn()
  await expect(recoverCaptureUpload('live', send, getServerStatus, store)).rejects.toThrow('tab khác')
  expect(send).not.toHaveBeenCalled()
  expect(getServerStatus).not.toHaveBeenCalled()
  expect(await store.firstPart('live')).toBeDefined()
})

it('removes only the acknowledged descriptor when a finalize response was lost', async () => {
  const store = new MemoryCaptureQueueStore()
  const uploader = new CaptureUploader('done', async () => { throw new TypeError('response lost') }, () => {}, { store, retryDelaysMs: [] })
  await expect(uploader.finish(10)).rejects.toThrow()
  const send = vi.fn()
  expect(await recoverCaptureUpload('done', send, async () => ({ status: 'complete' }), store)).toEqual({ status: 'complete' })
  expect(await store.getState('done')).toBeUndefined()
  expect(send).not.toHaveBeenCalled()
})

it('retains ownership until recovery finalization is acknowledged', async () => {
  const release = vi.fn()
  vi.mocked(acquireCaptureOwnership).mockResolvedValue(release)
  const store = new MemoryCaptureQueueStore()
  const uploader = new CaptureUploader('finishing', async () => { throw new TypeError('offline') }, () => {}, { store, retryDelaysMs: [] })
  await expect(uploader.finish(10)).rejects.toThrow()
  let confirm!: (result: unknown) => void
  const send = vi.fn(() => new Promise(resolve => { confirm = resolve }))
  const recovery = recoverCaptureUpload('finishing', send, async () => ({ status: 'recording', lease_expires_at: new Date(Date.now() + 60000).toISOString() }), store)
  await vi.waitFor(() => expect(confirm).toBeTypeOf('function'))
  expect(release).not.toHaveBeenCalled()
  confirm({ status: 'complete' }); await recovery
  expect(release).toHaveBeenCalledOnce()
})

it('preserves unacknowledged parts when the server is already complete', async () => {
  const store = new MemoryCaptureQueueStore()
  const uploader = new CaptureUploader('unacknowledged', async () => { throw new TypeError('offline') }, () => {}, { store, retryDelaysMs: [] })
  uploader.addFrame(sampleFrame); uploader.flush()
  await expect(uploader.drain()).rejects.toThrow()
  const send = vi.fn()
  await expect(recoverCaptureUpload('unacknowledged', send, async () => ({ status: 'complete' }), store)).rejects.toThrow('đã đóng')
  expect(await store.firstPart('unacknowledged')).toBeDefined()
  expect(await store.getState('unacknowledged')).toBeDefined()
  expect(send).not.toHaveBeenCalled()
})

it('persists recorder-start ahead of video and retries its exact metadata', async () => {
  let attempts = 0
  const sent = vi.fn(async (_path: string, _body?: unknown, _blob?: Blob) => { void _path; void _body; void _blob; if (attempts++ === 0) throw new TypeError('offline'); return { status: 'complete' } })
  const uploader = new CaptureUploader('metadata', sent, () => {}, { retryDelaysMs: [0, 0] })
  const metadata = { start_performance_ms: 100, started_at_utc: '2026-01-01T00:00:00Z', mime_type: 'video/webm' }
  uploader.addMetadata('/api/captures/metadata/recorder-start', metadata)
  uploader.addVideoChunk(new Blob(['source'], { type: 'video/webm' }))
  await uploader.finish(30)
  expect(sent.mock.calls.map(call => call[0])).toEqual(['/api/captures/metadata/recorder-start', '/api/captures/metadata/recorder-start', '/api/captures/metadata/video-chunks/0', '/api/captures/metadata/finalize'])
  expect(sent.mock.calls[0][1]).toEqual(metadata)
  expect(sent.mock.calls[1][1]).toEqual(metadata)
})

it('bounds volatile memory and reports the lost video chunk instead of complete', async () => {
  const store = new MemoryCaptureQueueStore()
  const sent = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; return { status: 'incomplete' } })
  const uploader = new CaptureUploader('memory-limit', sent, () => {}, { store, maxVolatileBytes: 2 })
  uploader.addVideoChunk(new Blob(['too-large']))
  expect(await uploader.finish(10)).toEqual({ status: 'incomplete' })
  expect(sent.mock.calls[0][1]).toMatchObject({ expected_video_chunks: 0, known_data_gaps: [expect.stringContaining('vượt giới hạn')] })
  expect(sent.mock.calls.some(call => call[0].includes('video-chunks'))).toBe(false)
})

it('records storage failure as a known gap while allowing the caller to keep playing', async () => {
  class FailedStore extends MemoryCaptureQueueStore {
    async putPart(): Promise<void> { throw new Error('storage quota exceeded') }
  }
  const sent = vi.fn(async (_path: string, _body?: unknown) => { void _path; void _body; return { status: 'incomplete' } })
  const uploader = new CaptureUploader('quota', sent, () => {}, { store: new FailedStore() })
  expect(() => { uploader.addFrame(sampleFrame); uploader.flush() }).not.toThrow()
  expect(await uploader.finish(10)).toEqual({ status: 'incomplete' })
  expect(sent.mock.calls[0][1]).toMatchObject({ expected_batches: 0, known_data_gaps: ['storage quota exceeded'] })
})

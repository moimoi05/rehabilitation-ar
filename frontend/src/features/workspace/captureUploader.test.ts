import { describe, expect, it, vi } from 'vitest'
import { CaptureHttpError, CaptureUploader } from './captureUploader'

describe('CaptureUploader', () => {
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

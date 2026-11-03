import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import TrackingBenchmarkPage from './TrackingBenchmarkPage'

const mock = vi.hoisted(() => ({ request: vi.fn(), run: vi.fn() }))
vi.mock('./benchmarkArtifacts', () => ({ benchmarkRequest: mock.request }))
vi.mock('./benchmarkRunner', async importOriginal => ({ ...await importOriginal<typeof import('./benchmarkRunner')>(), runBenchmark: mock.run }))
vi.mock('./TrackingRecordingComparison', () => ({ default: () => null, COMPARISON_RUNS_KEY: 'comparison' }))

beforeEach(() => {
  vi.clearAllMocks()
  mock.request.mockResolvedValue({ source_path: 'test.mp4', width: 1280, height: 720, duration: 1, fps: 30 })
  mock.run.mockResolvedValue({ run_id: 'test', status: 'COMPLETE', directory: 'test', errors: [], summary: { requested_fps: { hand: 30, pose: 15 }, actual_fps: { hand: 22, pose: 11 }, actual_delegates: { hand: 'GPU', pose: 'CPU' } } })
})

it('can run the 720p latency configuration alone and shows requested versus achieved FPS', async () => {
  render(<TrackingBenchmarkPage />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Bắt đầu benchmark' })).toBeEnabled())
  fireEvent.change(screen.getByRole('combobox', { name: 'Cấu hình benchmark' }), { target: { value: 'latency-3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu benchmark' }))
  await waitFor(() => expect(mock.run).toHaveBeenCalledOnce())
  expect(mock.run.mock.calls[0][0]).toMatchObject({ handFirst: true, handFps: 30, poseFps: 15, inferenceResolution: { width: 1280, height: 720 } })
  expect(await screen.findByText(/Hand 22.0\/30 FPS \(GPU\)/)).toBeVisible()
})

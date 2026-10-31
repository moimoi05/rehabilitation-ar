import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useData } from './useData'

afterEach(cleanup)

it('ignores the previous patient response after the requested patient changes', async () => {
  let finishOld!: (value: string) => void
  const oldLoad = vi.fn(() => new Promise<string>(resolve => { finishOld = resolve }))
  const newLoad = vi.fn().mockResolvedValue('patient B')
  const view = renderHook(({ load }) => useData(load), { initialProps: { load: oldLoad as () => Promise<string> } })
  view.rerender({ load: newLoad })
  await waitFor(() => expect(view.result.current.data).toBe('patient B'))
  await act(async () => finishOld('patient A'))
  expect(view.result.current.data).toBe('patient B')
  expect(view.result.current.error).toBe('')
})

it('ignores stale errors and keeps the current loading state during a newer request', async () => {
  let rejectOld!: (error: Error) => void, finishNew!: (value: string) => void
  const oldLoad = () => new Promise<string>((_resolve, reject) => { rejectOld = reject })
  const newLoad = () => new Promise<string>(resolve => { finishNew = resolve })
  const view = renderHook(({ load }) => useData(load), { initialProps: { load: oldLoad } })
  view.rerender({ load: newLoad })
  await act(async () => rejectOld(new Error('old patient failed')))
  expect(view.result.current.loading).toBe(true)
  expect(view.result.current.error).toBe('')
  await act(async () => finishNew('patient B'))
  expect(view.result.current.data).toBe('patient B')
})

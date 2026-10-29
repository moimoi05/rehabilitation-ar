import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVideoMapping } from './useVideoMapping'

afterEach(() => { vi.unstubAllGlobals() })

describe('cached video mapping', () => {
  it('refreshes for metadata, resize, fullscreen and source removal, then disconnects observers', () => {
    let resize: ResizeObserverCallback = () => {}
    const disconnect = vi.fn(), observe = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback } observe = observe; disconnect = disconnect })
    const video = document.createElement('video')
    document.body.append(video)
    video.style.objectFit = 'contain'
    Object.defineProperty(video, 'videoWidth', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(video, 'videoHeight', { configurable: true, writable: true, value: 0 })
    let box = { width: 1000, height: 1000 }
    video.getBoundingClientRect = () => ({ ...box } as DOMRect)
    const { result, unmount } = renderHook(() => useVideoMapping({ current: video }))
    expect(result.current[0].current).toBeNull()
    expect(result.current[1].current).toEqual({ width: 1000, height: 1000 })
    Object.defineProperty(video, 'videoWidth', { value: 1600 })
    Object.defineProperty(video, 'videoHeight', { value: 900 })
    act(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(result.current[0].current?.rect.y).toBe(218.75)
    box = { width: 1600, height: 900 }
    act(() => resize([], {} as ResizeObserver))
    expect(result.current[0].current?.rect).toEqual({ x: 0, y: 0, width: 1600, height: 900 })
    expect(result.current[1].current).toEqual({ width: 1600, height: 900 })
    box = { width: 1000, height: 1000 }; video.style.objectFit = 'cover'
    act(() => document.dispatchEvent(new Event('fullscreenchange')))
    expect(result.current[0].current?.rect.x).toBeCloseTo(-388.888889)
    Object.defineProperty(video, 'videoWidth', { value: 0 })
    act(() => video.dispatchEvent(new Event('emptied')))
    expect(result.current[0].current).toBeNull()
    unmount(); video.remove(); expect(disconnect).toHaveBeenCalledOnce()
  })
})

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { videoContentRect } from './videoGeometry'
import type { Size, VideoFit, VideoMapping } from './videoGeometry'

/** Cache layout outside the animation loops; all overlays read the same mapping. */
export function useVideoMapping(videoRef: RefObject<HTMLVideoElement | null>): [RefObject<VideoMapping | null>, RefObject<Size | null>] {
  const mapping = useRef<VideoMapping | null>(null)
  const displayBox = useRef<Size | null>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const refresh = () => {
      const bounds = video.getBoundingClientRect()
      const box = { width: bounds.width, height: bounds.height }
      displayBox.current = box.width > 0 && box.height > 0 ? box : null
      const cssFit = getComputedStyle(video).objectFit
      const fit: VideoFit = cssFit === 'contain' || cssFit === 'cover' ? cssFit : 'fill'
      const rect = videoContentRect({ width: video.videoWidth, height: video.videoHeight }, box, fit)
      mapping.current = rect ? { box, rect } : null
    }
    const clear = () => { mapping.current = null }
    video.addEventListener('loadedmetadata', refresh)
    video.addEventListener('resize', refresh)
    video.addEventListener('emptied', clear)
    window.addEventListener('resize', refresh)
    document.addEventListener('fullscreenchange', refresh)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh)
    observer?.observe(video)
    const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refresh)
    mutation?.observe(video, { attributes: true, attributeFilter: ['class', 'style'] })
    if (video.parentElement) mutation?.observe(video.parentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    refresh()
    return () => {
      observer?.disconnect(); mutation?.disconnect()
      video.removeEventListener('loadedmetadata', refresh); video.removeEventListener('resize', refresh); video.removeEventListener('emptied', clear)
      window.removeEventListener('resize', refresh); document.removeEventListener('fullscreenchange', refresh)
      mapping.current = null
      displayBox.current = null
    }
  }, [videoRef])
  return [mapping, displayBox]
}

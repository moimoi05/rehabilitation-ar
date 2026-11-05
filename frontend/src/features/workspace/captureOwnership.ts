/** One owner per capture across same-origin tabs. The browser releases it on exit. */
export function acquireCaptureOwnership(captureId: string): Promise<() => void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks?.request) return Promise.reject(new Error('Trình duyệt không hỗ trợ Web Locks để bảo vệ dữ liệu giữa các tab.'))
  return new Promise((resolve, reject) => {
    void locks.request(`rehab-research-capture:${captureId}`, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) { reject(new Error('Capture đang được thu hoặc khôi phục trong tab khác.')); return }
      return new Promise<void>(unlock => {
        let released = false
        resolve(() => { if (!released) { released = true; unlock() } })
      })
    }).catch(reject)
  })
}

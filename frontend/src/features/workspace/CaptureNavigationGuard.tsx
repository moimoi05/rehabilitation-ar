import { useContext, useEffect } from 'react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom'

/** The production app uses a data router, which blocks both link and history navigation. */
export function CaptureNavigationGuard({ shouldBlock }: { shouldBlock: () => boolean }) {
  const router = useContext(UNSAFE_DataRouterContext)
  return router ? <DataRouterGuard shouldBlock={shouldBlock} /> : null
}

function DataRouterGuard({ shouldBlock }: { shouldBlock: () => boolean }) {
  const blocker = useBlocker(() => shouldBlock())
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm('Đang thu hoặc lưu dữ liệu. Rời trang sẽ gián đoạn capture và dữ liệu chưa gửi có thể mất. Bạn có muốn rời trang?')) blocker.proceed()
    else blocker.reset()
  }, [blocker])
  return null
}

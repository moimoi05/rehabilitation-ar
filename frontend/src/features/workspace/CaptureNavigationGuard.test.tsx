import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureNavigationGuard } from './CaptureNavigationGuard'

describe('capture navigation guard', () => {
  beforeEach(() => {
    // Node's Request rejects jsdom's AbortSignal; these routes have no loaders.
    const NodeRequest = globalThis.Request
    class TestRequest extends NodeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }) }
    }
    vi.stubGlobal('Request', TestRequest)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('blocks links and history navigation until the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    let active = true
    const router = createMemoryRouter([
      { path: '/', element: <p>Trang trước</p> },
      { path: '/capture', element: <><CaptureNavigationGuard shouldBlock={() => active} /><p>Đang thu</p><Link to="/next">Tiếp</Link></> },
      { path: '/next', element: <p>Trang tiếp</p> },
    ], { initialEntries: ['/', '/capture'], initialIndex: 1 })
    render(<RouterProvider router={router} />)
    fireEvent.click(screen.getByText('Tiếp'))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Đang thu')).toBeInTheDocument()
    await router.navigate(-1)
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Đang thu')).toBeInTheDocument()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByText('Tiếp'))
    expect(await screen.findByText('Trang tiếp')).toBeInTheDocument()
    active = false
  })
  it('allows navigation without prompting when capture is inactive', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const router = createMemoryRouter([
      { path: '/', element: <><CaptureNavigationGuard shouldBlock={() => false} /><Link to="/next">Tiếp</Link></> },
      { path: '/next', element: <p>Trang tiếp</p> },
    ])
    render(<RouterProvider router={router} />)
    fireEvent.click(screen.getByText('Tiếp'))
    expect(await screen.findByText('Trang tiếp')).toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
  })
})

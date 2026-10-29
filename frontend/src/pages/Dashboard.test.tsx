import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'
afterEach(()=>vi.unstubAllGlobals())
it('tính thống kê từ phiên và hồ sơ trả về',async()=>{
 const patients=[{id:1,research_code:'NC-001'}]
 const sessions=[{id:2,patient_id:1,session_type:'assessment',status:'completed',created_at:'2026-01-01T00:00:00Z'}]
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async (url:string)=>({ok:true,json:async()=>url.endsWith('/patients')?patients:sessions})))
 render(<MemoryRouter><Dashboard/></MemoryRouter>)
 expect(await screen.findByText('Đánh giá · NC-001')).toBeInTheDocument()
 expect(screen.getAllByText('1')).toHaveLength(3)
})
it('cho phép tải lại khi backend mất kết nối',async()=>{
 const fetchMock=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ok:true,json:async()=>[]});vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><Dashboard/></MemoryRouter>)
 await userEvent.click(await screen.findByRole('button',{name:'Thử lại'}))
 expect(await screen.findByText('Chưa có phiên nào. Tạo phiên đầu tiên để bắt đầu.')).toBeInTheDocument()
})

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'
afterEach(()=>vi.unstubAllGlobals())
it('hiển thị bốn thống kê và hoạt động thật do API tổng hợp',async()=>{
 const summary={outpatients:12,inpatients:8,assessments:21,training_sessions:34,recent_activity:[{patient:{id:1,research_code:'NC-001'},session:{id:2,patient_id:1,session_type:'assessment',status:'completed',created_at:'2026-01-01T00:00:00Z'}}]}
 const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>summary});vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><Dashboard/></MemoryRouter>)
 expect(await screen.findByText('Đánh giá · NC-001')).toBeInTheDocument()
 for (const value of ['12','8','21','34']) expect(screen.getByText(value,{exact:true})).toBeInTheDocument()
 expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/dashboard'),expect.anything())
 expect(screen.getByRole('link',{name:/Bắt đầu đánh giá/})).toHaveAttribute('href','/assessment')
})
it('cho phép tải lại khi backend mất kết nối',async()=>{
 const fetchMock=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ok:true,json:async()=>({outpatients:0,inpatients:0,assessments:0,training_sessions:0,recent_activity:[]})});vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><Dashboard/></MemoryRouter>)
 await userEvent.click(await screen.findByRole('button',{name:'Thử lại'}))
 expect(await screen.findByText('Chưa có phiên nào. Tạo phiên đầu tiên để bắt đầu.')).toBeInTheDocument()
})

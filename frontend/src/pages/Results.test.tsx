import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import Results from './Results'
afterEach(()=>vi.unstubAllGlobals())
it('mở chi tiết hiệu chuẩn của phiên từ danh sách kết quả',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async (url:string)=>({ok:true,json:async()=>url.includes('/calibrations')?[]:url.endsWith('/patients')?[{id:1,research_code:'NC-001'}]:[{id:2,patient_id:1,session_type:'assessment',status:'completed'}]})))
 render(<MemoryRouter><Results/></MemoryRouter>)
 await userEvent.click(await screen.findByRole('button',{name:'Xem hiệu chuẩn'}))
 expect(await screen.findByText('Chưa có cấu hình hiệu chuẩn được lưu cho phiên này.')).toBeInTheDocument()
 expect(screen.getByText(/Đánh giá AI: Chưa triển khai/)).toBeInTheDocument()
 await userEvent.click(screen.getByRole('button',{name:'Đóng'}))
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('thử tải lại danh sách sau lỗi backend',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ok:true,json:async()=>[]}))
 render(<MemoryRouter><Results/></MemoryRouter>)
 await userEvent.click(await screen.findByRole('button',{name:'Thử lại'}))
 expect(await screen.findByText('Chưa có kết quả phiên.')).toBeInTheDocument()
})
it('xem kết quả trò chơi theo phiên và phân biệt điểm với FMA-UE',async()=>{
 const fetchMock=vi.fn().mockImplementation(async (url:string)=>({ok:true,json:async()=>url.includes('/exercise-results')?[{id:10,trial_id:1,session_id:2,game_key:'glowing_flower',affected_side:'right',duration_seconds:30,score:4,target_count:8,source:'camera',created_at:'2026-10-28T00:00:00Z'}]:url.endsWith('/patients')?[{id:1,research_code:'NC-001'}]:[{id:2,patient_id:1,session_type:'training',status:'in_progress'}]}))
 vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><Results/></MemoryRouter>)
 await userEvent.click(await screen.findByRole('button',{name:'Xem trò chơi'}))
 expect(await screen.findByText('4 / 8')).toBeInTheDocument()
 expect(screen.getByText('30 giây')).toBeInTheDocument()
 expect(screen.getByText('Phải')).toBeInTheDocument()
 expect(screen.getByText(/Điểm trò chơi không phải điểm FMA-UE/)).toBeInTheDocument()
 expect(fetchMock.mock.calls.some(call=>String(call[0]).includes('/api/exercise-results?session_id=2'))).toBe(true)
})
it('hiển thị trạng thái trống và có thể thử lại khi tải kết quả trò chơi thất bại',async()=>{
 let shouldFail=true
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async (url:string)=>{
  if(url.includes('/exercise-results')) { if(shouldFail) { shouldFail=false; throw new Error('offline') } return {ok:true,json:async()=>[]} }
  return {ok:true,json:async()=>url.endsWith('/patients')?[{id:1,research_code:'NC-001'}]:[{id:2,patient_id:1,session_type:'training',status:'in_progress'}]}
 }))
 render(<MemoryRouter><Results/></MemoryRouter>)
 await userEvent.click(await screen.findByRole('button',{name:'Xem trò chơi'}))
 expect(await screen.findByText(/Không kết nối được backend/)).toBeInTheDocument()
 await userEvent.click(screen.getByRole('button',{name:'Thử lại'}))
 expect(await screen.findByText('Chưa có kết quả trò chơi cho phiên này.')).toBeInTheDocument()
})

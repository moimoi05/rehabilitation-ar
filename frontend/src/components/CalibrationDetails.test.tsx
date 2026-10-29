import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import CalibrationDetails from './CalibrationDetails'
afterEach(()=>vi.unstubAllGlobals())
it('hiển thị trạng thái xác nhận và thông số hiệu chuẩn đã lưu',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>[{id:1,session_id:4,camera_label:'Webcam',width:1280,height:720,mirrored:true,ghost_visible:true,opacity:.5,x:.5,y:.6,scale:1,affected_side:'right',confirmed:true,created_at:'2026-01-01T00:00:00Z'}]}))
  render(<CalibrationDetails sessionId={4} close={()=>{}}/>)
  expect(await screen.findByText('Đã xác nhận')).toBeInTheDocument()
  expect(screen.getByText('Webcam')).toBeInTheDocument()
  expect(screen.getByText('1280 × 720')).toBeInTheDocument()
  expect(screen.getByText(/cần kiểm tra và xác nhận tư thế một lần nữa/)).toBeInTheDocument()
})
it('có thể tải lại khi lấy hiệu chuẩn thất bại',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ok:true,json:async()=>[]}))
 render(<CalibrationDetails sessionId={4} close={()=>{}}/>)
 await userEvent.click(await screen.findByRole('button',{name:'Thử lại'}))
 expect(await screen.findByText('Chưa có cấu hình hiệu chuẩn được lưu cho phiên này.')).toBeInTheDocument()
})

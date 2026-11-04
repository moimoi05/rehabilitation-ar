import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import ReportsPage from './ReportsPage'

afterEach(()=>vi.unstubAllGlobals())
const report={session:{id:7,patient_id:1,session_type:'assessment',affected_side:'left',status:'completed',created_at:'2026-10-01T00:00:00Z'},patient:{id:1,research_code:'BN-001',full_name:'Người bệnh giả lập',affected_side:'right',dominant_hand:'right'},questionnaires:[{id:3,completed:true,template_snapshot:{name:'Tiếp nhận',version:1,questions:[{id:1,key:'history',label:'Tiền sử',question_type:'text'}]},answers:[{question_key:'history',value:'Nội dung lịch sử đã lưu'}]}],clinical_assessments:[{id:4,fma_ue_score:25,clinician_name:'Nhân viên chuyên môn',clinician_confirmed:true}],trials:[],results:[],duration_seconds:12,trial_count:2,is_baseline:true,selected_exercise_ids:[1]}

it('giữ báo cáo baseline, nội dung câu hỏi cũ và điểm chuyên môn đã xác nhận',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('/exercises')?[]:[report]})))
 render(<MemoryRouter><ReportsPage/></MemoryRouter>)
 expect(await screen.findByText('BN-001')).toBeInTheDocument()
 expect(screen.getByText('Baseline đầu vào')).toBeInTheDocument()
 expect(screen.getByText(/Tay bị ảnh hưởng: Trái/)).toBeInTheDocument()
 fireEvent.click(screen.getByText('Câu hỏi và câu trả lời đã lưu'))
 expect(screen.getByText('Nội dung lịch sử đã lưu')).toBeInTheDocument()
 expect(screen.getByText('25 / 66')).toBeInTheDocument()
 expect(screen.getByText(/Nhân viên chuyên môn/)).toBeInTheDocument()
})

it('gửi bộ lọc bệnh nhân, thời gian, game và buổi tập đến API',async()=>{
 const fetchMock=vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('/exercises')?[{id:2,name:'Bài tập chỉ định'}]:[]}));vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><ReportsPage/></MemoryRouter>)
 await screen.findByText(/Chưa có báo cáo phù hợp/)
 fireEvent.click(screen.getByRole('tab',{name:'Báo cáo luyện tập'}))
 fireEvent.change(screen.getByLabelText('Mã bệnh nhân'),{target:{value:'BN-001'}})
 fireEvent.change(screen.getByLabelText('Từ ngày'),{target:{value:'2026-10-01'}})
 fireEvent.change(screen.getByLabelText('Đến ngày'),{target:{value:'2026-10-31'}})
 fireEvent.change(screen.getByLabelText('Bài tập'),{target:{value:'2'}})
 fireEvent.change(screen.getByLabelText('Mã buổi / lần đánh giá'),{target:{value:'7'}})
 fireEvent.click(screen.getByRole('button',{name:'Áp dụng bộ lọc'}))
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/reports\/training\?research_code=BN-001&from_date=2026-10-01&to_date=2026-10-31&exercise_id=2&session_id=7/),expect.anything()))
 expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('áp dụng mã bệnh nhân ngay khi mở báo cáo bằng liên kết trực tiếp',async()=>{
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>[]}));vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter initialEntries={['/reports?research_code=BN-001']}><ReportsPage/></MemoryRouter>)
 await screen.findByText(/Chưa có báo cáo phù hợp/)
 expect(screen.getByLabelText('Mã bệnh nhân')).toHaveValue('BN-001')
 expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/reports\/assessments\?research_code=BN-001$/),expect.anything())
})

it('hiển thị hoạt động vẽ đã lưu mà không biến số nét thành điểm', async () => {
 const drawingReport = { ...report, session: { ...report.session, session_type: 'training' }, trials: [{ id: 8, exercise_id: 2, exercise_code: 'free_drawing', status: 'completed', results: [{ id: 9, result_json: JSON.stringify({ game_key: 'free_drawing', duration_seconds: 12.5, completed_strokes: 4, active_drawing_seconds: 8 }) }] }] }
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('/exercises')?[]:[drawingReport]})))
 render(<MemoryRouter initialEntries={['/reports?kind=training']}><ReportsPage/></MemoryRouter>)
 expect(await screen.findByText('4 nét · 8.0 giây đang vẽ')).toBeInTheDocument()
 expect(screen.queryByText(/Điểm: 4/)).not.toBeInTheDocument()
})

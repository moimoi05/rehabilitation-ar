import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Sessions from './Sessions'
const patient = { id: 1, research_code: 'NC-001', affected_side: 'right', dominant_hand: 'left', notes: null, created_at: '2026-01-01T00:00:00Z' }
const session = { id: 4, patient_id: 1, affected_side: 'right', session_type: 'assessment', status: 'draft', started_at: null, ended_at: null, notes: null, created_at: '2026-01-01T00:00:00Z' }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('Phiên nghiên cứu', () => {
  it('dùng tay ảnh hưởng khi bệnh nhân được chọn từ trang chi tiết', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({ok: true, json: async () => url.endsWith('/patients') ? [patient] : []})))
    render(<MemoryRouter initialEntries={['/sessions?patient=1']}><Sessions/></MemoryRouter>)
    await screen.findByText('Danh sách phiên')
    await screen.findByText('Chưa có phiên nào. Hãy tạo phiên cho bệnh nhân.')
    await userEvent.click(screen.getByRole('button',{name:'Tạo phiên mới'}))
    expect(screen.getByLabelText('Tay cần tập')).toHaveValue('right')
  })
  it('chỉ gửi trạng thái hợp lệ để backend đặt thời gian phiên', async () => {
    const fetchMock=vi.fn().mockImplementation(async (url:string, init?:RequestInit) => ({ok:true,json:async()=>init?.method === 'PATCH' ? {...session,status:'in_progress'} : url.endsWith('/patients') ? [patient] : [session]}))
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><Sessions/></MemoryRouter>)
    const status=await screen.findByLabelText('Trạng thái phiên 4')
    expect(screen.queryByRole('option',{name:'Hoàn thành'})).not.toBeInTheDocument()
    await userEvent.selectOptions(status,'in_progress')
    const patch=fetchMock.mock.calls.find(([, init])=>init?.method==='PATCH')
    expect(JSON.parse(patch![1].body)).toEqual({status:'in_progress'})
  })
  it('tạo phiên với bệnh nhân, loại phiên và tay đã chọn',async()=>{
    const fetchMock=vi.fn().mockImplementation(async (url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='POST'?session:url.endsWith('/patients')?[patient]:[]}))
    vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Sessions/></MemoryRouter>)
    await screen.findByText('Chưa có phiên nào. Hãy tạo phiên cho bệnh nhân.')
    await userEvent.click(screen.getByRole('button',{name:'Tạo phiên mới'}))
    await userEvent.selectOptions(screen.getByLabelText('Bệnh nhân'),'1')
    await userEvent.selectOptions(screen.getByLabelText('Loại phiên'),'training')
    await userEvent.click(screen.getByRole('button',{name:'Tạo phiên'}))
    const post=fetchMock.mock.calls.find(([,init])=>init?.method==='POST')
    expect(JSON.parse(post![1].body)).toMatchObject({patient_id:1,affected_side:'right',session_type:'training'})
  })
  it('khóa trạng thái phiên hoàn thành',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async (url:string)=>({ok:true,json:async()=>url.endsWith('/patients')?[patient]:[{...session,status:'completed'}]})))
    render(<MemoryRouter><Sessions/></MemoryRouter>)
    expect(await screen.findByLabelText('Trạng thái phiên 4')).toBeDisabled()
  })
  it('cho phép chọn tay khác, ghi chú và hủy phiên mới',async()=>{
    const fetchMock=vi.fn().mockImplementation(async (url:string)=>({ok:true,json:async()=>url.endsWith('/patients')?[patient]:[]}));vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Sessions/></MemoryRouter>)
    await screen.findByText('Chưa có phiên nào. Hãy tạo phiên cho bệnh nhân.')
    await userEvent.click(screen.getByRole('button',{name:'Tạo phiên mới'}))
    await userEvent.selectOptions(screen.getByLabelText('Bệnh nhân'),'1')
    await userEvent.selectOptions(screen.getByLabelText('Tay cần tập'),'left')
    await userEvent.type(screen.getByLabelText('Ghi chú'),'Luyện tập thử')
    await userEvent.click(screen.getByRole('button',{name:'Hủy'}))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('báo lỗi khi máy chủ từ chối chuyển trạng thái phiên',async()=>{
    const fetchMock=vi.fn().mockImplementation(async (url:string,init?:RequestInit)=>init?.method==='PATCH'?{ok:false,status:409,json:async()=>({detail:'Không thể chuyển trạng thái phiên.'})}:{ok:true,json:async()=>url.endsWith('/patients')?[patient]:[session]});vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Sessions/></MemoryRouter>)
    await userEvent.selectOptions(await screen.findByLabelText('Trạng thái phiên 4'),'in_progress')
    expect(await screen.findByText('Không thể chuyển trạng thái phiên.')).toBeInTheDocument()
  })
})

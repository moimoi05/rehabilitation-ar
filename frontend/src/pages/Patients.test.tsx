import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Patients from './Patients'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('Quản lý bệnh nhân', () => {
  it('tạo hồ sơ giả danh và tải lại danh sách', async () => {
    const patients = [{ id: 1, research_code: 'NC-001', affected_side: 'left', dominant_hand: 'right', notes: null, created_at: '2026-01-01T00:00:00Z' }]
    const fetchMock = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>[]}).mockResolvedValueOnce({ok:true,json:async()=>patients[0]}).mockResolvedValueOnce({ok:true,json:async()=>patients})
    vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Patients/></MemoryRouter>)
    await screen.findByText(/Chưa có bệnh nhân/)
    await userEvent.click(screen.getByRole('button',{name:'Thêm bệnh nhân'}))
    await userEvent.type(screen.getByLabelText('Mã nghiên cứu'),'NC-001')
    await userEvent.click(screen.getByRole('button',{name:'Lưu hồ sơ'}))
    expect(await screen.findByRole('link',{name:'NC-001'})).toBeInTheDocument()
    expect(fetchMock.mock.calls[1][1].method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({research_code:'NC-001',affected_side:'left',dominant_hand:'right'})
  })
  it('hiển thị lỗi kết nối và cho phép thử lại', async()=>{
    const fetchMock=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ok:true,json:async()=>[]})
    vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Patients/></MemoryRouter>)
    expect(await screen.findByText(/Không kết nối được backend/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button',{name:'Thử lại'}))
    await waitFor(()=>expect(screen.getByText(/Chưa có bệnh nhân/)).toBeInTheDocument())
  })
  it('sửa hồ sơ và gửi thay đổi đến API', async()=>{
    const p={id:1,research_code:'NC-001',affected_side:'left',dominant_hand:'right',notes:null,created_at:'2026-01-01T00:00:00Z'}
    const fetchMock=vi.fn().mockImplementation(async (_url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='PATCH'?{...p,affected_side:'right'}:[p]}))
    vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Patients/></MemoryRouter>)
    await userEvent.click(await screen.findByRole('button',{name:'Sửa'}))
    await userEvent.selectOptions(screen.getByLabelText('Tay ảnh hưởng'),'right')
    await userEvent.click(screen.getByRole('button',{name:'Lưu hồ sơ'}))
    await waitFor(()=>expect(fetchMock.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true))
    const patch=fetchMock.mock.calls.find(([,init])=>init?.method==='PATCH')
    expect(JSON.parse(patch![1].body).affected_side).toBe('right')
  })
  it('giữ form mở và giải thích lỗi trùng mã',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>[]}).mockResolvedValueOnce({ok:false,status:409,json:async()=>({detail:'Mã đã tồn tại'})}))
    render(<MemoryRouter><Patients/></MemoryRouter>)
    await screen.findByText(/Chưa có bệnh nhân/)
    await userEvent.click(screen.getByRole('button',{name:'Thêm bệnh nhân'}))
    await userEvent.type(screen.getByLabelText('Mã nghiên cứu'),'NC-001')
    await userEvent.click(screen.getByRole('button',{name:'Lưu hồ sơ'}))
    expect(await screen.findByText('Mã đã tồn tại')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
  it('lọc hồ sơ theo mã và trở về danh sách đầy đủ',async()=>{
    const patients=[{id:1,research_code:'NC-001',affected_side:'left',dominant_hand:'right',notes:null,created_at:'2026-01-01T00:00:00Z'},{id:2,research_code:'NC-002',affected_side:'right',dominant_hand:'left',notes:null,created_at:'2026-01-01T00:00:00Z'}]
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>patients}))
    render(<MemoryRouter><Patients/></MemoryRouter>)
    await screen.findByRole('link',{name:'NC-001'})
    await userEvent.type(screen.getByLabelText('Tìm mã nghiên cứu'),'002')
    expect(screen.queryByRole('link',{name:'NC-001'})).not.toBeInTheDocument()
    expect(screen.getByRole('link',{name:'NC-002'})).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Tìm mã nghiên cứu'))
    expect(screen.getByRole('link',{name:'NC-001'})).toBeInTheDocument()
  })
  it('cho phép nhập tay thuận và ghi chú rồi hủy mà không lưu',async()=>{
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>[]});vi.stubGlobal('fetch',fetchMock)
    render(<MemoryRouter><Patients/></MemoryRouter>)
    await screen.findByText(/Chưa có bệnh nhân/)
    await userEvent.click(screen.getByRole('button',{name:'Thêm bệnh nhân'}))
    await userEvent.selectOptions(screen.getByLabelText('Tay thuận'),'left')
    await userEvent.type(screen.getByLabelText('Ghi chú nghiên cứu'),'Dữ liệu giả lập')
    await userEvent.click(screen.getByRole('button',{name:'Hủy'}))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

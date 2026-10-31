import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PatientsAdmin from './PatientsAdmin'

const outpatient={id:1,research_code:'BN-001',full_name:'Người khám giả lập',patient_type:'outpatient',affected_side:'left',dominant_hand:'right',notes:null,created_at:'2026-10-01T00:00:00Z'}
const inpatient={...outpatient,id:2,research_code:'BN-002',full_name:'Người điều trị giả lập',patient_type:'inpatient'}
afterEach(()=>vi.unstubAllGlobals())

it('tách hai nhóm và tìm hồ sơ qua API có bộ lọc',async()=>{
 const fetchMock=vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('patient_type=inpatient')?[inpatient]:[outpatient]}));vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><PatientsAdmin/></MemoryRouter>)
 expect(await screen.findByRole('link',{name:'BN-001'})).toHaveAttribute('href','/admin/patients/1')
 expect(screen.queryByText('BN-002')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('tab',{name:'Bệnh nhân điều trị'}))
 expect(await screen.findByRole('link',{name:'BN-002'})).toBeInTheDocument()
 expect(screen.queryByText('BN-001')).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('Tìm mã hoặc họ tên'),{target:{value:'BN-002'}})
 fireEvent.click(screen.getByRole('button',{name:'Tìm kiếm'}))
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/patient_type=inpatient.*search=BN-002/),expect.anything()))
 expect(screen.queryByRole('button',{name:'Chuyển sang điều trị'})).not.toBeInTheDocument()
})

it('không mở bản sao hồ sơ khi chỉnh sửa bệnh nhân',async()=>{
 const fetchMock=vi.fn(async(_url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='PATCH'?{...outpatient,full_name:'Tên đã sửa'}:[outpatient]}));vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><PatientsAdmin/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Sửa'}))
 fireEvent.change(screen.getByLabelText('Họ tên'),{target:{value:'Tên đã sửa'}})
 fireEvent.click(screen.getByRole('button',{name:'Lưu hồ sơ'}))
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/patients/1'),expect.objectContaining({method:'PATCH'})))
 expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
})

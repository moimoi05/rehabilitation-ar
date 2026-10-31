import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TransferDialog from './TransferDialog'

const patient={id:1,research_code:'NC-001',patient_type:'outpatient' as const,affected_side:'left' as const,dominant_hand:'right' as const,full_name:'Người bệnh giả lập',date_of_birth:null,sex:'unspecified' as const,contact:null,admitted_at:null,notes:null,created_at:''}
afterEach(()=>vi.unstubAllGlobals())

it('chuyển nhóm bằng API chung và giữ liên kết lần đánh giá đầu vào đã chọn',async()=>{
 const transferred=vi.fn()
 const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='POST'?{patient:{...patient,patient_type:'inpatient'},transfer:{id:4}}:url.includes('workflow-config')?{allow_transfer_without_baseline:false}:[{id:7,status:'completed',session_type:'assessment',patient_id:1,created_at:'2026-10-01T00:00:00Z'}]}))
 vi.stubGlobal('fetch',fetchMock)
 render(<TransferDialog patient={patient} baselineSessionId={7} onClose={vi.fn()} onTransferred={transferred}/> )
 await screen.findByRole('option',{name:/#7/})
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận chuyển nhóm'}))
 await waitFor(()=>expect(transferred).toHaveBeenCalledWith(expect.objectContaining({id:1,patient_type:'inpatient'})))
 const call=fetchMock.mock.calls.find(([url,init])=>url.endsWith('/api/patients/1/transfer')&&init?.method==='POST')
 expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({to_type:'inpatient',baseline_assessment_session_id:7})
})

it('không cho chuyển thiếu đánh giá khi quy trình không cho phép ngoại lệ',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('workflow-config')?{allow_transfer_without_baseline:false}:[]})))
 render(<TransferDialog patient={patient} onClose={vi.fn()} onTransferred={vi.fn()}/> )
 await screen.findByText(/Chưa có đánh giá hoàn thành/)
 expect(screen.getByRole('button',{name:'Xác nhận chuyển nhóm'})).toBeDisabled()
})

it('yêu cầu lý do ngoại lệ rõ ràng trước khi chuyển thiếu baseline',async()=>{
 const transferred=vi.fn()
 const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='POST'?{patient:{...patient,patient_type:'inpatient'}}:url.includes('workflow-config')?{allow_transfer_without_baseline:true}:[]}))
 vi.stubGlobal('fetch',fetchMock)
 render(<TransferDialog patient={patient} onClose={vi.fn()} onTransferred={transferred}/> )
 await screen.findByText(/Chưa có đánh giá hoàn thành/)
 const submit=screen.getByRole('button',{name:'Xác nhận chuyển nhóm'})
 expect(submit).toBeDisabled()
 fireEvent.change(screen.getByLabelText('Lý do chuyển nhóm'),{target:{value:'Theo chỉ định chuyên môn, cần tiếp nhận trước đánh giá.'}})
 fireEvent.click(screen.getByLabelText(/Xác nhận ngoại lệ/))
 expect(submit).toBeEnabled()
 fireEvent.click(submit)
 await waitFor(()=>expect(transferred).toHaveBeenCalled())
 const call=fetchMock.mock.calls.find(([url,init])=>url.endsWith('/transfer')&&init?.method==='POST')
 expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({allow_without_baseline:true,reason:'Theo chỉ định chuyên môn, cần tiếp nhận trước đánh giá.'})
})

it('giữ hộp thoại và báo rõ nếu bệnh nhân đã chuyển nhóm từ nơi khác',async()=>{
 const transferred=vi.fn()
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>({ok:init?.method!=='POST',status:init?.method==='POST'?409:200,json:async()=>init?.method==='POST'?{detail:'Bệnh nhân đã thuộc nhóm điều trị.'}:url.includes('workflow-config')?{allow_transfer_without_baseline:false}:[{id:7,status:'completed',created_at:'2026-10-01T00:00:00Z'}]})))
 render(<TransferDialog patient={patient} baselineSessionId={7} onClose={vi.fn()} onTransferred={transferred}/> )
 await screen.findByRole('option',{name:/#7/})
 fireEvent.click(screen.getByRole('button',{name:'Xác nhận chuyển nhóm'}))
 expect(await screen.findByText('Bệnh nhân đã thuộc nhóm điều trị.')).toBeInTheDocument()
 expect(transferred).not.toHaveBeenCalled()
 expect(screen.getByRole('button',{name:'Xác nhận chuyển nhóm'})).toBeEnabled()
})

it('yêu cầu lý do khi chuyển bệnh nhân điều trị về nhóm đến khám',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.includes('workflow-config')?{allow_transfer_without_baseline:false}:[]})))
 render(<TransferDialog patient={{...patient,patient_type:'inpatient'}} onClose={vi.fn()} onTransferred={vi.fn()}/> )
 await screen.findByText(/Hồ sơ và toàn bộ lịch sử đánh giá/)
 expect(screen.getByRole('button',{name:'Xác nhận chuyển nhóm'})).toBeDisabled()
 fireEvent.change(screen.getByLabelText('Lý do chuyển nhóm'),{target:{value:'Kết thúc đợt điều trị theo quyết định chuyên môn.'}})
 expect(screen.getByRole('button',{name:'Xác nhận chuyển nhóm'})).toBeEnabled()
})

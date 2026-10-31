import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PatientProfile from './PatientProfile'

const patient={id:1,research_code:'BN-001',full_name:'Người bệnh giả lập',patient_type:'inpatient',date_of_birth:'1980-01-01',sex:'unspecified',contact:null,affected_side:'left',dominant_hand:'right',notes:null,admitted_at:'2026-10-31T00:00:00Z',created_at:'2026-10-01T00:00:00Z'}
const exercise={id:2,code:'guided_flower',name:'Hái hoa · Luyện tầm với',is_default:false,active:true,usage_mode:'both',renderer:'flower'}
const session={id:7,patient_id:1,session_type:'assessment',status:'completed',created_at:'2026-10-01T00:00:00Z'}
const baseline={session,patient,questionnaires:[],clinical_assessments:[],trials:[],results:[],duration_seconds:0,trial_count:0,is_baseline:true}
const report={patient,assessments:[baseline],training:[],transfers:[{id:5,patient_id:1,from_type:'outpatient',to_type:'inpatient',baseline_assessment_session_id:7,created_at:'2026-10-31T00:00:00Z'}],prescriptions:[],available_exercises:[]}
afterEach(()=>vi.unstubAllGlobals())
const view=()=>render(<MemoryRouter initialEntries={['/admin/patients/1']}><Routes><Route path="/admin/patients/:patientId" element={<PatientProfile/>}/></Routes></MemoryRouter>)

it('xem được đánh giá Baseline của hồ sơ đã chuyển nhóm và chỉ định rõ bác sĩ',async()=>{
 const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='POST'?{}:url.includes('/exercises')?[exercise,{...exercise,id:3,name:'Bài chưa hỗ trợ thực hiện',renderer:'unimplemented'}]:report}));vi.stubGlobal('fetch',fetchMock)
 view()
 expect(await screen.findByRole('heading',{name:'BN-001'})).toBeInTheDocument()
 expect(screen.getByText('Đánh giá #7 · Baseline')).toBeInTheDocument()
 expect(screen.getByRole('link',{name:'Xem Baseline'})).toHaveAttribute('href','/reports?patient_id=1&session_id=7')
 expect(screen.queryByRole('option',{name:'Bài chưa hỗ trợ thực hiện'})).not.toBeInTheDocument()
 const save=screen.getByRole('button',{name:'Lưu chỉ định'})
 expect(save).toBeDisabled()
 fireEvent.change(screen.getByLabelText('Bài tập bổ sung'),{target:{value:'2'}})
 fireEvent.change(screen.getByLabelText('Người chỉ định'),{target:{value:'Nhân viên chuyên môn'}})
 fireEvent.click(save)
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/patients/1/prescriptions'),expect.objectContaining({method:'POST'})))
 const call=fetchMock.mock.calls.find(([url,init])=>url.includes('/prescriptions')&&init?.method==='POST')
 expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({exercise_id:2,clinician_name:'Nhân viên chuyên môn'})
})

it('thông báo lỗi hồ sơ và cho phép tải lại',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementation(async(url:string)=>({ok:true,json:async()=>url.includes('/exercises')?[exercise]:report})))
 view()
 expect(await screen.findByText(/Không kết nối được backend/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Thử lại'}))
 expect(await screen.findByRole('heading',{name:'BN-001'})).toBeInTheDocument()
})

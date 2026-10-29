import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PatientDetail from './PatientDetail'
afterEach(()=>vi.unstubAllGlobals())
it('chỉ hiển thị phiên thuộc bệnh nhân đang xem',async()=>{
 const patient={id:1,research_code:'NC-001',affected_side:'right',dominant_hand:'left',notes:null,created_at:'2026-01-01T00:00:00Z'}
 const sessions=[{id:2,patient_id:1,session_type:'assessment',status:'completed',created_at:'2026-01-01T00:00:00Z'},{id:3,patient_id:2,session_type:'training',status:'draft',created_at:'2026-01-01T00:00:00Z'}]
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async (url:string)=>({ok:true,json:async()=>url.endsWith('/sessions')?sessions:patient})))
 render(<MemoryRouter initialEntries={['/patients/1']}><Routes><Route path="/patients/:id" element={<PatientDetail/>}/></Routes></MemoryRouter>)
 expect(await screen.findByText('Đánh giá · #2')).toBeInTheDocument()
 expect(screen.queryByText(/#3/)).not.toBeInTheDocument()
 expect(screen.getByRole('link',{name:/Tạo phiên/})).toHaveAttribute('href','/sessions?patient=1')
})

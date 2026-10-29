import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
afterEach(()=>vi.unstubAllGlobals())
describe('API',()=>{
 it('trả lỗi rõ ràng khi máy chủ từ chối yêu cầu',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({detail:'Mã đã tồn tại'})}))
  await expect(api.createPatient({research_code:'NC-001'})).rejects.toMatchObject({message:'Mã đã tồn tại',status:409})
 })
 it('trả lỗi có mã HTTP ngay cả khi response không phải JSON',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:503,json:async()=>{throw new Error('invalid JSON')}}))
  await expect(api.patients()).rejects.toMatchObject({message:'Yêu cầu thất bại (503)',status:503})
 })
 it('gửi PATCH và GET tới đúng tài nguyên',async()=>{
  const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({id:4})});vi.stubGlobal('fetch',fetchMock)
  await api.session(4); await api.updateSession(4,{status:'in_progress'}); await api.calibrations(4)
  expect(fetchMock.mock.calls[0][0]).toContain('/api/sessions/4')
  expect(fetchMock.mock.calls[1][1].method).toBe('PATCH')
  expect(fetchMock.mock.calls[2][0]).toContain('/api/calibrations?session_id=4')
 })
})

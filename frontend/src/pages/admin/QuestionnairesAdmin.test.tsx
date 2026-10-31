import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import QuestionnairesAdmin from './QuestionnairesAdmin'

const template={id:3,code:'intake',name:'Tiếp nhận lâm sàng',version:1,active:true,questions:[{id:7,key:'history',label:'Tiền sử',group:'Bệnh sử',question_type:'text',required:true,display_order:0,options:[]}]}
afterEach(()=>vi.unstubAllGlobals())

it('tạo phiên bản mới và sao chép nội dung thành payload mới, không sửa phiên bản cũ',async()=>{
 const fetchMock=vi.fn(async(_url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='POST'?{...template,id:4,version:2}:[template]}));vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><QuestionnairesAdmin/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Tạo phiên bản kế tiếp'}))
 expect(screen.getByLabelText('Phiên bản')).toHaveValue(2)
 fireEvent.change(screen.getByLabelText('Nội dung câu hỏi 1'),{target:{value:'Tiền sử cập nhật'}})
 fireEvent.click(screen.getByRole('button',{name:'Lưu phiên bản mới'}))
 await waitFor(()=>expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(true))
 const call=fetchMock.mock.calls.find(([,init])=>init?.method==='POST')
 expect(call?.[0]).toMatch(/\/api\/questionnaires$/)
 expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({code:'intake',version:2,questions:[{key:'history',label:'Tiền sử cập nhật'}]})
 expect(template.questions[0].label).toBe('Tiền sử')
 expect(fetchMock.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false)
})

it('hỗ trợ sáu kiểu câu hỏi và từ chối lựa chọn thiếu đáp án',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>[template]})))
 render(<MemoryRouter><QuestionnairesAdmin/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Tạo phiên bản kế tiếp'}))
 const kind=screen.getByLabelText('Kiểu câu hỏi 1')
 expect(kind.querySelectorAll('option')).toHaveLength(6)
 fireEvent.change(kind,{target:{value:'single_choice'}})
 fireEvent.click(screen.getByRole('button',{name:'Lưu phiên bản mới'}))
 expect(await screen.findByText(/Câu hỏi lựa chọn cần ít nhất một đáp án/)).toBeInTheDocument()
})

it('soạn bộ câu hỏi mới, sửa thứ tự và bỏ câu nháp trước khi xuất bản', async () => {
 const fetchMock=vi.fn(async(_url:string,init?:RequestInit)=>({ok:true,json:async()=>init?.method==='POST'?{id:9}:[template]}))
 vi.stubGlobal('fetch',fetchMock)
 render(<MemoryRouter><QuestionnairesAdmin/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'Tạo bộ câu hỏi'}))
 fireEvent.change(screen.getByLabelText('Mã bộ câu hỏi'),{target:{value:'intake_custom'}})
 fireEvent.change(screen.getByLabelText('Tên bộ câu hỏi'),{target:{value:'Thông tin trước khám'}})
 fireEvent.change(screen.getByLabelText('Phiên bản'),{target:{value:'3'}})
 fireEvent.click(screen.getByLabelText('Áp dụng cho lần đánh giá mới'))
 fireEvent.change(screen.getByLabelText('Mã câu hỏi 1'),{target:{value:'symptoms'}})
 fireEvent.change(screen.getByLabelText('Nhóm câu hỏi 1'),{target:{value:'Vận động'}})
 fireEvent.change(screen.getByLabelText('Nội dung câu hỏi 1'),{target:{value:'Biểu hiện được ghi nhận'}})
 fireEvent.change(screen.getByLabelText('Kiểu câu hỏi 1'),{target:{value:'multiple_choice'}})
 fireEvent.change(screen.getByLabelText('Thứ tự câu hỏi 1'),{target:{value:'2'}})
 fireEvent.change(screen.getByLabelText('Đáp án câu hỏi 1 (mỗi dòng một đáp án)'),{target:{value:'Đau\nYếu cơ'}})
 fireEvent.click(screen.getByLabelText('Bắt buộc trả lời câu 1'))
 fireEvent.click(screen.getByRole('button',{name:'Thêm câu hỏi'}))
 expect(screen.getByLabelText('Nội dung câu hỏi 2')).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Bỏ câu 2'}))
 expect(screen.queryByLabelText('Nội dung câu hỏi 2')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Lưu phiên bản mới'}))
 await screen.findByRole('status')
 const call=fetchMock.mock.calls.find(([,init])=>init?.method==='POST')
 expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({code:'intake_custom',name:'Thông tin trước khám',version:3,active:false,questions:[{key:'symptoms',group:'Vận động',question_type:'multiple_choice',display_order:2,required:true,options:['Đau','Yếu cơ']}]})
 expect(template.questions[0].label).toBe('Tiền sử')
})

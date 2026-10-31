import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import Layout from './Layout'
afterEach(()=>vi.unstubAllGlobals())
it('hiển thị trạng thái backend và đúng năm phân hệ nghiệp vụ',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({status:'ok',database:'connected'})}))
 render(<MemoryRouter><Layout/></MemoryRouter>)
 expect(await screen.findByText(/Hệ thống kết nối/)).toBeInTheDocument()
 expect(screen.getAllByRole('link')).toHaveLength(5)
 for (const [name, href] of [['Tổng quan','/'],['Đánh giá','/assessment'],['Luyện tập','/training'],['Báo cáo','/reports'],['Quản trị','/admin']]) {
  expect(screen.getByRole('link',{name})).toHaveAttribute('href',href)
 }
 expect(screen.queryByRole('link',{name:'Camera & hiệu chuẩn'})).not.toBeInTheDocument()
})

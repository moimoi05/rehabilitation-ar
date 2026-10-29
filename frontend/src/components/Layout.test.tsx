import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import Layout from './Layout'
afterEach(()=>vi.unstubAllGlobals())
it('hiển thị trạng thái backend và điều hướng đến workspace',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({status:'ok',database:'connected'})}))
 render(<MemoryRouter><Layout/></MemoryRouter>)
 expect(await screen.findByText(/Hệ thống kết nối/)).toBeInTheDocument()
 expect(screen.getByRole('link',{name:'Camera & hiệu chuẩn'})).toHaveAttribute('href','/workspace')
})

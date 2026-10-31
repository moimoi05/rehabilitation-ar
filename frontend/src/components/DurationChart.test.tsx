import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import DurationChart from './DurationChart'

it('vẽ thời lượng từ kết quả đã lưu và không gộp thang điểm trò chơi',()=>{
 render(<DurationChart data={[{label:'31/10 · #12',duration_seconds:15,game:'Hái hoa'},{label:'31/10 · #13',duration_seconds:30,game:'Vươn tay'}]}/> )
 expect(screen.getByRole('img',{name:'Thời lượng luyện tập theo ngày và bài tập'})).toBeInTheDocument()
 expect(screen.getByText('15 giây')).toBeInTheDocument()
 expect(screen.getByText('30 giây')).toBeInTheDocument()
 expect(screen.getByText('Hái hoa')).toBeInTheDocument()
 expect(screen.getByText('Vươn tay')).toBeInTheDocument()
 expect(screen.getByText('Ngày / buổi luyện tập')).toBeInTheDocument()
 expect(screen.getByText('Thời lượng (giây)')).toBeInTheDocument()
})

it('không tạo dữ liệu minh họa khi chưa có lượt được lưu',()=>{
 render(<DurationChart data={[]}/>)
 expect(screen.getByText(/Chưa có dữ liệu thời lượng/)).toBeInTheDocument()
 expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

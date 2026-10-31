export type DurationPoint = { label: string; duration_seconds: number; game: string }
export default function DurationChart({ data }: { data: DurationPoint[] }) {
  const points = data.filter(point => Number.isFinite(point.duration_seconds) && point.duration_seconds >= 0)
  if (!points.length) return <div className="empty">Chưa có dữ liệu thời lượng từ các lượt đã lưu.</div>
  const max = Math.max(1, ...points.map(point => point.duration_seconds))
  const width = Math.max(640, points.length * 150 + 100)
  const column = (width - 100) / points.length
  return <div className="duration-chart"><svg viewBox={`0 0 ${width} 360`} style={{ minWidth: width }} role="img" aria-label="Thời lượng luyện tập theo ngày và bài tập">
    <text x="18" y="18" className="chart-label">Thời lượng (giây)</text>
    {[0, .25, .5, .75, 1].map(ratio => <g key={ratio}><line x1="62" y1={265 - ratio * 220} x2={width - 20} y2={265 - ratio * 220} stroke="#e4edf2"/><text x="50" y={269 - ratio * 220} textAnchor="end" className="chart-label">{Math.round(max * ratio * 10) / 10}</text></g>)}
    <line x1="62" y1="35" x2="62" y2="265" stroke="#b6cfdc"/><line x1="62" y1="265" x2={width - 20} y2="265" stroke="#b6cfdc"/>
    {points.map((point, index) => { const center = 70 + column * (index + .5), barHeight = point.duration_seconds / max * 220; return <g key={`${point.label}-${point.game}-${index}`}><rect x={center - 22} y={265 - barHeight} width="44" height={barHeight} rx="4" fill={index % 2 ? '#40a397' : '#2581b0'}/><text x={center} y={253 - barHeight} textAnchor="middle" className="chart-value">{Math.round(point.duration_seconds * 10) / 10} giây</text><text x={center} y="287" textAnchor="middle" className="chart-label">{point.label}</text><text x={center} y="305" textAnchor="middle" className="chart-game">{point.game}</text></g> })}
    <text x={width / 2} y="343" textAnchor="middle" className="chart-label">Ngày / buổi luyện tập</text>
  </svg></div>
}

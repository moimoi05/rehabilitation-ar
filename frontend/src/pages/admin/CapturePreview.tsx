import { useState } from 'react'
import type { CaptureSummary } from '../../types/rehab'

const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'
type Preview = { columns: string[]; rows: Record<string, unknown>[]; total_rows: number }
type Kind = 'frames' | 'landmarks'

function ManifestPreview({ captureId }: { captureId: string }) {
  const [manifest, setManifest] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch(`${base}/api/captures/${encodeURIComponent(captureId)}/artifacts/manifest`)
      if (!response.ok) throw new Error(`Không tải được manifest (${response.status}).`)
      setManifest(JSON.stringify(await response.json(), null, 2))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được manifest.')
    } finally { setLoading(false) }
  }
  return <div className="rehab-section"><button className="text-link" disabled={loading} onClick={() => void load()}>{loading ? 'Đang tải…' : 'Xem manifest'}</button>
    {error && <p role="alert">{error}</p>}{manifest && <pre style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{manifest}</pre>}
  </div>
}

function PreviewTable({ captureId, kind }: { captureId: string; kind: Kind }) {
  const [data, setData] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch(`${base}/api/captures/${encodeURIComponent(captureId)}/preview/${kind}`)
      if (!response.ok) throw new Error(`Không tải được dữ liệu (${response.status}).`)
      setData(await response.json() as Preview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được dữ liệu.')
    } finally { setLoading(false) }
  }
  return <div className="rehab-section">
    <button className="text-link" disabled={loading} onClick={() => void load()}>{loading ? 'Đang tải…' : `Xem mẫu ${kind}`}</button>
    {error && <p role="alert">{error}</p>}
    {data && <><p>Hiển thị {data.rows.length} / {data.total_rows} dòng.</p><div className="table-wrap"><table><thead><tr>{data.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}>{data.columns.map(column => <td key={column}>{row[column] == null ? '—' : typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column])}</td>)}</tr>)}</tbody></table></div></>}
  </div>
}

export default function CapturePreview({ capture }: { capture: CaptureSummary }) {
  const summary = capture.artifact_summary
  if (!summary) return null
  return <details className="rehab-section"><summary>Xem mẫu dữ liệu capture {capture.id}</summary>
    <h4>Metadata đã lưu</h4>
    <dl className="detail-list">{Object.entries(summary).map(([key, value]) => <div key={key}><dt>{key}</dt><dd style={{ overflowWrap: 'anywhere' }}>{value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
    {summary.manifest_status === 'complete' && <ManifestPreview captureId={capture.id}/>}
    {summary.frames_status === 'complete' && <PreviewTable captureId={capture.id} kind="frames"/>}
    {summary.landmarks_status === 'complete' && <PreviewTable captureId={capture.id} kind="landmarks"/>}
  </details>
}

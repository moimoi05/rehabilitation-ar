import { useCallback, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { Empty, ErrorState, Loading } from '../../components/States'
import { Button } from '../../components/ui/button'
import { useData } from '../../hooks/useData'
import { rehabApi } from '../../services/rehab'
import type { QuestionnaireTemplate, QuestionType } from '../../types/rehab'

type DraftQuestion = { rowId: string; key: string; label: string; group: string; question_type: QuestionType; required: boolean; display_order: number; optionsText: string }
const freshQuestion = (index: number): DraftQuestion => ({ rowId: crypto.randomUUID(), key: `question_${index + 1}`, label: '', group: 'Thông tin lâm sàng', question_type: 'text', required: false, display_order: index, optionsText: '' })
const questionKinds: { type: QuestionType; label: string }[] = [{ type: 'text', label: 'Văn bản' }, { type: 'number', label: 'Số' }, { type: 'date', label: 'Ngày' }, { type: 'single_choice', label: 'Chọn một' }, { type: 'multiple_choice', label: 'Chọn nhiều' }, { type: 'boolean', label: 'Có / Không' }]

function TemplateEditor({ template, nextVersion, onClose, onSaved }: { template?: QuestionnaireTemplate; nextVersion: number; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(template?.code || '')
  const [name, setName] = useState(template?.name || '')
  const [version, setVersion] = useState(nextVersion)
  const [active, setActive] = useState(true)
  const [questions, setQuestions] = useState<DraftQuestion[]>(() => template ? template.questions.map(question => ({ rowId: crypto.randomUUID(), key: question.key, label: question.label, group: question.group || 'Thông tin lâm sàng', question_type: question.question_type, required: question.required, display_order: question.display_order, optionsText: question.options.join('\n') })) : [freshQuestion(0)])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const change = (rowId: string, changes: Partial<DraftQuestion>) => setQuestions(current => current.map(question => question.rowId === rowId ? { ...question, ...changes } : question))
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    const items = questions.map(question => ({ key: question.key.trim(), label: question.label.trim(), group: question.group.trim(), question_type: question.question_type, required: question.required, display_order: question.display_order, options: question.optionsText.split('\n').map(option => option.trim()).filter(Boolean) }))
    if (!items.length) { setError('Bộ câu hỏi cần ít nhất một câu hỏi.'); return }
    if (new Set(items.map(question => question.key)).size !== items.length) { setError('Mã câu hỏi không được trùng.'); return }
    if (items.some(question => !question.key || !question.label || !question.group)) { setError('Điền mã, nội dung và nhóm cho từng câu hỏi.'); return }
    if (items.some(question => ['single_choice', 'multiple_choice'].includes(question.question_type) && !question.options.length)) { setError('Câu hỏi lựa chọn cần ít nhất một đáp án.'); return }
    if (items.some(question => new Set(question.options).size !== question.options.length)) { setError('Đáp án trong một câu hỏi không được trùng.'); return }
    setSaving(true)
    try { await rehabApi.createQuestionnaire({ code: code.trim(), name: name.trim(), version, active, questions: items }); onSaved() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Không lưu được phiên bản câu hỏi.'); setSaving(false) }
  }
  return <div className="modal-backdrop"><div className="modal rehab-questionnaire-modal" role="dialog" aria-modal="true" aria-labelledby="questionnaire-editor-title"><div className="panel-heading"><div><span className="eyebrow">PHIÊN BẢN MỚI</span><h2 id="questionnaire-editor-title">{template ? 'Tạo phiên bản kế tiếp' : 'Tạo bộ câu hỏi'}</h2><p>Các lần đánh giá cũ giữ nguyên nội dung và câu trả lời.</p></div><button className="close" onClick={onClose} disabled={saving} aria-label="Đóng">×</button></div>
    <form className="form" onSubmit={event => void submit(event)}><div className="form-grid"><label>Mã bộ câu hỏi<input required pattern="[A-Za-z0-9_-]+" maxLength={64} value={code} readOnly={!!template} onChange={event => setCode(event.target.value)}/></label><label>Tên bộ câu hỏi<input required maxLength={255} value={name} onChange={event => setName(event.target.value)}/></label></div><div className="form-grid"><label>Phiên bản<input type="number" required min={nextVersion} step="1" value={version} onChange={event => setVersion(Number(event.target.value))}/></label><label className="checkbox"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)}/> Áp dụng cho lần đánh giá mới</label></div>
      {questions.map((question, index) => <fieldset className="rehab-question-fieldset" key={question.rowId}><legend>Câu hỏi {index + 1}</legend><div className="form-grid"><label>Mã câu hỏi {index + 1}<input required pattern="[A-Za-z0-9_-]+" maxLength={64} value={question.key} onChange={event => change(question.rowId, { key: event.target.value })}/></label><label>Nhóm câu hỏi {index + 1}<input required maxLength={255} value={question.group} onChange={event => change(question.rowId, { group: event.target.value })}/></label></div><label>Nội dung câu hỏi {index + 1}<input required maxLength={1000} value={question.label} onChange={event => change(question.rowId, { label: event.target.value })}/></label><div className="form-grid"><label>Kiểu câu hỏi {index + 1}<select value={question.question_type} onChange={event => change(question.rowId, { question_type: event.target.value as QuestionType })}>{questionKinds.map(kind => <option key={kind.type} value={kind.type}>{kind.label}</option>)}</select></label><label>Thứ tự câu hỏi {index + 1}<input type="number" required min="0" step="1" value={question.display_order} onChange={event => change(question.rowId, { display_order: Number(event.target.value) })}/></label></div>{['single_choice', 'multiple_choice'].includes(question.question_type) && <label>Đáp án câu hỏi {index + 1} (mỗi dòng một đáp án)<textarea rows={3} maxLength={50000} value={question.optionsText} onChange={event => change(question.rowId, { optionsText: event.target.value })}/></label>}<div className="rehab-toolbar"><label className="checkbox"><input type="checkbox" checked={question.required} onChange={event => change(question.rowId, { required: event.target.checked })}/> Bắt buộc trả lời câu {index + 1}</label><button type="button" className="text-link" disabled={saving || questions.length === 1} onClick={() => setQuestions(current => current.filter(item => item.rowId !== question.rowId))}>Bỏ câu {index + 1}</button></div></fieldset>)}
      <Button type="button" variant="outline" disabled={saving || questions.length >= 100} onClick={() => setQuestions(current => [...current, freshQuestion(current.length)])}><Plus size={16}/> Thêm câu hỏi</Button>{error && <ErrorState message={error}/>}<div className="form-actions"><Button type="button" variant="outline" disabled={saving} onClick={onClose}>Hủy</Button><Button disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu phiên bản mới'}</Button></div>
    </form></div></div>
}

export default function QuestionnairesAdmin() {
  const load = useCallback(() => rehabApi.questionnaires(true), [])
  const { data, error, loading, reload } = useData(load)
  const [editing, setEditing] = useState<QuestionnaireTemplate | null | undefined>(undefined)
  const [message, setMessage] = useState('')
  return <><Link className="back-link" to="/admin"><ArrowLeft size={16}/> Quản trị bệnh nhân</Link><div className="page-heading"><div><span className="eyebrow">QUẢN TRỊ</span><h1>Bộ câu hỏi lâm sàng</h1><p>Quản lý nội dung, kiểu trả lời và phiên bản dùng cho lần đánh giá mới.</p></div><Button onClick={() => setEditing(null)}><Plus size={16}/> Tạo bộ câu hỏi</Button></div>{message && <div className="notice" role="status">{message}</div>}<section className="panel">{loading ? <Loading/> : error ? <ErrorState message={error} retry={() => void reload()}/> : !data?.length ? <Empty>Chưa có bộ câu hỏi.</Empty> : <div className="table-wrap"><table><thead><tr><th>Bộ câu hỏi</th><th>Phiên bản</th><th>Số câu</th><th>Trạng thái</th><th/></tr></thead><tbody>{data.map(template => <tr key={template.id}><td><strong>{template.name}</strong><span className="cell-sub">{template.code}</span></td><td>{template.version}</td><td>{template.questions.length}</td><td>{template.active ? 'Đang áp dụng' : 'Đã lưu trữ'}</td><td><button className="text-link" onClick={() => setEditing(template)}>Tạo phiên bản kế tiếp</button></td></tr>)}</tbody></table></div>}</section>
    {editing !== undefined && <TemplateEditor template={editing || undefined} nextVersion={editing ? Math.max(...(data || []).filter(template => template.code === editing.code).map(template => template.version)) + 1 : 1} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); setMessage('Đã tạo phiên bản mới. Nội dung và câu trả lời của các lần đánh giá cũ được giữ nguyên.'); void reload() }}/>} 
  </>
}

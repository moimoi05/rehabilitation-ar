import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/button'
import type { QuestionnaireAnswer, QuestionnaireQuestion, QuestionnaireSubmission } from '../../types/rehab'

type Value = QuestionnaireAnswer['value']
type Props = { submission: QuestionnaireSubmission; onSave: (answers: QuestionnaireAnswer[]) => void; onBack: () => void; busy: boolean }

function AnswerInput({ question, value, onChange, disabled }: { question: QuestionnaireQuestion; value: Value; onChange: (value: Value) => void; disabled: boolean }) {
  const id = `question-${question.key}`
  if (question.question_type === 'multiple_choice') return <fieldset className="question-choices" disabled={disabled}>
    <legend>{question.label}{question.required ? ' *' : ''}</legend>
    {question.options.map(option => <label className="checkbox" key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={event => {
      const prior = Array.isArray(value) ? value : []
      onChange(event.target.checked ? [...prior, option] : prior.filter(item => item !== option))
    }} />{option}</label>)}
  </fieldset>
  if (question.question_type === 'single_choice' || question.question_type === 'boolean') {
    const selected = value === null ? '' : String(value)
    return <label htmlFor={id}>{question.label}{question.required ? ' *' : ''}<select id={id} required={question.required} disabled={disabled} value={selected} onChange={event => onChange(event.target.value === '' ? null : question.question_type === 'boolean' ? event.target.value === 'true' : event.target.value)}>
      <option value="">Chọn câu trả lời</option>{question.question_type === 'boolean' ? <><option value="true">Có</option><option value="false">Không</option></> : question.options.map(option => <option value={option} key={option}>{option}</option>)}
    </select></label>
  }
  return <label htmlFor={id}>{question.label}{question.required ? ' *' : ''}<input id={id} disabled={disabled} type={question.question_type === 'date' ? 'date' : question.question_type === 'number' ? 'number' : 'text'} step={question.question_type === 'number' ? 'any' : undefined} required={question.required} maxLength={question.question_type === 'text' ? 4000 : undefined} value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? null : question.question_type === 'number' ? Number(event.target.value) : event.target.value)} /></label>
}

export default function QuestionnaireForm({ submission, onSave, onBack, busy }: Props) {
  const template = submission.template_snapshot
  const questions = [...template.questions].sort((a, b) => a.display_order - b.display_order)
  const [values, setValues] = useState<Record<string, Value>>(() => Object.fromEntries(submission.answers.map(answer => [answer.question_key, answer.value])))
  const [error, setError] = useState('')
  function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    const missing = questions.find(question => question.required && (values[question.key] === undefined || values[question.key] === null || values[question.key] === '' || (Array.isArray(values[question.key]) && (values[question.key] as string[]).length === 0)))
    if (missing) { setError(`Vui lòng trả lời: ${missing.label}.`); return }
    onSave(questions.map(question => ({ question_key: question.key, value: values[question.key] ?? null })))
  }
  return <section className="panel"><div className="panel-heading"><div><h2>Câu hỏi lâm sàng</h2><p>{template.name} · phiên bản {template.version}</p></div><span className="badge">{submission.completed ? 'Đã lưu' : 'Chưa hoàn tất'}</span></div>
    <p className="help">Câu hỏi và câu trả lời được lưu riêng cho lần đánh giá này. Dấu * là trường bắt buộc.</p>
    <form className="form questionnaire-form" onSubmit={submit}>
      {questions.map((question, index) => <div key={question.key} className="question-item">{question.group && question.group !== questions[index - 1]?.group && <h3>{question.group}</h3>}<AnswerInput question={question} value={values[question.key] ?? null} disabled={busy || submission.completed} onChange={value => setValues(previous => ({ ...previous, [question.key]: value }))} /></div>)}
      {error && <p className="state error" role="alert">{error}</p>}
      <div className="form-actions"><Button type="button" variant="outline" disabled={busy} onClick={onBack}>Quay lại</Button>{submission.completed ? <Button type="button" onClick={() => onSave(submission.answers)} disabled={busy}>Tiếp tục đến camera</Button> : <Button disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu câu trả lời và tiếp tục'}</Button>}</div>
    </form>
  </section>
}

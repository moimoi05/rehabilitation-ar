import { Button } from '../../components/ui/button'
import { Empty } from '../../components/States'
import type { Exercise, Trial } from '../../types/rehab'

type Props = { exercises: Exercise[]; trials?: Trial[]; selectedIds?: number[]; onSelectionChange?: (ids: number[]) => void; onPlay: (exercise: Exercise) => void; disabled?: boolean }
export default function ExerciseCatalog({ exercises, trials = [], selectedIds, onSelectionChange, onPlay, disabled = false }: Props) {
  const playable = exercises.filter(exercise => exercise.active && (exercise.renderer === 'flower' || (exercise.renderer === 'free_drawing' && exercise.usage_mode === 'training')))
  return <div className="exercise-catalog">{playable.length === 0 ? <Empty>Chưa có bài tập đang hoạt động để thực hiện.</Empty> : playable.map(exercise => <article className="panel exercise-card" key={exercise.id}>
    <div className="panel-heading"><h3>{exercise.name}</h3></div>
    <p>{exercise.description}</p><p className="help">{exercise.instructions}</p>
    <p className="help">Số lượt trong buổi: {trials.filter(trial => trial.exercise_id === exercise.id || (!trial.exercise_id && trial.exercise_code === exercise.code)).length}</p>
    {selectedIds && onSelectionChange && <label className="checkbox"><input type="checkbox" checked={selectedIds.includes(exercise.id)} disabled={disabled || trials.some(trial => trial.exercise_id === exercise.id)} onChange={event => onSelectionChange(event.target.checked ? [...selectedIds, exercise.id] : selectedIds.filter(id => id !== exercise.id))} />Chọn {exercise.name}</label>}
    <Button disabled={disabled || (selectedIds !== undefined && !selectedIds.includes(exercise.id))} onClick={() => onPlay(exercise)}>Thực hiện {exercise.name}</Button>
  </article>)}</div>
}

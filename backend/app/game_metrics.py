"""Reproducible 2D game metrics from verified events and streamed processed samples.

Inputs are never modified. Only entity summaries and the previous point of each
trajectory are retained; accepted stroke histories are not loaded into memory.
These are game interaction measures, without clinical or FMA-UE interpretation.
"""
from bisect import bisect_right
from dataclasses import dataclass, replace
from math import hypot, isfinite

ALGORITHM_VERSION = 'game-metrics-2d-v1'
MAX_GAP_MS = 250
TERMINALS = {'GAME_COMPLETED', 'GAME_STOPPED', 'GAME_CANCELLED'}
CUT_EVENTS = {'TRACKING_LOST', 'TRACKING_RECOVERED', 'GEOMETRY_PAUSED',
    'GEOMETRY_RESUMED', 'GEOMETRY_CHANGED', 'GAME_PAUSED', 'GAME_RESUMED'}


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def _metric(name, value, unit, count=0, *, partial=False, reason=None):
    if isinstance(value, float) and not isfinite(value):
        value, reason = None, 'nonfinite_result'
    return dict(metric_name=name, value=value, unit=unit,
        algorithm_version=ALGORITHM_VERSION, sample_count=count,
        quality_status='unavailable' if value is None else 'partial' if partial else 'valid',
        unavailable_reason=(reason or 'insufficient_data') if value is None else None)


def _point(payload, x_key='x', y_key='y', *, offsets=False):
    x, y = payload.get(x_key), payload.get(y_key)
    width, height, space = payload.get('width'), payload.get('height'), payload.get('coordinate_space')
    if not all(_number(v) for v in (x, y, width, height)) or width <= 0 or height <= 0:
        return None
    if space == 'display_normalized':
        if not offsets and not (0 <= x <= 1 and 0 <= y <= 1):
            return None
        x, y = x * width, y * height
    elif space not in {'logical_canvas_px', 'display_pixels'}:
        return None
    if not offsets and space != 'display_normalized' and not (0 <= x <= width and 0 <= y <= height):
        return None
    return (float(x), float(y), space, float(width), float(height), payload.get('mapping_version'))


@dataclass(frozen=True)
class _Path:
    previous: tuple | None = None
    first_ms: float | None = None
    last_ms: float | None = None
    length: float = 0
    elapsed_ms: float = 0
    count: int = 0
    pairs: int = 0
    broken: bool = False

    def add(self, point, timestamp, segment):
        if point is None or not _number(timestamp):
            return replace(self, previous=None, broken=True)
        current = (point, float(timestamp), segment)
        distance, elapsed, pairs, broken = 0, 0, 0, self.broken
        if self.previous:
            before, before_ms, before_segment = self.previous
            gap = timestamp - before_ms
            if 0 < gap <= MAX_GAP_MS and point[2:] == before[2:] and segment == before_segment:
                distance, elapsed, pairs = hypot(point[0] - before[0], point[1] - before[1]), gap, 1
            else:
                broken = True
        return _Path(current, self.first_ms if self.first_ms is not None else timestamp,
            timestamp, self.length + distance, self.elapsed_ms + elapsed,
            self.count + 1, self.pairs + pairs, broken)

    def metric(self, name, unit, *, speed=False):
        value = self.length if self.pairs else None
        if speed:
            value = self.length * 1000 / self.elapsed_ms if self.pairs and self.elapsed_ms > 0 else None
        return _metric(name, value, unit, self.count, partial=self.broken,
            reason='insufficient_contiguous_samples')


def _identity(row, capture_id, trial_id, game_key):
    expected = {'capture_id': str(capture_id), 'trial_id': trial_id, 'game_key': game_key}
    for key, value in expected.items():
        if row.get(key) is not None and str(row[key]) != str(value):
            raise ValueError('Metric input identity differs from capture, trial or game')


def _event_state(events, capture_id, trial_id, game_key):
    state = dict(start=None, end=None, terminal={}, event_count=0, targets={}, strokes={},
        drags={}, cuts=[], losses=0, undo=0, clear=0, tracking_time=0., known_time=0.)
    tracking, geometry, paused, previous, active_target = None, False, False, None, None
    for row in events:
        _identity(row, capture_id, trial_id, game_key)
        timestamp, kind, payload = row.get('timestamp_ms'), row.get('event_type'), row.get('payload', {})
        if not _number(timestamp) or timestamp < 0 or not isinstance(payload, dict):
            raise ValueError('Metric event has invalid timestamp or payload')
        state['event_count'] += 1
        if previous is not None and timestamp < previous:
            raise ValueError('Metric events must be ordered')
        if previous is not None and state['start'] is not None and state['end'] is None:
            elapsed = timestamp - previous
            if tracking is not None:
                state['known_time'] += elapsed
            if tracking and not geometry and not paused:
                state['tracking_time'] += elapsed
        previous = timestamp
        if kind == 'GAME_STARTED' and state['start'] is None:
            state['start'] = timestamp
            tracking = payload.get('tracking_usable') if isinstance(payload.get('tracking_usable'), bool) else None
        if kind in TERMINALS:
            state['end'], state['terminal'] = timestamp, payload
        if kind in CUT_EVENTS:
            source_time = row.get('source_timestamp_ms')
            state['cuts'].append(source_time if _number(source_time) else timestamp)
        if kind == 'TRACKING_LOST':
            state['losses'] += 1
            target = state['targets'].get(payload.get('target_id', active_target))
            if target is not None:
                target['losses'] += 1
            tracking = False
        elif kind == 'TRACKING_RECOVERED':
            tracking = True
        elif kind in {'GEOMETRY_PAUSED', 'GEOMETRY_RESUMED'}:
            geometry = kind == 'GEOMETRY_PAUSED'
        elif kind in {'GAME_PAUSED', 'GAME_RESUMED'}:
            paused = kind == 'GAME_PAUSED'
            if kind == 'GAME_RESUMED' and isinstance(payload.get('tracking_usable'), bool):
                tracking = payload['tracking_usable']
        _entity_event(state, kind, timestamp, payload)
        if kind == 'TARGET_SPAWNED':
            active_target = payload.get('target_id')
    state['cuts'].sort()
    return state


def _entity_event(state, kind, timestamp, payload):
    if kind == 'TARGET_SPAWNED' and payload.get('target_id') is not None:
        key = payload['target_id']
        if key in state['targets']:
            raise ValueError('Duplicate target spawn identity')
        state['targets'][key] = dict(snapshot=payload, touch_geometry=payload, start=timestamp, end=None, touched={}, losses=0)
    elif kind in {'GEOMETRY_PAUSED', 'GEOMETRY_RESUMED', 'GEOMETRY_CHANGED'}:
        target = state['targets'].get(payload.get('target_id'))
        if target is not None:
            target['touch_geometry'] = payload
    elif kind == 'TARGET_TOUCHED':
        target = state['targets'].get(payload.get('target_id'))
        if target is None or target['end'] is not None:
            raise ValueError('Touch must reference one untouched spawned target')
        target['end'], target['touched'] = timestamp, payload
    elif kind == 'STROKE_STARTED' and payload.get('stroke_id') is not None:
        key = payload['stroke_id']
        if key in state['strokes']:
            raise ValueError('Duplicate stroke identity')
        state['strokes'][key] = dict(start=timestamp, end=None, completion={}, snapshot=payload)
    elif kind == 'STROKE_COMPLETED':
        stroke = state['strokes'].get(payload.get('stroke_id'))
        if stroke is None or stroke['end'] is not None:
            raise ValueError('Stroke completion must reference one open stroke')
        stroke['end'], stroke['completion'] = timestamp, payload
    elif kind == 'STROKE_GRABBED' and payload.get('drag_id') is not None:
        key = payload['drag_id']
        if key in state['drags']:
            raise ValueError('Duplicate drag identity')
        state['drags'][key] = dict(start=timestamp, end=None, completion={}, snapshot=payload)
    elif kind in {'STROKE_RELEASED', 'DRAG_INTERRUPTED'}:
        drag = state['drags'].get(payload.get('drag_id'))
        if drag is None or drag['end'] is not None:
            raise ValueError('Drag completion must reference one open drag')
        drag['end'], drag['completion'] = timestamp, {**payload, 'interrupted': kind == 'DRAG_INTERRUPTED'}
    elif kind == 'UNDO':
        state['undo'] += 1
    elif kind == 'CLEAR_CANVAS':
        state['clear'] += 1


def _paths(samples, state, capture_id, trial_id, game_key):
    paths, total, previous_time = {}, _Path(), -1
    for key, drag in state['drags'].items():
        point = _point(drag['snapshot'], 'offset_x', 'offset_y', offsets=True)
        segment = bisect_right(state['cuts'], drag['start'])
        paths[('drag', key)] = _Path().add(point, drag['start'], segment)
    for row in samples:
        _identity(row, capture_id, trial_id, game_key)
        timestamp, payload = row.get('timestamp_ms'), row.get('payload', {})
        if not _number(timestamp) or timestamp < previous_time or not isinstance(payload, dict):
            raise ValueError('Metric sample timeline or payload invalid')
        previous_time = timestamp
        kind = row.get('sample_type')
        category = {'flower_cursor': 'target', 'drawing_stroke_point': 'stroke', 'drawing_drag_point': 'drag'}.get(kind)
        if category is None:
            continue
        key = payload.get(f'{category}_id')
        collection = state[{'target': 'targets', 'stroke': 'strokes', 'drag': 'drags'}[category]]
        if key not in collection:
            raise ValueError('Interaction sample references an unknown game entity')
        if state['start'] is None or timestamp < state['start'] or state['end'] is not None and timestamp > state['end']:
            continue
        usable = payload.get('usable') is True and payload.get('freshness', 'fresh') == 'fresh'
        point = _point(payload, 'offset_x', 'offset_y', offsets=True) if category == 'drag' else _point(payload)
        if not usable:
            point = None
        segment = bisect_right(state['cuts'], timestamp)
        identity = (category, key)
        paths[identity] = paths.get(identity, _Path()).add(point, timestamp, segment)
        if category == 'target':
            total = total.add(point, timestamp, segment)
    return paths, total


def _coverage(state):
    wall = state['end'] - state['start'] if state['start'] is not None and state['end'] is not None else None
    coverage = state['tracking_time'] / wall if wall is not None and wall > 0 and state['known_time'] >= wall - .000001 else None
    return wall, _metric('tracking_coverage', coverage, 'ratio', state['event_count'],
        reason='missing_game_interval_or_tracking_state')


def _flower_target(key, target, path, complete):
    snapshot, touched, geometry = target['snapshot'], target['touched'], target['touch_geometry']
    center = _point(geometry, 'target_x', 'target_y')
    endpoint = _point({**geometry, **touched}, 'cursor_x', 'cursor_y')
    error = hypot(center[0] - endpoint[0], center[1] - endpoint[1]) if center and endpoint and center[2:] == endpoint[2:] else None
    duration = target['end'] - target['start'] if target['end'] is not None else None
    metrics = {name: _metric(name, None, 'ms', reason='movement_onset_algorithm_not_implemented')
        for name in ('movement_onset_ms', 'reaction_time_ms', 'movement_time_ms')}
    metrics.update(time_to_touch_ms=_metric('time_to_touch_ms', duration, 'ms', int(duration is not None), reason='target_not_touched'),
        path_length=path.metric('path_length', 'px'), endpoint_error=_metric('endpoint_error', error, 'px', int(error is not None), reason='touch_coordinates_unavailable'),
        success=_metric('success', target['end'] is not None, 'boolean', 1, partial=not complete),
        tracking_loss_count=_metric('tracking_loss_count', target['losses'], 'count', target['losses'], partial=not complete))
    return dict(target_id=key, target_sequence=snapshot.get('target_sequence'), spawn_timestamp_ms=target['start'],
        touch_timestamp_ms=target['end'], target_geometry=snapshot, touch_geometry=geometry, metrics=metrics)


def _flower(state, paths, total, complete):
    targets = [_flower_target(key, target, paths.get(('target', key), _Path()), complete) for key, target in state['targets'].items()]
    durations = [item['metrics']['time_to_touch_ms']['value'] for item in targets if item['touch_timestamp_ms'] is not None]
    count, touched = len(targets), len(durations)
    known = state['start'] is not None
    def count_metric(name, value):
        return _metric(name, value if known else None, 'count', state['event_count'], partial=not complete)
    score = state['terminal'].get('score')
    trial = dict(spawned_target_count=count_metric('spawned_target_count', count),
        completed_target_count=count_metric('completed_target_count', touched),
        score=_metric('score', score if _number(score) else None, 'count', touched,
            partial=not complete or score != touched, reason='terminal_game_score_unavailable'),
        completion_rate=_metric('completion_rate', touched / count if count else None, 'ratio', count,
            partial=not complete, reason='no_spawned_targets'),
        mean_time_to_touch_ms=_metric('mean_time_to_touch_ms', sum(durations) / touched if touched else None, 'ms', touched,
            partial=not complete, reason='no_touched_targets'), total_path_length=total.metric('total_path_length', 'px'))
    gameplay = state['terminal'].get('gameplay_elapsed_ms')
    trial['gameplay_duration_ms'] = _metric('gameplay_duration_ms', gameplay if _number(gameplay) else None, 'ms',
        state['event_count'], reason='gameplay_clock_unavailable')
    return trial, targets


def _stroke(key, stroke, path):
    completion, ended = stroke['completion'], stroke['end'] is not None
    expected = completion.get('point_count')
    if _number(expected) and expected != path.count:
        path = replace(path, broken=True)
    duration = path.last_ms - path.first_ms if path.first_ms is not None and path.last_ms is not None else None
    interrupted = completion.get('interrupted') if ended and isinstance(completion.get('interrupted'), bool) else None
    reason = completion.get('reason') if interrupted else 'none' if interrupted is False else None
    metrics = dict(stroke_duration_ms=_metric('stroke_duration_ms', duration, 'ms', path.count, partial=path.broken or not ended),
        stroke_point_count=_metric('stroke_point_count', path.count if path.count else None, 'count', path.count,
            partial=path.broken or not ended, reason='accepted_samples_unavailable'),
        stroke_length=path.metric('stroke_length', 'logical_canvas_px'),
        stroke_mean_speed=path.metric('stroke_mean_speed', 'logical_canvas_px/s', speed=True),
        stroke_smoothness=_metric('stroke_smoothness', None, 'dimensionless', path.count, reason='smoothness_algorithm_not_implemented'),
        stroke_interrupted=_metric('stroke_interrupted', interrupted, 'boolean', 1, reason='stroke_completion_unavailable'),
        interruption_reason=_metric('interruption_reason', reason, 'category', 1, reason='stroke_completion_unavailable'))
    return dict(stroke_id=key, started_timestamp_ms=stroke['start'], ended_timestamp_ms=stroke['end'], metrics=metrics)


def _drag(key, drag, path):
    ended = drag['end'] is not None
    interrupted = drag['completion'].get('interrupted') if ended else None
    reason = drag['completion'].get('reason') if interrupted else 'none' if ended else None
    duration = drag['end'] - drag['start'] if ended else None
    return dict(drag_id=key, stroke_id=drag['snapshot'].get('stroke_id'), metrics=dict(
        drag_duration_ms=_metric('drag_duration_ms', duration, 'ms', path.count, reason='drag_completion_unavailable'),
        drag_distance=path.metric('drag_distance', 'logical_canvas_px'),
        drag_completed=_metric('drag_completed', not interrupted if ended else None, 'boolean', 1, reason='drag_completion_unavailable'),
        drag_interrupted=_metric('drag_interrupted', interrupted, 'boolean', 1, reason='drag_completion_unavailable'),
        drag_interruption_reason=_metric('drag_interruption_reason', reason, 'category', 1, reason='drag_completion_unavailable')))


def _drawing(state, paths, complete):
    strokes = [_stroke(key, item, paths.get(('stroke', key), _Path())) for key, item in state['strokes'].items()]
    drags = [_drag(key, item, paths.get(('drag', key), _Path())) for key, item in state['drags'].items()]
    completed = [item for item in state['strokes'].values() if item['end'] is not None]
    stroke_paths = [paths.get(('stroke', key), _Path()) for key in state['strokes']]
    lengths = [path.length for path in stroke_paths if path.pairs]
    duration_values = [item['metrics']['stroke_duration_ms']['value'] for item in strokes
        if item['ended_timestamp_ms'] is not None and item['metrics']['stroke_duration_ms']['value'] is not None]
    known = state['start'] is not None
    counts = dict(completed_stroke_count=len(completed), drag_attempt_count=len(drags),
        drag_completed_count=sum(item['completion'].get('interrupted') is False for item in state['drags'].values()),
        drag_interrupted_count=sum(item['completion'].get('interrupted') is True for item in state['drags'].values()),
        undo_count=state['undo'], clear_count=state['clear'],
        tracking_interrupted_stroke_count=sum(item['completion'].get('reason') == 'tracking_lost' and item['completion'].get('interrupted') is True for item in completed))
    trial = {name: _metric(name, count if known else None, 'count', state['event_count'], partial=not complete) for name, count in counts.items()}
    missing_points = any(_number(item['completion'].get('point_count')) and item['completion']['point_count'] != path.count
        for item, path in zip(state['strokes'].values(), stroke_paths))
    partial = any(path.broken for path in stroke_paths) or len(lengths) != len(stroke_paths) or missing_points or not complete
    trial.update(total_stroke_length=_metric('total_stroke_length', sum(lengths) if lengths else None,
        'logical_canvas_px', sum(path.count for path in stroke_paths), partial=partial, reason='insufficient_contiguous_samples'),
        active_drawing_duration_ms=_metric('active_drawing_duration_ms', sum(path.elapsed_ms for path in stroke_paths)
            if any(path.pairs for path in stroke_paths) else None, 'ms', sum(path.count for path in stroke_paths), partial=partial,
            reason='insufficient_contiguous_samples'),
        mean_stroke_duration_ms=_metric('mean_stroke_duration_ms', sum(duration_values) / len(duration_values)
            if duration_values else None, 'ms', len(duration_values), partial=partial, reason='no_measured_completed_strokes'))
    return trial, strokes, drags


def compute_game_metrics(events, samples, *, game_key, capture_id, trial_id):
    """Consume each iterable once; preserve deleted artwork through its event history."""
    if game_key not in {'glowing_flower', 'free_drawing'}:
        raise ValueError('Unsupported research game')
    state = _event_state(events, capture_id, trial_id, game_key)
    paths, total = _paths(samples, state, capture_id, trial_id, game_key)
    complete = state['start'] is not None and state['end'] is not None
    wall, coverage = _coverage(state)
    targets, strokes, drags = [], [], []
    if game_key == 'glowing_flower':
        trial, targets = _flower(state, paths, total, complete)
    else:
        trial, strokes, drags = _drawing(state, paths, complete)
    trial.update(tracking_coverage=coverage,
        tracking_loss_count=_metric('tracking_loss_count', state['losses'] if state['start'] is not None else None,
            'count', state['event_count'], partial=not complete),
        wall_clock_duration_ms=_metric('wall_clock_duration_ms', wall, 'ms', state['event_count'], reason='missing_game_interval'))
    return dict(metric_schema_version=1, algorithm_version=ALGORITHM_VERSION,
        capture_id=str(capture_id), trial_id=trial_id, game_key=game_key,
        source_artifacts=['events.parquet', 'interaction_samples.parquet'],
        parameters=dict(max_gap_ms=MAX_GAP_MS, path_method='sum_contiguous_euclidean_segments',
            display_normalized_to_pixels=True, stroke_duration='last_source_sample_minus_first_source_sample',
            mean_speed='contiguous_path_length_over_contiguous_sample_duration',
            completion_rate='touched_targets_over_all_spawned_targets',
            tracking_coverage='usable_unpaused_processing_time_over_game_wall_clock'),
        trial=trial, targets=targets, strokes=strokes, drags=drags)

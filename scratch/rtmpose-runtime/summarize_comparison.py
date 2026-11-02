"""Read saved raw observations; no inference/video decoding or clinical scoring.

Usage: python summarize_comparison.py RUN_DIRECTORY [RUN_DIRECTORY ...]
Prints JSON. Redirect into an ignored supplemental artifact if desired.
"""
import json
import math
import statistics
import sys
from pathlib import Path


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {'count': 0, 'mean': None, 'p50': None, 'p95': None}
    def percentile(fraction):
        return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]
    return {'count': len(ordered), 'mean': statistics.mean(ordered),
            'p50': percentile(.5), 'p95': percentile(.95)}


def valid_point(point):
    if not isinstance(point, dict) or point.get('valid') is False:
        return False
    if not all(isinstance(point.get(axis), (int, float))
               and math.isfinite(point[axis]) and 0 <= point[axis] <= 1
               for axis in ('x', 'y')):
        return False
    if point.get('source') == 'rtmpose':
        score = point.get('confidence')
        return point.get('valid') is True and isinstance(score, (int, float)) and math.isfinite(score)
    return True


def side_points(row, side):
    hands, categories = row.get('raw_hand_landmarks') or [], row.get('handedness') or []
    for points, labels in zip(hands, categories):
        if labels and labels[0].get('categoryName') == side:
            if len(points) == 21 and all(valid_point(point) for point in points):
                return points
    return None


def summarize(folder):
    rows = [json.loads(line) for line in (folder / 'landmarks.jsonl').open(encoding='utf-8') if line.strip()]
    rows = [row for row in rows if 'frame_id' in row and row.get('raw_hand_landmarks') is not None]
    summary = json.loads((folder / 'summary.json').read_text(encoding='utf-8'))
    sides = {}
    source_gaps = [current['source_timestamp_ms'] - previous['source_timestamp_ms']
                   for previous, current in zip(rows, rows[1:])]
    for side in ('Left', 'Right'):
        observations = [side_points(row, side) for row in rows]
        dropouts = recoveries = pairs = 0
        displacements, valid_pair_gaps = [], []
        for index, (previous, current) in enumerate(zip(observations, observations[1:])):
            dropouts += previous is not None and current is None
            recoveries += previous is None and current is not None
            if previous is None or current is None:
                continue
            pairs += 1
            gap = source_gaps[index]
            if 0 < gap <= 500:
                # Finger indices 1..20 only; raw 2D Euclidean displacement.
                displacements.extend(math.hypot(current[point]['x'] - previous[point]['x'],
                                                current[point]['y'] - previous[point]['y'])
                                     for point in range(1, 21))
                valid_pair_gaps.append(gap)
        denominator = max(0, len(observations) - 1)
        sides[side] = {
            'processed_observations': len(observations),
            'complete_21_point_observations': sum(points is not None for points in observations),
            'complete_to_missing_transitions': dropouts,
            'missing_to_complete_transitions': recoveries,
            'adjacent_processed_complete_pairs': pairs,
            'adjacent_processed_pair_denominator': denominator,
            'adjacent_processed_complete_pair_rate': pairs / denominator if denominator else None,
            'raw_finger_displacement_normalized_image_2d': distribution(displacements),
            'displacement_pair_source_gap_ms': distribution(valid_pair_gaps),
        }
    return {
        'run_id': folder.name, 'configuration': summary.get('configuration'),
        'artifact_status': summary.get('artifact_status'),
        'source_gap_between_processed_hand_observations_ms': distribution(source_gaps),
        'sides': sides,
        'definitions': {
            'complete': 'Exactly 21 raw canonical hand points, finite/in-image; explicit invalid is rejected. RTMPose also requires valid=True and finite confidence. Engine thresholds differ.',
            'dropout': 'Observed complete-to-missing transition between processed observations, not every source frame and not a diagnosed tracking failure cause.',
            'pair_rate': 'Adjacent processed observations with this side complete at both ends / all adjacent processed hand-observation pairs.',
            'displacement': 'Euclidean per-finger-landmark step, indices1..20, normalized image coordinates, only adjacent complete pairs with source gap in (0,500]ms; includes real motion, camera effects, and estimation error. Not accuracy, ground-truth jitter, or clinical validity.',
            'source_gap': 'Source media timestamp differences between processed observations. Different frame selection prevents an exactly matched per-frame accuracy comparison.',
        },
    }


if __name__ == '__main__':
    print(json.dumps([summarize(Path(argument)) for argument in sys.argv[1:]], ensure_ascii=False, indent=2, allow_nan=False))

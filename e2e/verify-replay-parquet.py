"""Verify downloaded replay artifacts in memory; never print landmark data."""
import base64
import json
import math
import sys
from collections import Counter, defaultdict

import pyarrow as pa
import pyarrow.parquet as pq

FRAME_TYPES = {
    'capture_id': 'string', 'patient_id': 'int64', 'session_id': 'int64', 'trial_id': 'int64',
    'frame_id': 'int64', 'source_frame_id': 'int64', 'timestamp_ms': 'double',
    'video_media_time_ms': 'double', 'utc_time': 'string', 'inference_performed': 'bool',
    'pose_detected': 'bool', 'hand_detected': 'bool', 'inference_ms': 'double', 'skipped_frames': 'int64',
}
LANDMARK_TYPES = {
    'capture_id': 'string', 'patient_id': 'int64', 'session_id': 'int64', 'trial_id': 'int64',
    'frame_id': 'int64', 'timestamp_ms': 'double', 'video_media_time_ms': 'double',
    'landmark_source': 'string', 'landmark_index': 'int64', 'landmark_name': 'string',
    'x': 'double', 'y': 'double', 'z': 'double', 'coordinate_space': 'string',
    'is_valid': 'bool', 'invalid_reason': 'string', 'visibility': 'double', 'presence': 'double',
    'handedness': 'string', 'representation': 'string',
}


def read_table(encoded, expected):
    table = pq.read_table(pa.BufferReader(base64.b64decode(encoded, validate=True)))
    actual = {field.name: str(field.type) for field in table.schema}
    assert list(actual) == list(expected) and actual == expected, 'Parquet schema differs from the documented contract'
    return table.to_pylist()


def verify(input_data):
    meta = input_data['metadata']
    frames = read_table(input_data['frames'], FRAME_TYPES)
    landmarks = read_table(input_data['landmarks'], LANDMARK_TYPES)
    assert len(frames) == meta['artifact_summary']['frame_count'] > 0, 'Frame count mismatch'
    assert len(landmarks) == meta['artifact_summary']['landmark_count'] > 0, 'Landmark count mismatch'
    identity = {key: meta[key] for key in ('patient_id', 'session_id', 'trial_id')}
    identity['capture_id'] = meta['id']
    by_frame = {}
    previous_id, previous_timestamp, previous_media = -1, -1.0, -1.0
    for frame in frames:
        assert all(frame[key] == value for key, value in identity.items()), 'Frame identity mismatch'
        assert frame['frame_id'] > previous_id, 'Frame IDs are not strictly increasing'
        timestamp, media = frame['timestamp_ms'], frame['video_media_time_ms']
        assert timestamp is not None and math.isfinite(timestamp) and timestamp >= previous_timestamp, 'Invalid frame timestamp'
        assert media is not None and math.isfinite(media) and media >= previous_media, 'Invalid source media timestamp'
        assert frame['utc_time'], 'Frame UTC timestamp is missing'
        assert frame['skipped_frames'] is not None and frame['skipped_frames'] >= 0, 'Invalid skipped frame count'
        if not frame['inference_performed']:
            assert frame['pose_detected'] is None and frame['hand_detected'] is None and frame['inference_ms'] is None, 'Unprocessed frame has detection results'
        by_frame[frame['frame_id']] = frame
        previous_id, previous_timestamp, previous_media = frame['frame_id'], timestamp, media
    assert sum(frame['inference_performed'] for frame in frames) == meta['artifact_summary']['inferred_count'], 'Inference count mismatch'
    assert any(frame['pose_detected'] is True for frame in frames), 'Pose did not detect on this test video'
    assert any(frame['hand_detected'] is True for frame in frames), 'Hand did not detect on this test video'

    sources, spaces, representations = Counter(), Counter(), Counter()
    hands = defaultdict(set)
    combinations = Counter()
    raw_pose = {}
    displays = []
    for point in landmarks:
        assert all(point[key] == value for key, value in identity.items()), 'Landmark identity mismatch'
        frame = by_frame.get(point['frame_id'])
        assert frame and frame['inference_performed'], 'Landmark has no inferred source frame'
        assert point['timestamp_ms'] == frame['timestamp_ms'] and point['video_media_time_ms'] == frame['video_media_time_ms'], 'Landmark timestamp differs from source frame'
        assert point['landmark_source'] in ('pose', 'hand') and point['coordinate_space'] in ('normalized_image', 'world'), 'Unknown landmark type'
        assert point['representation'] in ('raw', 'display') and point['landmark_name'], 'Unknown landmark representation'
        assert point['landmark_index'] >= 0, 'Invalid landmark index'
        if point['is_valid']:
            assert all(point[key] is not None and math.isfinite(point[key]) for key in ('x', 'y', 'z')), 'Valid landmark is missing coordinates'
        else:
            assert point['invalid_reason'], 'Invalid landmark has no reason'
        sources[point['landmark_source']] += 1
        spaces[point['coordinate_space']] += 1
        representations[point['representation']] += 1
        combinations[(point['landmark_source'], point['coordinate_space'], point['representation'])] += 1
        if point['landmark_source'] == 'pose' and point['coordinate_space'] == 'normalized_image':
            if point['representation'] == 'raw':
                raw_pose[(point['frame_id'], point['landmark_index'])] = point
            else:
                displays.append(point)
        if point['landmark_source'] == 'hand' and point['coordinate_space'] == 'normalized_image' and point['representation'] == 'raw':
            hands[(point['frame_id'], point['handedness'])].add(point['landmark_index'])
    assert all(combinations[(source, space, 'raw')] for source in ('pose', 'hand') for space in ('normalized_image', 'world')), 'Pose or Hand raw coordinate data missing'
    assert spaces['normalized_image'] and spaces['world'], 'Coordinate space missing'
    assert representations['raw'] and representations['display'], 'Raw or display landmark data missing'
    assert all((point['frame_id'], point['landmark_index']) in raw_pose for point in displays), 'Display landmark has no raw landmark for the same frame'
    assert any(any(point[key] != raw_pose[(point['frame_id'], point['landmark_index'])][key] for key in ('x', 'y', 'z')) for point in displays), 'No smoothed Pose differs from raw on this test video'
    assert any(set(range(21)).issubset(indexes) for indexes in hands.values()), 'No complete 21-point hand in test data'
    assert sum(not point['is_valid'] for point in landmarks) == meta['artifact_summary']['invalid_count'], 'Invalid landmark count mismatch'
    return {'frames': len(frames), 'landmarks': len(landmarks), 'inferred': meta['artifact_summary']['inferred_count'], 'sources': dict(sources)}


try:
    print(json.dumps(verify(json.load(sys.stdin))))
except Exception as exc:
    print(f'Parquet verification failed: {exc}', file=sys.stderr)
    sys.exit(1)

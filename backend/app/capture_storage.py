"""Private, bounded-memory staging and Parquet conversion for capture runs."""
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq

MAX_BATCH_BYTES = 5 * 1024 * 1024
MAX_CHUNK_BYTES = 16 * 1024 * 1024
FRAME_SCHEMA = pa.schema([
    ('capture_id', pa.string()), ('patient_id', pa.int64()), ('session_id', pa.int64()), ('trial_id', pa.int64()),
    ('frame_id', pa.int64()), ('source_frame_id', pa.int64()), ('timestamp_ms', pa.float64()),
    ('video_media_time_ms', pa.float64()), ('utc_time', pa.string()), ('inference_performed', pa.bool_()),
    ('pose_detected', pa.bool_()), ('hand_detected', pa.bool_()), ('inference_ms', pa.float64()), ('skipped_frames', pa.int64()),
])
LANDMARK_SCHEMA = pa.schema([
    ('capture_id', pa.string()), ('patient_id', pa.int64()), ('session_id', pa.int64()), ('trial_id', pa.int64()),
    ('frame_id', pa.int64()), ('timestamp_ms', pa.float64()), ('video_media_time_ms', pa.float64()),
    ('landmark_source', pa.string()), ('landmark_index', pa.int64()), ('landmark_name', pa.string()),
    ('x', pa.float64()), ('y', pa.float64()), ('z', pa.float64()), ('coordinate_space', pa.string()),
    ('is_valid', pa.bool_()), ('invalid_reason', pa.string()), ('visibility', pa.float64()), ('presence', pa.float64()),
    ('handedness', pa.string()), ('representation', pa.string()),
])

def root_path():
    value = os.getenv('REHAB_DATA_DIR')
    if not value:
        raise RuntimeError('REHAB_DATA_DIR must be configured for private capture storage')
    return Path(value).resolve()

def capture_path(capture_id):
    from uuid import UUID
    return root_path() / str(UUID(str(capture_id)))

def enough_space(path, incoming):
    path.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(path).free < incoming + 100 * 1024 * 1024:
        raise OSError('Insufficient free disk space')

def put_idempotent(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Publish only fully fsynced data. Hard linking fails rather than overwriting an existing index.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.upload-', delete=False) as target:
            temporary = Path(target.name)
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        try:
            os.link(temporary, path)
            return True
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError('Index already contains different data')
            return False
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def convert_landmarks(folder, paths, capture_id, patient_id, session_id, trial_id):
    base = dict(capture_id=str(capture_id), patient_id=patient_id, session_id=session_id, trial_id=trial_id)
    frame_count = landmark_count = valid_count = inferred_count = skipped_count = 0
    last_id, last_time = -1, -1.0
    frame_file, landmark_file = folder / 'frames.parquet.tmp', folder / 'landmarks.parquet.tmp'
    with pq.ParquetWriter(frame_file, FRAME_SCHEMA) as frame_writer, pq.ParquetWriter(landmark_file, LANDMARK_SCHEMA) as landmark_writer:
        for path in paths:
            payload = json.loads(path.read_text(encoding='utf-8'))
            frames, landmarks = [], []
            for frame in payload['frames']:
                if frame['frame_id'] <= last_id or frame['timestamp_ms'] < last_time:
                    raise ValueError('Frame IDs and timestamps must be monotonic across batches')
                last_id, last_time = frame['frame_id'], frame['timestamp_ms']
                frame_count += 1
                inferred_count += int(frame['inference_performed'])
                skipped_count += frame.get('skipped_frames', 0)
                frames.append({**base, **{k: v for k, v in frame.items() if k != 'landmarks'}})
                for point in frame['landmarks']:
                    landmark_count += 1
                    valid_count += int(point['is_valid'])
                    landmarks.append({**base, 'frame_id': frame['frame_id'], 'timestamp_ms': frame['timestamp_ms'], 'video_media_time_ms': frame.get('video_media_time_ms'), **point})
            frame_writer.write_table(pa.Table.from_pylist(frames, schema=FRAME_SCHEMA))
            if landmarks:
                landmark_writer.write_table(pa.Table.from_pylist(landmarks, schema=LANDMARK_SCHEMA))
    if pq.read_metadata(frame_file).num_rows != frame_count or pq.read_metadata(landmark_file).num_rows != landmark_count:
        raise ValueError('Parquet row-count verification failed')
    os.replace(frame_file, folder / 'frames.parquet')
    os.replace(landmark_file, folder / 'landmarks.parquet')
    frame_file, landmark_file = folder / 'frames.parquet', folder / 'landmarks.parquet'
    return dict(frame_count=frame_count, inferred_count=inferred_count, skipped_count=skipped_count,
                landmark_count=landmark_count, valid_count=valid_count, invalid_count=landmark_count-valid_count,
                frames_sha256=sha256_file(frame_file), landmarks_sha256=sha256_file(landmark_file))

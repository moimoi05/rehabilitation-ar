"""Versioned private artifact manifest; encoded-video PTS alignment is unmeasured."""
import json
import os

from .capture_storage import sha256_file


def write_manifest(folder, capture, summary, status, error=None):
    artifacts = []
    config = getattr(capture, 'model_config_info', None) or {}
    mime = getattr(capture, 'video_mime_type', None)
    extension = {'video/webm': 'webm', 'video/mp4': 'mp4', 'video/ogg': 'ogv'}.get((mime or '').split(';')[0], 'unavailable')
    for kind, name, requested in (
        ('frames', 'frames.parquet', capture.record_landmarks),
        ('landmarks', 'landmarks.parquet', capture.record_landmarks),
        ('video', summary.get('video_file') or f'video.{extension}' if capture.record_video else None, capture.record_video),
        ('tracking_video', summary.get('tracking_video_file') or f'tracking_video.{extension}' if config.get('record_tracking_video') else None, config.get('record_tracking_video', False)),
    ):
        path = folder / name if name else None
        artifact_status = summary.get(f'{kind}_status')
        present = artifact_status in ('complete', 'incomplete') and path is not None and path.is_file()
        artifacts.append(dict(kind=kind, name=name, required=requested,
            mime_type=mime if kind in ('video', 'tracking_video') else 'application/vnd.apache.parquet',
            status=artifact_status if present else summary.get(f'{kind}_status', 'missing' if requested else 'not_requested'),
            size_bytes=path.stat().st_size if present else None,
            sha256=sha256_file(path) if present else None,
            record_count=summary.get('frame_count' if kind == 'frames' else 'landmark_count') if kind in ('frames', 'landmarks') else None,
            **({'rendering': 'realtime_tracking_overlay'} if kind == 'tracking_video' else {})))
    manifest = dict(capture_id=capture.id, patient_id=capture.patient_id,
        session_id=capture.session_id, trial_id=capture.trial_id,
        capture_schema_version=getattr(capture, 'capture_schema_version', 1),
        capture_mode=getattr(capture, 'capture_mode', 'manual'), source_type=capture.source_type,
        status=status, error=error, started_at_utc=capture.started_at_utc.isoformat(),
        ended_at_utc=capture.ended_at_utc.isoformat() if getattr(capture, 'ended_at_utc', None) else None,
        start_performance_ms=getattr(capture, 'start_performance_ms', None),
        duration_ms=getattr(capture, 'duration_ms', None),
        game_started_at_ms=summary.get('game_started_at_ms'), game_ended_at_ms=summary.get('game_ended_at_ms'),
        termination_reason=summary.get('termination_reason'), known_data_gaps=summary.get('known_data_gaps', []),
        model_status_counts=summary.get('model_status_counts', {}),
        missing_result_summary=summary.get('missing_result_summary', {}),
        width=getattr(capture, 'width', None), height=getattr(capture, 'height', None),
        video_mime_type=getattr(capture, 'video_mime_type', None),
        consent=dict(video=getattr(capture, 'consent_video', None), landmarks=getattr(capture, 'consent_landmarks', None)),
        configuration=config, artifacts=artifacts,
        synchronization=dict(method='main_thread_source_observation_monotonic_minus_capture_t0',
            recorder_start=config.get('recorder_start'), tracking_recorder_start=config.get('tracking_recorder_start'), encoded_pts_mapping='unavailable',
            accuracy='approximate_unmeasured',
            limitations=['Source media time is not encoded MediaRecorder PTS.',
                'Observation IDs do not imply one-to-one encoded video frames.',
                'Recorder start event does not measure encoder buffering offset.',
                'Tracking video is rendered in real time and is not guaranteed to align frame-for-frame with source video or landmarks.']),
        validity_policy='finite xyz and normalized-image bounds only; visibility/presence retained without a validity threshold; not clinical accuracy',
        hand_identity_policy='hand_observation_index is local to one observation, not a stable tracking identity',
        manifest_self_integrity='manifest checksum is stored in PostgreSQL artifact_summary, not self-referential')
    temporary = folder / 'manifest.json.tmp'
    with temporary.open('w', encoding='utf-8') as target:
        json.dump(manifest, target, ensure_ascii=False, indent=2, allow_nan=False)
        target.flush()
        os.fsync(target.fileno())
    temporary.replace(folder / 'manifest.json')
    return dict(manifest_status='complete', manifest_file='manifest.json',
                manifest_size_bytes=(folder / 'manifest.json').stat().st_size,
                manifest_sha256=sha256_file(folder / 'manifest.json'))

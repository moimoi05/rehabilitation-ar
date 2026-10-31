"""Read-only, reproducible preservation snapshot for an additive migration.

Run before/after Alembic and compare counts/hashes, using the same legacy field
projection. No patient names, contact details or raw results are exported.
"""
import argparse
import hashlib
import json
from pathlib import Path

from sqlalchemy import inspect, text

from .db import get_engine

LEGACY_COLUMNS = {
    'patients': ['id', 'research_code', 'affected_side', 'dominant_hand', 'notes', 'created_at'],
    'sessions': ['id', 'patient_id', 'affected_side', 'session_type', 'status', 'started_at', 'ended_at', 'notes', 'created_at'],
    'calibrations': ['id', 'session_id', 'camera_label', 'camera_device_id', 'width', 'height',
        'mirrored', 'ghost_visible', 'opacity', 'x', 'y', 'scale', 'affected_side', 'confirmed', 'created_at'],
    'trials': ['id', 'session_id', 'exercise_code', 'notes', 'created_at'],
    'exercise_results': ['id', 'trial_id', 'result_json', 'round_id', 'created_at'],
    'clinical_assessments': ['id', 'patient_id', 'fma_ue_score', 'notes', 'created_at'],
    'landmark_records': ['id', 'trial_id', 'storage_reference', 'format', 'model_version', 'created_at'],
    'video_records': ['id', 'trial_id', 'storage_reference', 'consent_recorded', 'created_at'],
    'model_predictions': ['id', 'session_id', 'model_version', 'prediction_json', 'clinician_confirmed', 'created_at'],
}


def snapshot(connection):
    inspector = inspect(connection)
    quoted = connection.dialect.identifier_preparer.quote
    tables = set(inspector.get_table_names())
    report = {'tables': {}, 'foreign_key_violations': [], 'classification_review': []}
    for name, desired in LEGACY_COLUMNS.items():
        if name not in tables:
            continue
        existing = {column['name'] for column in inspector.get_columns(name)}
        columns = [column for column in desired if column in existing]
        projection = ', '.join(quoted(column) for column in columns)
        rows = connection.execute(text(f'SELECT {projection} FROM {quoted(name)} ORDER BY id')).mappings()
        digest, count = hashlib.sha256(), 0
        for row in rows:
            digest.update(json.dumps(dict(row), sort_keys=True, default=str, ensure_ascii=False).encode('utf-8'))
            digest.update(b'\n')
            count += 1
        report['tables'][name] = {'count': count, 'legacy_sha256': digest.hexdigest()}
    for name in tables:
        for fk in inspector.get_foreign_keys(name):
            conditions = ' AND '.join(f'c.{quoted(local)} = p.{quoted(remote)}' for local, remote in
                zip(fk['constrained_columns'], fk['referred_columns']))
            not_null = ' AND '.join(f'c.{quoted(column)} IS NOT NULL' for column in fk['constrained_columns'])
            missing = f"p.{quoted(fk['referred_columns'][0])} IS NULL"
            count = connection.scalar(text(f'SELECT count(*) FROM {quoted(name)} c LEFT JOIN {quoted(fk["referred_table"])} p ON {conditions} WHERE {not_null} AND {missing}'))
            if count:
                report['foreign_key_violations'].append({'table': name, 'constraint': fk['name'], 'count': count})
    if 'patients' in tables and 'legacy_review_required' in {column['name'] for column in inspector.get_columns('patients')}:
        report['classification_review'] = [dict(row) for row in connection.execute(text(
            'SELECT id, research_code, patient_type FROM patients WHERE legacy_review_required ORDER BY id')).mappings()]
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--compare', type=Path)
    args = parser.parse_args()
    with get_engine().connect() as connection:
        report = snapshot(connection)
    if args.compare:
        before = json.loads(args.compare.read_text(encoding='utf-8'))
        report['preserved'] = before['tables'] == report['tables'] and not report['foreign_key_violations']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'tables': {key: value['count'] for key, value in report['tables'].items()},
        'foreign_key_violations': len(report['foreign_key_violations']), 'preserved': report.get('preserved')}))
    if report.get('preserved') is False or report['foreign_key_violations']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()

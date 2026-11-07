"""Parquet schemas for reading captured game events and interaction samples.

These definitions do not enable recording or change the capture API version.
"""
import pyarrow as pa


EVENT_SCHEMA = pa.schema([
    ('capture_id', pa.string()), ('patient_id', pa.int64()),
    ('session_id', pa.int64()), ('trial_id', pa.int64()),
    ('game_key', pa.string()), ('sequence', pa.int64()),
    ('timestamp_ms', pa.float64()), ('event_type', pa.string()),
    ('event_id', pa.string()), ('event_schema_version', pa.int64()),
    ('payload_json', pa.string()),
])

SAMPLE_SCHEMA = pa.schema([
    ('capture_id', pa.string()), ('patient_id', pa.int64()),
    ('session_id', pa.int64()), ('trial_id', pa.int64()),
    ('game_key', pa.string()), ('sequence', pa.int64()),
    ('timestamp_ms', pa.float64()), ('source_timestamp_ms', pa.float64()),
    ('source_observation_id', pa.int64()), ('sample_type', pa.string()),
    ('sample_id', pa.string()), ('sample_schema_version', pa.int64()),
    ('payload_json', pa.string()),
])

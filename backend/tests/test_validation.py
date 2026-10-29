import pytest
from pydantic import ValidationError
from app.schemas import PatientCreate, CalibrationCreate, SessionCreate


def test_patient_code_and_side_validation():
    assert PatientCreate(research_code='DEMO-001', affected_side='left', dominant_hand='right').research_code == 'DEMO-001'
    with pytest.raises(ValidationError):
        PatientCreate(research_code='  ', affected_side='left', dominant_hand='right')
    with pytest.raises(ValidationError):
        PatientCreate(research_code='A', affected_side='other', dominant_hand='right')


def test_calibration_coordinates_and_confirmation():
    data = dict(session_id=1, affected_side='left', x=.5, y=.5, scale=1, opacity=.5)
    assert CalibrationCreate(**data).confirmed is False
    with pytest.raises(ValidationError):
        CalibrationCreate(**{**data, 'x': 1.1})
    with pytest.raises(ValidationError):
        CalibrationCreate(**{**data, 'scale': 0})


def test_image_anchor_accepts_versioned_finite_image_coordinates_and_preserves_legacy():
    data = dict(session_id=1, affected_side='left')
    assert CalibrationCreate(**data).image_anchor is None
    anchor = {'version': 1, 'x': .2, 'y': .8, 'scale': 1.25}
    assert CalibrationCreate(**data, image_anchor=anchor).model_dump()['image_anchor'] == anchor
    bounds = {'version': 1, 'x': 0, 'y': 1, 'scale': 15}
    assert CalibrationCreate(**data, image_anchor=bounds).model_dump()['image_anchor'] == bounds
    assert CalibrationCreate(**data, image_anchor=None).image_anchor is None


@pytest.mark.parametrize('anchor', [
    {'version': 2, 'x': .2, 'y': .8, 'scale': 1.25},
    {'version': True, 'x': .2, 'y': .8, 'scale': 1.25},
    {'x': .2, 'y': .8, 'scale': 1.25},
    {'version': 1, 'x': -.1, 'y': .8, 'scale': 1.25},
    {'version': 1, 'x': .2, 'y': 1.1, 'scale': 1.25},
    {'version': 1, 'x': float('nan'), 'y': .8, 'scale': 1.25},
    {'version': 1, 'x': .2, 'y': float('inf'), 'scale': 1.25},
    {'version': 1, 'x': True, 'y': .8, 'scale': 1.25},
    {'version': 1, 'x': .2, 'y': .8, 'scale': float('inf')},
    {'version': 1, 'x': .2, 'y': .8, 'scale': 0},
    {'version': 1, 'x': .2, 'y': .8, 'scale': 15.01},
    {'version': 1, 'x': .2, 'y': .8, 'scale': 1.25, 'extra': True},
])
def test_image_anchor_rejects_invalid_values(anchor):
    with pytest.raises(ValidationError):
        CalibrationCreate(session_id=1, affected_side='left', image_anchor=anchor)


def test_session_invalid_kind():
    with pytest.raises(ValidationError):
        SessionCreate(patient_id=1, affected_side='right', session_type='diagnosis')
from app import db
from app import main


def test_only_postgres_is_accepted(monkeypatch):
    monkeypatch.setenv('DATABASE_URL', 'sqlite:///forbidden.db')
    db.get_engine.cache_clear()
    with pytest.raises(RuntimeError, match='PostgreSQL'):
        db.get_engine()
    db.get_engine.cache_clear()


def test_health_shows_database_failure(monkeypatch):
    def unavailable():
        raise RuntimeError('configuration missing')
    monkeypatch.setattr(main, 'get_engine', unavailable)
    assert main.health() == {'status': 'degraded', 'database': 'unavailable'}


def test_end_before_start_rejected():
    with pytest.raises(ValidationError):
        SessionCreate(patient_id=1, affected_side='left', session_type='assessment', started_at='2026-01-02T00:00:00Z', ended_at='2026-01-01T00:00:00Z')

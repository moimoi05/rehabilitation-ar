"""Read-only schema capability and legacy-calibration behavior."""
from contextlib import contextmanager
import os
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session as DBSession

from app import main
from app.db import get_db


class Inspector:
    def __init__(self, columns):
        self.columns = columns

    def has_table(self, name):
        return self.columns is not None and name == 'calibrations'

    def get_columns(self, _name):
        return [{'name': name} for name in self.columns]


class Engine:
    @contextmanager
    def connect(self):
        yield object()


def test_capabilities_reflect_the_database_schema(monkeypatch):
    monkeypatch.setattr(main, 'get_engine', lambda: Engine())
    monkeypatch.setattr(main, 'inspect', lambda _connection: Inspector(['id', 'image_anchor']))
    with TestClient(main.app) as client:
        assert client.get('/api/capabilities').json() == {'status': 'ok', 'imageAnchorV1': True}
        monkeypatch.setattr(main, 'inspect', lambda _connection: Inspector(['id']))
        assert client.get('/api/capabilities').json() == {'status': 'ok', 'imageAnchorV1': False}
        monkeypatch.setattr(main, 'inspect', lambda _connection: Inspector(None))
        assert client.get('/api/capabilities').json() == {'status': 'degraded', 'imageAnchorV1': False}


def test_capabilities_are_degraded_without_disclosing_database_errors(monkeypatch):
    def fail():
        raise SQLAlchemyError('sensitive connection detail')
    monkeypatch.setattr(main, 'get_engine', fail)
    with TestClient(main.app) as client:
        response = client.get('/api/capabilities')
    assert response.status_code == 200
    assert response.json() == {'status': 'degraded', 'imageAnchorV1': False}


def test_legacy_api_never_references_missing_column(monkeypatch):
    """The legacy list, detail and write use SQL without the optional column."""
    statements = []
    row = {'id': 5, 'session_id': 1, 'camera_label': None, 'camera_device_id': None,
           'width': None, 'height': None, 'mirrored': True, 'ghost_visible': True,
           'opacity': .45, 'x': .5, 'y': .5, 'scale': 1., 'affected_side': 'left',
           'confirmed': False, 'created_at': '2026-01-01T00:00:00Z'}

    class Result:
        def mappings(self): return self
        def all(self): return [row]
        def one(self): return row
        def one_or_none(self): return row

    class Session:
        def get(self, model, identity): return SimpleNamespace(id=identity)
        def connection(self): return object()
        def execute(self, stmt):
            statements.append(str(stmt.compile(compile_kwargs={'literal_binds': True})))
            return Result()
        def add(self, value): pass
        def commit(self): pass
        def rollback(self): pass

    monkeypatch.setattr(main, 'inspect', lambda _connection: Inspector(['id', 'session_id']))
    main.app.dependency_overrides[get_db] = lambda: Session()
    try:
        with TestClient(main.app) as client:
            assert client.get('/api/calibrations?session_id=1').json()[0]['image_anchor'] is None
            assert client.get('/api/calibrations/5').json()['image_anchor'] is None
            assert client.post('/api/calibrations', json={'session_id': 1, 'affected_side': 'left'}).status_code == 201
            assert client.post('/api/calibrations', json={'session_id': 1, 'affected_side': 'left', 'image_anchor': {'version': 1, 'x': .5, 'y': .5, 'scale': 1}}).status_code == 409
    finally:
        main.app.dependency_overrides.clear()
    assert len(statements) == 3
    assert all('image_anchor' not in statement.lower() for statement in statements)


def test_real_postgresql_schema_compatibility(monkeypatch):
    """Run against an explicitly supplied isolated test database at either revision."""
    url = os.getenv('TEST_DATABASE_URL')
    expected = os.getenv('TEST_EXPECT_ANCHOR')
    if not url or expected not in {'0', '1'}:
        pytest.skip('TEST_DATABASE_URL and TEST_EXPECT_ANCHOR required')
    if not url.startswith('postgresql+psycopg://'):
        pytest.fail('PostgreSQL required')
    engine = create_engine(url)
    connection = engine.connect()
    transaction = connection.begin()
    db = DBSession(bind=connection, join_transaction_mode='create_savepoint', expire_on_commit=False)
    monkeypatch.setattr(main, 'get_engine', lambda: engine)
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(main.app) as client:
            assert client.get('/api/capabilities').json() == {'status': 'ok', 'imageAnchorV1': expected == '1'}
            person = client.post('/api/patients', json={'research_code': 'TEST-' + uuid4().hex[:12], 'affected_side': 'left', 'dominant_hand': 'right'}).json()
            session = client.post('/api/sessions', json={'patient_id': person['id'], 'affected_side': 'left', 'session_type': 'assessment'}).json()
            base = {'session_id': session['id'], 'affected_side': 'left', 'x': .3, 'y': .7}
            created = client.post('/api/calibrations', json=base)
            assert created.status_code == 201
            assert created.json()['image_anchor'] is None
            assert client.get(f"/api/calibrations/{created.json()['id']}").json()['x'] == .3
            assert client.get('/api/calibrations', params={'session_id': session['id']}).json()[0]['y'] == .7
            anchored = client.post('/api/calibrations', json={**base, 'image_anchor': {'version': 1, 'x': .2, 'y': .8, 'scale': 1}})
            assert anchored.status_code == (201 if expected == '1' else 409)
            if expected == '1':
                assert anchored.json()['image_anchor']['x'] == .2
    finally:
        main.app.dependency_overrides.clear()
        db.close()
        transaction.rollback()
        connection.close()
        engine.dispose()

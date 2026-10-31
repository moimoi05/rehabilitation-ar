"""Browser origins must not be able to mutate a localhost research API by form POST."""
from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app, origins


def test_untrusted_origin_cannot_invoke_no_body_mutations():
    invoked = []
    def should_not_connect():
        invoked.append(True)
        raise AssertionError('A rejected origin must not reach the database')
    app.dependency_overrides[get_db] = should_not_connect
    try:
        with TestClient(app) as client:
            for path in ('/api/training-sessions/1/complete', '/api/assessments/1/start',
                         '/api/sessions/1/setup/invalidate', '/api/trials/1/cancel'):
                response = client.post(path, headers={'Origin': 'https://untrusted.example'},
                                       content=b'')
                assert response.status_code == 403
            assert invoked == []
    finally:
        app.dependency_overrides.clear()


def test_configured_browser_origin_and_non_browser_clients_remain_usable():
    app.dependency_overrides[get_db] = lambda: None
    try:
        with TestClient(app) as client:
            # Invalid JSON is rejected by schema after the origin gate, proving
            # normal browser and CLI requests can still reach the actual route.
            for headers in ({}, {'Origin': origins[0]}):
                assert client.post('/api/patients', json={}, headers=headers).status_code == 422
    finally:
        app.dependency_overrides.clear()

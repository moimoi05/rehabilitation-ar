"""Small filesystem-only checks; never connect to a patient database."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.benchmarks import router


def client_for(tmp_path, monkeypatch, host='127.0.0.1'):
    monkeypatch.setenv('REHAB_BENCHMARK_DIR', str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, base_url='http://127.0.0.1:8001', client=(host, 1234))


def test_local_gate(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch, '192.168.1.2')
    assert client.post('/api/benchmarks/runs', json={}).status_code == 403
    client = client_for(tmp_path, monkeypatch)
    assert client.post('/api/benchmarks/runs', json={}, headers={'Origin': 'https://evil.test'}).status_code == 403


def test_unique_append_and_finalize_failure(tmp_path, monkeypatch):
    client = client_for(tmp_path, monkeypatch)
    run = client.post('/api/benchmarks/runs', json={'configuration': {'delegate': 'GPU'}}).json()
    other = client.post('/api/benchmarks/runs', json={}).json()
    assert run['run_id'] != other['run_id']
    base = '/api/benchmarks/runs/' + run['run_id']
    assert client.put(base + '/artifacts/fps.csv?offset=0', content=b'timestamp_ms\n').status_code == 200
    assert client.put(base + '/artifacts/fps.csv?offset=0', content=b'overwrite').status_code == 409
    assert client.put(base + '/artifacts/evil.exe?offset=0', content=b'bad').status_code == 422
    final = client.post(base + '/finalize', json={'error': 'initialization failed'}).json()
    assert final['status'] == 'INCOMPLETE'
    assert (tmp_path / run['run_id'] / 'manifest.json').is_file()
    assert (tmp_path / run['run_id'] / 'fps.csv').read_bytes() == b'timestamp_ms\n'
    assert client.put(base + '/artifacts/fps.csv?offset=13', content=b'late').status_code == 409

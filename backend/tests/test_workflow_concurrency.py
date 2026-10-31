"""Real independent PostgreSQL transactions exercise transfer serialization."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

from app import models
from app.workflow_common import now
from app.workflow_patients import transfer_patient
from app.workflow_schemas import TransferCreate


def test_concurrent_transfers_create_exactly_one_admission():
    url = os.getenv('TEST_DATABASE_URL')
    if not url:
        pytest.skip('Explicit PostgreSQL test database required')
    if not url.startswith('postgresql+psycopg://'):
        pytest.fail('PostgreSQL required')
    engine = create_engine(url)
    # Isolate committed concurrent fixtures from the application's public schema.
    schema = 'test_transfer_' + uuid4().hex
    owned = engine.execution_options(schema_translate_map={None: schema})
    with engine.begin() as connection:
        connection.execute(CreateSchema(schema))
    try:
        models.Base.metadata.create_all(owned)
        with Session(owned) as db:
            person = models.Patient(research_code='CONCURRENT', affected_side='left', dominant_hand='right')
            db.add(person)
            db.flush()
            baseline = models.Session(patient_id=person.id, affected_side='left',
                session_type='assessment', status='completed', started_at=now(), ended_at=now())
            db.add(baseline)
            db.commit()
            patient_id, baseline_id = person.id, baseline.id
        barrier = Barrier(2)
        def attempt():
            with Session(owned, expire_on_commit=False) as db:
                # Both requests start with outpatient cached in their identity map.
                assert db.get(models.Patient, patient_id).patient_type == 'outpatient'
                barrier.wait(timeout=10)
                try:
                    transfer_patient(db, patient_id, TransferCreate(to_type='inpatient',
                        baseline_assessment_session_id=baseline_id))
                    return 200
                except HTTPException as failure:
                    db.rollback()
                    return failure.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: attempt(), range(2)))
        assert sorted(outcomes) == [200, 409]
        with Session(owned) as db:
            assert db.scalar(select(func.count()).select_from(models.Patient)) == 1
            assert db.scalar(select(func.count()).select_from(models.PatientTransfer)) == 1
            assert db.scalar(select(func.count()).select_from(models.AuditLog).where(models.AuditLog.action == 'transfer')) == 1
            saved = db.scalar(select(models.PatientTransfer))
            assert saved.baseline_assessment_session_id == baseline_id
            assert db.get(models.Session, baseline_id).status == 'completed'
    finally:
        # This exact schema was created above solely for this test. Public data,
        # the database itself and all pre-existing schemas remain untouched.
        with engine.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        engine.dispose()

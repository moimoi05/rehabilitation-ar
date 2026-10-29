"""Add pseudonymous demonstration records; safe to run repeatedly."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_engine
from .models import Patient, Session as RehabSession


def main():
    with Session(get_engine()) as db:
        for code, side, dominant in [('DEMO-001', 'left', 'right'), ('DEMO-002', 'right', 'right'), ('DEMO-003', 'left', 'left')]:
            existing = db.scalar(select(Patient).where(Patient.research_code == code))
            if existing is not None:
                continue
            patient = Patient(research_code=code, affected_side=side, dominant_hand=dominant, notes='Dữ liệu giả lập phục vụ kiểm thử.')
            db.add(patient)
            db.flush()
            now = datetime.now(timezone.utc)
            db.add(RehabSession(patient_id=patient.id, affected_side=side, session_type='assessment', status='completed', started_at=now - timedelta(minutes=20), ended_at=now, notes='Phiên giả lập, không phải dữ liệu lâm sàng.'))
        db.commit()
    print('Demo seed complete.')

if __name__ == '__main__':
    main()


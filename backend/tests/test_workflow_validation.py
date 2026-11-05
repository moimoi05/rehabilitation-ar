from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app import workflow_sessions
from app.questionnaires import validate_answer


@pytest.mark.parametrize('kind,value,options', [
    ('number', 10**400, []), ('number', True, []), ('number', float('inf'), []),
    ('date', '2026-02-30', []), ('date', '2026-1-1', []), ('boolean', 'false', []),
    ('single_choice', 'unknown', ['left', 'right']),
    ('multiple_choice', ['left', 'left'], ['left', 'right']),
    ('multiple_choice', [], ['left', 'right']), ('text', '   ', []),
])
def test_invalid_questionnaire_values_return_validation_error(kind, value, options):
    question = {'key': 'test', 'label': 'Câu hỏi thử', 'question_type': kind,
        'required': True, 'options': options}
    with pytest.raises(HTTPException) as failure:
        validate_answer(question, value)
    assert failure.value.status_code == 422


@pytest.mark.parametrize('active', [True, False, None])
def test_resume_preserves_active_capture_and_expires_only_interrupted_capture(monkeypatch, active):
    now = datetime.now(timezone.utc)
    session = SimpleNamespace(id=61, patient_id=7, session_type='training',
        managed_workflow=True, status='in_progress', setup_confirmed=True, setup_revision=4)
    capture = SimpleNamespace(status='recording', error_message=None,
        lease_expires_at=None if active is None else now + timedelta(seconds=30 if active else -30))
    db = MagicMock()
    db.scalars.return_value.all.return_value = [capture]
    db.scalar.return_value = now
    monkeypatch.setattr(workflow_sessions, 'locked_session', lambda *_: session)
    monkeypatch.setattr(workflow_sessions, 'require', lambda *_: SimpleNamespace(patient_type='inpatient'))
    monkeypatch.setattr(workflow_sessions, 'cancel_pending_trials', lambda db, identity: db.cancel_trials(identity))
    monkeypatch.setattr(workflow_sessions, 'audit', lambda *_args, **_kwargs: None)
    if active is not False:
        with pytest.raises(HTTPException) as failure:
            workflow_sessions.resume_training(61, db)
        assert failure.value.status_code == 409
        assert capture.status == 'recording' and session.setup_confirmed
        db.cancel_trials.assert_not_called()
        db.commit.assert_not_called()
    else:
        assert workflow_sessions.resume_training(61, db) is session
        assert capture.status == 'incomplete'
        assert session.setup_revision == 5 and not session.setup_confirmed
        db.cancel_trials.assert_called_once_with(61)
        db.commit.assert_called_once()

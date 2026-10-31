"""Downgrade must refuse to discard authored configuration, even before visits."""
import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from app import models
from app.db import get_db
from app.main import app
from test_api import client


def migration_module():
    path = Path(__file__).parents[1] / 'alembic/versions/b10f_hospital_workflows_hospital_workflows_additive_schema.py'
    spec = importlib.util.spec_from_file_location('workflow_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_downgrade_keeps_authored_questionnaires(client):
    response = client.post('/api/questionnaires', json={
        'code': 'CUSTOM-' + uuid4().hex[:8], 'name': 'Bộ câu hỏi do nhân viên cấu hình',
        'version': 1, 'active': True,
        'questions': [{'key': 'note', 'label': 'Thông tin bổ sung', 'group': 'Khám',
            'question_type': 'text', 'required': False, 'display_order': 0, 'options': []}]})
    assert response.status_code == 201, response.text
    module = migration_module()
    db = next(app.dependency_overrides[get_db]())
    with pytest.raises(RuntimeError, match='configuration'):
        module.ensure_configuration_can_downgrade(db.connection())
    assert client.get(f"/api/questionnaires/{response.json()['id']}").status_code == 200


@pytest.mark.parametrize('kind', ['exercise', 'question'])
def test_downgrade_keeps_authored_changes_to_seeded_content(client, kind):
    db = next(app.dependency_overrides[get_db]())
    if kind == 'exercise':
        entity = db.scalar(select(models.ExerciseCatalog).where(models.ExerciseCatalog.code == 'glowing_flower'))
        entity.instructions = 'Hướng dẫn đã được nhân viên biên soạn lại'
    else:
        entity = db.scalar(select(models.QuestionnaireQuestion).where(models.QuestionnaireQuestion.key == 'condition'))
        entity.label = 'Nội dung câu hỏi do nhân viên cập nhật'
    db.commit()
    with pytest.raises(RuntimeError, match='configuration'):
        migration_module().ensure_configuration_can_downgrade(db.connection())


def test_default_seed_configuration_allows_safe_downgrade(client):
    db = next(app.dependency_overrides[get_db]())
    migration_module().ensure_configuration_can_downgrade(db.connection())

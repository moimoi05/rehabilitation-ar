import pytest
from fastapi import HTTPException
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

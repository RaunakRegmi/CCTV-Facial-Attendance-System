from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from google.api_core.exceptions import AlreadyExists
from google.auth.credentials import AnonymousCredentials
from google.cloud.firestore_v1 import Client
from backend.app.repository import Repository, STUDENT_FIELDS


def snapshot(identifier, data):
    result = Mock()
    result.id = identifier
    result.exists = True
    result.to_dict.return_value = data
    return result


def test_student_projection_excludes_biometrics():
    db = Mock()
    query = db.collection.return_value
    query.select.return_value.limit.return_value.stream.return_value = [snapshot('s1', {'full_name': 'Student', 'photo_base64': 'secret'})]
    rows = Repository(db).students()
    query.select.assert_called_once_with(STUDENT_FIELDS)
    assert rows == [{'id': 's1', 'full_name': 'Student'}]


def test_mutation_and_audit_are_atomic():
    db = Mock()
    repo = Repository(db)
    repo.create('students', 's1', {'full_name': 'Student'}, 'admin')
    batch = db.batch.return_value
    assert batch.create.call_count == 2
    audit = batch.create.call_args_list[1].args[1]
    assert audit['actor_uid'] == 'admin'
    assert audit['resource'] == 'students/s1'
    assert 'full_name' not in audit
    batch.commit.assert_called_once()
    batch.commit.side_effect = AlreadyExists('existing')
    with pytest.raises(HTTPException) as error:
        repo.create('students', 's1', {}, 'admin')
    assert error.value.status_code == 409


def test_cursor_uses_firestore_document_reference(monkeypatch):
    # Build a real SDK query without contacting Google: catches invalid cursor API usage.
    db = Client(project='test', credentials=AnonymousCredentials())
    from google.cloud.firestore_v1.query import Query
    captured = []
    def stream(query):
        captured.append(query._to_protobuf())
        return iter([])
    monkeypatch.setattr(Query, 'stream', stream)
    assert Repository(db).logs('CS-1', 'cursor123') == {'items': [], 'next_cursor': None}
    query = captured[0]
    assert query.limit == 501
    assert query.start_at.values[0].reference_value.endswith('/classes/CS-1/attendance_logs/cursor123')
    assert not query.start_at.before


def test_page_has_next_cursor_without_dropping_boundary():
    db = Mock()
    query = db.collection.return_value.document.return_value.collection.return_value.order_by.return_value
    query.limit.return_value.stream.return_value = [snapshot(str(i), {'status': 'Present'}) for i in range(501)]
    page = Repository(db).logs('CS-1')
    assert len(page['items']) == 500
    assert page['items'][-1]['id'] == page['next_cursor'] == '499'

import base64
from io import BytesIO
from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from backend.app.config import Settings
from backend.app.main import create_app
from backend.app import main, security

HEADERS = {'Origin': 'https://attendance.example', 'X-Requested-With': 'AttendanceDashboard'}


class Repo:
    def __init__(self):
        self.users = {'a': {'role': 'admin'}, 't': {'role': 'teacher', 'class_ids': ['CS-1']}}
        self.records = {}

    def profile(self, uid): return self.users.get(uid)
    def classes(self, user): return []
    def students(self, class_id): return []
    def logs(self, class_id, after): return {'items': [], 'next_cursor': None}
    def assert_classes(self, ids):
        if ids != ['CS-1']: raise HTTPException(422, 'Class missing')
    def create(self, collection, identifier, data, uid):
        if identifier in self.records: raise HTTPException(409, 'Already exists')
        self.records[identifier] = data
    def delete_student(self, identifier, uid): self.records.pop(identifier, None)


@pytest.fixture
def context(monkeypatch):
    repo = Repo()
    verify = Mock(side_effect=lambda cookie, **kw: {'uid': cookie})
    monkeypatch.setattr(security.auth, 'verify_session_cookie', verify)
    app = create_app(Settings('project', 'key', HEADERS['Origin']), repo)
    with TestClient(app, base_url='https://attendance.example') as client:
        yield client, repo, verify


def signed(client, uid='a'):
    client.cookies.set(security.COOKIE, uid, path='/api')
    return client


@pytest.mark.parametrize('path', ['/api/classes', '/api/students', '/api/classes/CS-1/logs', '/api/auth/me'])
def test_anonymous_denied(context, path):
    client, _, _ = context
    assert client.get(path).status_code == 401


def test_class_authorization_and_admin_boundary(context):
    client, _, verify = context
    signed(client, 't')
    assert client.get('/api/classes/CS-1/logs').status_code == 200
    assert client.get('/api/classes/CS-2/logs').status_code == 403
    assert client.get('/api/students?class_id=CS-1').status_code == 200
    assert client.get('/api/students').status_code == 403
    assert client.get('/api/students?class_id=CS-2').status_code == 403
    assert client.post('/api/classes', headers=HEADERS, json={'class_id': 'CS-2', 'class_name': 'Class'}).status_code == 403
    assert client.delete('/api/students/s1', headers=HEADERS).status_code == 403
    assert verify.call_args.kwargs['check_revoked'] is True


def test_disabled_and_revoked_sessions(context):
    client, repo, verify = context
    signed(client)
    repo.users['a']['disabled'] = True
    assert client.get('/api/classes').status_code == 403
    verify.side_effect = ValueError('bad cookie')
    assert client.get('/api/classes').status_code == 401


@pytest.mark.parametrize('headers', [{}, {'Origin': 'https://evil.example', 'X-Requested-With': 'AttendanceDashboard'}, {'Origin': HEADERS['Origin']}])
def test_csrf_including_login(context, headers):
    client, _, _ = context
    signed(client)
    assert client.post('/api/auth/login', headers=headers, json={'email': 'x@y.z', 'password': 'secret'}).status_code == 403
    assert client.delete('/api/students/s1', headers=headers).status_code == 403


def test_validated_creation_and_duplicates(context):
    client, repo, _ = context
    signed(client)
    body = {'class_id': 'CS-1', 'class_name': 'First class'}
    assert client.post('/api/classes', headers=HEADERS, json=body).status_code == 201
    assert repo.records['CS-1'] == {**body, 'room': None}
    assert client.post('/api/classes', headers=HEADERS, json=body).status_code == 409
    for invalid in [dict(body, class_id='../bad'), dict(body, admin=True), dict(body, class_name='   ')]:
        assert client.post('/api/classes', headers=HEADERS, json=invalid).status_code == 422


def test_input_not_echoed_and_payload_limit(context):
    client, _, _ = context
    signed(client)
    response = client.post('/api/students', headers=HEADERS, json={'photo_base64': 'PRIVATEBIOMETRIC'})
    assert response.status_code == 422
    assert 'PRIVATEBIOMETRIC' not in response.text
    response = client.post('/api/students', headers=HEADERS, content=b'x' * 950001)
    assert response.status_code == 413
    assert response.headers['cache-control'] == 'no-store'


def test_photo_validation_and_enrollment(context):
    client, _, _ = context
    signed(client)
    image = BytesIO()
    Image.new('RGB', (20, 20)).save(image, format='JPEG')
    body = {'student_id': 's1', 'full_name': 'Student', 'enrolled_classes': ['CS-1'], 'photo_base64': 'data:image/jpeg;base64,' + base64.b64encode(image.getvalue()).decode()}
    assert client.post('/api/students', headers=HEADERS, json=body).status_code == 201
    assert client.post('/api/students', headers=HEADERS, json=dict(body, photo_base64='data:image/jpeg;base64,bm90YW5pbWFnZQ==')).status_code == 422
    assert client.post('/api/students', headers=HEADERS, json=dict(body, enrolled_classes=['unknown'])).status_code == 422
    assert client.delete('/api/students/s1', headers=HEADERS).status_code == 204


def test_login_cookie_and_logout(context, monkeypatch):
    client, _, _ = context
    post = Mock(return_value=httpx.Response(200, json={'idToken': 'id-token'}))
    monkeypatch.setattr(main.httpx, 'post', post)
    monkeypatch.setattr(main.auth, 'verify_id_token', lambda *a, **kw: {'uid': 'a'})
    monkeypatch.setattr(main.auth, 'create_session_cookie', lambda *a, **kw: 'a')
    revoke = Mock()
    monkeypatch.setattr(main.auth, 'revoke_refresh_tokens', revoke)
    response = client.post('/api/auth/login', headers=HEADERS, json={'email': 'admin@example.com', 'password': ' password '})
    assert response.status_code == 200
    cookie = response.headers['set-cookie']
    for attribute in ['HttpOnly', 'Secure', 'SameSite=strict', 'Path=/api']:
        assert attribute in cookie
    assert 'id-token' not in response.text
    assert post.call_args.kwargs['json']['password'] == ' password '
    assert client.get('/api/auth/me').status_code == 200
    assert client.post('/api/auth/logout', headers=HEADERS).status_code == 200
    revoke.assert_called_once()
    assert client.get('/api/auth/me').status_code == 401


def test_login_throttling(context, monkeypatch):
    client, _, _ = context
    monkeypatch.setattr(main.httpx, 'post', lambda *a, **kw: httpx.Response(400))
    for _ in range(5):
        assert client.post('/api/auth/login', headers=HEADERS, json={'email': 'x@y.z', 'password': 'invalid'}).status_code == 401
    response = client.post('/api/auth/login', headers=HEADERS, json={'email': 'x@y.z', 'password': 'invalid'})
    assert response.status_code == 429
    assert response.headers['retry-after'] == '60'


def test_backend_failure_is_sanitized(context):
    client, repo, _ = context
    signed(client)
    repo.classes = Mock(side_effect=RuntimeError('private credentials'))
    response = client.get('/api/classes')
    assert response.status_code == 503
    assert 'private credentials' not in response.text
    assert response.headers['x-request-id']


def test_production_configuration(monkeypatch):
    for key in ['FIREBASE_PROJECT_ID', 'FIREBASE_WEB_API_KEY', 'APP_ORIGIN', 'APP_ENV']:
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError): Settings.from_env()
    monkeypatch.setenv('FIREBASE_PROJECT_ID', 'project')
    monkeypatch.setenv('FIREBASE_WEB_API_KEY', 'key')
    monkeypatch.setenv('APP_ORIGIN', 'http://example.com')
    with pytest.raises(RuntimeError): Settings.from_env()
    monkeypatch.setenv('APP_ENV', 'development')
    with pytest.raises(RuntimeError): Settings.from_env()
    monkeypatch.setenv('APP_ORIGIN', 'http://localhost:5173')
    assert not Settings.from_env().secure_cookies


def test_monolith_serves_ui_and_keeps_api_404(tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'index.html').write_text('<html>Attendly</html>')
    (tmp_path / 'assets' / 'app.js').write_text('export const version = 1;')
    app = create_app(Settings('project', 'key', HEADERS['Origin']), Repo(), frontend_dir=tmp_path)
    with TestClient(app, base_url=HEADERS['Origin']) as client:
        page = client.get('/')
        assert page.status_code == 200
        assert 'Attendly' in page.text
        assert "script-src 'self'" in page.headers['content-security-policy']
        assert client.get('/assets/app.js').status_code == 200
        assert client.get('/api/unknown').status_code == 404
        assert client.get('/api/unknown').headers['content-type'] == 'application/json'
        assert client.get('/assets/%2e%2e/index.html').status_code == 404
        assert client.get('/backend/.env').status_code == 404

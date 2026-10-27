"""Same-origin API: deploy /api behind the dashboard's HTTPS reverse proxy."""
import logging
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import timedelta
from threading import Lock

import firebase_admin
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from firebase_admin import auth, firestore
from firebase_admin.exceptions import FirebaseError

from .config import Settings
from .models import ClassCreate, Identifier, Login, StudentCreate
from .repository import Repository
from .security import COOKIE, admin, authorize_class, current_user
from .web import mount_dashboard

log = logging.getLogger('attendance.api')


class LoginLimiter:
    """Bounded per-process protection. Add shared edge limits for multiple workers."""
    def __init__(self):
        self.entries = OrderedDict()
        self.lock = Lock()

    def allow(self, key):
        with self.lock:
            now = time.monotonic()
            start, count = self.entries.get(key, (now, 0))
            if now - start >= 60:
                start, count = now, 0
            self.entries[key] = (start, count + 1)
            self.entries.move_to_end(key)
            if len(self.entries) > 10000:
                self.entries.popitem(last=False)
            return count < 5


def create_app(settings=None, repository=None, firebase=None, frontend_dir=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.settings = settings or Settings.from_env()
        owned = None
        if repository is None:
            owned = firebase_admin.initialize_app(options={'projectId': app.state.settings.project_id}, name=f'api-{uuid.uuid4()}')
            app.state.firebase = owned
            app.state.repo = Repository(firestore.client(app=owned))
        else:
            app.state.firebase = firebase
            app.state.repo = repository
        yield
        if owned:
            firebase_admin.delete_app(owned)

    app = FastAPI(title='Attendance API', version='1.0.0', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    limiter = LoginLimiter()

    @app.middleware('http')
    async def boundary(request, call_next):
        request_id = uuid.uuid4().hex
        settings = request.app.state.settings
        response = None
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            if request.headers.get('origin') != settings.origin or request.headers.get('x-requested-with') != 'AttendanceDashboard':
                response = JSONResponse({'detail': 'Invalid request origin'}, status_code=403)
        if response is None and request.method in ('POST', 'PUT', 'PATCH'):
            # Stream-count before parsing, including chunked requests.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 950000:
                    response = JSONResponse({'detail': 'Request too large'}, status_code=413)
                    break
            if response is None:
                request._body = bytes(body)
        try:
            if response is None:
                response = await call_next(request)
        except Exception:
            # Avoid logging exception payloads that may contain credentials or biometrics.
            log.error('request_failed request_id=%s', request_id)
            response = JSONResponse({'detail': 'Service unavailable'}, status_code=503)
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        response.headers.update({'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Request-ID': request_id})
        if settings.secure_cookies:
            response.headers['Strict-Transport-Security'] = 'max-age=31536000'
        log.info('request_id=%s method=%s status=%s', request_id, request.method, response.status_code)
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exc):
        # Pydantic errors can echo passwords and base64 photos. Never return input.
        return JSONResponse({'detail': 'Invalid request data', 'errors': [
            {'loc': e['loc'], 'type': e['type']} for e in exc.errors()
        ]}, status_code=422)

    @app.get('/api/health')
    def health():
        return {'status': 'ok'}

    @app.post('/api/auth/login')
    def login(body: Login, request: Request, response: Response):
        if not limiter.allow(request.client.host if request.client else 'unknown'):
            raise HTTPException(429, 'Too many attempts. Try again shortly.', headers={'Retry-After': '60'})
        settings = request.app.state.settings
        try:
            result = httpx.post('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
                params={'key': settings.api_key}, json={'email': body.email, 'password': body.password, 'returnSecureToken': True}, timeout=10)
            if result.status_code != 200:
                raise HTTPException(401, 'Unable to sign in')
            token = result.json()['idToken']
            claims = auth.verify_id_token(token, check_revoked=True, app=request.app.state.firebase)
            profile = request.app.state.repo.profile(claims['uid'])
            if not profile or profile.get('disabled') is True or profile.get('role') not in ('admin', 'teacher'):
                raise HTTPException(403, 'Account has not been granted access')
            session = auth.create_session_cookie(token, expires_in=timedelta(seconds=settings.session_seconds), app=request.app.state.firebase)
        except (httpx.HTTPError, FirebaseError, ValueError, KeyError) as exc:
            raise HTTPException(503, 'Sign-in service unavailable') from exc
        response.set_cookie(COOKIE, session, max_age=settings.session_seconds, httponly=True, secure=settings.secure_cookies, samesite='strict', path='/api')
        return {'uid': claims['uid'], 'role': profile['role']}

    @app.get('/api/auth/me')
    def me(user=Depends(current_user)):
        return user

    @app.post('/api/auth/logout')
    def logout(request: Request, response: Response, user=Depends(current_user)):
        auth.revoke_refresh_tokens(user['uid'], app=request.app.state.firebase)
        response.delete_cookie(COOKIE, path='/api', secure=request.app.state.settings.secure_cookies, httponly=True, samesite='strict')
        return {'status': 'signed_out'}

    @app.get('/api/classes')
    def classes(request: Request, user=Depends(current_user)):
        return request.app.state.repo.classes(user)

    @app.post('/api/classes', status_code=201)
    def add_class(body: ClassCreate, request: Request, user=Depends(admin)):
        request.app.state.repo.create('classes', body.class_id, body.model_dump(), user['uid'])
        return {'id': body.class_id}

    @app.get('/api/students')
    def students(request: Request, class_id: Identifier | None = None, user=Depends(current_user)):
        if class_id:
            authorize_class(user, class_id)
        elif user['role'] != 'admin':
            raise HTTPException(403, 'Select an authorized class')
        return request.app.state.repo.students(class_id)

    @app.post('/api/students', status_code=201)
    def add_student(body: StudentCreate, request: Request, user=Depends(admin)):
        request.app.state.repo.assert_classes(body.enrolled_classes)
        request.app.state.repo.create('students', body.student_id, body.model_dump(), user['uid'])
        return {'id': body.student_id}

    @app.delete('/api/students/{student_id}', status_code=204)
    def delete_student(student_id: Identifier, request: Request, user=Depends(admin)):
        request.app.state.repo.delete_student(student_id, user['uid'])
        return Response(status_code=204)

    @app.get('/api/classes/{class_id}/logs')
    def logs(class_id: Identifier, request: Request, after: Identifier | None = None, user=Depends(current_user)):
        authorize_class(user, class_id)
        return request.app.state.repo.logs(class_id, after)

    mount_dashboard(app, frontend_dir)
    return app


app = create_app()

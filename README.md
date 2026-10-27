# Attendly — CCTV attendance workspace

A modular monolith with a React teacher/admin interface, a FastAPI application, and Firebase-backed authentication and persistence. Browser data operations go through `/api`. The compiled UI and API run in the same production process and on the same origin.

## Project structure

```text
classroom-dashboard/              React application (the only frontend)
  src/
    App.jsx                      Authentication entry point
    features/
      attendance/                Live TeacherDashboard, analytics, data hook, chart
      admin/                     Classes and student enrollment
      auth/                      Login and session lifecycle
    shared/                      API client and theme
    index.css                    Shared responsive design system
  tests/                         Analytics and browser smoke checks
backend/
  app/                           FastAPI, authorization, persistence, static hosting
  tests/                         API security and repository tests
  dual_state_engine.py           Trusted camera/vision worker
  requirements-api.txt           Independent API dependencies
Dockerfile                       UI build + non-root API runtime
firestore.rules                  Deny browser access to Firestore
```

The former `frontend/src/TeacherDashboard.jsx` prototype has been consolidated into `classroom-dashboard/src/features/attendance/TeacherDashboard.jsx`. Its replacement uses live API data, with no mock production attendance. Demo fixtures exist only in tests.

## Development

Use Python 3.11+ and Node 22+. Create and activate an API virtual environment, install dependencies, and configure the environment before starting:

```sh
python -m venv .venv-api
. .venv-api/bin/activate
pip install -r backend/requirements-api.txt pytest
cp backend/.env.example backend/.env
```

Fill `backend/.env` with your Firebase project ID, Web API key, and an absolute `GOOGLE_APPLICATION_CREDENTIALS` path outside the repository. Never place service-account credentials in frontend variables. Load this trusted configuration into each API shell with `set -a`, `. backend/.env`, then `set +a`. Production should prefer workload identity / Application Default Credentials.

Enable Firebase Email/Password authentication and provision individual users. Create server-managed Firestore documents at `users/<Firebase Auth UID>` with `role: "admin"` or `role: "teacher"`, `disabled: false`, and `class_ids: ["CS-101"]` for teacher assignments. Missing profiles deny access. There is no public signup or automatic administrator creation. Password reset and account provisioning currently require the institution administrator.

Publish the supplied `firestore.rules` to deny browser database access. The Admin SDK bypasses these rules, so restrict backend IAM identities and profile-management access. Removing client SDK calls does not change existing remotely permissive rules.

```sh
npm --prefix classroom-dashboard ci
npm run dev:api
# In another terminal:
npm run dev
```

Open `http://localhost:5173`. Set APP_ORIGIN to the exact frontend origin. Vite proxies `/api` to localhost:8000.

## One-server production build

```sh
npm run build
npm start
```

FastAPI serves the compiled application at `/` and the API at `/api`. Set APP_ENV=production and APP_ORIGIN to the public HTTPS origin; terminate TLS at your trusted ingress. Rebuild the frontend before starting the server. Alternatively, build the root Dockerfile; it contains the web application and API, not the separate GPU vision runtime. Supply credentials at runtime, never in an image.

## Validation

```sh
npm run lint
npm run test:web
npm run test:api
npm run build
# Optional browser checks against the running development server:
python classroom-dashboard/tests/ui_smoke.py http://127.0.0.1:5173
```

Browser smoke checks require Python Playwright and Chromium. They intercept API requests with synthetic test data and do not contact Firebase. The API test suite uses fakes; live Firebase and camera integration remain a deployment gate.

## Release limitations

This foundation is not a claim of enterprise readiness. Deploy Firestore rules, provision accounts, and complete staging and operational checks before rollout. Live Firebase/camera integration and the Docker deployment have not been exercised.

The current camera worker remains trusted backend code with Admin SDK access. Scoped per-device ingestion, durable retries, MFA/SSO, biometric retention/deletion policies, backup/restore tests, and monitoring remain follow-up work. Multiple API replicas require shared edge rate limiting; the included login limiter is per process. Attendance polls paginated class history every 15 seconds, and class/student listings have a 1,000-record capacity limit. Tenant isolation is not implemented: this release is for a single institution.

In production, terminate HTTPS at a trusted ingress, apply body/time limits and shared rate limits, and never log passwords, session cookies, photos, or RTSP credentials. The API serves CSP and permission restrictions with the HTML; a separately hosted frontend must reproduce those headers. Logout revokes the user's Firebase sessions across devices.

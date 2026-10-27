# Attendly web application

The single React frontend for the attendance monolith. The live teacher dashboard is in `src/features/attendance/TeacherDashboard.jsx`, administration is in `src/features/admin`, and authentication is in `src/features/auth`. Shared API/theme modules and the responsive design system are under `src/shared` and `src/index.css`.

Run `npm ci`, then `npm run dev`; the API must run on localhost:8000. Production builds are served by FastAPI from this directory's `dist`. See the [root README](../README.md).

Checks: `npm run build`, `npm run lint`, `npm test`. Browser smoke checks: `python tests/ui_smoke.py http://127.0.0.1:5173` (requires Python Playwright with Chromium).
